import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalInitializer } from '../dist/init.js';
const cli = resolve('dist/cli.js');
async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'dev-init-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('greenfield CLI generates local drafts in caller directory', async t => {
  const root = await project(t);
  const result = spawnSync(process.execPath, [cli, 'init', '--mode', 'greenfield'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Draft only/);
  const directory = join(root, '.dev-assistant/init');
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(state.mode, 'greenfield');
  assert.equal(state.status, 'draft');
  assert.deepEqual(state.technologies, []);
  assert.match(await readFile(join(directory, 'constitution.draft.md'), 'utf8'), /TODO/);
  assert.deepEqual(await readdir(root), ['.dev-assistant']);
  const gate = spawnSync(process.execPath, [cli, 'spec', '--feature', '001-test'], { cwd: root, encoding: 'utf8' });
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /BLOCKED/);
});
test('brownfield inspects known manifests and preserves existing Constitution and sources', async t => {
  const root = await project(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'existing-app' }));
  await writeFile(join(root, 'go.mod'), 'module example\n');
  await writeFile(join(root, 'app.ts'), 'existing code');
  await mkdir(join(root, '.specify/memory'), { recursive: true });
  await writeFile(join(root, '.specify/memory/constitution.md'), 'approved principles');
  const result = await new LocalInitializer().initialize(root, 'brownfield');
  const state = JSON.parse(await readFile(join(result.directory, 'state.json'), 'utf8'));
  assert.equal(state.projectName, 'existing-app');
  assert.deepEqual(state.technologies.sort(), ['Go', 'JavaScript/TypeScript']);
  assert.equal(state.existingConstitution, true);
  assert.equal(await readFile(join(root, '.specify/memory/constitution.md'), 'utf8'), 'approved principles');
  assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), 'existing code');
});
test('repeat and concurrent initialization preserve the first draft', async t => {
  const root = await project(t);
  const initializer = new LocalInitializer();
  const results = await Promise.allSettled([initializer.initialize(root, 'greenfield'), initializer.initialize(root, 'greenfield')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const path = join(root, '.dev-assistant/init/constitution.draft.md');
  await writeFile(path, 'user edited draft');
  await assert.rejects(initializer.initialize(root, 'brownfield'), /already exists/);
  assert.equal(await readFile(path, 'utf8'), 'user edited draft');
});
test('symlink output directories are rejected without writing outside project', async t => {
  const root = await project(t), outside = await project(t);
  await symlink(outside, join(root, '.dev-assistant'));
  await assert.rejects(new LocalInitializer().initialize(root, 'greenfield'), /real directory/);
  assert.deepEqual(await readdir(outside), []);
});
test('malformed manifest fails before creating output; symlink manifests are not read', async t => {
  const root = await project(t);
  await writeFile(join(root, 'package.json'), '{invalid');
  await assert.rejects(new LocalInitializer().initialize(root, 'brownfield'), SyntaxError);
  assert.deepEqual(await readdir(root), ['package.json']);
  const other = await project(t);
  await symlink(join(root, 'package.json'), join(other, 'package.json'));
  const result = await new LocalInitializer().initialize(other, 'brownfield');
  const state = JSON.parse(await readFile(join(result.directory, 'state.json'), 'utf8'));
  assert.deepEqual(state.detectedManifests, []);
});
