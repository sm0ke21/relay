// Full-screen terminal UI. Renders the orchestrator's run state as a flow
// diagram: lead -> fan-out -> workers (+ escalations) -> fan-in -> review.

import os from 'node:os';
import { Canvas, C, S, wrap, segLen, clean } from './canvas.js';
import { modelLabel, family, isTerminal, toolCalls, parseMcp } from './agent.js';

const SPIN = ['◐', '◓', '◑', '◒'];
const EFFORT = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
const ACTIVE = new Set(['planning', 'running', 'reviewing']);

const cap = (s) => String(s).replace(/^\w/, (c) => c.toUpperCase());
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
const colorOf = (name) => C[name] || C.text;
// Stable colour per MCP server name. Avoids the role colours (blue, purple,
// orange, green) and anything close to the red used for failures.
const SERVER_PALETTE = ['#5fd7af', '#e6c27a', '#b5d98a', '#8ee3e3', '#d7b98e', '#e9a6d8'];
// Colours are handed out in order of first appearance, so the first six
// servers in a session never share one (hashing names caused collisions).
const serverColors = new Map();
const serverColor = (name = '') => {
  if (!serverColors.has(name)) serverColors.set(name, SERVER_PALETTE[serverColors.size % SERVER_PALETTE.length]);
  return serverColors.get(name);
};
// colour for a tool call by its tool name
const toolColor = (name = '') => {
  if (name.startsWith('mcp__relay')) return C.purple;
  const mcp = parseMcp(name);
  if (mcp) return serverColor(mcp.server);
  if (name === 'StructuredOutput') return C.green;
  return C.blue;
};
const fmtDur = (ms) => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
};

// an agent's current activity, with the MCP server name (if any) in its colour
const activitySegs = (st, fallback = '') => {
  const text = st?.activity || fallback;
  const mcp = st?.activityMcp;
  if (mcp && text.startsWith(mcp.server))
    return [[mcp.server, S(serverColor(mcp.server), { bold: true })], [text.slice(mcp.server.length), S(C.dim)]];
  return [[text, S(C.dim)]];
};

const famColor = (id) => ({ opus: C.purple, haiku: C.blue, sonnet: C.orange, fable: C.yellow })[family(id)] || C.text;

// box-drawing junction for a cell with connections up/down/left/right
const JUNC = {
  '0011': '─', '0111': '┬', '1011': '┴', '1111': '┼', '0101': '┌', '0110': '┐', '1001': '└',
  '1010': '┘', '1101': '├', '1110': '┤', '1100': '│', '0100': '╷', '1000': '╵', '0001': '╶', '0010': '╴',
};

export class TUI {
  constructor({ opts, startRun, onQuit, onDetach }) {
    this._opts = opts;
    this.startRun = startRun;
    this.onQuit = onQuit;
    this.onDetach = onDetach;
    this.orch = null;
    this.input = '';
    this.sel = 0;
    this.detail = false;
    this.scroll = 0;
    this.view = 'transcript'; // detail view: transcript | timeline
    this.tick = 0;
    this.flash = '';
    this.pending = false;
    this.cmd = false; // '/' command line opened during a run
  }

  // an attached session's own settings win over the local CLI flags
  get opts() {
    return this.orch?.opts || this._opts;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  open() {
    const out = process.stdout;
    out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this.onData = (s) => this.onKey(s);
    process.stdin.on('data', this.onData);
    this.onResize = () => {
      this.prev = null;
      out.write('\x1b[2J');
      this.render();
    };
    out.on('resize', this.onResize);
    this.timer = setInterval(() => {
      this.tick++;
      this.render();
    }, 150);
    this.render();
  }

  close() {
    clearInterval(this.timer);
    process.stdin.off('data', this.onData);
    process.stdout.off('resize', this.onResize);
    try {
      process.stdin.setRawMode(false);
    } catch {}
    process.stdin.pause();
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  attach(orch) {
    this.sel = 0;
    this.detail = false;
    if (this.orch === orch) return;
    this.orch = orch;
    orch.on('change', () => this.schedule());
    orch.on('end', (run) => {
      const tail = this.onDetach ? 'type a follow-up · /new starts over · ^D detach · ^C end session' : 'type a follow-up · /new starts over · ctrl-c to quit';
      this.flash = run?.phase === 'done' ? `done · enter opens a transcript · ${tail}` : `${run?.phase || 'ended'} · ${tail}`;
      this.render();
    });
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.render();
    }, 40);
  }

  get run() {
    return this.orch?.run || null;
  }

  running() {
    return !!this.run && ACTIVE.has(this.run.phase);
  }

  items() {
    const r = this.run;
    if (!r) return [];
    return [
      { kind: 'lead' },
      ...r.tasks.map((t) => ({ kind: 'task', t })),
      ...r.escalations.map((e) => ({ kind: 'esc', e })),
    ];
  }

  selected() {
    const it = this.items();
    if (!it.length) return null;
    this.sel = ((this.sel % it.length) + it.length) % it.length;
    return it[this.sel];
  }

  label(alias) {
    return this.orch ? this.orch.label(alias) : alias;
  }

