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
    if (agent === 'claude') {
      assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
      assert.ok(call.args.includes('--strict-mcp-config'));
      assert.ok(!call.args.includes('--mcp-config'));
      assert.equal(call.args[call.args.indexOf('--setting-sources') + 1], 'user');
    }
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function grandchildScript(t) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'agent-tree-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, 'marker');
  // The grandchild inherits the pipes and would create the marker after 1s if it survived.
  const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1000)`;
  const spawnGrandchild = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' });`;
  const { existsSync } = await import('node:fs');
  return { spawnGrandchild, survived: () => existsSync(marker) };
}
test('timeout returns promptly and stops descendants that hold the pipes', async t => {
  const { spawnGrandchild, survived } = await grandchildScript(t);
  const started = Date.now();
  await assert.rejects(new NodeProcessRunner().run({ executable: process.execPath, args: ['-e', `${spawnGrandchild} setTimeout(() => {}, 5000)`], cwd: tmpdir(), input: '', timeoutMs: 200 }), { code: 'TIMEOUT' });
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  await sleep(1500);
  assert.equal(survived(), false);
});
test('normal exit resolves promptly even if a background descendant keeps the pipes', async t => {
  const { spawnGrandchild, survived } = await grandchildScript(t);
  const started = Date.now();
  const result = await new NodeProcessRunner().run({ executable: process.execPath, args: ['-e', `${spawnGrandchild} process.stdout.write('done'); process.exit(0)`], cwd: tmpdir(), input: '', timeoutMs: 5000 });
  assert.deepEqual([result.stdout, result.exitCode], ['done', 0]);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  await sleep(1500);
  assert.equal(survived(), false);
});
test('SIGINT to the host process also stops the agent process group', async t => {
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const { spawnGrandchild, survived } = await grandchildScript(t);
  const module = pathToFileURL(resolve('dist/agents/executor.js')).href;
  const host = `import { NodeProcessRunner } from ${JSON.stringify(module)};
    setTimeout(() => process.kill(process.pid, 'SIGINT'), 300);
    await new NodeProcessRunner().run({ executable: process.execPath, args: ['-e', ${JSON.stringify(`${spawnGrandchild} setTimeout(() => {}, 5000)`)}], cwd: ${JSON.stringify(tmpdir())}, input: '', timeoutMs: 10000 });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', host], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.signal, 'SIGINT', result.stderr);
  await sleep(1500);
  assert.equal(survived(), false);
});
test('NUL characters are rejected as INVALID_REQUEST and spawn errors stay typed', async () => {
  for (const agent of ['codex', 'claude', 'copilot']) {
    await assert.rejects(createAgentExecutor(agent, { run: async () => { assert.fail('must not run'); } }).execute({ workspace: tmpdir(), instruction: 'a\u0000b' }), { code: 'INVALID_REQUEST' });
  }
  await assert.rejects(new NodeProcessRunner().run({ executable: process.execPath, args: ['a\u0000b'], cwd: tmpdir(), input: '', timeoutMs: 3000 }), error => error instanceof AgentExecutionError && error.code === 'PROCESS_ERROR');
});
