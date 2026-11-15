#!/usr/bin/env node
// A tiny stdio MCP server for trying relay's tool timeline and MCP labels.
// All data is made up. Tools have different speeds, and one always fails.
//
//   node examples/demo-mcp.js --config > /tmp/demo-mcp.json   # prints a ready-to-use config
//   relay --mcp-config /tmp/demo-mcp.json "..."

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--config')) {
  const config = { mcpServers: { demo: { command: process.execPath, args: [fileURLToPath(import.meta.url)] } } };
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (a, b) => a + Math.random() * (b - a);

const TOOLS = {
  get_forecast: {
    description: 'Made-up weather forecast for a city (demo data). Takes about 0.5-1.5s.',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' }, days: { type: 'number', description: '1-5, default 3' } },
      required: ['city'],
    },
    async run({ city, days = 3 }) {
      await sleep(between(500, 1500));
      const out = [];
      for (let i = 1; i <= Math.min(5, Math.max(1, days)); i++)
        out.push(`day ${i}: ${Math.round(between(8, 30))}°C, ${['sunny', 'cloudy', 'rain', 'windy'][i % 4]}`);
      return `DEMO forecast for ${city}\n${out.join('\n')}`;
    },
  },
  search_docs: {
    description: 'Search a fake documentation index (demo data). Takes about 1-2.5s.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run({ query }) {
      await sleep(between(1000, 2500));
      return `DEMO results for "${query}":\n1. Guide: ${query} basics\n2. Reference: ${query} options\n3. FAQ: common ${query} problems`;
    },
  },
  slow_job: {
    description: 'Wait for the given number of seconds (1-10), then report done. Use it to see long bars.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
    async run({ seconds }) {
      const s = Math.min(10, Math.max(1, Number(seconds) || 1));
      await sleep(s * 1000);
      return `slow_job finished after ${s}s`;
    },
  },
  always_fails: {
    description: 'Always returns an error. Use it to see a failed call in the timeline.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
    async run({ reason }) {
      await sleep(between(200, 600));
      throw new Error(`demo failure${reason ? `: ${reason}` : ''}`);
    },
  },
};

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'demo', version: '0.1.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
      });
    case 'tools/call': {
      const tool = TOOLS[msg.params?.name];
      if (!tool) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool ${msg.params?.name}` } });
      try {
        return reply({ content: [{ type: 'text', text: await tool.run(msg.params.arguments || {}) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