  // ── input ─────────────────────────────────────────────────────────────
  onKey(s) {
    if (this.running()) this.flash = '';
    if (s === '\x03') {
      if (this.running() && !this.orch.aborted) {
        this.orch.abort();
        this.flash = 'aborted · ctrl-c again to quit';
      } else this.onQuit();
      return this.render();
    }
    if (s === '\x04' && this.onDetach) return this.onDetach();
    if (this.detail) {
      const page = Math.max(1, process.stdout.rows - 5);
      if (s === '\x1b' || s === 'q' || s === '\x1b[D' || s === '\r') this.detail = false;
      else if (s === '\x1b[A' || s === 'k') this.scroll++;
      else if (s === '\x1b[B' || s === 'j') this.scroll = Math.max(0, this.scroll - 1);
      else if (s === '\x1b[5~' || s === 'b') this.scroll += page;
      else if (s === '\x1b[6~' || s === ' ') this.scroll = Math.max(0, this.scroll - page);
      else if (s === 'g') this.scroll = 1e9;
      else if (s === 'G') this.scroll = 0;
      else if (s === 't' || s === '\t') {
        this.view = this.view === 'timeline' ? 'transcript' : 'timeline';
        this.scroll = 0;
      }
      return this.render();
    }
    if (this.cmd && !this.running()) this.cmd = false; // run ended under us; keep the text as normal input
    const idle = !this.running();
    const editing = idle || this.cmd;
    if (this.cmd && s === '\x1b') {
      this.cmd = false;
      this.input = '';
    } else if (s === '\t' || s === '\x1b[C' || s === '\x1b[B') this.sel++;
    else if (s === '\x1b[Z' || s === '\x1b[D' || s === '\x1b[A') this.sel--;
    else if (s === '\r') {
      const text = this.input.trim();
      if (editing && /^\/[a-z]+(\s|$)/i.test(text)) {
        this.input = '';
        this.cmd = false;
        this.command(text);
      } else if (idle && text) {
        this.input = '';
        this.flash = '';
        this.attach(this.startRun(text));
      } else if (this.cmd) {
        this.cmd = false;
        this.input = '';
      } else if (this.selected()) {
        this.detail = true;
        this.scroll = 0;
      }
    } else if (editing) {
      if (s === '\x04' && !this.input) return this.onQuit();
      if ((s === '\x7f' || s === '\b') && this.cmd && this.input === '/') this.cmd = false;
      if (s === '\x7f' || s === '\b') this.input = [...this.input].slice(0, -1).join('');
      else if (s === '\x15') this.input = '';
      else if (s === '\x17') this.input = this.input.replace(/\S+\s*$/, '');
      else if (!s.startsWith('\x1b')) this.input += s.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    } else if (s === '/') {
      this.cmd = true;
      this.input = '/';
      this.flash = '';
    } else if (s === 'd' && this.onDetach) {
      return this.onDetach();
    } else if (s === 'q') {
      this.orch.abort();
      this.flash = 'aborted · ctrl-c to quit';
    }
    this.render();
  }

  // Slash commands typed at the prompt. Plain messages are follow-ups to the
  // conversation so far; `/new` drops the current run (aborting it if it is
  // still going), forgets the conversation and returns to an empty screen in
  // the same session; `/new <task>` then starts that task straight away.
  command(text) {
    const [, name, rest] = text.match(/^\/([a-z]+)\s*(.*)$/i);
    switch (name.toLowerCase()) {
      case 'new': {
        const wasRunning = this.running();
        this.orch?.reset?.();
        this.sel = 0;
        this.detail = false;
        this.scroll = 0;
        if (rest.trim()) {
          // the server handles messages in order, so the reset lands first
          this.flash = '';
          this.attach(this.startRun(rest.trim()));
        } else this.flash = wasRunning ? 'run aborted · new conversation' : 'new conversation';
        break;
      }
      default:
        this.flash = `unknown command /${name} · try /new`;
    }
  }

  // ── render ────────────────────────────────────────────────────────────
  render() {
    const W = Math.max(40, process.stdout.columns || 80);
    const H = Math.max(16, process.stdout.rows || 24);
    const cv = new Canvas(W, H);
    if (this.detail && this.selected()) this.drawDetail(cv, W, H);
    else this.drawMain(cv, W, H);
    // only repaint rows that changed since the last frame
    const rows = cv.rows();
    const prev = this.prev && this.prev.length === rows.length ? this.prev : [];
    let out = '';
    rows.forEach((r, y) => {
      if (prev[y] !== r) out += `\x1b[${y + 1};1H` + r;
    });
    this.prev = rows;
    if (out) process.stdout.write(out);
  }

  drawMain(cv, W, H) {
    const o = this.opts;
    const L = this.label(o.lead), Wk = this.label(o.worker), E = this.label(o.escalate);
    let y = H >= 40 ? 1 : 0;
    const small = H < 30;

    cv.center(0, y, W, [
      ['RELAY', S(C.white, { bold: true })], [' · ', S(C.dim)],
      [L.toUpperCase(), S(C.orange, { bold: true })], [' LEADS', S(C.white, { bold: true })], [' · ', S(C.dim)],
      [Wk.toUpperCase(), S(famColor(o.worker), { bold: true })], [' SWARMS', S(C.white, { bold: true })], [' · ', S(C.dim)],
      [E.toUpperCase(), S(C.purple, { bold: true })], [' ON CALL', S(C.white, { bold: true })],
    ]);
    cv.hline(2, y + 1, W - 4, '═', S(C.faint));
    if (!small) cv.center(0, y + 2, W, [
      ['■ ', S(C.orange)], [`${L} · lead`, S(C.text)], ['   '],
      ['■ ', S(famColor(o.worker))], [`${Wk} · swarm`, S(C.text)], ['   '],
      ['■ ', S(C.purple)], [`${E} · escalation`, S(C.text)], ['   '],
      ['■ ', S(C.green)], ['review · gate', S(C.text)],
    ]);
    const top = small ? y + 3 : y + 4;

    const logLines = H >= 44 ? 5 : H >= 32 ? 4 : H >= 26 ? 3 : 2;
    const logH = logLines + 2;
    const logY = H - 5 - logH;
    const bodyH = logY - 1 - top;

    let x0 = 2, dw = W - 4;
    if (W >= 100 && bodyH >= 8) {
      const sw = Math.min(36, Math.max(26, Math.floor(W * 0.24)));
      cv.clip = [top, top + bodyH];
      this.drawSidebar(cv, 1, top, sw, bodyH);
      cv.clip = null;
      x0 = sw + 4;
      dw = W - x0 - 2;
    }
    if (bodyH >= 6) {
      cv.clip = [top, top + bodyH];
      this.drawFlow(cv, x0, top, dw, bodyH);
      cv.clip = null;
    }
    this.drawLog(cv, 1, logY, W - 2, logH);
    this.drawPrompt(cv, 1, H - 4, W - 2);
    this.drawStatus(cv, W, H - 1);
  }

