// Detachable sessions. A session is a background process that owns an
// Orchestrator and listens on a unix socket; TUIs (and `relay logs`) attach
// as clients and receive throttled state snapshots plus transcript deltas.
//
//   relay "task"         spawn session + attach
//   d / ctrl-d           detach (session keeps running)
//   relay attach [id]    come back later
//   relay ls | logs | kill

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../bin/relay.js');
export const STATE_DIR =
  process.env.RELAY_STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'relay');
const SESS_DIR = path.join(STATE_DIR, 'sessions');
const HISTORY = path.join(STATE_DIR, 'history.jsonl');
const ACTIVE = new Set(['planning', 'running', 'reviewing']);
const TR_CAP = 3000;

export const sessPaths = (id) => {
  const dir = path.join(SESS_DIR, id);
  let sock = path.join(dir, 'sock');
  // unix socket paths are capped at ~107 bytes; fall back to a short dir
  if (Buffer.byteLength(sock) > 100) sock = path.join('/tmp', `relay-${process.getuid?.() ?? 'u'}`, `${id}.sock`);
  return { dir, sock, meta: path.join(dir, 'meta.json'), log: path.join(dir, 'server.log') };
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// ── discovery ────────────────────────────────────────────────────────────
export function listSessions() {
  let ids = [];
  try {
    ids = fs.readdirSync(SESS_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const p = sessPaths(id);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
    } catch {
      // half-created or broken; reap if old
      try {
        if (Date.now() - fs.statSync(p.dir).mtimeMs > 60_000) fs.rmSync(p.dir, { recursive: true, force: true });
      } catch {}
      continue;
    }
    if (!alive(meta.pid)) {
      fs.rmSync(p.dir, { recursive: true, force: true });
      continue;
    }
    out.push(meta);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function recentHistory(n = 5) {
  try {
    return fs
      .readFileSync(HISTORY, 'utf8')
      .trim()
      .split('\n')
      .slice(-n)
      .map((l) => JSON.parse(l))
      .reverse();
  } catch {
    return [];
  }
}

// Pick a session by id/prefix, else the newest one started from cwd, else the newest.
export function resolveSession(arg, cwd = process.cwd()) {
  const all = listSessions();
  if (arg) {
    const exact = all.find((s) => s.id === arg || s.id === `r-${arg}`);
    if (exact) return exact;
    const pre = all.filter((s) => s.id.startsWith(arg) || s.id.startsWith(`r-${arg}`));
    if (pre.length === 1) return pre[0];
    if (pre.length > 1) throw new Error(`"${arg}" matches ${pre.map((s) => s.id).join(', ')}`);
    throw new Error(`no live session "${arg}" (see relay ls)`);
  }
  if (!all.length) throw new Error('no live sessions (see relay ls)');
  return all.find((s) => s.cwd === cwd) || all[0];
}

// ── spawning ─────────────────────────────────────────────────────────────
export async function spawnSession(opts, goal) {
  fs.mkdirSync(SESS_DIR, { recursive: true });
  let id;
  do id = `r-${randomBytes(2).toString('hex')}`;
  while (fs.existsSync(sessPaths(id).dir));
  const p = sessPaths(id);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const logfd = fs.openSync(p.log, 'a');
  const child = spawn(process.execPath, [BIN, '__serve', id], {
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', logfd, logfd],
    env: { ...process.env, RELAY_SESSION_INIT: JSON.stringify({ opts, goal }) },
  });
  fs.closeSync(logfd);
  let exited = null;
  child.on('exit', (code) => (exited = code));
  child.unref();
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(p.meta) && fs.existsSync(p.sock)) return id;
    if (exited !== null) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  let tail = '';
  try {
    tail = fs.readFileSync(p.log, 'utf8').trim().split('\n').slice(-5).join('\n');
  } catch {}
  throw new Error(`session ${id} failed to start${tail ? `:\n${tail}` : ''}`);
}

// ── server ───────────────────────────────────────────────────────────────
export async function serve(id) {
  const init = JSON.parse(process.env.RELAY_SESSION_INIT || '{}');
  delete process.env.RELAY_SESSION_INIT; // don't leak into agents
  const srv = new SessionServer(id, init.opts);
  await srv.listen();
  if (init.goal) srv.start(init.goal);
}

class SessionServer {
  constructor(id, opts) {
    this.id = id;
    this.opts = opts;
    this.p = sessPaths(id);
    this.clients = new Set();
    this.orch = null;
    this.runSeq = 0;
    // Finished runs of the current conversation, oldest first. Each new message
    // is a follow-up to these; only /new starts a fresh conversation.
    this.thread = [];
    this.startedAt = Date.now();
    this.lastActive = Date.now();
    this.metaAt = 0;
  }

  get active() {
    return !!this.orch && ACTIVE.has(this.orch.run.phase);
  }

  async listen() {
    fs.mkdirSync(path.dirname(this.p.sock), { recursive: true, mode: 0o700 });
    fs.rmSync(this.p.sock, { force: true });
    this.server = net.createServer((sock) => this.onClient(sock));
    await new Promise((res, rej) => this.server.listen(this.p.sock, res).on('error', rej));
    try {
      fs.chmodSync(this.p.sock, 0o600); // dir is 0700 anyway
    } catch {}
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('SIGHUP', () => {});
    process.on('uncaughtException', (e) => console.error(new Date().toISOString(), 'uncaught', e));
    process.on('unhandledRejection', (e) => console.error(new Date().toISOString(), 'unhandled', e));
    process.on('exit', () => {
      try {
        this.orch?.abort();
      } catch {}
      fs.rmSync(this.p.dir, { recursive: true, force: true });
      fs.rmSync(this.p.sock, { force: true });
    });
    const idleMs = (this.opts.idleTimeout ?? 24) * 3600_000;
    setInterval(() => {
      if (!this.clients.size && !this.active && Date.now() - this.lastActive > idleMs) this.shutdown('idle timeout');
    }, 30_000);
    this.writeMeta(true);
    console.error(new Date().toISOString(), `session ${this.id} pid ${process.pid} listening`);
  }

  onClient(sock) {
    const c = { sock, sent: new Map(), run: -1, mode: 'tui' };
    this.clients.add(c);
    this.lastActive = Date.now();
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        this.onMessage(c, m);
      }
    });
    sock.on('close', () => {
      this.clients.delete(c);
      this.lastActive = Date.now();
      this.writeMeta(true);
    });
  }

  onMessage(c, m) {
    switch (m.type) {
      case 'hello':
        c.mode = m.mode || 'tui';
        this.send(c, this.snap(c));
        this.writeMeta(true);
        break;
      case 'start':
        if (m.goal && !this.active) this.start(String(m.goal));
        break;
      case 'abort':
        this.orch?.abort();
        break;
      case 'new':
        this.reset();
        break;
      case 'quit':
        this.shutdown('quit from client');
        break;
    }
  }

  // /new: drop the current run (aborting it if it is still going) and forget
  // the conversation, so the next message starts from scratch and clients go
  // back to an empty screen. An aborted run still finishes in the background
  // and writes its report and history entry.
  reset() {
    this.thread = [];
    if (!this.orch) return;
    this.orch.abort();
    this.orch = null;
    this.runSeq++;
    this.lastActive = Date.now();
    this.flush();
    this.writeMeta(true);
  }

  start(goal) {
    this.runSeq++;
    this.lastActive = Date.now();
    const thread = this.thread;
    const orch = new Orchestrator({ ...this.opts, history: thread.slice() });
    this.orch = orch;
    orch.on('change', () => this.orch === orch && this.dirty());
    orch.on('end', (run) => {
      this.lastActive = Date.now();
      try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.appendFileSync(
          HISTORY,
          JSON.stringify({
            id: this.id, turn: run.turn, goal: run.goal, cwd: this.opts.cwd, phase: run.phase, verdict: run.verdict,
            cost: orch.cost, report: run.reportPath, startedAt: run.startedAt, endedAt: run.endedAt,
          }) + '\n',
        );
      } catch {}
      // A /new during the run swapped in a fresh thread; this one is gone.
      if (thread === this.thread)
        thread.push({
          goal: run.goal, brief: run.brief, phase: run.phase, verdict: run.verdict,
          summary: run.summary || run.error, reportPath: run.reportPath,
        });
      if (this.orch !== orch) return; // replaced by /new or a later run
      this.flush();
      for (const c of this.clients) this.send(c, { type: 'end', phase: run.phase });
      this.writeMeta(true);
    });
    orch.start(goal);
    this.writeMeta(true);
    this.dirty();
  }

  dirty() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 100);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    for (const c of this.clients) this.send(c, this.snap(c));
    this.writeMeta();
  }

  send(c, obj) {
    if (c.sock.destroyed) return;
    c.sock.write(JSON.stringify(obj) + '\n');
  }

  snap(c) {
    const o = this.orch;
    if (c.run !== this.runSeq) {
      c.sent = new Map();
      c.run = this.runSeq;
    }
    const base = {
      type: 'snap',
      session: { id: this.id, pid: process.pid, startedAt: this.startedAt, clients: this.clients.size },
      opts: this.opts,
      runSeq: this.runSeq,
    };
    if (!o) return { ...base, run: null, agents: [], tr: [], cost: 0, aborted: false, labels: {} };
    const r = o.run;
    const aid = (a) => a?.id ?? null;
    const run = {
      goal: r.goal, brief: r.brief, turn: r.turn, phase: r.phase, round: r.round, plan: r.plan, rounds: r.rounds,
      verdict: r.verdict, summary: r.summary, startedAt: r.startedAt, endedAt: r.endedAt,
      reportPath: r.reportPath, error: r.error,
      log: r.log.slice(c.mode === 'logs' ? -500 : -80),
      leadAgents: r.leadAgents.map(aid),
      tasks: r.tasks.map((t) => ({ ...t, agent: aid(t.agent) })),
      escalations: r.escalations.map((e) => ({ ...e, agent: aid(e.agent) })),
    };
    const agents = [];
    const tr = [];
    for (const a of o.agents) {
      const { transcript, ...st } = a.state;
      agents.push([a.id, st]);
      if (c.mode !== 'tui') continue;
      const total = (st.trDropped || 0) + transcript.length; // absolute count
      const sent = c.sent.get(a.id) || 0;
      if (sent === 0) tr.push([a.id, { reset: true, entries: transcript }]);
      else if (total > sent) {
        const n = Math.min(total - sent, transcript.length - 1); // never resend the prompt
        tr.push([a.id, { entries: transcript.slice(transcript.length - n) }]);
      }
      c.sent.set(a.id, total);
    }
    const labels = {};
    for (const k of ['lead', 'worker', 'escalate']) labels[this.opts[k]] = o.label(this.opts[k]);
    return { ...base, run, agents, tr, cost: o.cost, aborted: o.aborted, labels };
  }

  writeMeta(force = false) {
    if (!force && Date.now() - this.metaAt < 1000) return;
    this.metaAt = Date.now();
    const r = this.orch?.run;
    const meta = {
      id: this.id,
      pid: process.pid,
      cwd: this.opts.cwd,
      goal: r?.goal || '',
      phase: !r ? 'idle' : r.phase === 'idle' ? 'starting' : r.phase,
      verdict: r?.verdict || '',
      cost: this.orch?.cost || 0,
      runs: this.runSeq,
      turns: this.thread.length,
      clients: this.clients.size,
      report: r?.reportPath || '',
      startedAt: this.startedAt,
      updatedAt: Date.now(),
    };
    try {
      fs.writeFileSync(this.p.meta + '.tmp', JSON.stringify(meta));
      fs.renameSync(this.p.meta + '.tmp', this.p.meta);
    } catch {}
  }

  shutdown(reason) {
    if (this.closing) return;
    this.closing = true;
    console.error(new Date().toISOString(), `shutdown: ${reason}`);
    try {
      this.orch?.abort();
    } catch {}
    for (const c of this.clients) {
      this.send(c, { type: 'bye', reason });
      c.sock.end();
    }
    this.server?.close();
    setTimeout(() => process.exit(0), 300);
  }
}

