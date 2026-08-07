# NAF.AC — Agent Control: making the fleet steerable

**Status: PROPOSAL — awaiting operator approval. No code.**
Trigger: operator, 2026-08-07 — *"I must have control over how the agent
works. How do I control it? Do they work with the prompt, or what?"* plus a
mandate to research enterprise competitors and close the gap.

---

## 1 · How control works TODAY (verified in code, not from memory)

**Yes — each worker is driven by a prompt.** It is called its *charter*, and
it is the literal instruction the model receives every run. You can already
read every charter verbatim on its worker page. What you cannot do is
change it from the UI.

| Control | Where it lives now | Can you change it? |
|---|---|---|
| The prompt (charter) | `apps/api/src/services/agent-fleet/charters/*.charter.ts` — code, versioned in git | ❌ **code change + deploy only** |
| On/off + autonomy dial | `AgentCharter.enabled` / `.autonomyLevel` | ✅ worker page |
| Autonomy cap | code constant per charter | ❌ code |
| Daily budget, token cap, findings cap | code constants | ❌ code |
| Evidence-age tolerance, dedupe grammar | code constants | ❌ code |
| Which evidence it reads (`observationKeys`) | code | ❌ code |
| Which tools it may propose (`toolNames`) | code | ❌ code |
| Model | `AiFeatureModelPref`, per TIER not per worker | ⚠️ Settings → AI, a different page |
| Schedule | one sweep + one council cron, fleet-wide | ❌ env vars |
| Scope (marketplaces / campaigns) | columns exist on `AgentCharter` and are read into the registry — **and nothing enforces them** | ❌ dead config |
| Kill switch / halt | env var + fleet halt | ✅ (halt) |
| Run now | `POST /agent/fleet/run/:key` exists | ⚠️ no button anywhere |

So the honest summary: **you can turn a worker on, move its dial, and stop
the fleet. Everything about *how it thinks* is a code change.** For a
system whose whole promise is operator control, that is the gap.

Three latent problems fall out of that table:

- **Scope is a lie of omission.** The fields exist, the UI could show them,
  and no code path filters evidence by them. Shipping a scope control
  without enforcement would be worse than not having it.
- **Model pinning is per tier, not per worker.** Pinning "analyst" pins all
  three analysts. There is no way to try a cheaper model on one worker.
- **A prompt change is a deploy.** No preview, no diff, no rollback, no way
  to know whether the change made the worker better or worse.

---

## 2 · What the market does (research, 2026)

**Enterprise agent platforms** — Microsoft's Agent 365/Copilot Studio
deliberately *separates governance, authoring, and runtime*: instructions
are authored in the UI, a test panel replays conversations before release,
and a control plane governs what agents may do. Salesforce Agentforce pairs
an Agent Builder (topics → actions → guardrails, with **approval required
for data-modifying actions**) with a **Testing Center** and a **Reasoning
Log** for auditability. AWS Bedrock AgentCore wraps any framework with
isolation and networking. The common shape, stated plainly in the
control-plane literature: *the control plane decides which tool calls an
agent may make, which model traffic it may issue, which actions need human
approval, and records everything for later review.*

**Prompt management** is its own product category — PromptLayer, LangSmith,
Langfuse, LangWatch, Agenta, Vellum. The consensus feature set:
immutable **versioned** prompts, **side-by-side diffs**, an **approval
workflow**, **instant rollback without a redeploy**, a **playground** to
try a variant against real inputs, **environment promotion** (dev → prod),
and **A/B testing in production**. The phrase that recurs: prompts are
*core software assets*, not strings in code.

**Evaluation** is the gate everyone puts in front of a prompt change —
Braintrust, Arize, Galileo. Offline evaluation runs the agent against a
curated **golden dataset** before deployment; the same eval definitions run
locally, in CI, and in production; and a CI check **blocks the change** if
quality drops below threshold.

