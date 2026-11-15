// Simulated agents for `relay --mock`: exercises the whole pipeline and TUI
// without spending tokens.

import { Agent } from './agent.js';

const MODEL = { opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' };
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = ['src/auth.ts', 'src/session.ts', 'lib/db.js', 'api/routes.ts', 'test/auth.test.ts', 'README.md', 'package.json'];
const STEPS = [
  () => ['Read', { file_path: pick(FILES) }],
  () => ['Grep', { pattern: pick(['refreshToken', 'export function', 'TODO', 'sourceMap']) }],
  () => ['Glob', { pattern: pick(['src/**/*.ts', '**/*.test.ts', 'lib/*']) }],
  () => ['Edit', { file_path: pick(FILES) }],
  () => ['Bash', { command: pick(['npm test -- auth', 'git diff --stat', 'tsc --noEmit']) }],
];

export class MockAgent extends Agent {
  run() {
    if (this._p) return this._p;
    this._p = this.sim().catch((e) => this.finish('failed', e.message)).then(() => this.state);
    return this._p;
  }

  kill() {
    this._killed = true;
    this.finish('cancelled');
  }

  async step(ms) {
    await sleep(ms);
    if (this._killed) throw new Error('cancelled');
  }

  usage(k = 1) {
    const st = this.state;
    st.turns++;
    st.tokensIn += Math.round(rnd(6000, 22000) * k);
    st.tokensOut += Math.round(rnd(100, 700) * k);
    st.cost += (this.o.model.includes('opus') ? 0.012 : 0.0015) * k * rnd(0.6, 1.4);
  }

  tool(name, input) {
    this.state.tools++;
    const d = this.describe(name, input);
    this.state.activity = d;
    this.push('tool', d);
    this.usage();
    this.changed();
  }

  describe(name, input) {
    return name === 'Bash' ? `$ ${input.command}` : `${name} ${input.file_path || input.pattern || ''}`.trim();
  }

  async sim() {
    const st = this.state;
    const o = this.o;
    st.status = 'running';
    st.startedAt = Date.now();
    st.model = MODEL[o.model] || o.model;
    this.changed();
    const fast = o.role === 'worker' && !o.model.includes('opus');

    const n = o.role === 'lead' ? Math.round(rnd(3, 6)) : Math.round(rnd(4, 10));
    for (let i = 0; i < n; i++) {
      await this.step(rnd(fast ? 350 : 600, fast ? 1100 : 1600));
      if (o.role === 'worker' && i === 2 && o.onEscalate && Math.random() < 0.45) {
        const q = pick([
          'Token refresh races with logout; which lock order is safe?',
          'Two failing tests contradict each other. Which one encodes the intended behaviour?',
          'Is it safe to drop the legacy session table, or do migrations still read it?',
        ]);
        this.tool('mcp__relay__escalate_to_opus', {});
        st.activity = '⇡ escalate (advise)';
        this.push('tool', `⇡ escalate (advise)\n${q}`);
        this.changed();
        const ans = await o.onEscalate({ question: q, context: '', mode: Math.random() < 0.3 ? 'delegate' : 'advise' });
        if (this._killed) throw new Error('cancelled');
        this.push('result', ans.text);
        continue;
      }
      const [name, input] = pick(STEPS)();
      this.tool(name, input);
    }
    await this.step(rnd(300, 800));

    if (o.schema && o.kind === 'plan') st.structured = this.fakePlan();
    else if (o.schema && o.kind === 'review') st.structured = this.fakeReview();
    else if (o.role === 'escalation')
      st.result = 'Take the session lock before the token lock everywhere; add a regression test that interleaves logout() during refresh().';
    else st.result = `Completed "${o.title}". Changed ${pick(FILES)} and ${pick(FILES)}; tests pass.`;
    this.push('final', st.result || JSON.stringify(st.structured, null, 2));
    this.finish('done');
  }

  fakePlan() {
    const t = (id, title, deps = [], model = 'fast') => ({
      id,
      title,
      prompt: `Mock task ${title} for: ${this.o.goal}`,
      depends_on: deps,
      model,
    });
    return {
      summary: 'Map the code, fix in parallel, then verify.',
      tasks: [
        t('t1', 'map the repo'),
        t('t2', 'find call sites'),
        t('t3', 'audit session store'),
        t('t4', 'fix token refresh', ['t1', 't2']),
        t('t5', 'race-proof logout', ['t3'], 'strong'),
        t('t6', 'regression tests', ['t4', 't5']),
      ],
    };
  }

  fakeReview() {
    if ((this.o.round || 1) < 2)
      return {
        done: false,
        verdict: 'one gap: docs not updated',
        summary: '',
        followups: [{ id: 'f1', title: 'update docs', prompt: 'Update README for new auth flow', depends_on: [] }],
      };
    return {
      done: true,
      verdict: 'goal met · tests green',
      summary:
        '## Mock run complete\n\n- Token refresh fixed in `src/auth.ts`\n- Logout race closed (lock order: session → token)\n- 4 regression tests added\n- README updated',
      followups: [],
    };
  }
}