// ── client ───────────────────────────────────────────────────────────────
// Mirrors the server's Orchestrator closely enough that the TUI can't tell
// the difference: .run, .agents, .cost, .aborted, .label(), .abort().
export class RemoteSession extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.run = null;
    this.agents = [];
    this.cost = 0;
    this.aborted = false;
    this.labels = {};
    this.opts = null;
    this.session = null;
    this._agents = new Map();
    this.runSeq = -1;
  }

  connect(mode = 'tui') {
    return new Promise((resolve, reject) => {
      let first = true;
      let buf = '';
      const sock = net.createConnection(sessPaths(this.id).sock);
      this.sock = sock;
      sock.on('connect', () => this.send({ type: 'hello', mode }));
      sock.on('error', (e) => (first ? reject(e) : this.emit('error', e)));
      sock.on('close', () => this.emit('disconnect', this.byeReason));
      sock.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.type === 'snap') {
            this.onSnap(m);
            if (first) {
              first = false;
              resolve(this);
            }
          } else if (m.type === 'end') this.emit('end', this.run);
          else if (m.type === 'bye') this.byeReason = m.reason;
        }
      });
    });
  }

  send(o) {
    if (this.sock && !this.sock.destroyed) this.sock.write(JSON.stringify(o) + '\n');
  }

  onSnap(m) {
    if (m.runSeq !== this.runSeq) {
      this._agents = new Map();
      this.runSeq = m.runSeq;
    }
    this.opts = m.opts;
    this.session = m.session;
    this.labels = m.labels || {};
    this.cost = m.cost || 0;
    this.aborted = !!m.aborted;
    for (const [id, st] of m.agents || []) {
      const prev = this._agents.get(id);
      this._agents.set(id, { id, state: { ...st, transcript: prev?.state.transcript || [] } });
    }
    for (const [id, d] of m.tr || []) {
      const a = this._agents.get(id);
      if (!a) continue;
      if (d.reset) a.state.transcript = d.entries;
      else {
        const t = a.state.transcript;
        t.push(...d.entries);
        if (t.length > TR_CAP) t.splice(1, t.length - TR_CAP);
      }
    }
    this.agents = [...this._agents.values()];
    if (!m.run) this.run = null;
    else {
      const A = (id) => (id ? this._agents.get(id) || null : null);
      this.run = {
        ...m.run,
        leadAgents: m.run.leadAgents.map(A).filter(Boolean),
        tasks: m.run.tasks.map((t) => ({ ...t, agent: A(t.agent) })),
        escalations: m.run.escalations.map((e) => ({ ...e, agent: A(e.agent) })),
      };
    }
    this.emit('change');
  }

  label(alias) {
    return this.labels[alias] || alias;
  }

  start(goal) {
    this.send({ type: 'start', goal });
  }

  abort() {
    this.send({ type: 'abort' });
  }

  reset() {
    this.send({ type: 'new' });
  }

  quit() {
    this.send({ type: 'quit' });
  }

  detach() {
    this.sock?.end();
  }
}
