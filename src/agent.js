// One `claude -p` process, parsed from --output-format stream-json into a
// plain `state` object the TUI can render.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

export const CLAUDE_BIN = process.env.RELAY_CLAUDE_BIN || 'claude';

// claude-haiku-5-5 -> "haiku 5.5"
export function modelLabel(id = '') {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id);
  if (m) return m[3] ? `${m[1]} ${m[2]}.${m[3]}` : `${m[1]} ${m[2]}`;
  return id;
}

export const family = (id = '') => (/(opus|sonnet|haiku|fable)/.exec(id) || [, id])[1];

const short = (s, n = 70) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

export function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Read': return `Read ${base(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit': return `Edit ${base(input.file_path)}`;
    case 'Write': return `Write ${base(input.file_path)}`;
    case 'Grep': return `Grep "${short(input.pattern, 30)}"`;
    case 'Glob': return `Glob ${short(input.pattern, 30)}`;
    case 'Bash': return `$ ${short(input.command, 50)}`;
    case 'Task':
    case 'Agent': return `Task ${short(input.description, 40)}`;
    case 'WebSearch': return `Search ${short(input.query, 40)}`;
    case 'WebFetch': return `Fetch ${short(input.url, 40)}`;
    case 'TodoWrite': return 'TodoWrite';
    case 'StructuredOutput': return 'StructuredOutput';
    case 'mcp__relay__escalate_to_opus': return `⇡ escalate (${input.mode || 'advise'})`;
    default: return name.replace(/^mcp__/, '');
  }
}

const TERMINAL = new Set(['done', 'failed', 'cancelled', 'skipped']);
export const isTerminal = (s) => TERMINAL.has(s);

export class Agent extends EventEmitter {
  /**
   * o: { id, role, title, model, prompt, cwd, systemAppend, schema, tools,
   *      allowedTools, permissionMode, mcpConfig, strictMcp, effort, budget,
   *      keepSessions, logFile, env }
   */
  constructor(o) {
    super();
    this.o = o;
    this.id = o.id;
    this.child = null;
    this._msgs = new Set();
    this.state = {
      id: o.id,
      role: o.role,
      title: o.title,
      alias: o.model,
      model: o.model,
      status: 'queued',
      turns: 0,
      tools: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      activity: '',
      transcript: [{ kind: 'prompt', text: o.prompt, t: Date.now() }],
      result: '',
      structured: null,
      error: '',
      startedAt: 0,
      endedAt: 0,
      sessionId: '',
    };
  }

  push(kind, text) {
    const tr = this.state.transcript;
    tr.push({ kind, text: String(text ?? ''), t: Date.now() });
    if (tr.length > 3000) tr.splice(1, tr.length - 3000);
  }

  changed() {
    this.emit('change', this.state);
  }

  args() {
    const o = this.o;
    const a = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose'];
    a.push('--permission-prompts', 'none');
    if (!o.keepSessions) a.push('--no-session-persistence');
    if (o.effort) a.push('--effort', o.effort);
    if (o.schema) a.push('--json-schema', JSON.stringify(o.schema));
    if (o.tools) a.push('--tools', o.tools.join(','));
    if (o.permissionMode) a.push('--permission-mode', o.permissionMode);
    if (o.mcpConfig) a.push('--mcp-config', JSON.stringify(o.mcpConfig));
    if (o.strictMcp) a.push('--strict-mcp-config');
    if (o.systemAppend) a.push('--append-system-prompt', o.systemAppend);
    if (o.budget != null && o.budget > 0) a.push('--max-budget-usd', o.budget.toFixed(2));
    if (o.allowedTools?.length) a.push('--allowedTools', ...o.allowedTools);
    return a;
  }

