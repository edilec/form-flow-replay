import { isDeepStrictEqual } from 'node:util';

export const TOOL_ID = 'form-flow-replay';
export const LIMITS = Object.freeze({ bytes: 1_048_576, steps: 100, depth: 5, milliseconds: 5000 });
export const RULE_SEVERITY = Object.freeze({
  'input-unreadable': 'error', 'plan-invalid': 'error', 'trace-invalid': 'error',
  'plan-incomplete': 'error', 'trace-incomplete': 'error', 'byte-limit': 'error',
  'depth-limit': 'error', 'record-limit': 'error', 'time-limit': 'error',
  'plan-step-invalid': 'error', 'trace-step-invalid': 'error', 'plan-duplicate': 'error',
  'trace-duplicate': 'error', 'trace-unexpected': 'error', 'step-unobserved': 'error',
  'step-order-mismatch': 'error', 'input-mode-mismatch': 'error', 'focus-mismatch': 'error',
  'validation-mismatch': 'error', 'mock-submit-mismatch': 'error'
});
const INCOMPLETE = new Set(['input-unreadable', 'plan-invalid', 'trace-invalid', 'plan-incomplete', 'trace-incomplete', 'byte-limit', 'depth-limit', 'record-limit', 'time-limit', 'plan-step-invalid', 'trace-step-invalid', 'plan-duplicate', 'trace-duplicate', 'trace-unexpected', 'step-unobserved']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const safeId = x => typeof x === 'string' && x.length > 0 && x.length <= 128 && x.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\p{Cf}]/u.test(x);
function tooDeep(input) {
  const stack = [[input, 0]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > LIMITS.depth) return true;
    if (value && typeof value === 'object') for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  return false;
}
function finding(findings, ruleId, file, pointer, message, ordinal) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new Error('Unknown rule');
  const value = { ruleId, severity: RULE_SEVERITY[ruleId], message, location: { file, pointer } };
  if (ordinal !== undefined) value.stepId = `step-${ordinal + 1}`;
  findings.push(value);
}
function report(findings, checked) {
  findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
  const status = findings.some(f => INCOMPLETE.has(f.ruleId)) ? 'incomplete' : findings.some(f => f.severity === 'error') ? 'fail' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: 0 }, findings };
}
export function incomplete(ruleId, file, message) {
  const findings = [];
  finding(findings, ruleId, file, '', message);
  return report(findings, 0);
}
function validPlanStep(s) {
  return object(s) && Object.keys(s).every(k => ['id', 'input', 'expect'].includes(k)) && safeId(s.id) && ['keyboard', 'pointer'].includes(s.input)
    && object(s.expect) && Object.keys(s.expect).length > 0 && Object.keys(s.expect).every(k => ['focus', 'validationText', 'mockSubmit'].includes(k))
    && (!Object.hasOwn(s.expect, 'focus') || safeId(s.expect.focus))
    && (!Object.hasOwn(s.expect, 'validationText') || typeof s.expect.validationText === 'string')
    && (!Object.hasOwn(s.expect, 'mockSubmit') || object(s.expect.mockSubmit));
}
function validTraceStep(s) {
  return object(s) && Object.keys(s).every(k => ['id', 'input', 'focus', 'validationText', 'mockSubmit'].includes(k)) && safeId(s.id) && ['keyboard', 'pointer'].includes(s.input)
    && (!Object.hasOwn(s, 'focus') || safeId(s.focus))
    && (!Object.hasOwn(s, 'validationText') || typeof s.validationText === 'string')
    && (!Object.hasOwn(s, 'mockSubmit') || object(s.mockSubmit));
}

