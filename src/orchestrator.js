// Plan (lead) -> parallel workers (with escalation) -> review (lead) -> repeat.

import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, isTerminal, modelLabel } from './agent.js';
import { MockAgent } from './mock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.join(HERE, 'escalate-mcp.js');
const READ_ONLY = ['Read', 'Grep', 'Glob'];

const TASK_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'short id, e.g. t1' },
    title: { type: 'string', description: '2-4 words, max 24 chars, lowercase' },
    prompt: {
      type: 'string',
      description: 'Complete, self-contained instructions: files, the change or answer expected, acceptance criteria.',
    },
    depends_on: { type: 'array', items: { type: 'string' } },
    model: { type: 'string', enum: ['fast', 'strong'], description: 'fast (default) or strong for hard tasks' },
  },
  required: ['id', 'title', 'prompt'],
};

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'one line: the approach' },
    tasks: { type: 'array', minItems: 1, items: TASK_ITEM },
  },
  required: ['summary', 'tasks'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    verdict: { type: 'string', description: 'max 60 chars' },
    summary: { type: 'string', description: 'final markdown report / answer for the user' },
    followups: { type: 'array', items: TASK_ITEM },
  },
  required: ['done', 'verdict', 'summary'],
};

const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s;
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export class Orchestrator extends EventEmitter {
  /**
   * opts: { cwd, lead, worker, escalate, effort, concurrency, rounds, maxTasks,
   *         maxEscalations, budget, permissionMode, allow[], yolo, inheritMcp,
   *         keepSessions, mock, outDir }
   */
  constructor(opts) {
    super();
    this.o = opts;
    this.agents = [];
    this.aborted = false;
    this.run = {
      goal: '',
      phase: 'idle',
      round: 0,
      plan: null,
      rounds: [],
      leadAgents: [],
      tasks: [],
      escalations: [],
      log: [],
      verdict: '',
      summary: '',
      startedAt: 0,
      endedAt: 0,
      reportPath: '',
      error: '',
    };
  }

  // ── bookkeeping ────────────────────────────────────────────────────────
  changed() {
    this.emit('change');
  }

  log(who, color, msg) {
    const e = { t: Date.now(), who, color, msg: String(msg).replace(/\s+/g, ' ').trim() };
    this.run.log.push(e);
    if (this.run.log.length > 500) this.run.log.shift();
    this.emit('log', e);
    this.changed();
  }

  get cost() {
    return this.agents.reduce((n, a) => n + (a.state.cost || 0), 0);
  }

  budgetLeft() {
    return this.o.budget ? this.o.budget - this.cost : Infinity;
  }

  label(alias) {
    const live = this.agents.find((a) => a.o.model === alias && a.state.model !== alias);
    return live ? modelLabel(live.state.model) : alias;
  }

  makeAgent(o) {
    const base = {
      cwd: this.o.cwd,
      keepSessions: this.o.keepSessions,
      logFile: this.runDir ? path.join(this.runDir, 'agents', `${o.id}.jsonl`) : null,
      goal: this.run.goal,
      round: this.run.round,
    };
    const left = this.budgetLeft();
    if (Number.isFinite(left)) base.budget = Math.max(0.01, left);
    const a = this.o.mock ? new MockAgent({ ...base, ...o }) : new Agent({ ...base, ...o });
    a.on('change', () => this.changed());
    this.agents.push(a);
    return a;
  }

  workerPerms() {
    if (this.o.yolo) return { permissionMode: 'bypassPermissions', allowedTools: [] };
    return {
      permissionMode: this.o.permissionMode || 'acceptEdits',
      allowedTools: [...READ_ONLY, 'mcp__relay__escalate_to_opus', ...(this.o.allow || [])],
    };
  }

  // ── escalation socket ─────────────────────────────────────────────────
  async openSocket() {
    if (this.o.mock) return;
    this.sockPath = path.join(os.tmpdir(), `relay-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
    this.server = net.createServer((sock) => {
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
          if (m.type !== 'escalate') continue;
          this.escalate(m.worker, m).then((r) => {
            if (!sock.destroyed) sock.write(JSON.stringify({ reqId: m.reqId, ...r }) + '\n');
          });
        }
      });
    });
    await new Promise((res, rej) => this.server.listen(this.sockPath, res).on('error', rej));
  }

  closeSocket() {
    this.server?.close();
    if (this.sockPath) fs.rmSync(this.sockPath, { force: true });
  }

  async escalate(workerId, { question, context, mode }) {
    const run = this.run;
    const task = run.tasks.find((t) => t.id === workerId);
    if (this.aborted) return { text: 'run aborted', isError: true };
    if (run.escalations.length >= this.o.maxEscalations)
      return { text: 'Escalation limit reached for this run. Proceed with your best judgement and note the uncertainty in your report.', isError: true };
    if (this.budgetLeft() <= 0) return { text: 'Budget exhausted; proceed on your own.', isError: true };

    const id = `e${run.escalations.length + 1}`;
    const esc = { id, taskId: workerId, question, mode, agent: null };
    const advise = mode !== 'delegate';
    const prompt = [
      `A ${this.label(this.o.worker)} worker in a multi-agent run escalated a problem to you (${mode}).`,
      `Overall goal of the run: ${run.goal}`,
      task ? `The worker's task (${task.id} · ${task.title}):\n${task.prompt}` : '',
      `QUESTION:\n${question}`,
      context ? `CONTEXT FROM THE WORKER:\n${context}` : '',
      advise
        ? 'Investigate as needed with read-only tools, then answer with concrete, directly applicable guidance (exact files, code, commands). The worker will apply it. Be concise.'
        : 'Carry out this piece of work yourself in the repository, verify it, then report exactly what you changed so the worker can continue.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const perms = this.workerPerms();
    esc.agent = this.makeAgent({
      id,
      role: 'escalation',
      title: `${mode} · ${workerId}`,
      model: this.o.escalate,
      prompt,
      effort: this.o.effort,
      tools: advise ? READ_ONLY : undefined,
      permissionMode: advise ? undefined : perms.permissionMode,
      allowedTools: advise ? READ_ONLY : perms.allowedTools.filter((t) => !t.startsWith('mcp__relay')),
      strictMcp: !this.o.inheritMcp,
    });
    if (task) task.escalations.push(id);
    run.escalations.push(esc);
    this.log(this.label(this.o.escalate), 'purple', `${workerId} escalated (${mode}) · ${question}`);
    const st = await esc.agent.run();
    if (st.status === 'done') {
      this.log(this.label(this.o.escalate), 'purple', `${id} answered ${workerId} · $${st.cost.toFixed(3)}`);
      return { text: st.result || '(no answer)', isError: false };
    }
    this.log(this.label(this.o.escalate), 'red', `${id} ${st.status}: ${st.error}`);
    return { text: `Escalation failed (${st.error || st.status}). Proceed with your best judgement.`, isError: true };
  }

  // ── lead ──────────────────────────────────────────────────────────────
  async lead(kind, prompt, schema) {
    const n = this.run.leadAgents.length + 1;
    const a = this.makeAgent({
      id: `lead-${kind}-${n}`,
      role: 'lead',
      kind,
      title: kind,
      model: this.o.lead,
      prompt,
      schema,
      effort: this.o.effort,
      tools: kind === 'review' && (this.o.yolo || (this.o.allow || []).some((r) => r.startsWith('Bash')))
        ? [...READ_ONLY, 'Bash']
        : READ_ONLY,
      allowedTools: kind === 'review' ? [...READ_ONLY, ...(this.o.allow || [])] : READ_ONLY,
      permissionMode: kind === 'review' && this.o.yolo ? 'bypassPermissions' : undefined,
      strictMcp: !this.o.inheritMcp,
      round: this.run.round,
    });
    this.run.leadAgents.push(a);
    const st = await a.run();
    if (st.status !== 'done') throw new Error(`lead ${kind} ${st.status}: ${st.error}`);
    let out = st.structured;
    if (!out && st.result) {
      try {
        out = JSON.parse(st.result.match(/\{[\s\S]*\}/)?.[0] || '');
      } catch {}
    }
    if (!out) throw new Error(`lead ${kind} returned no structured output`);
    return out;
  }

  planPrompt() {
    const o = this.o;
    return [
      `You are the lead orchestrator (${this.label(o.lead)}) of a multi-agent coding harness.`,
      `You plan. Cheaper ${o.worker} workers execute tasks in parallel (up to ${o.concurrency} at once). ` +
        `Workers can escalate hard sub-problems to ${o.escalate} themselves.`,
      `Working directory: ${o.cwd}`,
      `GOAL:\n${this.run.goal}`,
      [
        'Investigate the repository as much as you need to (read-only tools) to plan well, then return the plan as structured output.',
        `- Split the goal into 1-${o.maxTasks} self-contained tasks. A fast, literal model executes each from its prompt alone: give concrete file paths, the exact change or answer expected, and how to check it.`,
        '- Tasks run in parallel unless depends_on says otherwise. Never let two parallel tasks edit the same file: chain them with depends_on.',
        '- Do not over-split. A small goal is one task. A question can be answered by one or a few investigation tasks.',
        '- model "strong" only for a task that genuinely needs deep reasoning; otherwise "fast".',
        '- ids: t1, t2, ...  titles: 2-4 lowercase words.',
      ].join('\n'),
    ].join('\n\n');
  }

  reviewPrompt(round) {
    const run = this.run;
    const last = round >= this.o.rounds;
    const results = run.tasks
      .map((t) => {
        const st = t.agent?.state;
        const report = st?.result || st?.error || t.note || '(no output)';
        return `### ${t.id} · ${t.title} [round ${t.round}] — ${t.status}${t.escalations.length ? ` (escalated ×${t.escalations.length})` : ''}\nTask: ${clip(t.prompt, 600)}\nReport:\n${clip(report, 3000)}`;
      })
      .join('\n\n');
    return [
      `You are the lead orchestrator. Round ${round} of at most ${this.o.rounds} has finished.`,
      `GOAL:\n${run.goal}`,
      `PLAN: ${run.plan?.summary || ''}`,
      `TASK RESULTS:\n\n${results}`,
      [
        'Verify the work against the goal: read the changed files, check the reports for gaps or contradictions, run checks if your tools allow. Then return structured output:',
        '- done: true when the goal is met (or cannot be improved further in this run).',
        '- verdict: one short line (max 60 chars).',
        '- summary: the final report for the user in markdown — what was done, files changed, caveats. If the goal was a question, the full answer.',
        `- followups: only when done is false — tasks for the next round, same rules as planning (self-contained, no two parallel tasks on one file). New ids, not reused ones.`,
        last ? '- This is the LAST round: done must be true; summarise what remains undone in summary.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ].join('\n\n');
  }

  // ── workers ───────────────────────────────────────────────────────────
  addTasks(list, round) {
    const ids = new Set(this.run.tasks.map((t) => t.id));
    const rename = {};
    const tasks = [];
    for (const raw of list.slice(0, this.o.maxTasks)) {
      let id = String(raw.id || `t${this.run.tasks.length + tasks.length + 1}`).replace(/[^\w.-]/g, '');
      if (ids.has(id)) {
        const nid = `${id}.r${round}`;
        rename[id] = nid;
        id = nid;
      }
      ids.add(id);
      tasks.push({
        id,
        title: String(raw.title || id).slice(0, 40),
        prompt: String(raw.prompt || ''),
        deps: (raw.depends_on || []).map(String),
        strong: raw.model === 'strong',
        round,
        status: 'queued',
        agent: null,
        escalations: [],
        note: '',
      });
    }
    for (const t of tasks) t.deps = t.deps.map((d) => rename[d] || d);
    this.run.tasks.push(...tasks);
    this.run.rounds.push({ n: round, ids: tasks.map((t) => t.id), review: null });
    return tasks;
  }

  workerPrompt(t) {
    const deps = t.deps
      .map((d) => this.run.tasks.find((x) => x.id === d))
      .filter((d) => d?.agent?.state.result)
      .map((d) => `[${d.id} · ${d.title}] reported:\n${clip(d.agent.state.result, 1500)}`);
    return [
      `Overall goal (for context only): ${this.run.goal}`,
      `YOUR TASK (${t.id} · ${t.title}):\n${t.prompt}`,
      deps.length ? `Results from tasks you depend on:\n\n${deps.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  workerSystem(t) {
    return [
      `You are worker ${t.id} in a multi-agent run led by an orchestrator. Other workers handle other tasks in parallel in the same directory.`,
      '- Do your task completely, and only your task. Do not edit files outside its scope unless it requires it.',
      `- If you hit something that needs stronger reasoning than you can reliably give (a subtle bug, a design decision, the same failure twice, real ambiguity), call the escalate_to_opus tool with a self-contained question and the relevant context. Use mode "delegate" to hand over a well-defined piece of work. Do not escalate routine work.`,
      '- Finish with a concise report: what you did, files changed, anything unresolved or uncertain. That report is all the orchestrator sees.',
    ].join('\n');
  }

  launch(t) {
    const perms = this.workerPerms();
    const model = t.strong ? this.o.escalate : this.o.worker;
    t.status = 'running';
    t.agent = this.makeAgent({
      id: t.id,
      role: 'worker',
      title: t.title,
      model,
      prompt: this.workerPrompt(t),
      systemAppend: this.workerSystem(t),
      ...perms,
      strictMcp: !this.o.inheritMcp,
      mcpConfig: this.o.mock
        ? undefined
        : {
            mcpServers: {
              relay: {
                command: process.execPath,
                args: [MCP_SERVER],
                env: { RELAY_SOCK: this.sockPath, RELAY_WORKER: t.id, RELAY_ESC_LABEL: this.o.escalate },
              },
            },
          },
      onEscalate: (req) => this.escalate(t.id, req),
    });
    this.log(t.id, t.strong ? 'purple' : 'blue', `${t.title} → ${model}`);
    return t.agent.run().then((st) => {
      t.status = st.status === 'done' ? 'done' : st.status === 'cancelled' ? 'cancelled' : 'failed';
      const color = t.status === 'done' ? 'green' : 'red';
      this.log(t.id, color, t.status === 'done'
        ? `done · ${st.turns} turns · ${st.tools} tools · $${st.cost.toFixed(3)}`
        : `${t.status}: ${st.error}`);
    });
  }

  execute(round) {
    const tasks = this.run.tasks.filter((t) => t.round === round);
    const byId = (id) => this.run.tasks.find((x) => x.id === id);
    return new Promise((resolve) => {
      let running = 0;
      const tick = () => {
        if (this.aborted) {
          for (const t of tasks) if (t.status === 'queued') t.status = 'cancelled';
          if (running === 0) resolve();
          return;
        }
        for (const t of tasks) {
          if (t.status !== 'queued') continue;
          const deps = t.deps.map(byId).filter(Boolean);
          const bad = deps.find((d) => ['failed', 'skipped', 'cancelled'].includes(d.status));
          if (bad) {
            t.status = 'skipped';
            t.note = `dependency ${bad.id} ${bad.status}`;
            this.log(t.id, 'dim', `skipped · ${t.note}`);
            continue;
          }
          if (this.budgetLeft() <= 0) {
            t.status = 'skipped';
            t.note = 'budget exhausted';
            this.log(t.id, 'red', 'skipped · budget exhausted');
            continue;
          }
          if (running >= this.o.concurrency) continue;
          if (deps.every((d) => d.status === 'done')) {
            running++;
            this.launch(t).then(() => {
              running--;
              tick();
            });
          }
        }
        if (tasks.every((t) => isTerminal(t.status))) return resolve();
        if (running === 0) {
          // nothing runnable: cyclic or unknown-but-pending deps
          for (const t of tasks)
            if (t.status === 'queued') {
              t.status = 'skipped';
              t.note = 'unsatisfiable dependencies';
              this.log(t.id, 'red', 'skipped · unsatisfiable dependencies');
            }
          resolve();
        }
        this.changed();
      };
      tick();
    });
  }

  // ── main loop ─────────────────────────────────────────────────────────
  async start(goal) {
    const run = this.run;
    run.goal = goal;
    run.startedAt = Date.now();
    this.runDir = path.join(this.o.outDir || path.join(this.o.cwd, '.relay', 'runs'), stamp());
    try {
      await this.openSocket();
      run.phase = 'planning';
      run.round = 1;
      this.log(this.label(this.o.lead), 'orange', `planning · ${goal}`);
      const plan = await this.lead('plan', this.planPrompt(), PLAN_SCHEMA);
      run.plan = plan;
      const tasks = this.addTasks(plan.tasks || [], 1);
      this.log(this.label(this.o.lead), 'orange', `plan · ${tasks.length} tasks · ${plan.summary}`);

      for (let round = 1; round <= this.o.rounds && !this.aborted; round++) {
        run.round = round;
        run.phase = 'running';
        this.changed();
        await this.execute(round);
        if (this.aborted) break;

        run.phase = 'reviewing';
        this.log(this.label(this.o.lead), 'orange', `reviewing round ${round}`);
        const rv = await this.lead('review', this.reviewPrompt(round), REVIEW_SCHEMA);
        const r = run.rounds.find((x) => x.n === round);
        if (r) r.review = rv;
        run.verdict = rv.verdict;
        run.summary = rv.summary || run.summary;
        const follow = rv.done ? [] : rv.followups || [];
        this.log('gate', rv.done ? 'green' : 'orange', `${rv.done ? 'pass' : 'more work'} · ${rv.verdict}`);
        if (rv.done || !follow.length || round >= this.o.rounds) break;
        this.addTasks(follow, round + 1);
        this.log(this.label(this.o.lead), 'orange', `round ${round + 1} · ${follow.length} follow-ups`);
      }
      run.phase = this.aborted ? 'aborted' : 'done';
    } catch (e) {
      if (this.aborted) run.phase = 'aborted';
      else {
        run.phase = 'failed';
        run.error = e.message;
        this.log('relay', 'red', e.message);
      }
    } finally {
      run.endedAt = Date.now();
      this.closeSocket();
      try {
        run.reportPath = this.writeReport();
        this.log('relay', 'dim', `receipt → ${path.relative(this.o.cwd, run.reportPath)}`);
      } catch (e) {
        this.log('relay', 'red', `report: ${e.message}`);
      }
      this.changed();
      this.emit('end', run);
    }
    return run;
  }

  abort() {
    if (this.aborted || ['idle', 'done', 'failed', 'aborted'].includes(this.run.phase)) return;
    this.aborted = true;
    this.log('relay', 'red', 'aborting · stopping all agents');
    for (const a of this.agents) if (!isTerminal(a.state.status)) a.kill();
  }

  writeReport() {
    const run = this.run;
    fs.mkdirSync(this.runDir, { recursive: true });
    const money = (n) => `$${(n || 0).toFixed(4)}`;
    const row = (a) => {
      const s = a.state;
      return `| ${s.id} | ${s.role} | ${s.model} | ${s.status} | ${s.turns} | ${s.tools} | ${s.tokensIn} | ${s.tokensOut} | ${money(s.cost)} | ${s.endedAt && s.startedAt ? ((s.endedAt - s.startedAt) / 1000).toFixed(1) + 's' : '-'} |`;
    };
    const md = [
      `# relay run · ${new Date(run.startedAt).toISOString()}`,
      `**Goal:** ${run.goal}`,
      `**Phase:** ${run.phase}${run.error ? ` — ${run.error}` : ''}  ·  **Verdict:** ${run.verdict || '-'}  ·  **Cost:** ${money(this.cost)}  ·  **Elapsed:** ${((run.endedAt - run.startedAt) / 1000).toFixed(1)}s`,
      `## Summary\n\n${run.summary || '_none_'}`,
      `## Plan\n\n${run.plan?.summary || ''}\n\n` +
        run.tasks
          .map((t) => `- **${t.id} · ${t.title}** (round ${t.round}, ${t.strong ? 'strong' : 'fast'}) — ${t.status}${t.deps.length ? ` · after ${t.deps.join(', ')}` : ''}${t.note ? ` · ${t.note}` : ''}`)
          .join('\n'),
      `## Escalations\n\n` +
        (run.escalations.map((e) => `- **${e.id}** from ${e.taskId} (${e.mode}): ${e.question}\n  - → ${clip(e.agent?.state.result || e.agent?.state.error, 800).replace(/\n/g, '\n    ')}`).join('\n') || '_none_'),
      `## Agents\n\n| id | role | model | status | turns | tools | tok in | tok out | cost | time |\n|---|---|---|---|---|---|---|---|---|---|\n${this.agents.map(row).join('\n')}`,
      `## Worker reports\n\n` + run.tasks.map((t) => `### ${t.id} · ${t.title}\n\n${t.agent?.state.result || t.agent?.state.error || t.note || '_no output_'}`).join('\n\n'),
    ].join('\n\n');
    const p = path.join(this.runDir, 'report.md');
    fs.writeFileSync(p, md + '\n');
    fs.writeFileSync(
      path.join(this.runDir, 'run.json'),
      JSON.stringify(
        {
          goal: run.goal,
          phase: run.phase,
          verdict: run.verdict,
          plan: run.plan,
          rounds: run.rounds,
          cost: this.cost,
          agents: this.agents.map((a) => ({ ...a.state, transcript: undefined })),
        },
        null,
        2,
      ),
    );
    return p;
  }
}
