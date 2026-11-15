#!/usr/bin/env node
// Tiny stdio MCP server loaded into every worker. Exposes one tool,
// `escalate_to_opus`, which forwards the request over a unix socket to the
// relay orchestrator. The orchestrator runs the stronger model (so it shows
// up in the TUI), and the answer comes back here as the tool result.

import net from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const SOCK = process.env.RELAY_SOCK;
const WORKER = process.env.RELAY_WORKER || '?';
const STRONG = process.env.RELAY_ESC_LABEL || 'Opus';

const TOOL = {
  name: 'escalate_to_opus',
  description:
    `Hand a hard sub-problem to a stronger model (${STRONG}). Use it when you are stuck, ` +
    'have failed the same thing twice, face a subtle bug or a design decision with real ' +
    'trade-offs, or the task needs deeper reasoning than you can reliably give. Do NOT use ' +
    'it for routine work. The stronger model cannot see your conversation: put everything ' +
    'it needs (file paths, code excerpts, error output, what you tried) in `question` and ' +
    '`context`. mode "advise" (default): it investigates read-only and returns concrete ' +
    'guidance you then apply. mode "delegate": it carries out a well-defined piece of work ' +
    'itself (may edit files) and reports back. Blocks until it answers (can take minutes).',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The precise problem or piece of work, self-contained.' },
      context: { type: 'string', description: 'Relevant code, errors, file paths and what you already tried.' },
      mode: { type: 'string', enum: ['advise', 'delegate'], description: 'advise (default) or delegate.' },
    },
    required: ['question'],
  },
};

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function escalate(args) {
  return new Promise((resolve) => {
    if (!SOCK) return resolve({ text: 'relay socket not configured; proceed on your own.', isError: true });
    const reqId = randomUUID();
    let buf = '';
    let done = false;
    const end = (r) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    const sock = net.createConnection(SOCK, () => {
      sock.write(
        JSON.stringify({
          type: 'escalate',
          reqId,
          worker: WORKER,
          question: String(args.question || ''),
          context: String(args.context || ''),
          mode: args.mode === 'delegate' ? 'delegate' : 'advise',
        }) + '\n',
      );
    });
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.reqId === reqId) end({ text: m.text, isError: !!m.isError });
        } catch {}
      }
    });
    sock.on('error', (e) => end({ text: `escalation unavailable (${e.message}); proceed on your own.`, isError: true }));
    sock.on('close', () => end({ text: 'escalation channel closed; proceed on your own.', isError: true }));
  });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return; // notification
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'relay', version: '0.1.0' },
      });
    case 'ping':
      return reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: [TOOL] });
    case 'tools/call': {
      if (msg.params?.name !== TOOL.name) return fail(msg.id, -32602, `unknown tool ${msg.params?.name}`);
      const r = await escalate(msg.params.arguments || {});
      return reply(msg.id, { content: [{ type: 'text', text: r.text || '(empty answer)' }], isError: r.isError });
    }
    default:
      return fail(msg.id, -32601, `method not found: ${msg.method}`);
  }
});
rl.on('close', () => process.exit(0));
