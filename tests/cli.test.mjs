import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseCommand, run } from '../dist/app.js';
import { ReviewMergeGate } from '../dist/gate.js';
const valid = (phase, featureId) => ({ phase, featureId, reviewed: true, merged: true,
  baseBranch: 'main', mergeCommitOnMain: true, artifactsPresent: true, artifactsMatchApproved: true });
const output = () => { const lines = []; return { lines, out: x => lines.push(x), error: x => lines.push(x) }; };
test('commands require valid explicit options', () => {
  for (const mode of ['greenfield', 'brownfield']) assert.deepEqual(parseCommand(['init', '--mode', mode]), { kind: 'init', mode });
  for (const kind of ['spec', 'design', 'implement']) assert.deepEqual(parseCommand([kind, '--feature', '001-reservation']), { kind, featureId: '001-reservation' });
  for (const args of [['unknown'], ['init'], ['init', '--mode', 'bad'], ['design', '--feature', '../escape'], ['spec', '--feature', 'ok', '--force'], ['implement', '--mode', 'brownfield']]) {
    assert.throws(() => parseCommand(args));
  }
});
test('phase mapping and Constitution project scope', async () => {
  const calls = [];
  const gate = new ReviewMergeGate({ read: async (phase, feature) => { calls.push([phase, feature]); return valid(phase, feature); } });
  for (const phase of ['specification', 'design', 'implementation']) assert.equal((await gate.check(phase, '001-booking')).allowed, true);
  assert.deepEqual(calls, [['constitution', undefined], ['specification', '001-booking'], ['design', '001-booking']]);
});
test('missing, unreviewed, unmerged, wrong branch, absent/changed artifacts are blocked', async () => {
  for (const patch of [{ reviewed: false }, { merged: false }, { baseBranch: 'develop' }, { mergeCommitOnMain: false }, { artifactsPresent: false }, { artifactsMatchApproved: false }, { featureId: 'another' }, { phase: 'design' }]) {
    const gate = new ReviewMergeGate({ read: async () => ({ ...valid('specification', '001-booking'), ...patch }) });
    assert.equal((await gate.check('design', '001-booking')).allowed, false);
  }
  assert.equal((await new ReviewMergeGate({ read: async () => undefined }).check('specification')).allowed, false);
  assert.equal((await new ReviewMergeGate({ read: async () => { throw new Error('offline'); } }).check('specification')).allowed, false);
  assert.equal((await new ReviewMergeGate({ read: async () => { throw new Error('must not read'); } }).check('design')).allowed, false);
});
const initialization = (inits = []) => ({ root: '/project', initializer: { initialize: async (...args) => { inits.push(args); return { directory: '/project/.dev-assistant/init' }; } } });
test('init bypasses gate; valid phases check gate; unfinished workflows never report success', async () => {
  const calls = [], inits = [];
  const gate = { check: async (...args) => { calls.push(args); return { allowed: true }; } };
  const initIo = output();
  assert.equal(await run(['init', '--mode', 'greenfield'], gate, initIo, initialization(inits)), 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(inits, [['/project', 'greenfield', undefined]]);
  assert.match(initIo.lines.join('\n'), /draft created: \/project\/\.dev-assistant\/init/);
  for (const kind of ['spec', 'design', 'implement']) assert.equal(await run([kind, '--feature', '001-test'], gate, output(), initialization(inits)), 2);
  assert.deepEqual(calls, [['specification', '001-test'], ['design', '001-test'], ['implementation', '001-test']]);
  assert.equal(inits.length, 1);
  const io = output();
  assert.equal(await run(['design', '--feature', '001-test'], { check: async () => ({ allowed: false, reason: 'not merged' }) }, io, initialization()), 1);
  assert.match(io.lines.join('\n'), /BLOCKED: not merged/);
});
test('init failures are reported with exit code 1', async () => {
  const io = output();
  const failing = { root: '/project', initializer: { initialize: async () => { throw new Error('draft already exists'); } } };
  assert.equal(await run(['init', '--mode', 'brownfield'], { check: async () => ({ allowed: true }) }, io, failing), 1);
  assert.deepEqual(io.lines, ['draft already exists']);
});
test('built executable help, errors, and fail-closed behavior', () => {
  for (const [args, code, pattern] of [[['--help'], 0, /dev init/], [['design', '--feature', '001-test'], 1, /BLOCKED/], [['oops'], 1, /Unknown command/]]) {
    const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, code);
    assert.match(result.stdout + result.stderr, pattern);
  }
});

test('init parses purpose and repeated constraints in any order', async () => {
  const args = ['init', '--constraint', 'API compatibility', '--purpose', ' Serve residents ', '--mode', 'brownfield', '--constraint', 'Offline'];
  assert.deepEqual(parseCommand(args), { kind: 'init', mode: 'brownfield', input: { purpose: 'Serve residents', constraints: ['API compatibility', 'Offline'] } });
  const inits = [];
  assert.equal(await run(args, { check: async () => { throw new Error('must not gate'); } }, output(), initialization(inits)), 0);
  assert.deepEqual(inits[0], ['/project', 'brownfield', { purpose: 'Serve residents', constraints: ['API compatibility', 'Offline'] }]);
});
test('init rejects missing, empty, duplicate, unknown and oversized inputs', () => {
  for (const extra of [['--purpose'], ['--purpose', '--constraint'], ['--purpose', '  '], ['--constraint', ''], ['--purpose', 'a', '--purpose', 'b'], ['--mode', 'brownfield'], ['--unknown', 'x'], ['--purpose', 'x'.repeat(4001)], ['--constraint', '\u0000'], ['--constraint', 'safe‮evil'], ['--purpose', 'x\u0085y'], ['--purpose', 'x y'], ['--constraint', '⁦hidden⁩']]) {
    assert.throws(() => parseCommand(['init', '--mode', 'greenfield', ...extra]));
  }
});
test('init accepts values starting with -- unless they are option names', () => {
  const base = ['init', '--mode', 'greenfield'];
  assert.deepEqual(parseCommand([...base, '--purpose', '--strict モードで動かす', '--constraint', '--no-network']).input, { purpose: '--strict モードで動かす', constraints: ['--no-network'] });
  for (const extra of [['--purpose', '--mode'], ['--constraint', '--purpose'], ['--purpose', '--help'], ['--constraint', '-h']]) {
    assert.throws(() => parseCommand([...base, ...extra]), /Missing value/);
  }
});
test('input length counts trimmed code points and rejects edge unsafe characters', () => {
  const base = ['init', '--mode', 'greenfield'];
  assert.equal(parseCommand([...base, '--purpose', `  ${'x'.repeat(4000)}  `]).input.purpose.length, 4000);
  assert.equal([...parseCommand([...base, '--constraint', '😀'.repeat(4000)]).input.constraints[0]].length, 4000);
  assert.throws(() => parseCommand([...base, '--purpose', '😀'.repeat(4001)]), /at most 4000 characters/);
  assert.throws(() => parseCommand([...base, '--purpose', ' leading separator']), /control or bidirectional/);
});
