#!/usr/bin/env node
// relay — Opus leads, Haiku swarms, Opus on call.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { TUI } from '../src/tui.js';
import { CLAUDE_BIN } from '../src/agent.js';
import {
  spawnSession, serve, listSessions, recentHistory, resolveSession, RemoteSession, sessPaths,
} from '../src/session.js';

const HELP = `relay — multi-agent harness for the claude CLI

usage: relay [options] [task...]       start a session and attach to it
       relay                             (interactive: type tasks in the TUI)
       relay -d [options] task...        start detached, print the session id
       relay attach [id]                 re-attach (default: newest session here)
       relay ls                          live sessions + recently finished runs
       relay logs [id] [-f]              print a session's log (-f: follow)
       relay kill <id>|--all             end sessions (aborts running agents)
       relay completion zsh|bash         print a shell completion script
       echo "task" | relay --plain       no session, no TUI, log to stdout

Runs live in a background session: press d (or ctrl-d) to detach, close the
terminal, and come back with relay attach.

An Opus lead plans the task and splits it into subtasks, Haiku workers run
them in parallel, and any worker can escalate a hard sub-problem to Opus
through the escalate_to_opus tool. The lead reviews the results and can run
more rounds. Every run leaves a report in .relay/runs/<time>/.

models
  --lead <model>           orchestrator model            (default: opus)
  --worker <model>         worker model                  (default: haiku)
  --escalate <model>       model workers escalate to     (default: opus)
  --effort <level>         lead/escalation effort: low|medium|high|xhigh|max (default: high)

limits
  -j, --concurrency <n>    parallel workers              (default: 4)
  --rounds <n>             max plan/review rounds        (default: 3)
  --max-tasks <n>          max tasks per round           (default: 8)
  --max-escalations <n>    max escalations per run       (default: 6)
  --budget <usd>           stop dispatching past this total spend

permissions (workers)
  --permission-mode <m>    claude permission mode        (default: acceptEdits)
  --allow <rule>           extra allowed tool rule, repeatable, e.g. --allow "Bash(npm test:*)"
  --yolo                   bypassPermissions for workers (sandboxes only!)
  --inherit-mcp            let agents load your MCP servers (default: isolated)
  --mcp-config <file>      give workers the MCP servers in this JSON file (repeatable);
                           their tools are allowed automatically

misc
  -C, --cwd <dir>          project directory             (default: .)
  --out <dir>              where run reports go          (default: <cwd>/.relay/runs)
  --plain                  no TUI, print the log (default when stdout is not a TTY)
  --mock                   simulated agents: try the TUI without spending tokens
  --keep-sessions          persist agent sessions (resumable with claude --resume)
  -d, --detach             start the session in the background and exit
  --idle-timeout <hours>   end an idle session nobody is attached to (default: 24)
  -h, --help

keys
  tab / arrows   select lead, worker or escalation
  enter          start the typed task, or open the selected agent
  t              in an agent's view: switch between transcript and tool timeline
  d / ctrl-d     detach (the session keeps running)
  q              abort the current run      ctrl-c   abort, then end the session
`;