  // ── flow diagram ──────────────────────────────────────────────────────
  drawFlow(cv, x0, top, dw, bodyH) {
    const run = this.run;
    const o = this.opts;
    const tasks = run?.tasks || [];
    const escs = run?.escalations || [];
    const sel = this.selected();
    const n = Math.max(1, tasks.length);
    const phase = run?.phase || 'idle';

    // Degrade in stages: shrink chrome first, then the worker boxes, then
    // page through worker rows.
    const LEVELS = [
      { lead: 6, conn: 2, w: 7, rg: 1, esc: 6, rev: 5, minW: 24, cw: false },
      { lead: 4, conn: 1, w: 7, rg: 0, esc: 4, rev: 4, minW: 24, cw: false },
      { lead: 4, conn: 1, w: 5, rg: 0, esc: 4, rev: 4, minW: 20, cw: true },
      { lead: 3, conn: 0, w: 5, rg: 0, esc: 0, rev: 3, minW: 20, cw: true },
    ];
    const grid = (z) => {
      const gap = 2;
      const cols = Math.max(1, Math.min(n, Math.floor((dw + gap) / (z.minW + gap))));
      const bw = Math.min(34, Math.floor((dw - gap * (cols - 1)) / cols));
      return { cols, bw, gap, rows: Math.ceil(n / cols) };
    };
    const fixed = (z) => z.lead + z.conn + 1 + 2 + 1 + (escs.length && z.esc ? z.esc : 0) + 1 + z.rev;
    const need = (z, rows) => fixed(z) + rows * z.w + (rows - 1) * z.rg;
    let lvl = LEVELS.findIndex((z) => need(z, grid(z).rows) <= bodyH);
    if (lvl < 0) lvl = LEVELS.length - 1;
    const z = LEVELS[lvl];
    const g = grid(z);
    const compactLead = lvl > 0;
    const maxRows = Math.max(1, Math.floor((bodyH - fixed(z) + z.rg) / (z.w + z.rg)));
    const visRows = Math.min(g.rows, maxRows);

    // window of rows: start at the first row that still has unfinished work
    let firstRow = 0;
    const firstOpen = tasks.findIndex((t) => !isTerminal(t.status));
    if (firstOpen >= 0) firstRow = Math.floor(firstOpen / g.cols);
    if (sel?.kind === 'task') {
      const r = Math.floor(tasks.indexOf(sel.t) / g.cols);
      if (r < firstRow || r >= firstRow + visRows) firstRow = r;
    }
    firstRow = Math.max(0, Math.min(firstRow, g.rows - visRows));
    const hidden = tasks.length - Math.min(tasks.length, visRows * g.cols);

    let y = top;
    const lw = Math.min(dw, 46);
    const lx = x0 + Math.floor((dw - lw) / 2);
    const cx = lx + Math.floor(lw / 2);
    this.drawLead(cv, lx, y, lw, z.lead, compactLead);
    y += z.lead;

    const flowing = phase === 'planning' || phase === 'running';
    for (let i = 0; i < z.conn; i++) cv.put(cx, y + i, '┊', S(C.orange));
    if (flowing && z.conn) cv.put(cx, y + (this.tick % z.conn), '•', S(C.orange, { bold: true }));
    y += z.conn;

    cv.center(x0, y, dw, [
      ['delegate to subagents', S(C.white)], [' · ', S(C.dim)], [this.label(o.worker), S(famColor(o.worker), { bold: true })],
      ...(hidden > 0 ? [[`  (rows ${firstRow + 1}-${firstRow + visRows} of ${g.rows})`, S(C.dim)]] : []),
    ]);
    y += 1;

    const rowXs = (count) => {
      const total = count * g.bw + (count - 1) * g.gap;
      const sx = x0 + Math.floor((dw - total) / 2);
      return Array.from({ length: count }, (_, i) => sx + i * (g.bw + g.gap));
    };
    const centers = (xs) => xs.map((x) => x + Math.floor(g.bw / 2));
    const rowsTasks = [];
    for (let r = firstRow; r < firstRow + visRows; r++) rowsTasks.push(tasks.slice(r * g.cols, (r + 1) * g.cols));
    const firstXs = rowsTasks[0]?.length ? rowXs(rowsTasks[0].length) : rowXs(Math.min(3, g.cols));

    this.drawFan(cv, y, cx, centers(firstXs), 'down', C.blue, phase === 'running');
    y += 2;

    let lastXs = firstXs;
    if (!tasks.length) {
      for (const x of firstXs) {
        cv.box(x, y, g.bw, z.w, S(C.faint), 'dashed');
        cv.center(x + 1, y + Math.floor(z.w / 2), g.bw - 2, [[phase === 'planning' ? `${SPIN[this.tick % 4]} awaiting plan` : 'idle', S(C.dim)]]);
      }
      y += z.w;
    } else {
      rowsTasks.forEach((row, ri) => {
        const xs = rowXs(row.length);
        row.forEach((t, i) => this.drawWorker(cv, xs[i], y, g.bw, z.w, t, sel?.kind === 'task' && sel.t === t, z.cw));
        lastXs = xs;
        y += z.w + (ri < rowsTasks.length - 1 ? z.rg : 0);
      });
    }

    // fan-in junction right under the last row
    this.drawFan(cv, y, cx, centers(lastXs), 'up', C.green, phase === 'reviewing', false);
    y += 1;

    // escalation lane: boxes hang either side of the centre line
    if (escs.length && z.esc) {
      const live = escs.filter((e) => !isTerminal(e.agent?.state.status));
      const order = [...live, ...escs.filter((e) => !live.includes(e)).reverse()];
      const ebw = Math.min(30, Math.max(20, g.bw));
      const perSide = (span) => Math.max(0, Math.floor((span + 1) / (ebw + 1)));
      const rightN = perSide(x0 + dw - (cx + 3));
      const leftN = perSide(cx - 2 - x0);
      let ri = 0, li = 0;
      for (const e of order) {
        let ex, side;
        if (ri <= li && ri < rightN) { ex = cx + 3 + ri * (ebw + 1); ri++; side = 1; }
        else if (li < leftN) { ex = cx - 2 - ebw - li * (ebw + 1); li++; side = -1; }
        else if (ri < rightN) { ex = cx + 3 + ri * (ebw + 1); ri++; side = 1; }
        else break;
        this.drawEsc(cv, ex, y, ebw, z.esc, e, sel?.kind === 'esc' && sel.e === e, z.esc < 6);
        const my = y + Math.floor(z.esc / 2);
        if (side === 1 && ri === 1) cv.hline(cx + 1, my, 2, '╌', S(C.purple));
        if (side === -1 && li === 1) cv.hline(cx - 1, my, 1, '╌', S(C.purple));
      }
      const more = escs.length - ri - li;
      for (let i = 0; i < z.esc; i++) cv.put(cx, y + i, '┊', S(C.green));
      if (more > 0) cv.segs(x0, y + z.esc - 1, [[`+${more} earlier`, S(C.dim)]], 12);
      y += z.esc;
    }
    cv.put(cx, y, '▼', S(C.green));
    y += 1;

    const rw = Math.min(dw, 46);
    this.drawReview(cv, x0 + Math.floor((dw - rw) / 2), y, rw, z.rev, z.rev < 5);
  }

