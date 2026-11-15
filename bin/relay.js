#!/usr/bin/env node
// relay — Opus leads, Haiku swarms, Opus on call.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.js';
import { TUI } from '../src/tui.js';
import { CLAUDE_BIN } from '../src/agent.js';

const HELP = `relay — multi-agent harness for the claude CLI

usage: relay [options] [task...]
       relay                      (interactive: type tasks in the TUI)
       echo "task" | relay --plain

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

misc
  -C, --cwd <dir>          project directory             (default: .)
  --out <dir>              where run reports go          (default: <cwd>/.relay/runs)
  --plain                  no TUI, print the log (default when stdout is not a TTY)
  --mock                   simulated agents: try the TUI without spending tokens
  --keep-sessions          persist agent sessions (resumable with claude --resume)
  -h, --help

keys
  tab / arrows   select lead, worker or escalation
  enter          start the typed task, or open the selected transcript
  q              abort the current run      ctrl-c   abort, then quit
`;

function parse(argv) {
  const o = {
    lead: 'opus', worker: 'haiku', escalate: 'opus', effort: 'high',
    concurrency: 4, rounds: 3, maxTasks: 8, maxEscalations: 6, budget: 0,
    permissionMode: 'acceptEdits', allow: [], yolo: false, inheritMcp: false,
    cwd: process.cwd(), outDir: '', plain: !process.stdout.isTTY, mock: false, keepSessions: false,
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
      case '-C': case '--cwd': o.cwd = path.resolve(val()); break;
      case '--out': o.outDir = path.resolve(val()); break;
      case '--plain': o.plain = true; break;
      case '--mock': o.mock = true; break;
      case '--keep-sessions': o.keepSessions = true; break;
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

const { o, goal: argGoal } = parse(process.argv.slice(2));

if (!o.mock) {
  const v = spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) die(`cannot run "${CLAUDE_BIN}" (set RELAY_CLAUDE_BIN or use --mock)`);
}

const orchs = new Set();
const killAll = () => {
  for (const x of orchs) x.abort();
};
process.on('SIGTERM', () => {
  killAll();
  process.exit(143);
});
process.on('exit', killAll);

const newOrch = () => {
  const orch = new Orchestrator(o);
  orchs.add(orch);
  return orch;
};

if (o.plain) {
  const goal = argGoal || (!process.stdin.isTTY ? await readStdin() : '');
  if (!goal) die('no task given (pass it as an argument or on stdin)');
  const orch = newOrch();
  const color = { orange: 33, blue: 34, purple: 35, green: 32, red: 31, dim: 90 };
  orch.on('log', (e) => {
    const t = new Date(e.t).toTimeString().slice(0, 8);
    process.stdout.write(`\x1b[90m${t}\x1b[0m  \x1b[${color[e.color] || 0};1m${e.who.padEnd(12)}\x1b[0m ${e.msg}\n`);
  });
  process.on('SIGINT', () => orch.abort());
  const run = await orch.start(goal);
  printSummary(orch);
  process.exit(run.phase === 'done' ? 0 : 1);
} else {
  if (!process.stdin.isTTY) die('the TUI needs an interactive terminal (use --plain)');
  let current = null;
  let quitting = false;
  const tui = new TUI({
    opts: o,
    startRun: (goal) => {
      current = newOrch();
      current.start(goal);
      return current;
    },
    onQuit: () => {
      if (quitting) return;
      quitting = true;
      current?.abort();
      tui.close();
      printSummary(current);
      setTimeout(() => process.exit(0), 50);
    },
  });
  tui.open();
  if (argGoal) tui.attach(tui.startRun(argGoal));
}
