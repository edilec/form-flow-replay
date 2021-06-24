import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, link, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LIMITS } from '../src/index.mjs';

const cli = join(import.meta.dirname, '../bin/form-flow-replay.mjs');
const plan = { schemaVersion: '1', steps: [{ id: 'focus-email', input: 'keyboard', expect: { focus: 'email' } }, { id: 'submit-local', input: 'pointer', expect: { mockSubmit: { email: 'sample@example.invalid' } } }] };
const trace = { schemaVersion: '1', complete: true, steps: [{ id: 'focus-email', input: 'keyboard', focus: 'email' }, { id: 'submit-local', input: 'pointer', mockSubmit: { email: 'sample@example.invalid' } }] };
const run = (root, ...extra) => spawnSync(process.execPath, [cli, '--root', root, '--plan', 'plan.json', '--trace', 'trace.json', ...extra], { encoding: 'utf8', env: process.env });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'form-trace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'plan.json'), JSON.stringify(plan));
  await writeFile(join(root, 'trace.json'), JSON.stringify(trace));
  return root;
}

test('CLI matching exported trace exits 0 with deterministic JSON', async t => {
  const root = await fixture(t), a = run(root), b = run(root);
  assert.equal(a.status, 0); assert.equal(a.stdout, b.stdout); assert.equal(a.stderr, '');
  assert.equal(JSON.parse(a.stdout).status, 'pass');
});

test('CLI broken keyboard path exits 1 with a stable step ID and no raw field value', async t => {
  const root = await fixture(t), altered = structuredClone(trace);
  altered.steps[0].focus = 'private-value';
  await writeFile(join(root, 'trace.json'), JSON.stringify(altered));
  const before = await readFile(join(root, 'trace.json'));
  const result = run(root), report = JSON.parse(result.stdout);
  assert.equal(result.status, 1); assert.equal(report.findings[0].ruleId, 'focus-mismatch');
  assert.equal(report.findings[0].stepId, 'step-1'); assert.ok(!result.stdout.includes('private-value'));
  assert.deepEqual(await readFile(join(root, 'trace.json')), before);
});

test('CLI explicit incomplete trace exits 2, and external endpoint field is never used', async t => {
  const root = await fixture(t), partial = structuredClone(trace);
  partial.complete = false; await writeFile(join(root, 'trace.json'), JSON.stringify(partial));
  const incomplete = run(root); assert.equal(incomplete.status, 2);
  assert.equal(JSON.parse(incomplete.stdout).findings[0].ruleId, 'trace-incomplete');
  partial.complete = true; partial.steps[1].endpoint = 'https://example.invalid/submit';
  await writeFile(join(root, 'trace.json'), JSON.stringify(partial));
  const endpoint = run(root); assert.equal(endpoint.status, 2);
  assert.ok(!endpoint.stdout.includes('example.invalid'));
});

test('CLI each input byte bound accepts N and refuses N+1', async t => {
  const root = await fixture(t);
  for (const [name, base] of [['plan.json', JSON.stringify(plan)], ['trace.json', JSON.stringify(trace)]]) {
    await writeFile(join(root, name), base + ' '.repeat(LIMITS.bytes - Buffer.byteLength(base)));
    assert.equal(run(root).status, 0);
    await writeFile(join(root, name), base + ' '.repeat(LIMITS.bytes + 1 - Buffer.byteLength(base)));
    const result = run(root); assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).findings[0].ruleId, 'byte-limit');
    await writeFile(join(root, name), base);
  }
});

test('CLI strict UTF-8 and missing input yield role-based incomplete reports; bad options have empty stdout', async t => {
  const root = await fixture(t);
  for (const [name, role] of [['plan.json', '@plan'], ['trace.json', '@trace']]) {
    const before = await readFile(join(root, name)); await writeFile(join(root, name), Buffer.from([0xff]));
    const result = run(root); assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).findings[0].location.file, role);
    await writeFile(join(root, name), before);
  }
  await rm(join(root, 'trace.json'));
  const missing = run(root); assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).findings[0].location.file, '@trace');
  const bad = run(root, '--unknown'); assert.equal(bad.status, 2); assert.equal(bad.stdout, '');
});

test('CLI ordinary output works; input escape, destination symlink and parent escape are refused', async t => {
  const root = await fixture(t), outside = await mkdtemp(join(tmpdir(), 'form-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const allowed = run(root, '--out', 'report.json'); assert.equal(allowed.status, 0);
  assert.equal(await readFile(join(root, 'report.json'), 'utf8'), allowed.stdout);
  await writeFile(join(outside, 'sentinel.json'), 'unchanged');
  await symlink(join(outside, 'sentinel.json'), join(root, 'linked.json'));
  const linked = run(root, '--out', 'linked.json'); assert.equal(linked.status, 2); assert.equal(linked.stdout, '');
  assert.equal(await readFile(join(outside, 'sentinel.json'), 'utf8'), 'unchanged');
  await symlink(outside, join(root, 'escape'));
  const escaped = run(root, '--out', 'escape/report.json'); assert.equal(escaped.status, 2); assert.equal(escaped.stdout, '');
  await assert.rejects(stat(join(outside, 'report.json')));
  await symlink(join(outside, 'sentinel.json'), join(root, 'outside.json'));
  const inputEscape = spawnSync(process.execPath, [cli, '--root', root, '--plan', 'outside.json', '--trace', 'trace.json'], { encoding: 'utf8', env: process.env });
  assert.equal(inputEscape.status, 2); assert.equal(JSON.parse(inputEscape.stdout).status, 'incomplete');
});

test('CLI refuses output hard links to either input and missing-input aliases through linked parent', async t => {
  const root = await fixture(t);
  for (const name of ['plan.json', 'trace.json']) {
    await link(join(root, name), join(root, 'hard.json'));
    const before = await readFile(join(root, name)); const result = run(root, '--out', 'hard.json');
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.deepEqual(await readFile(join(root, name)), before);
    await rm(join(root, 'hard.json'));
  }
  await rm(join(root, 'trace.json')); await symlink(root, join(root, 'alias'));
  for (const dest of ['trace.json', 'alias/trace.json']) {
    const result = run(root, '--out', dest);
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    await assert.rejects(stat(join(root, 'trace.json')));
  }
});