  run() {
    if (this._p) return this._p;
    this._p = new Promise((resolve) => {
      const st = this.state;
      st.status = 'running';
      st.startedAt = Date.now();
      st.activity = 'starting';
      this.changed();

      let log = null;
      if (this.o.logFile) {
        fs.mkdirSync(path.dirname(this.o.logFile), { recursive: true });
        log = fs.createWriteStream(this.o.logFile, { flags: 'a' });
      }

      let child;
      try {
        child = spawn(CLAUDE_BIN, this.args(), {
          cwd: this.o.cwd,
          env: { ...process.env, MCP_TOOL_TIMEOUT: '1800000', ...(this.o.env || {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (e) {
        this.finish('failed', `spawn failed: ${e.message}`);
        return resolve(st);
      }
      this.child = child;
      let stderr = '';
      child.on('error', (e) => {
        stderr += `\n${e.message}`;
      });
      child.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-4000);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(this.o.prompt);

      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        log?.write(line + '\n');
        this.onLine(line);
      });
      child.on('close', (code, signal) => {
        log?.end();
        this.child = null;
        if (!isTerminal(st.status)) {
          if (this._resultSeen && !st.error) this.finish('done');
          else
            this.finish(
              'failed',
              st.error || stderr.trim().split('\n').slice(-3).join(' ') || `exited ${code ?? signal}`,
            );
        }
        resolve(st);
      });
    });
    return this._p;
  }

  finish(status, error = '') {
    const st = this.state;
    if (isTerminal(st.status)) return;
    st.status = status;
    if (error) {
      st.error = error;
      this.push('error', error);
    }
    st.endedAt = Date.now();
    st.activity = status === 'done' ? 'finished' : status;
    this.changed();
    this.emit('exit', st);
  }

  kill() {
    if (this.child) {
      try {
        process.kill(-this.child.pid, 'SIGTERM');
      } catch {
        try { this.child.kill('SIGTERM'); } catch {}
      }
    }
    this.finish('cancelled');
  }

  onLine(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const st = this.state;
    if (ev.parent_tool_use_id) {
      // activity inside the agent's own Task subagents
      return;
    }
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          if (ev.model) st.model = ev.model;
          st.sessionId = ev.session_id || '';
        }
        break;
      case 'assistant': {
        const msg = ev.message || {};
        if (msg.model) st.model = msg.model;
        if (msg.id && !this._msgs.has(msg.id)) {
          this._msgs.add(msg.id);
          st.turns++;
          const u = msg.usage || {};
          st.tokensIn +=
            (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        }
        for (const b of msg.content || []) {
          if (b.type === 'text' && b.text?.trim()) {
            this.push('text', b.text);
            st.activity = short(b.text, 60);
          } else if (b.type === 'tool_use') {
            st.tools++;
            const d = describeTool(b.name, b.input);
            st.activity = d;
            if (b.name === 'StructuredOutput') this.push('tool', 'StructuredOutput');
            else this.push('tool', `${d}${b.name.startsWith('mcp__relay') ? '\n' + short(b.input?.question, 400) : ''}`);
            this.emit('tool', b.name, b.input);
          } else if (b.type === 'thinking' && b.thinking) {
            st.activity = 'thinking';
          }
        }
        break;
      }
      case 'user': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          let text = b.content;
          if (Array.isArray(text)) text = text.map((x) => x.text || '').join('\n');
          this.push(b.is_error ? 'error' : 'result', String(text ?? '').slice(0, 1500));
        }
        break;
      }
      case 'result': {
        this._resultSeen = true;
        st.cost = ev.total_cost_usd || st.cost;
        st.result = ev.result || '';
        st.structured = ev.structured_output ?? null;
        const u = ev.usage || {};
        st.tokensOut = u.output_tokens || st.tokensOut;
        const tin =
          (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (tin) st.tokensIn = tin;
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
          st.error = short(ev.result || ev.api_error_status || ev.subtype || 'error', 300);
          this.finish('failed', st.error);
        } else {
          if (st.result) this.push('final', st.result);
          this.finish('done');
        }
        break;
      }
    }
    this.changed();
  }
}