  drawFan(cv, y, cx, xs, dir, color, animate, arrows = true) {
    const st = S(color);
    if (!xs.length) return;
    const minX = Math.min(cx, ...xs), maxX = Math.max(cx, ...xs);
    const set = new Set(xs);
    if (minX === maxX) {
      cv.put(cx, y, '┊', st);
      if (arrows) cv.put(cx, y + 1, '▼', st);
      return;
    }
    for (let p = minX; p <= maxX; p++) {
      const u = dir === 'down' ? p === cx : set.has(p);
      const d = dir === 'down' ? set.has(p) : p === cx;
      const key = `${+u}${+d}${+(p > minX)}${+(p < maxX)}`;
      cv.put(p, y, JUNC[key] || '─', st);
    }
    if (animate) {
      const span = maxX - minX + 1;
      const k = this.tick % span;
      for (const off of [k, (k + Math.floor(span / 2)) % span]) {
        const p = minX + off;
        if (cv.ch[y]?.[p] === '─') cv.put(p, y, '●', S(color, { bold: true }));
      }
    }
    if (!arrows) return;
    if (dir === 'down') for (const x of xs) cv.put(x, y + 1, '▼', st);
    else cv.put(cx, y + 1, '▼', st);
  }

  drawLead(cv, x, y, w, h, compact) {
    const run = this.run;
    const o = this.opts;
    const phase = run?.phase || 'idle';
    const lead = run?.leadAgents.at(-1)?.state;
    const sel = this.selected()?.kind === 'lead';
    const active = phase === 'planning';
    cv.box(x, y, w, h, S(C.orange, { bold: sel }), sel ? 'heavy' : 'single');
    const iw = w - 4, ix = x + 2;
    const title = [
      ...(active ? [[`${SPIN[this.tick % 4]} `, S(C.orange)]] : []),
      [cap(this.label(o.lead)), S(C.orange, { bold: true })], [' · ', S(C.dim)], ['lead', S(C.orange, { bold: true })],
    ];
    const n = run?.tasks.length || 0;
    const phaseText = {
      idle: [['waiting for a task', S(C.text)]],
      planning: [['reads the repo · plans the work', S(C.white)]],
      running: [[`delegated ${n} task${n === 1 ? '' : 's'} · round ${run?.round}`, S(C.white)]],
      reviewing: [[`delegated ${n} tasks · reviewing`, S(C.white)]],
      done: [['✓ done', S(C.green, { bold: true })], [` · ${n} tasks · ${run?.rounds.length} round(s)`, S(C.text)]],
      failed: [['✗ failed', S(C.red, { bold: true })], [` · ${run?.error || ''}`, S(C.text)]],
      aborted: [['⊘ aborted', S(C.red, { bold: true })]],
    }[phase];
    const k = EFFORT[o.effort] || 3;
    const effort = [['effort ', S(C.dim)], ['▮'.repeat(k), S(C.orange)], ['▮'.repeat(5 - k), S(C.faint)], [` ${o.effort}`, S(C.orange)]];
    const foot = active && lead?.activity
      ? activitySegs(lead)
      : [['--model ', S(C.dim)], [o.lead, S(C.text)]];
    const lines = h <= 3 ? [[...title, [' · ', S(C.dim)], ...phaseText]] : compact ? [title, phaseText] : [title, phaseText, effort, foot];
    lines.slice(0, h - 2).forEach((l, i) => cv.center(ix, y + 1 + i, iw, l));
  }

  drawReview(cv, x, y, w, h, compact) {
    const run = this.run;
    const phase = run?.phase || 'idle';
    const active = phase === 'reviewing';
    const lastReview = run?.rounds.filter((r) => r.review).at(-1)?.review;
    const color = phase === 'done' ? C.green : phase === 'failed' || phase === 'aborted' ? C.red : active ? C.orange : C.faint;
    cv.box(x, y, w, h, S(color), 'single');
    const iw = w - 4, ix = x + 2;
    const title = [['back to ', S(C.white, { bold: true })], [`${cap(this.label(this.opts.lead))} · lead`, S(C.orange, { bold: true })]];
    let status;
    if (active) {
      status = [[`${SPIN[this.tick % 4]} `, S(C.orange)], ...activitySegs(run.leadAgents.at(-1)?.state, 'reviewing')];
    } else if (phase === 'done') status = [['✓ ', S(C.green)], [run.verdict || 'done', S(C.green)]];
    else if (lastReview && !lastReview.done) status = [['→ ', S(C.orange)], [`${lastReview.followups?.length || 0} follow-ups · ${lastReview.verdict}`, S(C.orange)]];
    else if (phase === 'failed' || phase === 'aborted') status = [[phase, S(C.red)]];
    else status = [['waiting for the swarm', S(C.dim)]];
    const lines = h <= 3 ? [[...title, ['  ', ''], ...status]] : compact ? [title, status] : [title, [['review + verify', S(C.text)]], status];
    lines.slice(0, h - 2).forEach((l, i) => cv.center(ix, y + 1 + i, iw, l));
  }

