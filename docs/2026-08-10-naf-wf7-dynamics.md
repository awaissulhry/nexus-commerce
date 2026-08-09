# NAF.WF.7 — Dynamic workflow capabilities: the fleet-fit study

**Opened 2026-08-10. Research only — no code. Each recommendation below becomes
its own approval-gated build charter.**

The mandate, recorded 2026-08-07: *the workflow system lacks dynamic
capabilities; research thoroughly how the industry does them and how to
integrate them here the best way possible.* Contract v1 is deliberately static
— steps, edges, one trigger — and that was scope discipline, not a belief that
static is enough. This decides what dynamism **this** fleet needs.

Companion: `docs/2026-08-07-naf-wf-workflows-page.md` (the model at Part 5, the
executor at WF.4, the test lane at WF.5, the engagement close at Part 16).

---

## 0 · The finding that decides the ranking

Read the executor before reading the axes.

```ts
async function executeWalk(args: { levels: string[][]; … })
```

`executeWalk` walks **`string[][]` — levels of charter keys**. A step has no
identity beyond its `charterKey`, and `validateDefinition` enforces **one step
per worker**. That single fact sorts all eight axes into two groups:

| | needs node identity? | cost |
|---|---|---|
| conditions, retry, triggers, evidence overlay | **no** — they attach to a key or to the trigger | schema line + executor branch |
| **fan-out, sub-workflows** | **yes** — many instances of one worker, or a nested graph | rewrite the walk from keys to nodes, re-grain runs, re-grain gates, re-grain preview |

**The expensive executor change is required only by the two axes this study
does not recommend building.** That is the whole prioritisation argument, and
it is why the roadmap below is cheap.

---

## 1 · Conditionals / branching — a step that runs only if