export function compareFlow(input, { now = () => performance.now() } = {}) {
  const started = now();
  if (!object(input) || !object(input.plan) || input.plan.schemaVersion !== '1' || !Array.isArray(input.plan.steps) || input.plan.steps.length === 0 || Object.keys(input.plan).some(k => !['schemaVersion', 'complete', 'steps'].includes(k))) return incomplete('plan-invalid', '@plan', 'A version 1 plan with nonempty steps is required.');
  if (!object(input.trace) || input.trace.schemaVersion !== '1' || !Array.isArray(input.trace.steps) || Object.keys(input.trace).some(k => !['schemaVersion', 'complete', 'steps'].includes(k))) return incomplete('trace-invalid', '@trace', 'A version 1 local trace is required.');
  if (Object.hasOwn(input.plan, 'complete') && input.plan.complete !== true) return incomplete('plan-incomplete', '@plan', 'Plan explicitly declares incomplete evidence.');
  if (input.trace.complete !== true) return incomplete('trace-incomplete', '@trace', 'Trace must explicitly declare complete local capture.');
  if (tooDeep(input.plan) || tooDeep(input.trace)) return incomplete('depth-limit', '@plan', 'Evidence exceeds nesting depth 5.');
  if (input.plan.steps.length > LIMITS.steps || input.trace.steps.length > LIMITS.steps) return incomplete('record-limit', '@plan', 'Evidence exceeds 100 journey steps.');
  const findings = [], planIndex = new Map(), traceIndex = new Map();
  for (const [i, step] of input.plan.steps.entries()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', '@plan', 'Evaluation exceeded 5000 milliseconds.');
    if (!validPlanStep(step)) { finding(findings, 'plan-step-invalid', '@plan', `/steps/${i}`, 'Plan step has unusable fields.', i); continue; }
    if (planIndex.has(step.id)) finding(findings, 'plan-duplicate', '@plan', `/steps/${i}`, 'Plan step identity is duplicated.', i);
    else planIndex.set(step.id, { ...step, ordinal: i });
  }
  for (const [i, step] of input.trace.steps.entries()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', '@trace', 'Evaluation exceeded 5000 milliseconds.');
    if (!validTraceStep(step)) { finding(findings, 'trace-step-invalid', '@trace', `/steps/${i}`, 'Trace step has unusable fields.', i); continue; }
    if (traceIndex.has(step.id)) finding(findings, 'trace-duplicate', '@trace', `/steps/${i}`, 'Trace step identity is duplicated.', i);
    else traceIndex.set(step.id, { ...step, ordinal: i });
  }
  if (findings.length) return report(findings, 0);
  for (const step of planIndex.values()) if (!traceIndex.has(step.id)) finding(findings, 'step-unobserved', '@plan', `/steps/${step.ordinal}`, 'Expected step is absent from local trace.', step.ordinal);
  for (const step of traceIndex.values()) if (!planIndex.has(step.id)) finding(findings, 'trace-unexpected', '@trace', `/steps/${step.ordinal}`, 'Local trace contains an undeclared step.', step.ordinal);
  if (findings.length) return report(findings, 0);
  for (const step of planIndex.values()) {
    if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', '@plan', 'Evaluation exceeded 5000 milliseconds.');
    const seen = traceIndex.get(step.id), pointer = `/steps/${step.ordinal}`, ordinal = step.ordinal;
    if (seen.ordinal !== ordinal) finding(findings, 'step-order-mismatch', '@plan', pointer, 'Local trace step order differs from plan.', ordinal);
    if (seen.input !== step.input) finding(findings, 'input-mode-mismatch', '@plan', `${pointer}/input`, 'Keyboard or pointer input mode differs from plan.', ordinal);
    if (Object.hasOwn(step.expect, 'focus') && seen.focus !== step.expect.focus) finding(findings, 'focus-mismatch', '@plan', `${pointer}/expect/focus`, 'Observed focus differs from expected focus.', ordinal);
    if (Object.hasOwn(step.expect, 'validationText') && seen.validationText !== step.expect.validationText) finding(findings, 'validation-mismatch', '@plan', `${pointer}/expect/validationText`, 'Observed validation text differs from expectation.', ordinal);
    if (Object.hasOwn(step.expect, 'mockSubmit') && !isDeepStrictEqual(seen.mockSubmit, step.expect.mockSubmit)) finding(findings, 'mock-submit-mismatch', '@plan', `${pointer}/expect/mockSubmit`, 'Observed local mock-submit data differs from expectation.', ordinal);
  }
  if (now() - started > LIMITS.milliseconds) return incomplete('time-limit', '@plan', 'Evaluation exceeded 5000 milliseconds.');
  return report(findings, planIndex.size);
}
