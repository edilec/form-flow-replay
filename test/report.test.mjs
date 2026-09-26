import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFlow, TOOL_ID, LIMITS } from '../src/index.mjs';

const good = () => ({
  plan: { schemaVersion: '1', steps: [
    { id: 'focus-email', input: 'keyboard', expect: { focus: 'email' } },
    { id: 'validate-empty', input: 'keyboard', expect: { validationText: 'Email is required' } },
    { id: 'submit-local', input: 'pointer', expect: { mockSubmit: { email: 'sample@example.invalid' } } }
  ] },
  trace: { schemaVersion: '1', complete: true, steps: [
    { id: 'focus-email', input: 'keyboard', focus: 'email' },
    { id: 'validate-empty', input: 'keyboard', validationText: 'Email is required' },
    { id: 'submit-local', input: 'pointer', mockSubmit: { email: 'sample@example.invalid' } }
  ] }
});

test('matching keyboard and pointer trace passes without executing a form', () => {
  const result = compareFlow(good());
  assert.equal(TOOL_ID, 'form-flow-replay');
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.summary, { checked: 3, errors: 0, warnings: 0 });
  assert.deepEqual(result.findings, []);
});

const rules = report => report.findings.map(f => f.ruleId);

test('broken keyboard focus fails with a stable step ID and no raw values', () => {
  const input = good(); input.trace.steps[0].focus = 'other-private-field';
  const result = compareFlow(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['focus-mismatch']);
  assert.equal(result.findings[0].stepId, 'step-1');
  assert.equal(result.findings[0].location.pointer, '/steps/0/expect/focus');
  assert.ok(!JSON.stringify(result).includes('other-private-field'));
});

test('keyboard step observed through pointer path fails, while matching pointer path passes', () => {
  const input = good(); input.trace.steps[0].input = 'pointer';
  const result = compareFlow(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['input-mode-mismatch']);
  assert.equal(result.findings[0].stepId, 'step-1');
});

test('recorded journey order must match the declared step order', () => {
  const input = good(); [input.trace.steps[0], input.trace.steps[1]] = [input.trace.steps[1], input.trace.steps[0]];
  const result = compareFlow(input);
  assert.equal(result.status, 'fail');
  assert.ok(rules(result).includes('step-order-mismatch'));
});

test('validation and mock-submit differences fail without leaking form data', () => {
  const input = good(); input.trace.steps[1].validationText = 'Secret validation';
  input.trace.steps[2].mockSubmit.email = 'private@example.invalid';
  const result = compareFlow(input);
  assert.equal(result.status, 'fail');
  assert.deepEqual(rules(result), ['validation-mismatch', 'mock-submit-mismatch']);
  assert.ok(!JSON.stringify(result).includes('Secret validation'));
  assert.ok(!JSON.stringify(result).includes('private@example.invalid'));
});

test('missing, duplicate, and partial trace evidence is incomplete, not a clean comparison', () => {
  const missing = good(); missing.trace.steps.pop();
  assert.equal(compareFlow(missing).status, 'incomplete');
  assert.ok(rules(compareFlow(missing)).includes('step-unobserved'));
  const duplicate = good(); duplicate.trace.steps.push({ ...duplicate.trace.steps[0], focus: 'different' });
  assert.equal(compareFlow(duplicate).status, 'incomplete');
  assert.ok(rules(compareFlow(duplicate)).includes('trace-duplicate'));
  const partial = good(); partial.trace.complete = false;
  assert.deepEqual(rules(compareFlow(partial)), ['trace-incomplete']);
  assert.equal(compareFlow(partial).summary.checked, 0);
});

test('malformed or unrecognized steps cannot silently disappear from either index', () => {
  const badPlan = good(); badPlan.plan.steps[0].expect = {};
  assert.equal(compareFlow(badPlan).status, 'incomplete');
  assert.ok(rules(compareFlow(badPlan)).includes('plan-step-invalid'));
  const badTrace = good(); badTrace.trace.steps[0].focus = 42;
  assert.equal(compareFlow(badTrace).status, 'incomplete');
  assert.ok(rules(compareFlow(badTrace)).includes('trace-step-invalid'));
  const extra = good(); extra.trace.steps.push({ id: 'unexpected', input: 'keyboard', focus: 'other' });
  assert.ok(rules(compareFlow(extra)).includes('trace-unexpected'));
});

test('step ordinals 10 and 2 are sorted by code unit', () => {
  const input = good();
  input.plan.steps = Array.from({ length: 11 }, (_, i) => ({ id: `s-${i}`, input: 'keyboard', expect: { focus: 'target' } }));
  input.trace.steps = input.plan.steps.map((s, i) => ({ id: s.id, input: 'keyboard', focus: i === 2 || i === 10 ? 'other' : 'target' }));
  const result = compareFlow(input);
  assert.deepEqual(result.findings.map(f => f.location.pointer), ['/steps/10/expect/focus', '/steps/2/expect/focus']);
});

test('record, depth, and injected time bounds accept N and refuse N+1', () => {
  const input = good();
  input.plan.steps = Array.from({ length: LIMITS.steps }, (_, i) => ({ id: `s-${i}`, input: 'keyboard', expect: { focus: 'target' } }));
  input.trace.steps = input.plan.steps.map(s => ({ id: s.id, input: 'keyboard', focus: 'target' }));
  assert.equal(compareFlow(input).status, 'pass');
  input.plan.steps.push({ id: 'extra', input: 'keyboard', expect: { focus: 'target' } });
  assert.deepEqual(rules(compareFlow(input)), ['record-limit']);
  input.plan.steps.pop(); input.trace.steps.push({ id: 'extra', input: 'keyboard', focus: 'target' });
  assert.deepEqual(rules(compareFlow(input)), ['record-limit']);
  const nested = good(); assert.equal(compareFlow(nested).status, 'pass');
  nested.plan.steps[2].expect.mockSubmit.email = { nested: true };
  assert.deepEqual(rules(compareFlow(nested)), ['depth-limit']);
  const exact = [0, LIMITS.milliseconds, LIMITS.milliseconds, LIMITS.milliseconds, LIMITS.milliseconds];
  assert.equal(compareFlow(good(), { now: () => exact.shift() ?? LIMITS.milliseconds }).status, 'pass');
  let calls = 0;
  assert.deepEqual(rules(compareFlow(good(), { now: () => calls++ < 4 ? 0 : LIMITS.milliseconds + 1 })), ['time-limit']);
});

test('a late time overrun cannot become a clean form comparison', () => {
  let calls = 0;
  const result = compareFlow(good(), { now: () => calls++ < 10 ? 0 : LIMITS.milliseconds + 1 });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(rules(result), ['time-limit']);
});