  taskView(t) {
    const st = t.agent?.state;
    const escRunning = this.run.escalations.some((e) => e.taskId === t.id && e.agent && !isTerminal(e.agent.state.status));
    const status = t.status === 'running' && escRunning ? 'escalated' : t.status;
    const color = {
      queued: C.faint, running: t.strong ? C.purple : C.blue, escalated: C.purple,
      done: C.green, failed: C.red, skipped: C.dim, cancelled: C.dim,
    }[status] || C.text;
    let pct = 0;
    if (t.status === 'done') pct = 100;
    else if (st) pct = Math.round(95 * (1 - Math.exp(-(st.turns || 0) / 10)));
    return { st, status, color, pct };
  }

  drawWorker(cv, x, y, w, h, t, selected, compact) {
    const { st, status, color, pct } = this.taskView(t);
    const kind = selected ? 'heavy' : status === 'queued' ? 'dashed' : 'single';
    cv.box(x, y, w, h, S(color, { bold: selected }), kind);
    const iw = w - 4, ix = x + 2;
    const title = [[t.id, S(C.dim)], [' ', ''], [t.title, S(C.white, { bold: true })]];
    const mid = st?.model || (t.strong ? this.opts.escalate : this.opts.worker);
    const model = [[cap(st?.model ? modelLabel(mid) : this.label(mid)), S(famColor(mid))]];
    const barW = Math.max(4, iw - 6);
    const f = Math.round((barW * pct) / 100);
    const barColor = status === 'failed' ? C.red : status === 'done' ? C.green : status === 'escalated' ? C.purple : color;
    const bar = [['█'.repeat(f), S(barColor)], ['░'.repeat(barW - f), S(C.faint)], [`${String(pct).padStart(4)}%`, S(C.text)]];
    const deps = t.deps.length ? `after ${t.deps.join(', ')}` : 'waiting';
    const activity = status === 'queued' || t.note ? [[status === 'queued' ? deps : t.note, S(C.dim)]] : activitySegs(st);
    const spin = SPIN[this.tick % 4];
    const cost = st?.cost ? ` · $${st.cost.toFixed(3)}` : '';
    const statusLine = {
      queued: [['· queued', S(C.dim)]],
      running: [[`${spin} running`, S(color)], [` · ${st?.tools || 0} tools`, S(C.dim)]],
      escalated: [[`${spin} ⇡ ${this.label(this.opts.escalate)}`, S(C.purple, { bold: true })]],
      done: [['✓ done', S(C.green)], [st ? ` · ${fmtTime(st.endedAt - st.startedAt)}${cost}` : '', S(C.dim)]],
      failed: [['✗ failed', S(C.red, { bold: true })], [cost, S(C.dim)]],
      skipped: [['⊘ skipped', S(C.dim)]],
      cancelled: [['⊘ cancelled', S(C.dim)]],
    }[status];
    const lines = compact ? [title, bar, statusLine] : [title, model, bar, activity, statusLine];
    lines.forEach((l, i) => cv.center(ix, y + 1 + i, iw, l));
    if (selected) cv.bg(x + 1, y + 1, w - 2, C.hlbg);
  }

  drawEsc(cv, x, y, w, h, e, selected, compact) {
    const st = e.agent?.state;
    const status = st?.status || 'queued';
    const color = status === 'failed' ? C.red : C.purple;
    cv.box(x, y, w, h, S(color, { bold: selected }), selected ? 'heavy' : status === 'running' ? 'single' : 'dashed',
      [[`⇡ ${e.id}`, S(C.purple, { bold: true })]]);
    const iw = w - 4, ix = x + 2;
    const title = [[e.mode, S(C.purple, { bold: true })], [' · from ', S(C.dim)], [e.taskId, S(C.white)]];
    const q = [[e.question, S(C.text)]];
    const model = [[cap(modelLabel(st?.model || this.opts.escalate)), S(C.purple)]];
    const act = activitySegs(st, 'thinking');
    const stl = status === 'running'
      ? [[`${SPIN[this.tick % 4]} `, S(C.purple)], ...act]
      : status === 'done'
        ? [['✓ answered', S(C.green)], [` · $${st.cost.toFixed(3)}`, S(C.dim)]]
        : [[status, S(C.red)]];
    const lines = compact ? [title, stl] : [title, model, q, stl];
    lines.slice(0, h - 2).forEach((l, i) => cv.center(ix, y + 1 + i, iw, l));
    if (selected) cv.bg(x + 1, y + 1, w - 2, C.hlbg);
  }