**Industry.** [AWS Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-states-language.html)
made `Choice` the canonical vocabulary: a state that picks the next state from
input. [Zapier Paths](https://help.zapier.com/hc/en-us/articles/8496288555917-Add-branching-logic-to-Zap-workflows-with-Paths)
is the builder-product form — each condition starts a branch with its own
steps, and *"path branches run one at a time, left to right"*, which is a
scheduling surprise worth knowing. n8n splits the concept in two —
[IF and Switch](https://docs.n8n.io/flow-logic/) for branching, **Filter** for
"drop what does not match". [LangGraph](https://deepwiki.com/langchain-ai/langgraph/3.5-control-flow-primitives)
routes with conditional edges returning the next node.

**Converged:** every product has this; it is table stakes. **Argued:** whether
a condition *branches the graph* (Step Functions, Zapier, n8n) or *filters a
step* (n8n's Filter, Airflow's `ShortCircuitOperator`). **Our laws:** a branch
construct forks the DAG and forces node identity; a filter does not.

**Verdict: BUILD — as a step-level condition, not a branch.**

- **(a) Operator story.** The concrete Xavia case is cost, not logic: *"do not
  run the bid tuner if the negative miner found nothing."* Real spend, dark
  fleet, one operator — skipping an expensive step whose input is empty is the
  dynamism that pays for itself.
- **(b) Contract.** Additive, stays `v: 1`:
  ```ts
  interface WorkflowStepV1 { charterKey: string; gate: 'ask'|'act'|'inherit'
    runIf?: { after: string; test: 'found-something' | 'found-nothing' } }
  ```
  `after` must already be an ancestor — `topoLevels`' acyclicity law is
  **extended, not superseded**: the condition rides an existing edge.
- **(c) Executor.** Before calling `executeCharter`, resolve the predicate from
  the ancestor's row in this orchestration. Unmet → the step **skips**, which
  `executeWalk` already counts (`skipped++`). No new outcome, no new write.
  Gates unaffected: a skipped step cannot loosen anything.
- **(d) Four surfaces.** *Editor:* one picker on the step card ("only if … found
  something") — pure D1. *Picture:* the step reads "only if the negative miner
  found something". *Runs:* `assembleTestStatus`-style skip already renders.
  *Test lane:* the predicate evaluates against **preview** rows, so it is
  previewable by construction. *Diff:* `condition on <worker> — added/changed`.
  *Teaching:* one sentence + a drift-test alarm.

---

## 2 · Per-item fan-out — do this for EACH item

**Industry.** Step Functions `Map`, [LangGraph's `Send`](https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph.Send.html)
(*"invoke the same node multiple times in parallel with different states, before
aggregating results back"*), Vellum's Map node, n8n's item stream, Make's
iterator. **Converged:** map-reduce is the shape. **Argued:** aggregation
semantics and per-item failure.

**Verdict: DEFER.** *Our unit of work is already a batch.* An analyst charter
reads its evidence and emits **up to 50 findings in ONE run** — the fan-out is
inside the charter, one layer down. And where per-item *action* matters, the
approvals inbox is already per-proposal. Building fan-out would mint a second
grain for something the fleet grains twice already, at the cost of the full
node-identity rewrite (§0).

**Falsifier that revives it:** a charter that must run with *different inputs*
per item rather than reading a set. The nearest real case — per-marketplace
IT/DE/FR/ES — is **already served by the assignment `target`**, which narrows
evidence before the worker sees it. If a case appears that `target` cannot
express, this axis returns.

---

## 3 · Waits and timers — pause, resume, timeout

**Industry.** Step Functions `Wait`; Temporal timers;
[Inngest `step.sleep`](https://www.inngest.com/docs/learn/inngest-steps)
— *"suspends a workflow mid-execution for seconds or months at zero cost… and
resumes exactly where it stopped"*; Trigger.dev wait tokens. **Converged:**
durable sleep is the headline feature of the durable-execution category.

**Verdict: REFUSE for now — we do not have durable execution.**

`executeWalk` is an in-process `async` walk with a live-run latch
(`liveStoredRuns`). A process restart ends it; nothing is checkpointed. A wait
of any consequence means checkpointing every step's completion and resuming
from it — that is the durable-execution rewrite Inngest and Temporal *are*, not
a feature bolted onto a walk.

**The honest alternative exists today:** two routines and a schedule. Say so in
the teaching rather than shipping a sleep that a deploy silently kills.

**Interaction the charter asked me to surface, not design around:**
`nextCronFire` scans **8 days and stops**, so the two-routine workaround
inherits the same floor — nothing can be spaced more than 8 days apart by
clock. That is Part 16's open operator decision, and axis 3 makes it sharper:
raising `SCAN_LIMIT_MINUTES` buys spacing that a wait construct would otherwise
have to buy far more expensively.

---

## 4 · Event triggers — including the ABSENCE of an expected event

**Industry.** Airflow sensors; Dagster sensors;
[Prefect's *proactive* automations](https://docs.prefect.io/v3/automate/events/automations-triggers)
are the reference for absence: *"a proactive trigger will fire when its
threshold has not been met by the end of the window of time defined by
`within`"*, with a floor of 10 seconds and resolution bounded by the sweep
cadence. [Inngest `waitForEvent`](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event)
covers the presence case inside a run.

**Verdict: BUILD the ABSENCE case — priority 2, contingent on locks §5 row 9.**

- **(a) Operator story, and it is the strongest in this study.** Xavia's
  recorded history contains exactly this failure: **AMS ingest was RBAC-blocked
  and produced sparse data for a long time, undetected** — the fleet had no way
  to notice that something expected had simply stopped arriving. A silent
  failure detector is the one dynamic capability with a real scar behind it.
- **(b) Contract.** A third trigger variant, additive:
  `{ type: 'absence', expect: '<feed key>', within: '<duration>' }` — still
  **exactly one trigger per workflow**, still diffed as `trigger changed`.
- **(c) Composition with row 9 — checked, and it holds.** Row 9 proposes
  `{ type: 'assignment', assignmentId }` with the rule that *the workflow
  scheduler never arms it* and *execution enters through `runStoredWorkflow`
  and nothing else*. An absence trigger takes the **same shape**: a caller, not
  a write path (L2), armed by the sweep that already runs. **Row 9 is still
  `PROPOSED`, not `SETTLED`** — so this axis's build charter must not open
  until SB.AS countersigns, or it will design against a moving contract.
- **(d) Surfaces.** *Editor:* the trigger ladder gains a third rung. *Status:*
  "watching for X — nothing seen in 26h". *Test lane:* previewable by forcing
  the window closed. *Teaching:* the fleet's first sentence about **not**
  happening.

---

## 5 · Error / retry policies as authored branches

**Industry.** Step Functions `Retry` (max attempts, interval, **backoff rate**)
and `Catch`; Temporal retry policies; Inngest — *"each step … can be run and
retried independently and will not be re-executed if it has already been
successfully executed"*; Pipedream's retry-from-failed-step; n8n error
workflows. **Converged:** retry is *policy*, declared, not code. **Argued:**
whether a failure branch is authorable wiring (n8n) or configuration
(Temporal).

**Verdict: BUILD — narrowly, priority 3. Retry the transient class only.**

L2 permits it: *a retry is a re-CALL of an existing path.* But a blanket retry
is **wrong here** and the fleet already knows why — `classifyFailure` sorts
failures into a taxonomy, and two of its classes must never be retried: a
**budget/limit halt** is the system working (S3R's amber), and a **schema
validation failure twice over** is deterministic. Retrying either burns real
money to reach the same answer.

- **(b)** `step.retry?: { maxAttempts: 2 | 3 }` — no backoff vocabulary until
  something needs it.
- **(c)** `executeWalk` re-calls `executeCharter` **only** when
  `classifyFailure` returns the transient class; attempts stamp the same
  `orchestrationId`, so S3R's grouping already renders them as what they are.
- **(e)** Cost: executor + one schema line + one runs sentence. No new surface.

---

## 6 · Sub-workflows — a routine that calls a routine

**Industry.** [n8n Execute Sub-workflow](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow)
with typed inputs *"defined using a JSON example"* and a run-once-per-item
mode; Make subscenarios; Step Functions nested executions.

**Verdict: REFUSE at this N.** L3 permits it (composing charters is not
spawning agents), so this is a value judgement, not a legal one: **5 routines,
2–6 steps each, one operator.** Composition pays when fragments repeat; nothing
repeats yet. The cost is the full node-identity rewrite (§0) plus nested
orchestration grouping, nested gate resolution, and a nested preview story.

**Falsifier:** ≥15 routines, or one 3-step fragment appearing in 3+ routines.

---

## 7 · Data mapping WITHOUT expressions

**The charter asked me to prove or refute the anti-`{{ }}` position rather than
assume it. Refuted as stated — and it does not matter, because the question is
mis-framed for us.**

Zapier, Make and n8n all ship expression syntax and their users do use it; what
the post-mortems actually show is that expressions are where **non-technical
users stop**, which is why every one of them also ships a picker. So the
finding is "offer both, default to the picker", not "expressions are fatal".

But **law L7 makes the question different here**: steps do not pass payloads,
they read the **blackboard**. There is no `{{ steps.x.output }}` to write
because there is no mailbox. The only real question is *which* findings the
next step reads — and that is **scope**, which the assignment `target` already
expresses ("this campaign", "this marketplace") and binds before the worker
sees anything.

**Verdict: DEFER, pointing at `target`.** Falsifier: an operator need to scope
by something `target` cannot express (severity, age, origin worker).

---

## 8 · Evidence-overlay chaining — the WF.5 deferral

Today the test lane tells the truth and the truth is a gap: *"Hand-offs are not
simulated yet — each worker is tested on its own."* A council test therefore
proves nothing about the council: the director previews against **today's
board**, not against what the analysts would have just produced.

**Verdict: BUILD — priority 1. The cheapest real dynamism in this study.**

- **(a)** It closes an **admitted** hole in a shipped surface, which no other
  axis does.
- **(b) No contract change at all.** Nothing in the definition moves.
- **(c)** Confined to the preview path: the walk keeps each step's
  `previewFindings` in memory for the duration of the test and hands the next
  step an **overlay** — the board as it *would* be. Inside L7 (a read-time view
  of the blackboard, never a mailbox) and inside L2 by construction, because
  the preview path writes nothing.
- **(d)** *Test lane:* the sentence flips from "not simulated yet" to what it
  actually did. *Runs/editor/picture:* **unchanged** — this axis touches one
  surface. *Teaching:* one sentence retired, one added.
- **(e)** Cost: `workflow-test.service.ts` + `agent-executor`'s preview branch.
  No schema, no editor, no diff line, no new grain.

---

## 9 · The roadmap

Ranked by operator value per unit of new complexity. **Four of eight axes are
recommended; the two that would force the executor rewrite are not among them.**

| # | Charter | Axis | Cost | Gate |
|---|---|---|---|---|
| **WF7.a** | Evidence-overlay chaining in the test lane | 8 | preview path only — no schema, one surface | none |
| **WF7.b** | Step-level conditions (`runIf`) | 1 | +1 schema field, +1 executor check, 4 surfaces | none |
| **WF7.c** | Absence-of-event trigger | 4 | +1 trigger variant, a sweep, 3 surfaces | **locks §5 row 9 must say SETTLED** |
| **WF7.d** | Classified retry | 5 | executor + 1 schema line | none |
| — | Fan-out · data scoping | 2, 7 | DEFERRED, falsifiers recorded | — |
| — | Waits · sub-workflows | 3, 6 | REFUSED (no durable execution · wrong N) | — |

**The warning this study keeps in front of it:** OpenAI's Agent Builder was
killed 13 months after launch. The failure mode is not missing capability, it
is capability nobody asked for arriving faster than trust. This fleet is still
**entirely switched off** and has never acted on Amazon. A study that
recommended all eight axes would have been recommending a product for an
operator who does not yet exist.

---

## 10 · Sources

**State machines** — AWS Step Functions:
[Amazon States Language](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-states-language.html),
[error handling: Retry/Catch](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html).
**Durable execution** — Inngest:
[steps](https://www.inngest.com/docs/learn/inngest-steps),
[how functions execute](https://www.inngest.com/docs/learn/how-functions-are-executed),
[wait for event](https://www.inngest.com/docs/features/inngest-functions/steps-workflows/wait-for-event),
[durable execution](https://www.inngest.com/platform/durable-execution).
**Orchestrators** — Prefect:
[automations & triggers (proactive/absence)](https://docs.prefect.io/v3/automate/events/automations-triggers),
[event triggers](https://docs.prefect.io/v3/concepts/event-triggers).
**Builder products** — Zapier:
[Paths](https://help.zapier.com/hc/en-us/articles/8496288555917-Add-branching-logic-to-Zap-workflows-with-Paths),
[filter and path rules](https://help.zapier.com/hc/en-us/articles/8496180919949-Filter-and-path-rules-in-Zaps);
n8n: [flow logic](https://docs.n8n.io/flow-logic/),
[Execute Sub-workflow](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow),
[sub-workflows](https://docs.n8n.io/flow-logic/subworkflows/).
**Agent-native** — LangGraph:
[control-flow primitives](https://deepwiki.com/langchain-ai/langgraph/3.5-control-flow-primitives),
[Send API](https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph.Send.html).

**Read in this repo:** `orchestrator.ts` (`executeWalk`, `runStoredWorkflow`),
`workflow-defs.ts` (contract v1, `validateDefinition`), `fleet-graph.ts`
(`topoLevels`), `workflow-test.service.ts` (the preview walk),
`agent-executor.ts` (the preview branch, gates, stamping), `run-health.ts`
(`classifyFailure`), and locks §5 rows 9 and 10.