Sources: [Preloop — the AI agent control plane in 2026](https://preloop.ai/resources/ai-agent-control-plane-2026) ·
[Microsoft Learn — authoring agent instructions](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/authoring-instructions) ·
[Microsoft Learn — test your agent](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-test-bot) ·
[Smartbridge — Agentforce vs Copilot Studio 2026](https://smartbridge.com/salesforce-agentforce-vs-microsoft-copilot-studio-2026-comparison/) ·
[wetheflywheel — enterprise agent platforms 2026](https://wetheflywheel.com/en/guides/enterprise-ai-agent-platforms-2026/) ·
[PromptLayer — prompt management](https://www.promptlayer.com/prompt-management/) ·
[Braintrust — best prompt versioning tools](https://www.braintrust.dev/articles/best-prompt-versioning-tools-2025) ·
[LangWatch — prompt versioning & deploy](https://langwatch.ai/blog/what-is-prompt-management-and-how-to-version-control-deploy-prompts-in-productions) ·
[Confident AI — CI/CD for testing agents](https://www.confident-ai.com/knowledge-base/compare/best-ci-cd-tools-testing-ai-agents-before-production-2026) ·
[Galileo — agent evaluation platforms](https://galileo.ai/blog/best-ai-agent-evaluation-platforms)

**Where we already beat them.** Worth saying, because it shapes what to
copy and what not to: our preview-only tools mean an agent *structurally
cannot* reach Amazon; our critic is an adversarial second model with
code-computed blocks it cannot waive; our trust ladder is earned on
measured evidence with automatic demotion; and our findings are
shadow-graded against deterministic engines. Most platforms have approval
gates; few have an adversarial reviewer and none of this shadow-grading.
The gap is **not** safety — it is **authoring, iteration and evidence**.

---

## 3 · The gap, named

1. **No prompt authoring.** Charters are code. (Everyone else: UI + versions.)
2. **No diff / history / rollback** of behaviour changes.
3. **No preview.** You cannot run a worker against today's real evidence to
   see what it *would* find, without it writing findings.
4. **No evals.** Nothing tells you a new charter is better or worse than the
   old one before you enable it.
5. **No per-worker model choice** (tier-level only), no cost/quality trial.
6. **Policy knobs are constants** — budget, caps, evidence age.
7. **Scope exists but is inert.**
8. **No run controls in the UI** — no run-now, no cancel, no "pause for a week".
9. **No control audit** — who changed which dial, when, and why.
10. **No A/B or canary** — one charter, all runs.

---

## 4 · Proposed phases (AC series)

Design rules carried from FX: sentence → card → JSON; names not IDs; every
new term gets a glossary entry; nothing ships un-dark; honesty over polish.
Plus one new rule for this series: **a control that is not enforced must not
be rendered** (the scope lesson).

### AC.1 — Charter Studio: the prompt becomes an editable, versioned artifact
- New `AgentCharterRevision` table: full prompt text + policy snapshot,
  author, note, `createdAt`, `activatedAt`, `supersededAt`.
- Registry resolution becomes **code default ⊕ active revision** (code stays
  the floor and the fallback: an unreadable/absent revision means the code
  charter runs, exactly like today's fail-safe).
- UI on the worker page: edit the charter, see a **diff against what is
  running**, save as a new revision with a mandatory one-line note,
  **activate**, **roll back** to any earlier revision in one click.
- Acceptance: a behaviour change ships without a deploy; every change has an
  author, a note, and a revertible predecessor; the code charter always
  remains recoverable.

### AC.2 — Preview: run it without letting it write
- Executor gains a `preview` mode: gathers real evidence, calls the model,
  validates the output — and writes **nothing** to the blackboard.
- UI: "Try this charter" on the studio → shows the findings it *would* have
  written, the cost, the token count, and validation errors verbatim.
- Side-by-side: current charter vs draft revision, same evidence, both
  outputs on screen.
- Acceptance: an operator can judge a prompt edit in under a minute without
  any risk, and the run is visibly marked `preview` in the trace.

### AC.3 — Evals: evidence before promotion
- A golden set built from OUR history: past observations + the findings the
  deterministic engines proposed on the same data (we already store both —
  this is the shadow-grade corpus).
- Run a draft revision over the golden set; score: agreement with engines,
  schema-validation rate, dedupe-key stability, cost per finding.
- The activation button surfaces the comparison ("agreement 0.81 → 0.74 —
  this revision is worse on 3 of 5 measures"); **regression blocks
  activation** unless the operator overrides with a reason (recorded).
- Acceptance: no charter reaches live runs without a measured comparison to
  the one it replaces.

### AC.4 — Policy controls, made real
- Editable per worker, in the studio: daily budget, token cap, findings cap,
  evidence-age tolerance, per-worker **model pin** (moved from Settings→AI
  so the choice sits next to the worker it affects), and cadence.
- **Scope becomes enforced**: observation builders take the charter's
  marketplaces/campaign ids and filter evidence at the query. Until a
  builder honours scope, its scope control stays hidden (the new rule).
- Acceptance: every rendered control changes real behaviour, provably —
  each one gets a test that asserts the run changed.

### AC.5 — Tool policy per worker
- Which propose-tools a worker may use, editable; per-tool risk tier and
  "always ask" shown as facts, not buried in code.
- Acceptance: removing a tool from a worker provably stops it proposing that
  action (test), and the UI explains what each tool can and cannot do.

### AC.6 — Run controls
- Run now (the endpoint exists — it needs a button), run in preview, cancel
  a stuck run, and "pause this worker until <date>" (a dial with an expiry,
  so a temporary stop is not a forgotten off switch).
- Acceptance: every state a worker can be in is reachable and reversible
  from its page.

### AC.7 — Control audit
- `AgentControlAudit`: who changed what, from what to what, when, and why —
  dial moves, revision activations, policy edits, overrides of an eval block.
- Rendered as a timeline on the worker page and exportable.
- Acceptance: any behaviour change on any day is explainable from the UI
  alone — the EU AI Act posture the spec already commits to.

### AC.8 — A/B and canary (last, optional)
- Two active revisions with a split (e.g. alternate runs), compared on the
  same scorecard measures; promote the winner, retire the loser.
- Acceptance: a split reports a real difference with sample sizes, or says
  plainly that it cannot tell yet.

---

## 5 · Sequencing

AC.1 → AC.2 → AC.3 is the spine: author, try, prove. AC.4/AC.5 widen the
surface once the pattern exists. AC.6 and AC.7 are small and can ride
alongside. AC.8 only makes sense once several revisions exist.

## 6 · Decisions needed

1. **Where prompt truth lives.** My recommendation: **code default ⊕ DB
   revision** — the code charter is the floor and fallback, a revision
   overrides it, and reverting to code is always one click. The alternative
   (DB is truth) makes the repo stop describing the system.
2. **Who may edit charters** — any operator, or a restricted permission?
   Default: the existing `ai.run` permission, with the audit trail as the
   check.
3. **Eval strictness** — does a regression *block* activation (override with
   a recorded reason), or only warn? Default: block-with-override.
4. **Scope enforcement order** — which observation builders learn scope
   first? Default: the three ads analysts, marketplace filter first.
5. **Approve the phase set and order**, or reorder/cut.

---

## Execution record (2026-08-07 — AC.1–AC.8 SHIPPED)

Commits: 54a4cbbca (AC.1 revisions + AC.2 preview, and with them the
per-worker model pin, narrow-only tool list, pause-with-expiry and
revision attribution), ea34e5ae9 (AC.3 evals, AC.4 policy + ENFORCED
scope, AC.5 tool policy, AC.6 pause, AC.7 audit), 4a5272f98 (the UI:
Charter Studio, run controls, control history), 6eef84b2b (AC.8 split
testing). Migration `20260807a_nafac_agent_control` applied to prod.

**Verified on prod, end to end:**
- Preview against real evidence: ok, would have reported **14 findings**,
  12,075 in / 6,577 out tokens — and wrote **0** (findings before 7,
  after 7). Nothing reached the blackboard.
- Revision round trip: create → activate (the new prompt was in force,
  revision 2) → revert-to-code (the code charter back in force, no active
  revision). The fallback is real.
- Charter Studio renders on the worker page with the live charter loaded,
  "0 saved revisions", empty control history, and the run controls above.

**Honest note on that verification:** it ran via `railway run` on the
workstation, where the LOCAL Ollama provider is reachable, so the preview
used `qwen3-14b-nexus` at genuinely $0. On the server the same preview
uses the pinned Haiku and costs roughly 3–4 cents. The $0 is accurate for
that run, not a costing bug — and the finding counts differ (14 local vs
7 from Haiku) precisely because they are different models, which is
itself an argument for AC.3's measured comparison.

**Deviations from the plan, recorded:**
- Caps (budget, tokens, findings) can be TIGHTENED but not loosened from
  the UI — the code value stays the ceiling, exactly like `autonomyCap`.
  Raising a ceiling remains a code change, deliberately.
- Multi-marketplace scope is REFUSED by the API rather than accepted and
  ignored, because only single-market scope is enforced end to end. This
  is the series rule ("an unenforced control is never offered") applied to
  itself.
- n-gram themes are account-wide aggregates with no campaign of their own,
  so under an active scope they are withheld entirely rather than shown
  misleadingly, and the count of withheld rows is reported.