  // ── sidebar ───────────────────────────────────────────────────────────
  drawSidebar(cv, x, y, w, h) {
    const run = this.run;
    const o = this.opts;
    cv.box(x, y, w, h, S(C.orange), 'single');
    const iw = w - 4, ix = x + 2;
    cv.center(ix, y + 1, iw, [[this.label(o.lead).toUpperCase(), S(C.orange, { bold: true })]]);
    cv.center(ix, y + 2, iw, [['lead', S(C.orange)], [' · ', S(C.dim)], ['orchestrator', S(C.text)]]);

    const rows = []; // { segs, hl }
    const head = (mark, text, color, active) =>
      rows.push({ segs: [[`${active ? '◆' : mark} `, S(active ? C.white : color)], [text, S(active ? C.white : color, { bold: active })]], hl: active });
    const kids = (list) =>
      list.forEach((segs, i) => rows.push({ segs: [[i === list.length - 1 ? '└ ' : '├ ', S(C.faint)], ...segs] }));
    const gap = () => rows.push({ segs: [['│', S(C.faint)]] });
    const wrapK = (text, color, max = 3, ind = 2) =>
      wrap(text, iw - ind).slice(0, max).map((l) => [[l, S(color)]]);

    if (!run) {
      head('◇', 'idle', C.text, true);
      kids([[['type a task below', S(C.dim)]], [['enter to start', S(C.dim)]]]);
      gap();
      head('◇', 'models', C.text, false);
      kids([
        [['lead   ', S(C.dim)], [o.lead, S(famColor(o.lead))]],
        [['worker ', S(C.dim)], [o.worker, S(famColor(o.worker))]],
        [['escal. ', S(C.dim)], [o.escalate, S(famColor(o.escalate))]],
      ]);
      gap();
      head('◇', 'limits', C.text, false);
      kids([
        [[`${o.concurrency} parallel`, S(C.text)]],
        [[`${o.rounds} rounds max`, S(C.text)]],
        [[o.budget ? `$${o.budget} budget` : 'no budget cap', S(C.text)]],
        [[o.yolo ? 'bypass permissions' : o.permissionMode, S(o.yolo ? C.red : C.text)]],
      ]);
    } else {
      head('◇', run.turn > 1 ? `goal · turn ${run.turn}` : 'goal', C.text, false);
      kids(wrapK(run.goal, C.white, 4));
      gap();
      const planning = run.phase === 'planning';
      head('◇', 'plan', C.text, planning);
      if (run.plan) {
        const waves = this.waves(run.tasks.filter((t) => t.round === 1));
        kids([
          [[`${run.rounds[0]?.ids.length || 0} tasks`, S(C.white)], [` · ${waves} wave${waves === 1 ? '' : 's'}`, S(C.dim)]],
          ...wrapK(run.plan.summary, C.dim, 3),
        ]);
      } else if (planning) kids([[[`${SPIN[this.tick % 4]} `, S(C.orange)], ...activitySegs(run.leadAgents.at(-1)?.state, 'planning')]]);
      for (const r of run.rounds) {
        gap();
        const ts = run.tasks.filter((t) => t.round === r.n);
        const cnt = (s) => ts.filter((t) => t.status === s).length;
        const esc = run.escalations.filter((e) => ts.some((t) => t.id === e.taskId)).length;
        const active = run.phase === 'running' && run.round === r.n;
        head('◇', `round ${r.n}`, C.text, active);
        const k = [[[`${cnt('done')}/${ts.length} done`, S(C.green)]]];
        if (cnt('running')) k.push([[`${cnt('running')} running`, S(C.blue)]]);
        if (esc) k.push([[`${esc} escalated`, S(C.purple)]]);
        if (cnt('failed')) k.push([[`${cnt('failed')} failed`, S(C.red)]]);
        if (cnt('skipped')) k.push([[`${cnt('skipped')} skipped`, S(C.dim)]]);
        kids(k);
        if (r.review || (run.phase === 'reviewing' && run.round === r.n)) {
          gap();
          head('◇', `review ${r.n}`, C.text, !r.review);
          if (r.review)
            kids([
              ...wrapK(r.review.verdict, r.review.done ? C.green : C.orange, 2),
              ...(r.review.done ? [] : [[[`→ ${r.review.followups?.length || 0} follow-ups`, S(C.orange)]]]),
            ]);
          else kids([[[`${SPIN[this.tick % 4]} `, S(C.orange)], ...activitySegs(run.leadAgents.at(-1)?.state, 'verifying')]]);
        }
      }
      if (['done', 'failed', 'aborted'].includes(run.phase)) {
        gap();
        const ok = run.phase === 'done';
        head(ok ? '✓' : '✗', run.phase, ok ? C.green : C.red, false);
      }
    }

    // stats pinned to the bottom
    const agents = this.orch?.agents || [];
    const sum = (k) => agents.reduce((n, a) => n + (a.state[k] || 0), 0);
    const elapsed = run ? (run.endedAt || Date.now()) - run.startedAt : 0;
    const stats = [
      ['calls', String(sum('turns'))],
      ['tokens read', fmtTok(sum('tokensIn'))],
      ['cost', `$${(this.orch?.cost || 0).toFixed(3)}`],
      ['elapsed', fmtTime(elapsed)],
    ];
    const statsY = y + h - 1 - stats.length;
    const avail = statsY - 1 - (y + 4);
    const visible = rows.slice(Math.max(0, rows.length - avail));
    visible.forEach((r, i) => {
      cv.segs(ix, y + 4 + i, r.segs, iw);
      if (r.hl) cv.bg(x + 1, y + 4 + i, w - 2, C.hlbg);
    });
    stats.forEach(([k, v], i) => {
      cv.put(ix, statsY + i, k, S(C.dim));
      cv.right(ix, statsY + i, iw, [[v, S(i === 2 ? C.green : C.white, { bold: true })]]);
    });
  }

  waves(tasks) {
    const depth = {};
    const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const d = (t, seen = new Set()) => {
      if (depth[t.id] != null) return depth[t.id];
      if (seen.has(t.id)) return 1;
      seen.add(t.id);
      const ds = t.deps.map((x) => by[x]).filter(Boolean);
      return (depth[t.id] = ds.length ? 1 + Math.max(...ds.map((x) => d(x, seen))) : 1);
    };
    return tasks.length ? Math.max(...tasks.map((t) => d(t))) : 0;
  }

