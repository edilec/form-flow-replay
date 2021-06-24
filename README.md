# Form Flow Replay

Offline, read-only comparison of a declarative keyboard/pointer form journey against a separately exported local fixture trace. “Replay” here means checking recorded evidence, not driving a browser or form. No request is sent, no form is submitted, and no external service is contacted. Requires Node.js 22 or newer; no package dependencies.

## Run

```sh
node bin/form-flow-replay.mjs --root examples/passing --plan plan.json --trace trace.json
node bin/form-flow-replay.mjs --root examples/failing --plan plan.json --trace trace.json
npm run check
```

The examples exit `0` (matching trace) and `1` (broken keyboard focus at `step-1`). Add `--human` for a short stderr summary. `--out report.json` additionally writes the same JSON report within `--root`; stdout remains JSON. The output parent must already exist. Input and output names are relative to root, and input realpaths must remain inside it. Output symlinks, output-parent escapes, and path or hard-link aliases to either input are refused with exit `2` and empty stdout. An ordinary existing output file may be replaced atomically. Without `--out`, no file is written.

## Export format

The plan is UTF-8 JSON with `schemaVersion: "1"` and a nonempty `steps` array. Each step has a unique opaque `id`, `input` set to `keyboard` or `pointer`, and a nonempty `expect` object with any combination of `focus` (control ID), `validationText` (exact string), or `mockSubmit` (JSON object). An optional plan `complete` marker must be `true` if present. Trace JSON has `schemaVersion: "1"`, required `complete: true`, and a `steps` array. Each observed step has the matching `id` and `input`, plus observed `focus`, `validationText`, and/or `mockSubmit` fields. A trace may omit an observed field, but it then fails any corresponding expectation. IDs and focus control IDs must be nonblank strings up to 128 UTF-16 code units without control, bidi, or format characters. Extra root or step keys are invalid; `endpoint`, `url`, and other action fields are never acted on.

Matching uses exact step IDs internally and requires the same order. Focus and validation text compare exactly; mock-submit JSON compares structurally, so object property order is irrelevant. Missing, duplicated, malformed, extra, or explicitly partial trace evidence yields `incomplete`, not an asserted clean flow. The tool cannot establish that the trace itself was captured correctly; it checks the exported record only. Use synthetic values in examples and test exports, not real personal data.

## Rules and exits

| Rule | Severity | Meaning |
| --- | --- | --- |
| `step-order-mismatch`, `input-mode-mismatch` | error, fail | The recorded sequence or keyboard/pointer mode differs. |
| `focus-mismatch`, `validation-mismatch`, `mock-submit-mismatch` | error, fail | A recorded assertion differs from the plan. |
| `step-unobserved`, `trace-unexpected` | error, incomplete | An expected step is absent or an extra trace step is present. |
| `plan-step-invalid`, `trace-step-invalid`, `plan-duplicate`, `trace-duplicate` | error, incomplete | A step index is unusable or ambiguous. |
| `plan-invalid`, `trace-invalid`, `plan-incomplete`, `trace-incomplete` | error, incomplete | Required or complete exported evidence is absent. |
| `input-unreadable`, `byte-limit`, `depth-limit`, `record-limit`, `time-limit` | error, incomplete | An input cannot be evaluated within declared limits. |

Exit `0` means `pass`, exit `1` evaluated `fail`, and exit `2` `incomplete` or invalid invocation. Invalid options/configuration and output refusal leave stdout empty with a generic stderr diagnostic. Unreadable, undecodable, or unparseable input yields an `incomplete` JSON report. Reports follow the catalog v1 envelope. `@plan` and `@trace` are fixed logical roles for the exact files named at invocation, not filesystem paths; `/steps/N` uses zero-based ordinal provenance. Each finding carries a safe generated `stepId` such as `step-1`, mapped to the plan or trace ordinal. Raw step IDs, focus IDs, validation text, and mock-submit values never appear in the report. Findings sort by `(location.file, location.pointer, ruleId)` in JavaScript code-unit order; identical inputs produce identical stdout.

## Limits and non-goals

Each input file is limited to 1,048,576 bytes. At most 100 plan steps and 100 trace steps, JSON depth 5 (each document root at depth 0), and 5,000 ms of evaluation. Each bound accepts exactly N and returns `incomplete` at N+1. This tool does not run a browser, move focus, trigger validation, submit a form, compare screenshots, or contact a mock or real endpoint. It reports only on the exported local trace, even when a field is named `mockSubmit`.

MIT licensed; see [LICENSE](./LICENSE).