function parse(argv) {
  const o = {
    lead: 'opus', worker: 'haiku', escalate: 'opus', effort: 'high',
    concurrency: 4, rounds: 3, maxTasks: 8, maxEscalations: 6, budget: 0,
    permissionMode: 'acceptEdits', allow: [], yolo: false, inheritMcp: false,
    cwd: process.cwd(), outDir: '', plain: !process.stdout.isTTY, mock: false, keepSessions: false,
    detach: false, idleTimeout: 24, mcpServers: null,
  };
  const rest = [];
  const num = (v, k) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) die(`${k} expects a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const val = () => (inline !== undefined ? inline : argv[++i] ?? die(`${flag} needs a value`));
    switch (flag) {
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0);
      case '--lead': o.lead = val(); break;
      case '--worker': o.worker = val(); break;
      case '--escalate': o.escalate = val(); break;
      case '--effort': o.effort = val(); break;
      case '-j': case '--concurrency': o.concurrency = Math.max(1, num(val(), flag)); break;
      case '--rounds': o.rounds = Math.max(1, num(val(), flag)); break;
      case '--max-tasks': o.maxTasks = Math.max(1, num(val(), flag)); break;
      case '--max-escalations': o.maxEscalations = num(val(), flag); break;
      case '--budget': o.budget = num(val(), flag); break;
      case '--permission-mode': o.permissionMode = val(); break;
      case '--allow': o.allow.push(val()); break;
      case '--yolo': o.yolo = true; break;
      case '--inherit-mcp': o.inheritMcp = true; break;
      case '--mcp-config': {
        const file = val();
        let cfg;
        try {
          cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
          die(`--mcp-config ${file}: ${e.message}`);
        }
        const servers = cfg.mcpServers || cfg;
        if (!servers || typeof servers !== 'object' || Array.isArray(servers)) die(`--mcp-config ${file}: expected {"mcpServers": {...}}`);
        if (servers.relay) die(`--mcp-config ${file}: the server name "relay" is reserved`);
        o.mcpServers = { ...(o.mcpServers || {}), ...servers };
        break;
      }
      case '-C': case '--cwd': o.cwd = path.resolve(val()); break;
      case '--out': o.outDir = path.resolve(val()); break;
      case '--plain': o.plain = true; break;
      case '--mock': o.mock = true; break;
      case '--keep-sessions': o.keepSessions = true; break;
      case '-d': case '--detach': o.detach = true; o.plain = false; break;
      case '--idle-timeout': o.idleTimeout = num(val(), flag); break;
      case '--': rest.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith('-') && a.length > 1) die(`unknown option ${a} (see --help)`);
        rest.push(a);
    }
  }
  return { o, goal: rest.join(' ').trim() };
}

function die(msg) {
  process.stderr.write(`relay: ${msg}\n`);
  process.exit(2);
}

async function readStdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.trim();
}

function printSummary(orch) {
  const r = orch?.run;
  if (!r || !r.startedAt) return;
  const out = [];
  out.push(`\n\x1b[1mrelay · ${r.phase}\x1b[0m${r.verdict ? ` · ${r.verdict}` : ''} · $${orch.cost.toFixed(3)}`);
  if (r.error) out.push(`\x1b[31m${r.error}\x1b[0m`);
  if (r.summary) out.push('', r.summary);
  if (r.reportPath) out.push('', `\x1b[2mreport: ${r.reportPath}\x1b[0m`);
  process.stdout.write(out.join('\n') + '\n');
}

const COLOR = { orange: 33, blue: 34, purple: 35, green: 32, red: 31, dim: 90 };
const printLog = (e) => {
  const t = new Date(e.t).toTimeString().slice(0, 8);
  process.stdout.write(`\x1b[90m${t}\x1b[0m  \x1b[${COLOR[e.color] || 0};1m${e.who.padEnd(12)}\x1b[0m ${e.msg}\n`);
};
const tilde = (p) => (p || '').replace(os.homedir(), '~');
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const short = (s, n) => ((s = String(s || '')).length > n ? s.slice(0, n - 1) + '…' : s);

function checkClaude() {
  const v = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) die(`cannot run "${CLAUDE_BIN}" (set RELAY_CLAUDE_BIN or use --mock)`);
}

// ── subcommands ───────────────────────────────────────────────────────────
async function cmdLs() {
  const live = listSessions();
  if (!live.length) console.log('no live sessions');
  else {
    console.log('\x1b[1mID      PHASE      AGE   COST     ATT  CWD                       GOAL\x1b[0m');
    for (const s of live)
      console.log(
        `${s.id.padEnd(7)} ${s.phase.padEnd(10)} ${ago(s.startedAt).padEnd(5)} ${('$' + s.cost.toFixed(3)).padEnd(8)} ${String(s.clients).padEnd(4)} ${short(tilde(s.cwd), 25).padEnd(25)} ${short(s.goal || '(idle)', 60)}`,
      );
  }
  const hist = recentHistory(5);
  if (hist.length) {
    console.log('\n\x1b[1mrecently finished\x1b[0m');
    for (const h of hist)
      console.log(
        `\x1b[90m${h.id.padEnd(7)} ${h.phase.padEnd(10)} ${(ago(h.endedAt) + ' ago').padEnd(9)} $${(h.cost || 0).toFixed(3)}\x1b[0m  ${short(h.goal, 50)}\n        \x1b[90m${tilde(h.report)}\x1b[0m`,
      );
  }
}

async function connectTo(arg, mode) {
  let meta;
  try {
    meta = resolveSession(arg);
  } catch (e) {
    die(e.message);
  }
  const remote = new RemoteSession(meta.id);
  try {
    await remote.connect(mode);
  } catch (e) {
    die(`cannot reach session ${meta.id}: ${e.message}`);
  }
  return remote;
}

async function cmdLogs(args) {
  const follow = args.includes('-f') || args.includes('--follow');
  const id = args.find((a) => !a.startsWith('-'));
  const remote = await connectTo(id, 'logs');
  let last = 0;
  let runSeq = remote.runSeq;
  const dump = () => {
    if (remote.runSeq !== runSeq) {
      runSeq = remote.runSeq;
      last = 0;
    }
    for (const e of remote.run?.log || []) if (e.seq > last) {
      printLog(e);
      last = e.seq;
    }
  };
  dump();
  const active = ['planning', 'running', 'reviewing'].includes(remote.run?.phase);
  if (!follow || !active) process.exit(0);
  remote.on('change', dump);
  remote.on('end', (run) => {
    dump();
    console.log(`\x1b[90mrun ${run?.phase || 'ended'} · session ${remote.id} stays up (relay attach ${remote.id})\x1b[0m`);
    process.exit(0);
  });
  remote.on('disconnect', (why) => {
    console.log(`\x1b[90msession ended${why ? ` (${why})` : ''}\x1b[0m`);
    process.exit(0);
  });
  process.on('SIGINT', () => process.exit(0));
}

async function cmdKill(args) {
  const all = args.includes('--all');
  const targets = all ? listSessions() : [resolveSessionOrDie(args.find((a) => !a.startsWith('-')))];
  if (!targets.length) return console.log('no live sessions');
  for (const s of targets) {
    try {
      const r = new RemoteSession(s.id);
      await r.connect('logs');
      r.quit();
      await new Promise((res) => (r.on('disconnect', res), setTimeout(res, 3000)));
    } catch {
      try { process.kill(s.pid, 'SIGTERM'); } catch {}
    }
    console.log(`killed ${s.id}`);
  }
}

function resolveSessionOrDie(arg) {
  if (!arg) die('which session? (relay kill <id>, or --all)');
  try {
    return resolveSession(arg);
  } catch (e) {
    die(e.message);
  }
}

async function attachTUI(id, fresh) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) die('attaching needs an interactive terminal');
  const remote = await connectTo(id, 'tui');
  let done = false;
  const tui = new TUI({
    opts: remote.opts,
    startRun: (goal) => {
      remote.start(goal);
      return remote;
    },
    onQuit: () => finish('quit'),
    onDetach: () => finish('detach'),
  });
  function finish(kind, why) {
    if (done) return;
    done = true;
    tui.close();
    if (kind === 'quit') {
      remote.quit();
      printSummary(remote);
    } else if (kind === 'detach') {
      remote.detach();
      const r = remote.run;
      console.log(`detached from \x1b[1m${remote.id}\x1b[0m${r ? ` (${r.phase})` : ''} · come back with: relay attach ${remote.id}`);
    } else {
      printSummary(remote);
      console.log(`\x1b[90msession ${remote.id} ended${why ? ` (${why})` : ''}\x1b[0m`);
    }
    setTimeout(() => process.exit(0), 50);
  }
  remote.on('disconnect', (why) => finish('lost', why));
  process.on('SIGHUP', () => finish('detach'));
  process.on('SIGTERM', () => finish('detach'));
  tui.open();
  tui.attach(remote);
  if (!fresh) tui.flash = `attached to ${remote.id} · d / ^D detaches`;
}

function cmdCompletion(shell) {
  const file = { zsh: '_relay', bash: 'relay.bash' }[shell];
  if (!file) die('usage: relay completion zsh|bash');
  process.stdout.write(fs.readFileSync(new URL(`../completions/${file}`, import.meta.url), 'utf8'));
}

// Machine-readable session list for shell completion; must stay fast and quiet.
function cmdComplete(what) {
  const live = listSessions();
  for (const s of live) {
    if (what === 'ids') console.log(s.id);
    else {
      const desc = `${s.phase}${s.clients ? ' · attached' : ''} · ${short(s.goal || '(idle)', 50)} · ${tilde(s.cwd)}`;
      console.log(`${s.id}:${desc.replace(/[\r\n]+/g, ' ')}`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const SUB = { attach: 1, a: 1, ls: 1, list: 1, logs: 1, kill: 1, completion: 1, __serve: 1, __complete: 1 };

if (SUB[argv[0]]) {
  const [sub, ...args] = argv;
  if (sub === '__serve') await serve(args[0]);
  else if (sub === 'attach' || sub === 'a') await attachTUI(args[0], false);
  else if (sub === 'ls' || sub === 'list') await cmdLs();
  else if (sub === 'logs') await cmdLogs(args);
  else if (sub === 'kill') await cmdKill(args);
  else if (sub === 'completion') cmdCompletion(args[0]);
  else if (sub === '__complete') cmdComplete(args[0]);
} else {
  const { o, goal: argGoal } = parse(argv);
  if (!o.mock) checkClaude();

  if (o.plain) {
    // in-process, no session
    const goal = argGoal || (!process.stdin.isTTY ? await readStdin() : '');
    if (!goal) die('no task given (pass it as an argument or on stdin)');
    const orch = new Orchestrator(o);
    orch.on('log', printLog);
    process.on('SIGINT', () => orch.abort());
    process.on('exit', () => orch.abort());
    const run = await orch.start(goal);
    printSummary(orch);
    process.exit(run.phase === 'done' ? 0 : 1);
  } else if (o.detach) {
    if (!argGoal) die('--detach needs a task');
    const { detach, plain, ...sessOpts } = o;
    const id = await spawnSession(sessOpts, argGoal).catch((e) => die(e.message));
    console.log(`started \x1b[1m${id}\x1b[0m in the background`);
    console.log(`  relay attach ${id}    relay logs ${id} -f    relay kill ${id}`);
    console.log(`\x1b[90m  server log: ${tilde(sessPaths(id).log)}\x1b[0m`);
    process.exit(0);
  } else {
    if (!process.stdin.isTTY) die('the TUI needs an interactive terminal (use --plain or --detach)');
    const { detach, plain, ...sessOpts } = o;
    const id = await spawnSession(sessOpts, argGoal).catch((e) => die(e.message));
    await attachTUI(id, true);
  }
}