  // ── log / prompt / status ─────────────────────────────────────────────
  drawLog(cv, x, y, w, h) {
    cv.box(x, y, w, h, S(C.faint), 'single', [['session log', S(C.text)]]);
    const log = this.run?.log || [];
    const lines = log.slice(-(h - 2));
    lines.forEach((e, i) => {
      cv.segs(x + 2, y + 1 + i, [
        [hhmmss(e.t), S(C.faint)], ['  ', ''],
        [e.who.slice(0, 11).padEnd(12), S(colorOf(e.color), { bold: true })],
        [e.msg, S(C.text)],
      ], w - 4);
    });
    if (!log.length) cv.segs(x + 2, y + 1, [['no activity yet', S(C.dim)]], w - 4);
  }

  drawPrompt(cv, x, y, w) {
    cv.box(x, y, w, 3, S(C.faint));
    const run = this.run;
    const cursor = this.tick % 6 < 4 ? '█' : ' ';
    const pre = [[this.opts.cwd.replace(os.homedir(), '~'), S(C.blue)], [' $ ', S(C.white)]];
    let segs;
    if (this.running() && !this.cmd) {
      segs = [...pre, ['relay ', S(C.white)], [`"${run.goal}"`, S(C.text)], [' ', ''], [cursor, S(C.green)]];
      if (this.flash) segs.splice(2, 0, [`[${this.flash}] `, S(C.dim)]);
    } else {
      const avail = w - 4 - segLen(pre) - 2;
      const shown = [...this.input].slice(-avail).join('');
      segs = [...pre, [shown, S(C.white)], [cursor, S(C.green)]];
      if (!this.input) segs.push([` ${this.flash || (run ? 'type a follow-up and press enter' : 'describe a task and press enter')}`, S(C.dim)]);
      else if (this.cmd) segs.push([' enter runs · esc cancels', S(C.dim)]);
    }
    cv.segs(x + 2, y + 1, segs, w - 4);
  }

  drawStatus(cv, W, y) {
    const run = this.run;
    const o = this.opts;
    const phase = run?.phase || 'idle';
    const tasks = run?.tasks || [];
    const running = tasks.filter((t) => t.status === 'running').length;
    const escLive = (run?.escalations || []).some((e) => e.agent && !isTerminal(e.agent.state.status));
    const leadState = { idle: 'idle', planning: 'planning', running: 'delegating', reviewing: 'reviewing', done: 'done', failed: 'failed', aborted: 'aborted' }[phase];
    const workerState = running ? 'swarming' : phase === 'done' ? 'done' : 'idle';
    const item = (name, val, color) => [[name, S(C.text)], [' [', S(C.dim)], [val, S(color, { bold: true })], [']   ', S(C.dim)]];
    const segs = [
      ...item(family(this.label(o.lead)), leadState, C.orange),
      ...item(family(this.label(o.worker)), workerState, famColor(o.worker)),
      ...item('subagents', `${running}/${tasks.length}`, C.blue),
      ...item(family(this.label(o.escalate)), escLive ? 'advising' : 'on call', C.purple),
      ...item('cost', `$${(this.orch?.cost || 0).toFixed(2)}`, C.green),
    ];
    cv.segs(2, y, segs, W - 4);
    const sess = this.orch?.session?.id;
    const keys = (sess ? `${sess} · ` : '') + (this.running()
      ? `⇥ select  ⏎ open  ${sess ? 'd detach  ' : ''}q abort`
      : `⇥ select  ⏎ open/run  ${sess ? '^D detach  ^C end' : '^C quit'}`);
    if (segLen(segs) + keys.length + 6 < W) cv.right(0, y, W - 2, [[keys, S(C.dim)]]);
  }

  // ── transcript view ───────────────────────────────────────────────────
  drawDetail(cv, W, H) {
    const it = this.selected();
    const run = this.run;
    let agents = [];
    let name = '';
    if (it.kind === 'lead') {
      agents = run.leadAgents;
      name = `${this.label(this.opts.lead)} · lead`;
    } else if (it.kind === 'task') {
      agents = it.t.agent ? [it.t.agent] : [];
      name = `${it.t.id} · ${it.t.title}`;
    } else {
      agents = it.e.agent ? [it.e.agent] : [];
      name = `${it.e.id} · ${it.e.mode} from ${it.e.taskId}`;
    }
    const iw = W - 4;
    const timeline = this.view === 'timeline';
    const rows = timeline ? this.timelineRows(agents, iw) : [];
    const add = (text, color, prefix = '', max = Infinity) => {
      const ls = wrap(text, iw - prefix.length);
      ls.slice(0, max).forEach((l, i) => rows.push([[i ? ' '.repeat(prefix.length) : prefix, S(color)], [l, S(color)]]));
      if (ls.length > max) rows.push([[' '.repeat(prefix.length) + `… ${ls.length - max} more lines`, S(C.faint)]]);
    };
    if (!timeline && it.kind === 'task' && !it.t.agent) add(it.t.prompt, C.text, '▌ ');
    for (const a of timeline ? [] : agents) {
      const s = a.state;
      rows.push([[`━━ ${s.id}`, S(C.orange, { bold: true })], [` · ${modelLabel(s.model)} · ${s.status}`, S(C.dim)]]);
      for (const e of s.transcript) {
        if (e.kind === 'prompt') add(e.text, C.dim, '▌ ', 40);
        else if (e.kind === 'text') add(e.text, C.white);
        else if (e.kind === 'tool') add(e.text, toolColor(e.name), '→ ', 6);
        else if (e.kind === 'result') add(e.text, C.dim, '  ↳ ', 4);
        else if (e.kind === 'error') add(e.text, C.red, '  ✗ ', 6);
        else if (e.kind === 'final') {
          rows.push([['── result', S(C.green, { bold: true })]]);
          add(e.text, C.white);
        }
      }
      rows.push([['', '']]);
    }
    if (!timeline && it.kind === 'lead' && run.summary) {
      rows.push([['━━ final summary', S(C.green, { bold: true })], [run.verdict ? ` · ${run.verdict}` : '', S(C.dim)]]);
      add(run.summary, C.white);
    }

    const st = agents.at(-1)?.state;
    const sum = (k) => agents.reduce((n, a) => n + (a.state[k] || 0), 0);
    cv.segs(2, 0, [
      [name, S(C.white, { bold: true })], [' · ', S(C.dim)],
      [cap(modelLabel(st?.model || '')), S(famColor(st?.model || ''))], [' · ', S(C.dim)],
      [st?.status || 'queued', S(st?.status === 'done' ? C.green : st?.status === 'failed' ? C.red : C.blue)],
      [`  turns ${sum('turns')} · tools ${sum('tools')} · tokens ${fmtTok(sum('tokensIn'))} · $${sum('cost').toFixed(3)}`, S(C.dim)],
    ], W - 4);
    // view tabs, right-aligned on the header line
    cv.right(0, 0, W - 2, [
      [' transcript ', timeline ? S(C.dim) : S(C.white, { bold: true, bg: C.hlbg })], [' ', ''],
      [' timeline ', timeline ? S(C.white, { bold: true, bg: C.hlbg }) : S(C.dim)],
    ]);
    cv.hline(1, 1, W - 2, '─', S(C.faint));
    const viewH = H - 4;
    const maxScroll = Math.max(0, rows.length - viewH);
    this.scroll = Math.min(this.scroll, maxScroll);
    const start = Math.max(0, rows.length - viewH - this.scroll);
    rows.slice(start, start + viewH).forEach((r, i) => cv.segs(2, 2 + i, r, iw));
    cv.hline(1, H - 2, W - 2, '─', S(C.faint));
    cv.segs(2, H - 1, [
      [`t ${timeline ? 'transcript' : 'timeline'} · ↑↓ scroll · PgUp/PgDn · g/G top/bottom · esc back`, S(C.dim)],
      [this.scroll ? `   ${this.scroll} lines up` : '   following', S(C.faint)],
    ], W - 4);
  }

