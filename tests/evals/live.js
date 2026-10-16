// Live eval entry (bundled and run by tests/evals/run.js). Asks a real model to
// write each case's script using the same skill guide the agent gets, then
// scores it with the same verifier and simulator. No tools: this measures how
// good the guidance and the verifier are together, not the agent loop.
import { CASES, extractCode, checkExpectation } from './cases.js';
import { verifyScript } from '../../src/lib/verify.js';
import { runClientScript } from '../../src/lib/mockForm.js';
import { buildSystemPrompt } from '../../src/lib/agent/systemPrompt.js';
import { sendChat } from '../../src/providers/index.js';
import { PROVIDERS } from '../../src/providers/config.js';

const NO_TOOLS = 'This is an evaluation and no tools are available. Write the final script directly. Reply with ONLY the script in one ```javascript block, then one sentence on the configuration (table, type or when).';

async function scoreCase(config, c, withGuide) {
  const context = { table: c.side === 'client' ? 'sys_script_client' : 'sys_script' };
  const system = withGuide ? buildSystemPrompt({ context, instance: { env: 'dev' } }).text : 'You are a ServiceNow developer.';
  const reply = await sendChat(config, {
    messages: [
      { role: 'system', content: `${system}\n\n${NO_TOOLS}` },
      { role: 'user', content: `${c.prompt}${c.table ? `\n\nThe table is ${c.table}. Its fields: ${(c.fields || []).join(', ')}.` : ''}` },
    ],
    effort: 'medium',
  });
  const code = extractCode(reply.content);
  const result = verifyScript({ code, kind: c.kind, when: c.when, clientType: c.clientType, table: c.table, fields: c.fields });
  const failures = [];
  if (!result.ok) failures.push(...result.findings.filter((f) => f.severity === 'high').map((f) => `verify: ${f.ruleId} (line ${f.line})`));
  for (const s of c.scenarios || []) {
    // eslint-disable-next-line no-await-in-loop -- scenarios share nothing but are cheap and keep output ordered.
    const run = await runClientScript({ code, clientType: c.clientType, scenario: s.scenario });
    failures.push(...checkExpectation(run, s.expect).map((f) => `sim "${s.name}": ${f}`));
  }
  return { id: c.id, pass: failures.length === 0, failures, warnings: result.warnings, tokens: reply.usage };
}

export async function main(argv, env) {
  const provider = env.EVAL_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : null);
  const apiKey = provider === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY;
  if (!provider || !apiKey) {
    console.error('Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) to run the live eval.');
    return 2;
  }
  const config = { provider, apiKey, model: env.EVAL_MODEL || PROVIDERS[provider].defaultModel };
  const only = argv.find((a) => a.startsWith('--only='))?.slice(7);
  const withGuide = !argv.includes('--no-guide');
  const cases = CASES.filter((c) => !only || c.id.includes(only));

  console.log(`Live eval: ${config.provider} ${config.model}, ${withGuide ? 'with' : 'WITHOUT'} the skill guide, ${cases.length} case(s)\n`);
  const results = [];
  for (const c of cases) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential keeps rate limits and cost predictable.
      const r = await scoreCase(config, c, withGuide);
      results.push(r);
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${c.id}${r.warnings ? `  (${r.warnings} warning(s))` : ''}`);
      r.failures.forEach((f) => console.log(`        - ${f}`));
    } catch (err) {
      results.push({ id: c.id, pass: false, failures: [err.message] });
      console.log(`ERR   ${c.id}: ${err.message}`);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed (${Math.round((passed / results.length) * 100)}%)`);
  return passed === results.length ? 0 : 1;
}
