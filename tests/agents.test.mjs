import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createAgentExecutor, NodeProcessRunner, AgentExecutionError } from '../dist/agents/executor.js';

test('all executors use separate arguments, working directory and default timeout', async () => {
  const prompt = '日本語 $(touch unwanted) `command` "quoted"';
  for (const agent of ['codex', 'claude', 'copilot']) {
    let call;
    const runner = { run: async request => { call = request; return { stdout: ' result\n', stderr: 'diagnostic', exitCode: 0 }; } };
    assert.deepEqual(await createAgentExecutor(agent, runner).execute({ workspace: tmpdir(), instruction: prompt }), { output: 'result' });
    assert.equal(call.cwd, tmpdir());
    assert.equal(call.timeoutMs, 120000);
    if (agent === 'copilot') { assert.equal(call.args[1], prompt); assert.equal(call.input, ''); assert.ok(call.args.includes('--no-ask-user')); }
    else assert.equal(call.input, prompt);
    assert.ok(!call.args.includes('--allow-all-tools'));
    assert.ok(!call.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    if (agent === 'claude') assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
    if (agent === 'codex') assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
  }
});
test('invalid input does not launch a CLI', async () => {
  const executor = createAgentExecutor('codex', { run: async () => { assert.fail('must not run'); } });
  for (const patch of [{ instruction: ' ' }, { instruction: 'x'.repeat(65537) }, { workspace: 'relative' }, { workspace: '/nonexistent-agent-test-dir' }, { timeoutMs: 0 }, { timeoutMs: NaN }]) {
    await assert.rejects(executor.execute({ workspace: tmpdir(), instruction: 'hello', ...patch }), { code: 'INVALID_REQUEST' });
  }
  assert.throws(() => createAgentExecutor('unknown'), { code: 'INVALID_REQUEST' });
});
test('nonzero exit and empty output fail without exposing stderr', async () => {
  for (const [result, code] of [[{ stdout: 'partial', stderr: 'secret-token', exitCode: 1 }, 'FAILED'], [{ stdout: ' ', stderr: '', exitCode: 0 }, 'EMPTY_OUTPUT']]) {
    await assert.rejects(createAgentExecutor('claude', { run: async () => result }).execute({ workspace: tmpdir(), instruction: 'hello' }), error => error instanceof AgentExecutionError && error.code === code && !error.message.includes('secret-token'));
  }
});
test('process runner transmits literal stdin and correctly decodes split UTF-8', async () => {
  const runner = new NodeProcessRunner();
  const result = await runner.run({ executable: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'], cwd: tmpdir(), input: '日本語 $(no shell)', timeoutMs: 3000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '日本語 $(no shell)');
  const split = await runner.run({ executable: process.execPath, args: ['-e', 'const b=Buffer.from("花");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)'], cwd: tmpdir(), input: '', timeoutMs: 3000 });
  assert.equal(split.stdout, '花');
});
test('process runner reports missing executable, timeout and excessive output', async () => {
  const runner = new NodeProcessRunner();
  const base = { cwd: tmpdir(), input: '', timeoutMs: 3000 };
  await assert.rejects(runner.run({ ...base, executable: '/nonexistent-agent-test-executable', args: [] }), { code: 'NOT_FOUND' });
  await assert.rejects(runner.run({ ...base, executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 50 }), { code: 'TIMEOUT' });
  await assert.rejects(runner.run({ ...base, executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(5*1024*1024))'] }), { code: 'OUTPUT_LIMIT' });
});