  // Gantt-style tool timeline: one row per call, bars placed on the agent's own clock.
  timelineRows(agents, iw) {
    const rows = [];
    const now = Date.now();
    const spin = SPIN[this.tick % 4];
    for (const a of agents) {
      const s = a.state;
      const calls = toolCalls(s.transcript);
      const t0 = s.startedAt || calls[0]?.start || now;
      const t1 = s.endedAt || now;
      const span = Math.max(1, t1 - t0);
      const dur = (c) => (c.end ?? now) - c.start;
      const busy = calls.reduce((n, c) => n + dur(c), 0);
      const errors = calls.filter((c) => c.ok === false).length;

      rows.push([
        [`━━ ${s.id}`, S(C.orange, { bold: true })],
        [` · ${modelLabel(s.model)} · ${s.status} · ${calls.length} call${calls.length === 1 ? '' : 's'} · ${fmtDur(busy)} in tools · ${fmtDur(span)} total`, S(C.dim)],
        ...(errors ? [[` · ${errors} failed`, S(C.red, { bold: true })]] : []),
      ]);
      if (!calls.length) {
        rows.push([['  no tool calls yet', S(C.dim)]], [['', '']]);
        continue;
      }

      // per-tool totals, slowest first
      const by = new Map();
      for (const c of calls) {
        const key = c.mcp ? `${c.mcp.server} · ${c.mcp.tool}` : c.name;
        const g = by.get(key) || { key, name: c.name, n: 0, ms: 0, fail: 0 };
        g.n++;
        g.ms += dur(c);
        if (c.ok === false) g.fail++;
        by.set(key, g);
      }
      const groups = [...by.values()].sort((x, y) => y.ms - x.ms);
      const summary = [['  ', '']];
      groups.slice(0, 6).forEach((g, i) => {
        if (i) summary.push(['  ', '']);
        summary.push([g.key, S(toolColor(g.name))], [` ×${g.n} ${fmtDur(g.ms)}`, S(C.dim)]);
        if (g.fail) summary.push([` ✗${g.fail}`, S(C.red)]);
      });
      if (groups.length > 6) summary.push([`  +${groups.length - 6} more`, S(C.faint)]);
      rows.push(summary);

      // columns: offset | bar | label | duration + mark
      const offW = 8;
      const barW = Math.max(12, Math.min(60, Math.floor(iw * 0.38)));
      const durW = 9;
      const labelW = Math.max(10, iw - offW - barW - durW - 6);
      const axis = '├' + '─'.repeat(Math.max(0, barW - 2)) + '┤';
      rows.push([
        [' '.repeat(offW), ''], [axis, S(C.faint)], ['  ', ''],
        ['0s', S(C.faint)], [` → ${fmtDur(span)}${s.endedAt ? '' : ' (live)'}`, S(C.faint)],
      ]);
      for (const c of calls) {
        const sx = Math.min(barW - 1, Math.floor(((c.start - t0) / span) * barW));
        const ex = Math.min(barW, Math.max(sx + 1, Math.ceil((((c.end ?? now) - t0) / span) * barW)));
        const running = c.end == null;
        const color = c.ok === false ? C.red : toolColor(c.name);
        let label = clean(c.label);
        if ([...label].length > labelW) label = [...label].slice(0, labelW - 1).join('') + '…';
        const mark = running ? [spin, S(color)] : c.ok ? ['✓', S(C.green)] : ['✗', S(C.red, { bold: true })];
        rows.push([
          [`+${fmtDur(Math.max(0, c.start - t0))}`.padStart(offW - 1) + ' ', S(C.faint)],
          [' '.repeat(sx), ''],
          [(running ? '▒' : '█').repeat(ex - sx), S(color)],
          [' '.repeat(barW - ex), ''],
          ['  ', ''],
          [label.padEnd(labelW), S(c.mcp ? serverColor(c.mcp.server) : c.ok === false ? C.red : C.text)],
          [(running ? 'running' : fmtDur(dur(c))).padStart(durW - 2) + ' ', S(C.dim)],
          mark,
        ]);
      }
      rows.push([['', '']]);
    }
    if (!agents.length) rows.push([['  not started yet', S(C.dim)]]);
    return rows;
  }
}
