# NAF.AQ — The Approvals page (`/fleet/approvals`): what it is for, and what is on it

**Status: APPROVED by the operator 2026-08-07 — AQ.0 and AQ.1 BUILT.**
Execution record in Part 11; the phases still open are AQ.2–AQ.10.

Page 2 of ten (`docs/2026-08-07-naf-sb-fleet-pages.md` Part 3, Operate group).
Stream `SB.AQ`, claimed in `docs/2026-08-07-naf-sb-session-locks.md` §2.

A new series letter on purpose. **AP.1–AP.8 is closed** — it built the approval
*panel* on the fleet Overview and did it well. This is a different object: a
page, with room for things a panel could not hold, and a duty the panel never
had. Calling it AP.9 would make the record ambiguous about which artefact a
phase belongs to.

---

## PART 0 — The one sentence

> **This is where the fleet stops and asks, and where you answer.**

Everything else is a consequence. If a section cannot be justified as *helping
the operator answer well, telling them what became of an answer, or telling
them honestly why there is nothing to answer* — it belongs on another page.

---

## PART 1 — Ground truth, and the two facts that reorganise the page

Everything below was verified against the code and against the production
database this session. Where a number is stated, the query is cited.

### 1.1 The headline: the Waiting view cannot fill. Not "is empty" — *cannot fill*.

The queue is filtered to three tools:

```ts
// approval-inbox.service.ts:36,77
export const FLEET_TOOLS = ['create-negative-keyword', 'graduate-keyword', 'set-target-bid']
if (view === 'waiting')
  return { status: { in: ['pending','scheduled'] }, toolName: { in: FLEET_TOOLS } }
```

All three are **preview-only**. `ads-propose.tools.ts:1-12` says so in its own
header — *"there is deliberately NO `execute`"* — and the gate refuses to queue
a tool that has none:

```ts
// approval-gate.service.ts:71-74
if (!tool.execute) {
  return { ok: true, mode: 'preview', preview: pv.preview ?? pv.data }   // ← no row created
}
```

And the council, which is the only thing that would ever queue one:

```ts
// fleet-council.service.ts:164-176
const outcome = await runOrQueueTool(item.tool, item.args, …)
if (outcome.mode === 'queued' && outcome.approvalId) { queued++ }
else { blocked++ }                                    // ← every fleet tool lands here
```

So **a plan that passes the critic still produces zero approvals**, and the
counter that records this is called `blocked` — which the fleet surfaces as
though the critic had refused it. The one plan in production
(`status='critiqued'`, `criticVerdict='block'`, `approvalIds=[]`) never reached
that loop, so this has not yet been observed; it is waiting.

A second, independent lock says the same thing from the other end: **six of
seven charters cap at OBSERVE**. Only `amazon-ads-director` has
`autonomyCap='PROPOSE'`. At maximum dial, one worker of seven could ever ask
for anything — and its tools cannot be queued.

**And a third, found by the Assignments stream and verified here.** Grep every
caller of `runOrQueueTool` in `apps/api/src`:

| Caller | |
|---|---|
| `fleet-council.service.ts:164` | **the only fleet caller** |
| `tool-loop.service.ts:197` | legacy ACP copilot loop |
| `approval-gate.service.ts:117` | `requestApproval()` — the manual button |
| `autonomous/pricing-watchdog.ts:155` | non-fleet autonomous agent |
| `autonomous/listing-quality-keeper.ts:201` | non-fleet autonomous agent |

**`executeCharter` never calls it — at any autonomy level, for any worker.** So
a sweep run, an `ask` run and an assignment run are all structurally incapable
of queuing an approval; only the **weekly council cron** can. Three independent
walls: the tool has no executor, the dial cannot reach PROPOSE, and the caller
does not exist. Any one of them alone would empty the queue.

> **The page's queue is structurally unreachable. Building triage UI over it
> without saying so would be building a waiting room with no door.**

This is not a defect of AP.1–AP.8; it is Phase F of the fleet
(`AGENT_FLEET.md` — *"AUTO, tightly scoped"* adds the executors). It is this
page's job to **say it**, because no other surface can: Controls knows the
dials, Overview knows the schedule, and nothing anywhere knows whether a tool
can execute.

### 1.2 The inversion: the requests that *can* act are the ones nobody can see

Four callers can mint an approval for `set-price`, `publish-listing`,
`send-customer-message` or `apply-content` — the copilot tool loop,
`requestApproval()`'s manual button, and **two scheduled autonomous agents**,
`pricing-watchdog` (07:00 UTC daily) and `listing-quality-keeper`. Those four
tools have executors. They are the only rows on this page that can reach the
outside world.

**How close is that to live? One row.** Verified read-only against prod
(`_apx-autonomous.mts`): both crons are *registered* — `startPricingWatchdogCron`
schedules unless `NEXUS_ENABLE_PRICING_WATCHDOG === '0'`, so the default is
**on** — and each morning the job asks `isAgentScheduleEnabled(key)`, which
reads `AgentDefinition.enabled` and returns **false when the row is missing**.
Today: `AgentDefinition` holds exactly **one** row, `pricing-watchdog`
`enabled=false` (set 2026-06-17); `listing-quality-keeper` has **no row at
all**. `CronRun` shows **0 runs ever** for both. So the hole is **latent, not
leaking** — and the distance from latent to leaking is a single toggle in the
Control Center, not a deploy.

They are also filtered out of Waiting. And the sweep does *not* share the
filter:

```ts
// approval-inbox.service.ts:514-517 — no toolName clause
where: { status: 'pending', expiresAt: { not: null, lt: now } }
```

So a real, executable request is **created → never shown in any view → silently
expired in 24 hours**. The Assignments stream, reading the same finding from
their side, named it better than I did: this is not a visibility gap, it is a
*silent terminal failure*.

### 1.3 What is actually in the table (prod, 2026-08-07)

| | |
|---|---|
| Rows | **18**, all created inside one 3-hour window on **2026-06-17** — 51 days ago |
| Status | 15 rejected, 3 executed. **0 pending, 0 scheduled, 0 expired** |
| Tools | apply-content 12 · set-price 3 · send-customer-message 2 · publish-listing 1 — **not one ads tool** |
| Risk | medium 12, high 6. **`low` has never been written** |
| `decidedBy` | **null on 18/18** |
| Reasons | 15/18, every one a script tag: `acp3b-verify`, `acp3b-reject-test`, `acp4a-verify-cleanup` |
| Median decision latency | **0.6 seconds** — machine speed |
| From the fleet | **zero**. All 16 producing runs have `mode = NULL` (pre-fleet ACP, `manual-action` / `listing-quality-keeper`) |
| `AgentExemplar` | **0** · `AgentControlAudit` **0** · `executeAfter` set on **0** rows |
| Charters | 7, all `enabled=false`, all `OFF`; effective autonomy OFF for all 7; **0 instances** |

A beginner opening the page today reads **"Decided 18"** and concludes they have
made eighteen decisions. They have made none.

### 1.4 Eight more defects, each verified in code this session

1. **The glossary lies about the clock by 7×.** `glossary.tsx` tells the
   operator *"Approvals expire after 7 days"*; `approval-gate.service.ts:22`
   is `EXPIRY_HOURS = 24`.
2. **A failed execution silently re-enters Waiting.** `approval-gate.service.ts:162-187`
   writes `status:'pending', reason:'execution failed: …'` and **leaves
   `decidedBy`/`decidedAt` set**. `DecisionCard` only explains a comeback when
   the reason starts with `not run —` (the AP.6 staleness prefix), so an
   execution failure returns with **no explanation at all** and a stale decider
   on the row.
3. **Approving a fleet tool reads as success and does nothing.** With no
   `execute`, the terminal state is `status:'approved'`, reason *"approved;
   this tool is preview-only (no execute)"*. The UI renders "Approved" in the
   ok tone. The card's own teaching line — *"nothing reaches Amazon without
   passing through here"* — is true, and its unstated converse is also true:
   nothing reaches Amazon **after** passing through here either.
4. **Reject is harder than approve.** Reject demands a typed reason; a
   low-risk approve is one click. This is the exact asymmetry the oversight
   literature names as *the mechanism that manufactures rubber stamps*. AP.8
   built anti-rubber-stamp machinery and left the strongest lever pointing the
   wrong way.
5. **The depth ladder has one rung.** All three fleet tools are
   `riskTier: 'high'` (`ads-propose.tools.ts:94,153,220`), and `heavy = high ||
   !undoable`. So **100% of fleet approvals would be heavy cards with the ack
   tick** — precisely the blanket friction AP.8's own comment says it is
   avoiding. The compact lane has no population to serve.
6. **The card never says which campaign.** The API resolves entity ids to
   names and returns them as `labels`; the client destructures them away. Every
   card describes an action on an unnamed thing.
7. **The blast-radius sentence has no money in it.** `previewBulk` produces
   *"This approves 1 action: 1 × set target bid."* The page map promised
   *"…across 3 campaigns, €12.40 of daily spend."* It also counts only
   `status:'pending'`, so a selection containing a parked row **under-reports
   its own blast radius**, and `reject-all` can promise "reject all 5" and
   reject 3.
8. **The execution result is discarded.** `tool.execute()` returns `res.data`,
   documented as an undo snapshot; nothing stores it.
   `advertising/rollback.service.ts` exists, so control #18 (Rollback) is real
   — and unreachable from an approval. Nor is there a rail badge:
   `app-nav.ts` supports `badge:` on any item and Approvals has none, though
   the page map says it "earns a permanent badge".

Also: `trackRecord` is an unbounded two-query scan of every decided approval,
run on **every** waiting-view request. It is free at 18 rows and is the first
thing to break at 500.

---

## PART 2 — What the industry does, and what binds us

Six lenses, ~120 products. Only the conclusions that change a decision here.

### 2A · The verb set (LangChain Agent Inbox, LangGraph 1.x, Claude Agent SDK, OpenAI, Vercel, Gumloop)

The 2026 field has **narrowed** to a boolean. OpenAI's MCP approvals, Vercel AI
SDK 6, Microsoft Agent Framework and Gumloop all ship approve/deny with no edit
path. Exactly two shipped things let a human *change* the action:
LangChain 1.x's `edited_action` (typed dict, rebuilds the tool call preserving
the original id) and the Claude Agent SDK's `canUseTool → {behavior:"allow",
updatedInput}`.

- **Copy the LangChain 1.x contract, not the 2025 Agent Inbox one.** The inbox
  renders one free-text `<Textarea>` per arg and stringifies every value — its
  own README admits *"the values of the keys will be strings"*. For a bid
  field that is a hole straight through the CPC ceiling: an operator typing
  `4.2` for `0.42` gets a 10× bid with nothing in the way.
- **Invert the Claude SDK's silence.** Its documented behaviour is *"Claude
  sees the result but isn't told you changed anything."* Correct for a
  permission prompt; wrong for a fleet that is supposed to learn. A correction
  is the highest-quality training signal we will ever get — not "rejected" but
  "rejected to €0.30", a labelled gradient.
- **Supersede, don't mutate.** The production-queue literature is firm: an
  operator edit expires the request and mints a new one with a new idempotency
  key, and execution runs the *stored, hash-verified* args. Mutating in place
  lets the number approved and the number written diverge.
- **Three exits, not two.** MCP elicitation distinguishes `decline` (I
  considered it and said no) from `cancel` (I am walking away). Agent Inbox
  distinguishes *ignore* (the agent hears it) from *mark resolved* (the agent
  never hears). Declining teaches; dismissing does not.

### 2B · Work-lists (UiPath Action Center, ServiceNow, Camunda, Flowable, Temporal, ITIL)

Two-thirds of this surface is machinery for arbitrating between humans —
claim/unclaim, candidate groups, delegation, quorums, CAB. Delete all of it.
What survives:

- **Bulk gated by homogeneity.** UiPath permits Bulk Edit only for actions *of
  the same type* **and** *generated by the same process version*. The single
  most transferable safety rule found. "Approve all" must never span a bid
  nudge and a customer message.
- **A supersession state.** ServiceNow's **No Longer Required** — the state for
  a request overtaken by events. Without it, stale proposals either rot in the
  queue or get deleted, and you lose the ability to tell whether the fleet was
  *wrong* or merely *late*.
- **Two clocks.** Camunda's `followUpDate` (latest you should start) vs
  `dueDate` (deadline to finish). For us: *evidence goes stale at X* and *the
  request dies at Y*.
- **No queue item without a declared expiry behaviour** — and **`Auto Complete`
  must never mean auto-approve**. UiPath offers it; Zapier and Workato default
  to it; for spend it is wrong in every case.
- **Risk classification decides the gate before a human looks.** ITIL's
  Standard (template pre-approved once, runs unattended, logged against the
  template) / Normal (operator approves, tiered) / Emergency. This is the only
  thing that makes a one-person queue tractable at volume: the queue shrinks by
  *class*, not by the operator getting faster.

### 2C · Diff-gates (Terraform/HCP, Spacelift, Atlantis, CloudFormation, Argo, GitHub Actions)

Three architectures exist. **Diff-first** computes a machine-readable dry-run
and makes apply a separate transaction against the saved artefact.
**Message-first** (n8n, Zapier, Workato) pushes hand-written text plus two
buttons. **Identity-first** (GitHub Actions) gates on *who*, showing the
approver nothing about *what*. We are diff-first, and should stay there.

- **Apply consumes a stored plan, never a re-derivation.** What was approved is
  byte-identical to what executes.
- **World-drift is a section separate from the intent diff.** Terraform 0.15.4+
  leads with *"Objects have changed outside of Terraform… the following plan may
  include actions to undo or respond to these changes."* Before that it silently
  absorbed drift. **The ads equivalent — quietly overwriting a Seller Central
  edit — is the worst outcome available to us, and we already detect it as
  CONFLICT rows.**
- **Scope the staleness check to the fields the proposal reads.** Terraform's
  global state serial produces false positives, and people learn to re-plan
  reflexively. Atlantis's targeted `undiverged` check is the corrective. Our
  AP.6 re-check — re-running the tool's own dry-run and comparing a per-tool
  list of *material* fields — is already the good version. Keep it.
- **Partial failure is normal and deserves a designed screen.** Terraform's
  answer is "run plan again and read it". Ours must be *"Applied 7 of 11: 7
  bids updated, 1 failed (429 throttled), 3 not attempted"*, with the Amazon
  error per item.
- **Approval should gate the credential, not just a flag.** GitHub gets this
  right — approval is what unlocks the environment's secrets. This is the
  structural fix for the class of bug this repo already knows
  (`dryRun` a dead field; the halt guarding 2 engines of 8).

### 2D · Control planes (Agent 365, AgentCore, ACP/AP2, LangSmith, Langfuse, Phoenix, Braintrust)

- **An approval is a scoped, expiring, single-use grant — not a boolean.**
  AgentCore Policy makes approvals *consumed*: one approval permits one act,
  look-back capped at 24h. Stripe/OpenAI's ACP token carries
  `{max_amount, expires_at, reason:"one_time"}`. AP2 splits it into three
  layers we already have objects for: standing authority (the charter), the
  specific act (the approval), and a **receipt** carrying what actually
  happened including `error`+`error_description`. What we lack is the **hash
  binding** between them.
- **`execution_path` on every write** — `auto | human-reviewed` — is the
  highest-value/lowest-cost field in the whole survey. It is the only field
  that makes an autonomy dial auditable after the fact.
- **The best approval screen found anywhere is AP2's reference card**, and it
  shows three things most consoles omit: the **current** value beside the
  proposed one, an explicit **distance to the threshold**, and a sentence
  saying what you are authorising to happen *later, unattended*.
- **"Pending approval" is a risk state, not a workflow step** (Agent 365 ranks
  it Medium, next to prompt injection). Our version: *a worker enabled with no
  approval on record*.
- **One record shape for human and machine labels** (Phoenix's
  `annotator_kind ∈ HUMAN|LLM|CODE`) turns "does my auto-grader agree with me"
  into a `GROUP BY` instead of a project.

### 2E · What is actually owed — and what is theatre

This corrects a framing carried in `docs/2026-08-07-naf-ap-approval-inbox.md`
and in `AGENT_FLEET.md` L10, and it is worth getting right because it changes
how much we build:

> **An Amazon-ads bid/keyword agent is almost certainly not an Annex III
> high-risk system.** Annex III covers biometrics, critical infrastructure,
> education, employment, essential services, law enforcement, migration and
> justice. Marketing automation is outside it. The Digital Omnibus agreement of
> 7 May 2026 deferred Annex III obligations to **2 December 2027** in any case.
> GDPR Art. 22 does not engage either — a bid change has no legal or similarly
> significant effect on a natural person. Art. 4 (AI literacy) and Art. 50
> (transparency) are the live obligations, and neither is about this page.

So **Article 14 is a design template we steal, not a conformity regime we
satisfy.** L10's *"Human oversight on high-risk decisions is a legal
requirement, not a preference"* is overclaimed for ads. I am not editing
`AGENT_FLEET.md` — it is not this stream's file — but it should be softened by
whoever owns it, because a false legal justification is a bad reason to build
something and a worse reason to keep it when it stops working.

What we build here is owed **to the money, to Amazon's ToS, and to our own
future selves at 2am**. That is a sufficient reason, and it changes what we
build:

- **Four-eyes is structurally impossible and simulating it is worse than
  admitting it.** The AI Act itself mandates two-person verification in exactly
  one place (Art. 14(5), biometric identification) — direct evidence that
  four-eyes is not what oversight generally means. A second login operated by
  the same human produces a record that *asserts* independent review where none
  occurred. Write the exception down instead; ISO 27001 A.5.3 explicitly
  permits compensating controls where segregation cannot be achieved.
- **DORA is the permission slip to build less.** External approval bodies
  correlate *negatively* with lead time, deploy frequency and restore time, and
  **not at all** with change failure rate; organisations with formal external
  approval are 2.6× more likely to be low performers. Ceremony does not buy
  safety. Automated pre-checks, reversibility and fast detection do.
- **Automation bias is measured, not folklore**: erroneous decision support
  raises incorrect decisions by **26%** (Goddard 2012, 74 studies). The
  measured mitigators are *present information rather than recommendations* and
  *position the advice less prominently* — so the delta and the evidence should
  be the largest things on the card, and the recommendation should not be the
  default focus target.
- **Habituation is neurological.** Visual processing of a warning collapses
  after the **second** exposure. Polymorphic (appearance-varying) confirms
  resist it for at least five days. Use sparingly, top tier only — polymorphism
  on routine approvals is just an inconsistent UI.
- **Cognitive forcing functions beat explanations** at reducing over-reliance,
  *and* users prefer them least. Apply to exactly one tier or we will route
  around our own control.
- **Coded reasons, customised per action type, plus optional free text.** Coded
  lists matched free-text reasoning in only 46% of 15,636 alerts, and free text
  alone is unanalysable (one study found 209 spellings of "will monitor as
  recommended"). A randomised crossover trial found customised lists beat a
  generic one at p < 0.001. Include *"the recommendation itself is
  inappropriate"* as a first-class option — it is the highest-value signal for
  tuning a fleet and generic lists suppress it.
- **Rubber-stamp detectors have published thresholds**: sustained approval rate
  >98%, median decision time <5s, zero rejections in two cycles. Two or more
  signals means the control is a ceremony.

### 2F · Triage craft (Superhuman, Linear, Gmail, Gerrit, GitHub, Stripe Radar, Ramp, GitLab)

- **Digits for dispositions, letters for navigation** (Linear). A beginner
  browsing with j/k presses letters exploratively; digits are never pressed by
  accident. `1` Apply · `2` Apply with my edit · `3` Decline, and every letter
  stays safe. The buttons can carry the digit as a chip, which teaches the map
  without a tooltip.
- **Gerrit's attention set is the only honest badge.** Count only items where
  the operator is *the blocker*, never everything open, and give the hovercard
  that says why and when. A permanently-lit badge is ignored within a week.
- **Undo by holding the write, not by compensating it** (Gmail). A compensating
  re-write leaves two entries in Amazon's change history, can race the agent's
  next run and burns write quota. AP.4 already got this right; it is worth
  recording *why* so nobody "improves" it into a toast.
- **The button states the consequence, not the verb.** Never ship a button
  labelled "Approve". *"Apply — daily budget €40 → €65"*. Stripe and Ramp both
  do this; it also makes a screenshot self-documenting.
- **Order by consequence, not by `createdAt`.** Creation order puts a €2 bid
  nudge above a budget doubling.
- **Three empty states, not one** — *the fleet is off* / *the fleet ran and
  found nothing* / *your filter hides 12* look identical if you ship one
  generic empty, and all three read as "broken" to a first-time operator.
- **Snooze is a first-class verb.** Without a "not now" key the only way to
  clear a badge is to approve — the exact failure a spend queue cannot afford.
- **A command palette is the best onboarding device ever built** because it
  prints the shortcut beside every action. Ship a palette, not a tour: a tour
  on an empty queue has nothing to attach itself to.
- **Never rely on colour alone** (WCAG 1.4.1). Safe verbs quiet and left; the
  spend-affecting action alone on the right behind a divider, carrying a euro
  figure in its own label and a glyph, and **not the focus target**.

---

## PART 3 — What this page is NOT

Stated once, so nothing gets built twice. Derived from the other nine pages'
own claims, quoted from their files.

| Neighbour | Their claim | The boundary |
|---|---|---|
| **Overview** | "what needs you (approval count, expiring approvals)" | Overview states **the number** and links. Approvals states **the shape of the number** — oldest, expiring, parked, came back — and says nothing about runs, findings or spend |
| **Activity** | "Decisions: the event stream… `approval.requested` and `approval.decided`" — **already shipped**, reading `AgentApproval` directly with *no* tool filter (`fleet-timeline.service.ts:444-536`) | Activity **narrates that a decision happened**; Approvals is where a decision **is taken**, and is the only reader that defines what "waiting" means. DT.4's *"act where you read: approve or reject inline"* must not ship — it would duplicate or bypass the evidence gate, the track record, the staleness re-check and the undo window. Activity's events link here (`href` is `null` on both today) |
| **Fleet map** | overlays: autonomy / health / cost | The map may **show that approvals are waiting**; it may not decide them. Agreed with the SB.M stream this session |
| **Workers** | roster, report card, acceptance rate | Workers owns the scorecard. This page shows one narrow number — how this worker's proposals **of this kind** have fared with you. ⚠ **The two already disagree in code**: `scorecard.service.ts` counts `approved`; the inbox counts `executed` as approved too. Whichever page prints a rate must name its counting rule |
| **Workflows** | per-step `ask` gates | A gated step links here. There is never a second inbox there, and no gate editing here |
| **Assignments** | "New → Running → **Awaiting your approval** → Done" | **Settled with SB.AS this session** — they own the lifecycle state, we own the decision. `/fleet/approvals?assignment=<id>` lands the queue filtered. Contract in Part 7 |
| **Files & data** | uploads constrain reasoning | A file must never become a second write path that skips this gate |
| **Cost & value** | cost per accepted action, euros moved | "What it costs to be wrong" for **this** action is decision input and stays on the card. Any aggregate is Cost's. The likely leak is a euro total creeping onto the bulk confirmation — that one is ours, because it is a blast-radius statement, not analytics |
| **Controls** | the 20 controls, the ladder, the audit feed | Controls owns **what may reach this queue and why** — dials, tiers, the `alwaysAsk` floor, expiry policy, notification settings. This page explains the gate on **this** request and links. No dial is editable here. Note every decision already writes a `AgentControlAudit` row (`approve_action`, `reject_action`, `undo_approval`, `stale_refused`) which Controls renders — our record section stays the **approvals table**, not the audit feed |

Two more, explicitly out:

- **`BulkAutomationApproval` / `/api/bulk-automation-approvals`** — the listing
  automation queue. A separate system sharing no code. Putting it here would
  make the rail badge count two unrelated things.
- **`/marketing/ads/bulk`** — owns bulksheets. Part 7's homogeneous batch is not
  a second bulk editor.

---

## PART 4 — The proposed sections

Ten. The teaching layer is a condition of done on every one, not a section.

A structural idea that runs through S2 and S3: **the two strips trade places.**
When the queue is empty, S2 ("can anything arrive?") is the page and S3 is one
line. When the queue is full, S3 ("what is here, and what is urgent") is the
page and S2 is one line. Neither is ever absent, because the day S2 silently
disappears is the day an empty queue starts lying again.

### AQ-S1 · The header and the standing promise

**Purpose.** Tell someone who has never seen the fleet what this queue
guarantees, before they read a number — and keep saying it on the day the queue
is full.

Contents: `FleetPageShell` title and subtitle; a persistent two-line promise
that does not scroll away — *nothing on this page has happened yet*, and
*nothing the fleet proposes reaches Amazon unless you say yes here*; the shared
"How approvals work" drawer answering six questions (who may ask you · what the
critic already rejected before you saw it · what happens the moment you say yes
· what happens if you say nothing · whose name goes on the record · what this
page cannot do); a `Cmd+K` palette that prints every shortcut beside its action;
and `<Term>` tooltips on every piece of jargon.

**Why its own section.** The promise is the one sentence that must survive a
full queue. Inside the empty state it disappears exactly when volume makes
rubber-stamping tempting.

**Glossary debt** (append-only, one definition per term — re-read the file
immediately before editing): `approval`, `risk-tier`, `undo-window`,
`staleness`, `blast-radius`, `propose`, `critic`, `exemplar` exist.
New: **`reversibility-class`**, **`superseded`**, **`preview-only`**.

### AQ-S2 · Can anything reach this queue? — the gate's own state

**Purpose.** Answer the question an empty queue always raises: *is this empty
because nothing needs me, or because something is broken?* Today the honest
answer is **both**, and no other page can give it.

One plain sentence for each:

1. **Is the fleet on?** Today: no — seven charters, all OFF.
2. **Who could ask?** Only workers at PROPOSE. Today: none, and **six of seven
   cap at OBSERVE**, so at maximum dial exactly one worker could ever ask.
3. **Can what they propose actually run?** Today: **no** — all three fleet
   tools are preview-only, the gate refuses to queue a tool with no
   `execute()`, and an approve on one would record your decision, teach the
   fleet, and write nothing to Amazon. *This is the most load-bearing fact on
   the page and it is currently stated nowhere in the product.*
4. **When could something appear?** **The weekly council, and nothing else** —
   not the sweep, not an `ask`, not an assignment, because `executeCharter`
   never calls the queueing path. Naming the sweep here would be the fourth
   stale constant.
5. **What happens if you do nothing?** A request expires **24 hours** after it
   is made; expiry means refused-and-recorded and **never** auto-approved; the
   sweep runs every 30 seconds whether the fleet is on or off.
6. **What this queue does not cover.** The four tools with executors that route
   through their own downstream gates, and the ads write gate behind
   everything.

**Why its own section.** It joins three facts that live on three different
pages — the dials (Controls), the schedule (Overview) and executability
(nowhere) — into the one answer this queue needs. Without it, an empty state is
indistinguishable from a broken pipe. Today it genuinely *is* a broken pipe, and
the operator deserves to be told rather than to discover it.

**Data.** `/agent/fleet/state` and `/schedule` exist. New and trivial: one
derived boolean per tool, `typeof tool.execute === 'function'`, read straight
off the registry. `EXPIRY_HOURS` and the cron cadence surfaced as declared
constants rather than retyped into copy — that is how the glossary drifted to
"7 days" in the first place.

### AQ-S3 · Where the queue stands

**Purpose.** A different question from the list below it: *do I have to act in
the next hour, and what is the rail badge actually counting?*

Tiles, each one a filter (the house pattern from Workers S2): **Waiting ·
Expiring within the hour · Parked right now · Came back · Oldest**. Plus the
reconciliation line: how many requests are waiting **outside** the fleet views,
with a jump to S5.

**Why its own section.** These are cross-cutting derivations over the whole set
that no row can carry, and this is the only place the badge's number is
explained. Folded into a list header, the two facts that most change behaviour
— the expiry clock and "a yes may write nothing" — become the footnote nobody
reads, which is exactly where they sit today.

### AQ-S4 · Waiting for you — the list, the empty state, and the first item

**Purpose.** The queue itself, and for the coming weeks the most important
screen on the page: an empty queue that teaches instead of apologising.

- Grouped by worker under the worker's **real name** (never a raw key, never
  "unknown"; "an agent we cannot identify" is the existing, correct fallback).
- **Ordered by consequence, not by `createdAt`** — euros at risk × reversibility
  — with age and time-to-expiry on every row. `expiresAt` is stored on every row
  and rendered nowhere today.
- The row carries the money and the target so most decisions need no opening:
  worker · action in plain words · **the entity by name** · before → after ·
  the reason · risk · time left.
- **Three distinct empty states**: *the fleet is off and here is why nothing can
  arrive* (links S2) · *the fleet ran and found nothing* · *your filter hides
  N*.
- **A worked sample card, visibly inert**, so the operator has read a real
  proposal before their first real one arrives.
- **A one-time band above the first genuine fleet approval this account ever
  receives**: that it is the first, that nothing has happened yet, and that
  taking twenty minutes over it is the correct speed.
- A deep-link anchor per item, plus `?assignment=` (the SB.AS contract).

**Why its own section.** The empty state *is* this page for weeks. Reviewed as
a footnote to the list it gets written last and worst — and the first-item
moment is the single transition where the page stops being theory and starts
being money.

### AQ-S5 · Waiting from outside the fleet

**Purpose.** Show the requests no view shows — the only ones on this page that
can actually change a price, publish a listing or email a customer.

Same card vocabulary (all four are already in `TOOL_CARDS`), decided through
the **fleet** route so the decision is attributed, parked with the same
twenty-second undo, audited and turned into precedent — never through the older
route, which records no name, skips the undo, skips the staleness re-check and
teaches nothing. Honest about what cannot be shown for these rows: no worker
join, no track record, no resolved entity names. One line per action saying
where a yes actually goes, and that each has its own gate after this page.
Collapses to a single line when empty, which it usually will be.

**Why its own section.** Different producer, different endpoint, different cap,
thinner payload — and the *opposite* consequence. Appending them to the waiting
list would put two truncation rules and two qualities of attribution under one
count, which is precisely how a queue starts lying to the person who trusts it.

⚠ **This is the section that closes the silent terminal failure of §1.2**, and
it needs an operator decision (Part 6, Q1): does this page own **all**
approvals, or only the fleet's?

### AQ-S6 · The decision card

**Purpose.** One proposal, with enough on it to decide without opening anything
else, and enough friction that a serious change cannot be waved through.

Seven things, in this order — the "decision packet" the research converges on:

1. **What would change, and on what** — naming the actual campaign, ad group or
   search term. The API already resolves this and the client throws it away.
2. **The change as before → after**, with the current value read **live**, not
   the value the worker happened to see. *"€0.31 → €0.84 (+171%)"*; never
   *"bid €0.84"*, which is unjudgeable.
3. **Why**, in the worker's words, with **the evidence rows it read and how
   fresh they are**. *"decided on 3 days of AMS coverage"* is a fact the
   operator can weigh; a confidence percentage is not. This repo already knows
   sparse AMS coverage produces confident-looking garbage
   (`reference_ams_per_campaign_coverage`).
4. **What it costs if it is wrong**, in euros wherever a euro figure is honest.
5. **Whether it can be undone**, as one of three classes — *we can put it back*
   / *only compensated for, the spend is gone* / *not at all*. Never softened,
   never asserted in two places that can drift.
6. **How this worker's proposals of this kind have fared with you.**
7. **The expiry clock**, and what happens when it runs out.

Plus, as its own stacked block above the intent diff: **"Changed outside Nexus
since we last looked"** — the Terraform drift preamble. Seller Central edits,
Amazon's own automation, `CONFLICT` portfolio rows. The sentence a single
operator needs before an agent reverts a deliberate human edit.

**Re-tier the depth ladder.** Today `heavy = high risk || not undoable`, and
100% of fleet approvals are high risk, so the ladder has one rung and the ack
tick is blanket friction. Drive depth from **reversibility class × euros at
risk**, not from `riskTier` alone.

**Why its own section.** This is the entire product. Every other section is a
container for it, and it is the only one where getting the contents wrong
produces a confident, well-designed, wrong decision.

### AQ-S7 · The four answers

**Purpose.** Give the operator the four responses a real decision needs — yes,
yes-but-not-like-that, no, and I-need-to-know-more — instead of forcing every
near-miss into a rejection and a rerun.

- **Approve** — parks rather than fires (S8), may carry an optional note.
  Today approve is called with no reason at all, so only rejections can teach.
- **Edit-then-approve** — the one thing the industry standard has that we do
  not. **Typed, bounded fields**, never free-text: a bid is euros to two
  decimals inside the min-bid floor and under the CPC ceiling; a match type is
  an enum. Re-validated against **the same guards the write path uses**, and it
  **supersedes** the original row with a new idempotency key rather than
  mutating it. The edited card shows which fields the operator changed beside
  what the worker proposed.
- **Reject**, with a **coded reason customised to the action type** plus
  optional free text — including *"the recommendation itself is
  inappropriate"*.
- **Ask** — sends a question back to the worker and leaves the request waiting
  rather than deciding it.
- **Snooze** — "not now", waking on a clock **or on new evidence**.

**Symmetric friction.** Reject must be no harder than approve. Today it is
harder, and that asymmetry is the documented mechanism that manufactures rubber
stamps. Coded reasons on both sides fixes it: one click each, free text
optional on either.

**Buttons state the consequence**: *"Apply — daily budget €40 → €65"*, not
"Approve". Dispositions on digits `1`/`2`/`3`; every letter stays safe.

**Why its own section.** The verb set is this page's contract with the operator,
it carries the only genuinely new backend, and **edit** is where an operator
typing `4.2` instead of `0.42` becomes a ten-times bid. It needs its own review,
not a bullet inside the card.

### AQ-S8 · Deciding many at once

**Purpose.** Make clearing forty near-identical proposals a two-minute job
without making a mass mistake possible.

- **Homogeneity rule** (UiPath's): many may be decided together only when they
  are the same worker, same action kind and **same worker version**. "Approve
  all" can never span a bid nudge and a customer message.
- **Select-all scoped to the visible group or filter, never to the queue.**
  Gmail's two-step disambiguation is the minimum bar; a select-all that silently
  means "all 340 matching an unseen filter" is the most dangerous control we
  could ship.
- **The blast-radius sentence built server-side** so it cannot drift — count,
  kinds, high-risk share, **the aggregate euro ceiling**, and the irreversible
  count the server already computes and never uses. Reconciled against the rows
  that can actually be decided, so it cannot promise "reject all 5" and reject 3.
- **A result the operator can read** — *"37 done, 3 failed, here they are"* —
  instead of the silent reload that follows a partial failure now. Both bulk
  endpoints already return `failed[]` and the client discards it.

**Why its own section.** Bulk is where a trust-first page most easily becomes a
rubber stamp, and it is the only section whose failure mode is euros × N. It is
placed after the single-item verbs deliberately: bulk should be the last thing
an operator learns, not the first.

### AQ-S9 · The twenty seconds after yes — and what actually landed

**Purpose.** Make approving safe to do quickly by making it reversible, and
never claim something happened before it did.

- The **parked row** — green, in place, live countdown, inline Undo,
  deliberately not a toast. Keep AP.4's reasoning in the code so nobody
  "improves" it: a toast dies on reload; **the row is the undo**; and the write
  is *held*, never compensated, so Undo means the Amazon call never happened.
- The **stale hand-back**, saying what moved.
- **"Approved" and "it ran" are different words**, and only the second is a
  claim about Amazon. Today the preview-only terminal state renders as plain
  success.
- **What actually landed** — the receipt. Per-item status, the Amazon error on
  each failure, retry-the-remaining. Partial failure is normal when writing to
  a rate-limited third-party API and deserves a screen, not a log line.
- **Beyond the window**: a Revert action honestly labelled as a *new change
  Amazon will see*, not as an undo. `rollback.service.ts` exists; nothing links
  an approval to it.

**Three live defects this section must fix**, all found this session: a parked
row with a null `executeAfter` renders "Running now…" forever with no Undo and
never commits; a stale hand-back never resets its 24-hour clock, so the next
sweep can expire it seconds later; and a failed execution returns to `pending`
with `decidedBy` still set and **no explanation on the card**.

### AQ-S10 · The record, and what your decisions taught the fleet

**Purpose.** What you answered, why, when, who answered it — whether it
actually ran — and what the fleet learned from it.

- Decided and Expired as a compact ledger. Outcomes in impersonal words that do
  not overclaim. Your reason in your own words. Honest truncation
  (*"showing 100 of 143"*).
- **The eighteen pre-fleet rows labelled and explained**: not one is a fleet
  tool, not one carries a decider, every one was answered in under half a
  minute by a script. They are history, not precedent, and a beginner reading
  "Decided 18" must not conclude they have made eighteen decisions.
- **Expired rows read as what they are** — requests that died waiting for you,
  with how long they waited. That number is the one signal the queue is beating
  the operator.
- **Precedent**, read-only: worker, action, accepted/rejected, your note
  verbatim — plus a plain statement of how it is used (the most recent N go
  into that worker's next prompt) and the honest empty state, which today is
  the true one. Nothing in the API can switch off, reweight or correct a
  precedent; do not render a control that cannot act.
- Every row links to the same event on **Activity** rather than restating it.

**Why one section and not two.** The precedent panel is the *consequence* of the
record, it is the only argument against rubber-stamping that does not rely on
fear, and it is the entire justification for asking for a reason at all.
Separating them puts the reward on a different screen from the work.

### Deferred, and named so it is not lost: the oversight check

Rubber-stamp detection over the operator's own behaviour — approval rate,
median decision latency per action type, edit rate, override rate **per worker**
(never in aggregate, which hides the one worker being blindly trusted). The
research gives published thresholds and the honest reading: near-zero override
is ambiguous between a great worker and a rubber stamp, so it is read alongside
latency and sampled review, never alone.

**It cannot ship yet.** It needs ~20 real decisions before it can say anything,
and today there are zero. Shipping it now means an empty chart on an
already-empty page — the exact thing that makes an operator stop trusting a
surface. It is AQ.10, after the queue has been used.

---

## PART 5 — What is deliberately not here

- **Notifications, digests, push, one-click approve from Slack or email.**
  Settled by the operator in AP §6.4: notification belongs to the daily brief.
  And one-click approve from a notification is rejected outright for anything
  that spends — it strips the evidence and the blast-radius sentence, and makes
  a stray tap indistinguishable from a considered decision in the record. This
  page states in one sentence that you will be told; the switch is on Controls.
- **Assign, delegate, route, escalate, second approvers, quorums.** Two-thirds
  of the enterprise approval surface exists to arbitrate between humans. There
  is one. `AgentApproval` has no assignee column and even the resolved actor's
  `userId` is discarded — `decidedBy` is free text.
- **"Always approve this shape in future."** The strongest volume mechanic in
  the whole research, and the wrong home. It edits autonomy policy, which
  Controls owns, and the research's own warning applies: rules minted in a
  moment of impatience accumulate into invisible auto-approvals nobody can
  audit. The honest equivalent is the trust ladder, linked from S10.
- **SLA / expiry configuration.** The 24-hour clock is *explained* here and
  *set* on Controls. A settings form on a decision surface is how a queue page
  becomes a settings page.
- **Saved views, server-side search, cursor pagination — at first.** The
  endpoint has no `q`, no cursor and three hardcoded views, and there is no
  index on `toolName` or `decidedAt`. Filtering starts client-side over the
  loaded set with an honest *"showing N of M"*, and graduates only above a
  volume threshold. Filters over an empty table teach a beginner a concept and
  give them nothing.
- **Live staleness re-checking on every render.** `checkStaleness` re-runs each
  tool's database-backed dry-run. On-demand button, plus the automatic check at
  commit.
- **A chat thread with the worker.** Chat-first review is the named
  antipattern: a conversation is where decisions go to be lost. *Ask* stays a
  structured verb whose answer returns to the card.
- **A separate "currently parked" view.** The parked row already sits where the
  operator is looking. A separate view splits attention during the twenty
  seconds when attention matters most.

---

## PART 6 — Operator decisions — **SETTLED 2026-08-07 ("go ahead")**

The operator approved the study as written, which settles all seven at the
recommendation. Recorded here in the form they will be built to:

1. **This page owns every approval**, with the fleet / non-fleet split visible.
2. **The page says out loud that a yes writes nothing today.** Built in AQ.1.
3. **Edit-then-approve supersedes**, never mutates.
4. **Coded reasons on both sides.** Reject stops being harder than approve.
5. **The badge counts only what blocks you**, and reads zero when the fleet is
   off.
6. **Snooze exists**, waking on new evidence as well as on a clock.
7. **The glossary's "7 days" is fixed in AQ.0.**

The original questions and their reasoning are kept below, because the
reasoning is what a later reader needs — a settled decision with no argument
attached is the thing nobody can revisit safely.

### The questions as asked

**Q1 · Does this page own every approval, or only the fleet's?**
*Recommendation: every approval, with the fleet / non-fleet split visible
(S5).* The alternative leaves live, executable requests — price changes,
listing publishes, customer emails — created, invisible, and expired unseen in
24 hours. That is happening today.

**Q2 · Do we say out loud, on the page, that a yes writes nothing right now?**
*Recommendation: yes, prominently, in S2.* The alternative is a screen that
implies a gate is protecting Amazon when the actual protection is that the
action cannot execute at all. When Phase F adds executors, that sentence
changes — and the operator will know exactly when it changed.

**Q3 · Edit-then-approve: supersede or mutate?**
*Recommendation: supersede.* A new row, a new idempotency key, the dry-run
re-run to regenerate the preview, the edited numbers re-validated against the
write path's own guards. It costs more and it is the only version where the
number approved is provably the number written.

**Q4 · Symmetric friction — coded reasons on approve as well as reject?**
*Recommendation: yes.* Today reject demands typing and approve is one click,
which is the documented mechanism that manufactures rubber stamps. One click
each, a short customised coded list on both, free text optional on either.

**Q5 · What does the rail badge count?**
*Recommendation: only items blocking you* — Gerrit's attention set —
**including** the non-fleet ones under Q1, and **zero** when the fleet is off.
A badge that lights up for informational output is ignored within a week. If
the badge counts three views and the page shows four sources, the first thing
the operator learns is that the badge is wrong.

**Q6 · Snooze?** *Recommendation: yes*, waking on new evidence as well as on a
clock. Without a "not now", the only way to clear a badge is to approve.

**Q7 · Should I fix the glossary's "7 days" now, in AQ.0?** It is a one-line
change to a shared append-only file and the UI currently contradicts its own
constant by 7×.

---

## PART 7 — The cross-stream contract (settled 2026-08-07)

Agreed with the **Assignments** stream (`SB.AS`) this session, over five
exchanges. Recorded here and mirrored into locks §5 when both studies land.

- `AgentRun.assignmentId String?` — **theirs**, additive, migration
  `20260807e`. I never read `AgentAssignment`.
- **I expose** `GET /agent/fleet/approvals/rollup?assignmentIds=…` →
  `{ waiting, parked, returned, decided, expired }`. The `decidedBy`-set-on-
  `pending` exclusion lives **inside** the rollup, not in a comment beside it.
  ≤100 ids, **rejected over the cap, never truncated** — a silently short
  answer is a wrong count on a queue that gates every write.
- **They expose** `GET /agent/fleet/assignments/labels?ids=…` →
  `{ label, targetLabel, dueAt, state, href }`. Rendered verbatim; no
  synthesised labels; no hardcoded route shape. They refused a denormalised
  label column because it goes stale on rename — the same class as this doc's
  own two stale constants (the map drawing `FLEET_GRAPH`; the glossary's 7 days
  against `EXPIRY_HOURS = 24`) and the third the Assignments stream then found
  (`scopeCampaignIds`, rendered on two shipped surfaces and enforced by
  nothing — locks §5 decision 7). Four instances in one evening makes this a
  class, not a run of bad luck: **a read surface drawing a constant no
  executor honours.** Worth a standing check on any new fleet surface.
- Deep link `/fleet/approvals?assignment=<id>`; the queue lands filtered.
- ⚠ **The provenance card line is NOT built at AQ.3.** The Assignments stream
  corrected itself after its own code recon: an assignment run cannot produce
  an approval at all, because `executeCharter` never reaches the queueing path
  (§1.1's third wall). The contract is right and stays — `AgentRun.assignmentId`
  still earns its place, and the join will be waiting the day a path exists —
  but a card line built now would have nothing to render and the only symptom
  would be that it never appears. They deleted three of their own surfaces on
  the same reasoning: **ship it deleted, not empty.** That principle applies to
  this page too, and it is why the oversight check is AQ.10 and not AQ.1.
- **`blocked` → `returned`.** "Blocked" is already **the critic's verdict on a
  plan**, and the fleet's only plan to date is blocked, so the operator meets
  that word in the other sense first. A naming collision caught before either
  side built it.
- Their deadline, my expiry. The 7-days-vs-24-hours contradiction stays visible
  on my surface until I fix it; they will not paper over it.

Also agreed with the **Fleet map** stream (`SB.M`): the map may show that
approvals are waiting; it may not decide them. The same rule goes to
**Activity**, and that one is not yet agreed — see Part 8.

**Migration letter:** a–e are taken (a AC · b AP · c WF · d W.8 · e SB.AS).
**AQ takes `20260807f`** if it needs one.

---

## PART 8 — Open with other streams

1. **Activity (`SB.ACT`) — mostly settled, and better than I proposed.**
   `fleet-timeline.service.ts` already reads `AgentApproval` directly, with
   **no** `FLEET_TOOLS` filter, and emits `approval.requested` /
   `approval.decided` with `href: null` — so two fleet surfaces read the same
   table with different rules, in production, today. Reading their study
   (`docs/2026-08-07-naf-sbact-activity-page.md`), the important half is
   already resolved without either of us asking: their run-detail boundary is
   *"renders no controls — no retry, no re-run, no approve/reject, no cancel;
   `/fleet/approvals` owns decidable items"*, and their first principle is
   **"a record is read, not operated"**. DT.4's inline approve is dead. Good.
   Two things remain, both small:
   - **They are scoping the 18 pre-fleet approvals out of the timeline** and
     pointing at this page instead — correct, because Activity should not claim
     the fleet decided something it never did. But it **falsifies a comment I
     inherit**: `ApprovalInbox.tsx`'s header justifies keeping that history
     *"because the decision timeline already shows it"*. The history still
     belongs here — for a better reason, that this is the only page that can
     contextualise it — so the comment is mine to rewrite in AQ.1, not a
     behaviour change.
   - **Ask:** give the two approval events an `href` into this queue. Today
     Activity can tell the operator a request is waiting and offer nowhere to
     go.
2. **Workers (`SB.W`) — the two acceptance rates.** `scorecard.service.ts`
   counts `approved`; `approval-inbox.service.ts` counts `executed` as approved
   too. Both pages plan to show a number derived from the same decisions.
   Whichever prints a rate must name its counting rule, or they contradict each
   other on screen. Proposal: Workers owns the rate; this page shows only
   per-worker-per-tool history and never a percentage.
3. **`AGENT_FLEET.md` L10 overclaims the legal position** for an ads fleet
   (Part 2E). Not my file; flagged for whoever owns it.

---

## PART 9 — Proposed build order

Ordered by *what is true and unsaid* first, then by what has data.

| Phase | What | Why here |
|---|---|---|
| **AQ.0** | Tell the truth: fix the glossary's 24h/7d contradiction; surface `EXPIRY_HOURS` and the cron cadence as declared constants | One-line honesty fixes that stop the UI contradicting its own code. No page needed |
| **AQ.1** | The page exists: shell, promise, **S2 gate state**, three views, waiting list with the three teaching empty states, the record | Mostly re-housing what AP.1–AP.8 shipped, plus the one section only this page can host |
| **AQ.2** | **S5 — the non-fleet queue.** Close the silent terminal failure | The only live correctness bug on the page. Gated on Q1 |
| **AQ.3** | **S6 — the card, properly**: render `labels`, before→after with the live current value, evidence freshness, reversibility class, the drift block, re-tiered depth | Where a wrong decision actually gets made |
| **AQ.4** | **S7 — symmetric friction**, coded reasons, consequence-labelled buttons, digit dispositions, keyboard + palette | Cheap, and it removes the rubber-stamp asymmetry we shipped by accident |
| **AQ.5** | **S3 — the queue-shape strip**, the rail badge, filters above a volume threshold | Needs the badge decision (Q5). Useless until something arrives |
| **AQ.6** | **S8 — bulk** with homogeneity, euros in the blast radius, readable partial results | Only matters at volume; dangerous before the card is right |
| **AQ.7** | **S9 — what actually landed**: executed ≠ approved, the receipt, partial failure, revert-beyond-the-window | Needs an executor to exist to be exercised honestly |
| **AQ.8** | **Edit-then-approve** (supersede, typed fields, re-validation) | The largest new backend, and the single highest-value gap versus the industry |
| **AQ.9** | **Ask** | Needs a channel back into a suspended run. Nothing in the fleet suspends or resumes today. Likely deferred past this series |
| **AQ.10** | The oversight check | Needs ~20 real decisions |

**Honest constraint, stated once.** With the fleet dark and the fleet tools
preview-only, **AQ.2 is the only phase that can be exercised on live data**.
Everything else ships proven by tests plus a seeded row, and must be re-verified
the first time a worker actually asks — exactly as AP.1–AP.8 recorded, and for
the same reason.

---

## PART 10 — Build conventions this page is bound by

- **CSS prefix `aq-`, in `app/fleet/approvals/approvals.css`.** `ap-` is taken
  by `fleet-sections.css` (the old panel) and both could load on one page.
- `fleet-pages.css` stays frozen to shared `acr-pg-*` primitives.
  `.fleet-surface` already pins the DS tokens the `productsNextLight` way —
  copy that, never `.h10-shell` (`reference_ds_token_triplet_collision`).
- DS `DataGrid` + `GridToolbar` + `FilterBar` + `Pagination` inside
  `h10-ds-gridcard` for any table, all four DS stylesheets imported. Settled by
  Workers STUDY 0.
- **Zero native `<select>` under `app/fleet`** — the DS ratchet checks the
  working tree, so one offender blocks every session's push.
- Real-time is `_shared/use-visibility-poll.ts` — 10s, visibility-gated, an "as
  of" stamp and a *changed since you looked* cue rather than a silent re-sort
  under the cursor. Settled for all ten pages.
- Routes go in **`agent-fleet-approvals.routes.ts`**, registered with one line
  in `index.ts`. Never `agent-fleet.routes.ts` (771 lines, a `€` binary byte so
  `grep -a`, and a duplicate path is a boot crash).
- `nav-permissions.ts` is prefix-matched, so `/fleet/approvals` already inherits
  `pages.advertising`. No new row.
- Nothing under `rules-automation/fleet/` is touched — the Overview still
  renders `ApprovalInbox` and `DecisionCard`, and that move belongs to whoever
  takes the Overview.

---

## Sources

Code and data cited inline. Research sources by lens:

**Agent inboxes** — [LangChain Agent Inbox](https://github.com/langchain-ai/agent-inbox) · [LangGraph human-in-the-loop](https://docs.langchain.com/oss/python/langgraph/interrupts) · [`HumanInTheLoopMiddleware`](https://docs.langchain.com/oss/python/langchain/middleware) · [Claude Agent SDK `canUseTool`](https://code.claude.com/docs/en/agent-sdk/user-input) · [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) · [Vercel AI SDK 6 approvals](https://ai-sdk.dev/) · [MCP elicitation](https://modelcontextprotocol.io/specification) · [Gumloop HITL](https://docs.gumloop.com/core-concepts/human_in_the_loop)

**Work-lists** — [UiPath Action Center](https://docs.uipath.com/action-center) · [ServiceNow approvals](https://www.servicenow.com/docs/) · [Camunda 8 user tasks](https://docs.camunda.io/) · [Flowable](https://www.flowable.com/open-source/docs/) · [Temporal HITL](https://temporal.io/blog) · ITIL 4 change enablement

**Diff-gates** — [Terraform plan/apply](https://developer.hashicorp.com/terraform/cli/commands/plan) · [HCP Terraform runs](https://developer.hashicorp.com/terraform/cloud-docs/run) · [Atlantis apply requirements](https://www.runatlantis.io/docs/apply-requirements.html) · [CloudFormation drift-aware change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html) · [Spacelift runs](https://docs.spacelift.io/concepts/run) · [GitHub Actions environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) · [n8n Wait node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait/) · [Zapier Human in the Loop](https://help.zapier.com/) · [Airflow HITL operators](https://airflow.apache.org/docs/apache-airflow-providers-standard/) · [Prefect pause/suspend](https://docs.prefect.io/)

**Control planes** — [Microsoft Agent 365](https://learn.microsoft.com/en-us/microsoft-agent-365/) · [AWS Bedrock AgentCore Policy](https://docs.aws.amazon.com/bedrock-agentcore/) · [Agentic Commerce Protocol](https://developers.openai.com/commerce/) · [Google AP2](https://ap2-protocol.org/) · [LangSmith annotation queues](https://docs.langchain.com/langsmith/annotation-queues) · [Langfuse annotation](https://langfuse.com/docs/scores/annotation) · [Arize Phoenix annotations](https://arize.com/docs/phoenix/) · [Braintrust review](https://www.braintrust.dev/docs) · [ServiceNow AI Control Tower](https://www.servicenow.com/products/ai-control-tower.html)

**Compliance & oversight** — [EU AI Act Art. 14](https://artificialintelligenceact.eu/article/14/) · [EDPS ADM human-intervention checklist, 18 May 2026](https://www.edps.europa.eu/) · ISO/IEC 42001 A.6/A.9 · [NIST AI RMF](https://www.nist.gov/itl/ai-risk-management-framework) · Goddard, Roudsari & Wyatt, *Automation bias*, JAMIA 2012 · Buçinca, Malaya & Gajos, *To Trust or to Think*, CSCW 2021 · Anderson et al., *polymorphic warnings*, CHI 2015/2017 · Ben Green, *The flaws of policies requiring human oversight*, CLSR 2022 · [DORA change approval research](https://dora.dev/capabilities/streamlining-change-approval/) · *What You Approve Is What Executes*, arXiv 2606.02668

**Triage craft** — [Superhuman shortcuts](https://blog.superhuman.com/) · [Linear Triage](https://linear.app/docs/triage) · [Gerrit attention set](https://gerrit-review.googlesource.com/Documentation/user-attention-set.html) · [GitHub reviews & suggested changes](https://docs.github.com/en/pull-requests) · [Stripe Radar reviews](https://docs.stripe.com/radar/reviews) · [Ramp policy agent](https://ramp.com/) · [GitLab Pajamas destructive actions](https://design.gitlab.com/patterns/destructive-actions) · [WCAG 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) · [NN/g bulk actions](https://www.nngroup.com/articles/bulk-actions/)

---

## PART 11 — Execution record

### AQ.0 — tell the truth (2026-08-07)

Two one-line honesty fixes, no page involved.

| File | What |
|---|---|
| `services/agents/approval-gate.service.ts` | `EXPIRY_HOURS` is now **exported**, with the note saying why: the glossary retyped the number and the two drifted. Any surface stating the clock reads it from here |
| `.../fleet/glossary.tsx` | the `approval` entry said *"expire after 7 days"*; the gate has always used **24 hours**. Now correct, and it also states that expiry means refused rather than approved-by-default — the fact the old sentence left out |

### AQ.1 — the page exists (2026-08-07)

| File | What |
|---|---|
| `routes/agent-fleet-approvals.routes.ts` | **new** — `GET /agent/fleet/approvals/gate-state`. Its own file per the locks protocol; one line registers it in `index.ts` |
| `app/fleet/approvals/page.tsx` | `PlannedPage` replaced by the real page. Stylesheet order copied from Workers, plus `fleet-sections.css` because the inbox it renders is built from `ap-*` |
| `app/fleet/approvals/ApprovalsClient.tsx` | **new** — the standing promise, the "How approvals work" drawer, **AQ-S2 the gate state**, and the queue |
| `app/fleet/approvals/approvals.css` | **new** — the `aq-` family |
| `.../fleet/glossary.tsx` | one new term, `preview-only` |

**The load-bearing decision: the queue itself is the shipped `<ApprovalInbox>`,
imported unmodified.** Not copied, not forked. One decision surface is the rule
this page gave the Map, Activity and Assignments streams, and it would be
absurd to break it inside its own directory. AQ.3/AQ.4 rebuild the card here
and the import goes away; until then the page is *the panel plus the truth*,
which is strictly better than either and duplicates nothing.

**What S2 actually says**, derived live rather than typed into copy: how many
workers are at PROPOSE and how many could ever be (the cap is a code ceiling);
how many of the fleet's actions can execute, computed as `typeof tool.execute
=== 'function'` off the live registry so it cannot become a stale list; that
**only the weekly council** reaches the queueing path, said explicitly because
naming the sweep here would have been this page's own stale constant; what
happens if nobody answers, in hours read from `EXPIRY_HOURS`; and — when there
are any — the requests waiting *outside* the three fleet tools, which no view
shows and which the sweep will delete.

The blockers are computed server-side and rendered verbatim, so the sentence
the operator reads cannot drift from the condition that produced it. When the
pipe is open the whole section collapses to one green line.

**Verified.** `tsc --noEmit` clean on both apps (0 errors in `apps/web`; the
only API errors in the tree belonged to a sibling session's in-flight file).
DS-conformance ratchet clean. Prod database probed read-only for every number
in Part 1 — `_apx-probe.mts` and `_apx-autonomous.mts` are committed.

**Not verified locally, and honestly so:** the endpoint's own response. Any
script importing `tool-registry` pulls `mutate.tools.ts` → the outbound queue →
BullMQ → Redis at module load, and Redis is unreachable from a laptop —
`upstash.io` in the local `.env` is dead and `railway run` injects
`redis.railway.internal`, which only resolves inside Railway's private network.
So a local probe of `gate-state` cannot run in any environment available here.
The *facts* it reports are each verified independently (the three tools have no
`execute`, `approval-gate.service.ts:71-74` refuses to queue without one, six
of seven charters cap at OBSERVE); the assembled response is verified on prod
after deploy, which is the standing rule anyway.

**Not built in this pass:** AQ.2 through AQ.10.

### Prod verification (2026-08-07, in the browser)

`/fleet/approvals` on Vercel, against the live API. Every number on the
gate-state section is real and matches the read-only probes in Part 1:

| Tile | Rendered | Source |
|---|---|---|
| Who could ask | **0 of 7** — *"1 of 7 could ever be; the rest are capped lower in code"* | 7 charters all OFF; only `amazon-ads-director` caps at PROPOSE |
| Whether their actions can run | **0 of 3**, each with a `preview only` chip | `typeof tool.execute === 'function'` on the live registry |
| When one could appear | **in 2 days** — *"the weekly council, and nothing else"* | the council cron; the sweep is named as unable |
| If you never answer | **24h**, *"expiry means refused — never approved because nobody looked"* | `EXPIRY_HOURS`, read not retyped |

Geometry measured rather than eyeballed (`feedback_no_dead_space_layouts`
requires numbers, not element presence): `documentElement.scrollWidth === innerWidth`
so **no horizontal overflow**; `.acr` is 1662px of an available 1662px, i.e.
**100% width**; the four tiles are 388px each. The unused vertical space is an
honestly empty queue, not a shrink-wrapped layout.

The Decided view renders all 18 real rows correctly: worker names not keys,
`nobody recorded` attribution, risk chips, the `pre-fleet` label, and each
reason verbatim.

**One defect, found on prod and not in review — mine.** The Decided tab
rendered under the heading *"What you already decided"*, above eighteen rows
that each say `nobody recorded` and carry a `pre-fleet` chip. Those were script
runs in June. **The operator has never decided anything**, so the heading
credited them with eighteen decisions — two lines above the inbox's own footer
saying the opposite. This is verbatim the day-one trust hazard Part 1.3 names,
shipped in copy written by the same session that named it, which is worth
recording rather than quietly fixing. Now **"The decision record"**, true
whoever decided (`f4d0d525c`).

The lesson generalises past this page: **the honest-attribution work was done
at row level and the heading was never re-read against it.** Any summary line
above a list of records inherits the list's weakest claim, and needs checking
against the emptiest and most embarrassing case, not the imagined full one.

### AQ.2 — the non-fleet queue, and the guard that was pointing the wrong way (2026-08-07)

Operator settled Q1 as *this page owns every approval, with the split visible*.
Building it turned up a defect underneath the feature that had to be fixed
first, or the feature would have shipped a lie.

**`MATERIAL_PREVIEW_FIELDS` covered only the tools that cannot execute.**
The AP.6 staleness guard re-runs a tool's own dry-run at commit and compares a
per-tool list of *material* preview fields. That list held entries for
`set-target-bid`, `create-negative-keyword` and `graduate-keyword` — the three
preview-only tools, where a stale approval costs nothing — and **nothing at all
for `set-price`, `apply-content`, `publish-listing` and `send-customer-message`,
the four that can actually reach the outside world.** With an empty list the
only staleness signal is the handler refusing outright, so field-level drift —
precisely what the guard exists for — went unchecked on exactly the rows with
consequences.

This is the same inversion AP.3 found in `TOOL_CARDS`, one layer down and with
teeth: the fleet's own tools got the attention, the tools with history got
none. Filled in, with each choice reasoned in the code:

| Tool | Material now | Why |
|---|---|---|
| `set-price` | `changes` | `changes['base price'].from` is the **live** price. "Move this from €49 to €39" is a different decision at €35 |
| `apply-content` | `changes` | same shape — if someone edited the listing in between, the approved diff describes content that no longer exists |
| `publish-listing` | `currentlyPublished`, `publishMode` | **the important one**: if the channel flipped live between approval and run, a gated queue-up silently becomes a real publish |
| `send-customer-message` | `suppressed`, `emailOnFile`, `note` | if the customer opted out after the yes, it must not send. `note` is prose and included deliberately — it is the field that encodes live-vs-dry-run |

Verified first that re-running these handlers is safe: all four are read-only
in `mutate.tools.ts` (`findUnique` / `findFirst` and a suppression lookup). A
re-check with a side effect would be worse than no re-check.

**The feature itself.** `GET /agent/fleet/approvals/outside` lists
pending/scheduled approvals whose tool is not one of the fleet's three, with
the origin named verbatim (`manual-action`, `listing-quality-keeper`) and never
a fabricated worker. The section renders below the fleet queue, visually
distinct because these are the only rows that can act, and collapses to a
single honest line when empty — which is its normal state.

Decisions go through the **same** fleet decide route, so they get attribution,
the 20-second park, the audit row and the staleness re-check. Verified the path
does not filter by tool: `decideFleetApproval` → `scheduleApproval`
(`updateMany where {id, status:'pending'}`) and `decideApproval` — neither
mentions `FLEET_TOOLS`.

**One deliberate duplication, with an end date.** The parked-row countdown is a
second, smaller implementation of the shipped `ScheduledRow`, because that one
is not exported and this stream committed not to edit the file it lives in
while the Overview still renders it. AQ.3 moves the card into this directory
and the two become one. Recorded so it is a decision rather than an accident.

**Kept a separate section rather than widening `whereFor('waiting')`** — the
study's reasoning holds and got stronger on contact: different producer, thinner
payload (no worker join, no track record, no resolved entity names), opposite
consequence. Putting two qualities of attribution under one count is how a queue
starts lying to the person who trusts it.

### AQ.3 — the decision card, and the page stops borrowing (2026-08-07)

The card is where a wrong decision actually gets made, so this is the phase
that mattered most. Four things it adds, each one a gap the study named:

1. **Names, not ids.** `/agent/fleet/approvals` has always returned a `labels`
   map resolving campaign and target ids to names, and **every client
   destructured it away** — so in the whole history of this feature no card has
   ever said *which* campaign. It does now: *"On “casco integrale” (EXACT) in
   AIREON-IT-Generic · IT"*.
2. **Before → after.** `€0.31 → €0.84` instead of `bid €0.84`. Every preview
   already carried the starting value; nothing rendered it. Struck-through
   from, highlighted to, and a `new` marker where there is no before.
3. **Reversibility as one class, stated once** — *can be put back* /
   *only compensated for* / *cannot be undone*. It used to be asserted in two
   places (a chip and a sentence) that could drift apart. One source now, and
   the middle class exists because "reversible" alone is how an operator comes
   to believe a spend can be un-spent.
4. **The expiry clock**, stored on every row since AP.5 and rendered nowhere,
   plus **"check this is still true"** — an on-demand run of the same
   `checkStaleness` the commit path uses, behind `POST /approvals/:id/recheck`.
   The study rejected running it on every render for cost; on demand it is the
   honest version of Terraform's drift preamble, using the data we actually
   have rather than a drift feed we do not.

**Depth is re-tiered.** It was `riskTier === 'high' || !undoable`, and *every*
fleet tool is `riskTier: 'high'` — so 100% of cards were heavy and the
read-and-understood tick was blanket friction, exactly the click-through AP.8
says it is avoiding. Now it keys on **reversibility × can-it-execute**: the ack
gate only appears where a yes can actually do something irreversible.

**And the honest ceiling on the card itself:** where a tool cannot execute, the
card says so — *"approving this records your decision and teaches the fleet,
but changes nothing on Amazon"*. The page says it once at the top in S2; the
card says it again at the point of decision, because that is where it matters.

**The page stopped borrowing.** AQ.1 rendered the shipped `<ApprovalInbox>`
deliberately — one decision surface beat two. AQ.3 could not keep that and also
improve the card, because the inbox renders the old card internally; using the
new card in one section and the old one in another would have been the exact
duplication this stream has spent the engagement arguing against. So the lists
moved here too (`ApprovalLists.tsx`), with the AP.1–AP.8 behaviours reproduced
faithfully: three views with counts, grouping by worker name, selection with
the server-written blast-radius sentence, reject-all, the parked row with its
inline undo, and the impersonal outcome words.

Two small corrections came free with the rewrite: **reject-all now counts only
what the server will actually touch** (the shipped button counts every row in
the group, so it could promise "reject all 5" and reject 3), and the deliberate
duplicate countdown row from AQ.2 is gone — one `ParkedRow`, used by both
queues.

Still imported rather than copied: the tool **vocabulary** (`toolCardFor`) and
the glossary. Copying either would create two dictionaries that drift, which is
the defect AP.3 was written to fix. They move when the Overview stops rendering
the old card, and not before.

**Verified.** `tsc` clean on both apps for every file this stream owns; DS
ratchet clean; agent-fleet suite **369 passing across 41 files**.

### AQ.4 — the asymmetry we shipped by accident (2026-08-07)

The smallest change in the series and, by the research, one of the most
consequential.

**Reject demanded a typed sentence; approve was one click.** Three actions and
an essay to disagree, one click to agree. That is the documented mechanism by
which decision support quietly becomes a decision engine: if disagreeing costs
effort and agreeing costs none, a tired operator agrees. AP.8 built real
anti-rubber-stamp machinery — the track record, the evidence gate — and left
the strongest lever pointing the wrong way, because the reject reason was
valuable and nobody noticed that *requiring* it was the problem.

Both verbs are one click now:

- **Reject** opens a short row of **coded reasons**, one click each, shaped to
  the action. Chosen over a dropdown deliberately — a select is two
  interactions and hides its options until asked, which is exactly the friction
  being removed from the safe path.
- **Approve** stays one click, and the note is optional on both.

**The direction of the fix matters and is easy to get backwards.** The rule is
*make rejecting no harder than approving* — **not** *make approving harder*.
Friction is added only where a yes is irreversible (the read-and-understood
tick), never to the safe path.

**Coded, and per action type.** Coded override reasons matched reviewers' own
free-text reasoning in only 46% of 15,636 alerts, and free text alone is
unanalysable — one study found 209 spellings of "will monitor as recommended".
A randomised crossover trial found a customised per-context list beat a generic
one at p < 0.001. So each tool has its own four, and **every list carries "the
suggestion itself is wrong"** — the option generic lists suppress and free text
reveals, and the highest-value signal for tuning a worker, because it says the
*reasoning* was bad rather than the timing.

Stored as one string (`code — note`), so no migration and the record stays
readable. It is the reason that becomes precedent, and a coded label plus a
note reads better as precedent than either alone.

**The button states the consequence, not the verb.** *"Apply — bid €0.31 →
€0.84"* rather than "Approve". For a first-time operator that is the difference
between a decision and a guess, and it makes a screenshot self-documenting. It
falls back to the tool vocabulary when there is no delta worth naming.

**Deferred, deliberately: the keyboard map.** The study specifies j/k
navigation and digits `1`/`2`/`3` for the dispositions — digits precisely
because a beginner browsing with j/k presses letters exploratively and would
eventually fire one by accident. It is the right design and it is not built,
because **both queues are empty**: a keyboard model over a list with no rows
cannot be verified by anyone, and shipping an unverifiable interaction is how
you get a control that has never once been exercised. It moves to AQ.5, where
filters and the queue-shape strip give it something to move around.

### Prod verification of the card (2026-08-07)

Four phases had shipped a decision card that had **never rendered a real
proposal** — every claim about it was typecheck-deep. Fixed with the method and
the cleanup discipline the AP.4/AP.6/AP.8 records established: seed one
provably inert approval, verify, delete.

**Why the seed was safe, on three independent counts:** `set-target-bid` has no
`execute()`, so `decideApproval` cannot run anything for it under any
circumstances; the `targetId` deliberately did not exist; and `checkStaleness`
would refuse on the missing target before anything else happened. The preview
was hand-written rather than taken from a real campaign, so nothing in the
exercise touched a real entity.

What rendered, all correct:

| | |
|---|---|
| Entity | *"On “casco integrale modulare” (EXACT) in AIREON-IT-Generic"* — **the first time in this feature's life a card has named what it acts on** |
| Delta | `bid €0.31 → €0.84`, old value struck through |
| Reversibility | `can be put back` — the new single-source wording |
| Expiry | `24h left`, plus the exact instant under *if you do nothing* |
| Honest ceiling | *"Approving this records your decision and teaches the fleet, but changes nothing on Amazon"* |

**The re-tiering proved itself on screen.** The card is `high risk` and carries
**no read-and-understood tick** — because it cannot execute. Under the old rule
(`riskTier === 'high'`) it would have demanded the ritual for an action that is
physically incapable of doing anything, which is exactly the blanket friction
AP.8 says it exists to prevent.

**The recheck worked end to end**: it ran the tool's real dry-run, got a
refusal, and classified it stale in the stale style. The message it surfaced —
*"targetId and numeric proposedBidCents are required"* — was the seed's fault,
not the feature's: the fixture passed `bidCents` where the tool wants
`proposedBidCents`, so it refused on argument shape rather than the missing
target. The mechanism under test is the fail-closed path, and it held.

**Cleaned up**: 1 approval and 1 run deleted, 0 audit rows created (the row was
never decided), `AgentApproval` back to exactly **18**.

**AQ.4 prod-verified too, on a second seed.** The first cleanup happened before
the deploy landed, so rather than hold a prod row against an unknown wait the
row came down and went back up thirty seconds later — which is the point of
committing the script. Detecting that the deploy HAD landed needed a
discriminator the empty DOM could not give: fetching the deployed route chunk
and grepping it for a string unique to AQ.4 (`"Why not? One click"`). The
bundle is public, so this works unauthenticated where the rendered page does
not.

| | |
|---|---|
| Primary button | **`Apply — bid €0.31 → €0.84`** — the consequence, not the verb |
| Reject | one click, four codes shaped to this tool, ending in *"The suggestion itself is wrong"* |
| Note | optional on **both** verbs, required by neither |
| Symmetry | approve = 1 click, reject = 1 click. The asymmetry is gone |

And the re-check, on the corrected fixture, hit the branch it was meant to:
*"The facts have moved — target seed-target-does-not-exist not found (or is a
negative)"* — the tool's own dry-run refusing, surfaced in operator language and
classified stale.

**Cleaned up again**: `AgentApproval` back to exactly **18**, 0 audit rows,
0 runs left behind.

### AQ.8 — edit-then-approve (2026-08-07), taken out of order

**Re-sequenced deliberately.** AQ.5 is next in the plan — the queue-shape
strip, filters, and the rail badge — and all three render **nothing** today:
the strip has no rows to summarise, the study itself says filters must be
"absent entirely at zero", and the badge's count is zero and stays zero until
the fleet can queue, which is exactly what the operator's Q5 answer requires
(*"zero when the fleet is off"*). Building three surfaces that display nothing,
across three shared files including the app-wide rail, is the thing this
engagement has spent all night arguing against. So AQ.8 went first: it is the
study's **#1 named gap versus the industry**, it does not depend on volume, and
it can be verified with a seeded card.

**The gap.** The operator's most common real verdict on a proposal is not "no"
— it is *"right idea, wrong number"*. Without an edit path, every near-miss
becomes a reject plus a wait for the worker to propose again, which costs a
model call and lets the auction move in between.

Three decisions, each taken against the research rather than for convenience:

**1 · Supersede, never mutate.** The edit expires the original and mints a NEW
approval. Mutating in place is how the number approved and the number written
come apart, and it destroys the record of what the worker *actually* proposed —
which is the thing you want six months later when asking whether the worker or
the operator was wrong. The original lands in the record as **`superseded`**,
a status added for the reason ServiceNow keeps *No Longer Required*: without
somewhere to put an overtaken request it either rots in the queue or is
deleted. It is explicitly **not** `rejected` — the operator did not say no,
they said *not that number*.

**2 · The tool's own handler is the validator.** We do not copy the bid floor,
the authority pins or the protected-term rules into a second place where they
can drift. The server re-runs `tool.handler(editedArgs)` and takes its refusal
verbatim. That is the same code that produced the preview the operator read, so
the check cannot disagree with what they were shown — and it means the edit
path inherits every guard the propose path has, for free, permanently.

This matters more than it sounds. The reference implementation everyone copies
renders one free-text textarea per argument and stringifies every value — its
own README admits the values come back as strings. Over a money field that is a
hole straight through the bid rails: **an operator typing `4.2` for `0.42` gets
a ten-times bid with nothing in the way.** Here the field is typed, bounded
client-side as a courtesy, and re-validated server-side by the authority that
owns the rule.

**3 · The preview is regenerated, not patched**, so the card the operator sees
next describes *their* number rather than the worker's.

The editable field is **declared per tool** (`EDITABLE`), not inferred: a
generic "edit the args" box cannot be validated or labelled, so an action with
no safe numeric field simply shows no edit affordance. `set-target-bid` and
`graduate-keyword` have one today.

`amend_action` is its own audit action rather than an approve, because the
interesting fact is that the worker's number was **wrong and a human corrected
it** — the highest-quality signal the fleet ever gets, and folding it into
`approve_action` would lose it.

**Shared-file changes, declared:** `control-audit.service.ts` (+1 union
member), `approval-inbox.service.ts` (`superseded` added to `DECIDED_STATUSES`
so an edited proposal appears in the record instead of vanishing).

**Verified:** `tsc` clean on both apps; DS ratchet clean; agent-fleet suite
**372 passing across 41 files**.

### AQ.8 verified end to end on prod (2026-08-07)

The API deployed before the web build, which turned out to be better: it let
the **contract** be tested directly from the authenticated page, independently
of any UI.

**The test that mattered — the guard is the tool's, not the interface's:**

| Sent | Result |
|---|---|
| `proposedBidCents: 2` | **400** — *"proposed bid 2c is below the 5c floor"* |
| `proposedBidCents: 84` (unchanged) | **400** — *"that is the same as what was proposed"* |
| `proposedBidCents: 45` (valid) | **200**, superseded + new approval |

The first message is `ads-propose.tools.ts` speaking, verbatim. Not the UI's
bound, not a copied rule — the same handler that produced the preview the
operator read. That is the whole design: **an operator typing `4.2` for `0.42`
is refused by the authority that owns the floor**, and the edit path inherits
every future guard the propose path gains, permanently, without anyone
remembering to mirror it.

**The successful path needed a second fixture, and that is worth recording.**
The inert seed points at a target that does not exist, so the handler correctly
refuses and only the REFUSAL branch is reachable — the fixture that makes the
test safe is the same property that makes half of it untestable. A second
script (`_apx-seed-real.mts`) seeds against a real ad target with a +3c
proposal. Still structurally inert: `set-target-bid` is preview-only, so
`decideApproval` cannot run anything for it under any circumstances, and the
handler only reads.

What came back on the valid edit:

```
supersededId  cmsjo2a58…      (the worker's 53c proposal)
approvalId    cmsjo2u4o…      (new)
preview       proposedBidCents: 45
effect        Moves "motorrad jacke herren" from €0.50 to €0.45
              in DE_Exact_3_Keywords.
```

Three things to notice. The preview was **regenerated by the tool**, so it
describes the operator's number. It reads the **live** current bid (€0.50), not
the value stored on the original row. And the superseded original appears in the
record with its reason — *"superseded — you edited this before approving"* —
rather than vanishing.

**And the first attributed decision in this database's history.** The
superseded row carries `decidedBy: "awaissulhry"`. All 18 pre-existing rows have
`decidedBy: null`; AP.1 built attribution in and it had never once been
exercised on a live decision, because no decision had been taken through the
fleet path. It has now.

**Cleaned up**: 3 approvals and 2 runs deleted, and the `amend_action` audit row
with them. Re-probed: **18 approvals (15 rejected, 3 executed), 0 exemplars,
0 audit rows** — byte-for-byte the state before this started.

**Not yet verified: the edit UI itself.** The web build had not deployed when
the seeds came down. The contract beneath it is proven; the affordance that
drives it is not, and it should be exercised on the next card rather than
assumed.

### The edit UI, verified (2026-08-07) — closing the last open gap

The one thing the previous record listed as unproven. Exercised on prod against
a real seeded card.

**The affordance** reads *"Right idea, wrong number? Edit the bid"* and is quiet
until asked for — it should not compete with the two verbs for attention.

**The field starts at the worker's proposal** (€0.53) with *"the worker proposed
€0.53"* beside it, so the operator is editing a number rather than filling a
blank.

**The client guard, probed across four values:**

| Typed | Apply |
|---|---|
| `0.02` — below the 5c floor | disabled |
| `25.00` — above the sanity bound | disabled |
| `0.53` — the same as proposed | **disabled** |
| `0.45` — valid and different | enabled |

The third is the one worth noting: you cannot "edit" to the number that was
already proposed. It is a no-op the server also refuses, caught a round trip
earlier.

**The edit itself**, through the UI: the editor closed with no error, and the
card became `bid €0.50 → €0.45` — the operator's number, against the **live**
current bid, with the effect sentence regenerated by the tool. Waiting stayed at
1; Decided went 18 → 19.

**The record** shows the superseded original above fifty-one days of pre-fleet
history, and the contrast is the whole of AP.1 finally visible in one screen:

```
You changed the number   Bid tuner asked to change a keyword's bid
                         by awaissulhry · just now · HIGH RISK
                         "superseded — you edited this before approving"

Rejected                 listing quality keeper asked to change listing content
                         nobody recorded · 51d ago · MEDIUM RISK · pre-fleet
```

One polish came out of seeing it: the outcome word had fallen through to the
generic humanizer and rendered a bare *"superseded"* — true, but it reads as
something that happened TO the operator. It now says **"You changed the
number"**, because they did not say no; they said not that number.

**Still not exercised, and named rather than assumed:** the UI's rendering of a
SERVER refusal. The client bound stops every out-of-bounds value before it can
be sent, which is correct behaviour and means the `amendErr` path needs a
refusal the client cannot predict — an authority pin appearing between load and
submit, or a target archived mid-edit. The refusal itself is proven at the API
(`"proposed bid 2c is below the 5c floor"`); only its display is untested.

**Cleaned up**: 2 approvals, 1 run, 1 audit row. Re-probed: **18 approvals,
0 exemplars, 0 audit rows.**

### AQ.6 — bulk, with the money and the homogeneity rule (2026-08-07)

Bulk is where a trust-first page most easily becomes a rubber stamp, and it is
the only section whose failure mode is measured in **euros × N**.

**The money is in the sentence now.** It was *"This approves 1 action: 1 × set
target bid."* — count and kind, no exposure, though the parent page map promised
*"€12.40 of daily spend"*. Computed per tool from the preview the operator was
shown, never modelled:

- bid changes → *"raises what you pay per click by €0.63 in total across 2 keywords"*
- price changes → the summed delta across products

**And nothing where nothing can be said honestly.** A negative keyword saves
money in a way nobody can put a number on before the fact; `"€0.00"` would be a
lie of precision. `euro` is `null` and the sentence simply omits it. A
fabricated figure on a confirmation is worse than none, because it is the
number the operator will remember.

**The homogeneity rule**, from UiPath — the single most transferable safety
constraint in the whole survey. A bulk **approve** is refused across two kinds
of action, so one yes can never span a €0.02 bid nudge and a customer email.
Enforced in `bulkDecide`, not only in the preview: a preview a client can
decline to read is a suggestion, and the rule has to hold for the next caller
nobody has written yet.

**Refused on approve only.** Rejecting a mixed set stays allowed — saying no to
forty different things at once cannot hurt anyone, and blocking it would put
friction back on the safe path, which is the asymmetry AQ.4 exists to remove.

### The correction the tests forced, which is the more useful half

The study claimed `previewBulk` "counts only `status:'pending'` rows, so a
selection containing a parked row under-reports its own blast radius", and the
first version of this widened the query to include `scheduled`. **Three
existing tests failed, and they were right.**

A parked row is *already approved and counting down*. It is not part of the
decision being confirmed, so counting it **over**-reports exactly as badly as
dropping it silently under-reported. The honest answer was neither: count what
this decision will actually do, and **name what it skipped** —

> *"This approves 1 action: 1 × set target bid. You have 20 seconds to take it
> back. 1 other you selected is already decided or counting down, and is not
> affected."*

Worth recording plainly: **that was a wrong claim in the study, written
confidently, that survived into a commit message and was caught by a test I did
not write.** It is the same failure mode this document keeps naming — an
assertion nobody checked — and the only reason it did not ship is that AP.4 left
tests behind that asserted the old behaviour on purpose.

The three tests were then rewritten to assert the *new* intent rather than
having their expectations flipped, and four were added: the mixed-approve
refusal, the mixed-reject allowance, money present when honest, and money absent
when not.

**Verified:** `tsc` clean on both apps; DS ratchet clean; agent-fleet suite
**379 passing across 41 files** (7 new).

### AQ.6 verified on prod (2026-08-07)

Three seeded cards — two bid changes and one negative keyword, all inert — then
deleted.

**The money, summed from the previews the operator was shown:**

> *"This approves 2 actions: 2 × set target bid… It raises what you pay per
> click by **€0.56** in total across 2 keywords. You have 20 seconds to take it
> back."*

**The homogeneity rule, all three ways:**

| | |
|---|---|
| mixed **approve** preview | `homogeneous: false`, and the sentence IS the refusal |
| mixed **reject** preview | allowed — *"This rejects 2 actions: 1 × set target bid, 1 × create negative keyword."* |
| mixed **approve** through `bulk-decide` | **`ok: false, done: 0`** with the refusal |

The third is the one that matters. The rule holds at the point of action, not
just in the confirmation — a client that never calls the preview still cannot
approve two kinds of consequence with one yes.

### And a third self-inflicted lesson, same shape as the other two

The cleanup **reported success while leaving a row behind**. `_apx-seed-card.mts
clean` matched on `agentKey: 'amazon-bid-tuner'` **and** the marker, so the
negative-keyword seed — written under a different worker key — survived a clean
that printed `deleted approvals=1` and looked fine. Caught only by re-probing
and reading `19` where `18` was expected.

Fixed twice over: the query keys on the **marker alone** (the thing that means
"mine"; the agent key was incidental), and `clean` now **fails loudly** —
non-zero exit and a `⚠ NOT CLEAN` line — if the table is not back to 18 or any
seed run survives.

That is three for three tonight on the same failure mode: `?? []` compared
nothing and said nothing, a test grepped its own comment and passed, and a
cleanup deleted the wrong subset and announced success. **An operation whose
failure mode is silence will eventually be wrong quietly** — the only defence
is asserting the end state rather than trusting the step.

### Closing the gaps I owed (2026-08-08)

Three items that were not "blocked" — they were named and then not delivered.

**1 · The comeback banner now tells the two cases apart.** Study §1.4 defect #2,
catalogued and left unfixed through five phases. Two different things return a
request to the queue and the card only ever explained one:

| `reason` prefix | What happened | What the card says now |
|---|---|---|
| `not run — …` | AP.6 staleness. **Nothing was attempted** | *"You approved this before, and it did not run… decide again with the facts as they are now."* |
| `execution failed:` / `execution error:` | It **was attempted, against Amazon, and failed** | *"You approved this, it was attempted, and it failed… nothing here can tell you whether any part of it took effect, so check before deciding again."* |

The second is louder and says the uncomfortable part: a failed execution is not
a clean no-op, and this page cannot tell you whether it half-landed. Pretending
otherwise would be the same lie as calling a spend reversible.

**2 · Snooze — the decision approved in Part 6 Q6 and never built.** Without a
"not now" the only way to clear a badge is to approve, which is the one habit a
spend queue must not teach.

A **column**, not client state: the research's phrasing is *"keeping state so
'later' does not become 'never'"*, and a snooze held in a browser dies on
reload, is invisible to the rail badge, and lets the count disagree with the
queue. Migration `20260808b` — additive, one nullable column and one index.
(The letter moved: `20260807f` was claimed before midnight, and `20260808a` had
since been taken by SB.AS.)

**The constraint that makes it honest: a snooze can never outlive the request.**
`expiresAt` still owns its life. The API refuses a snooze past expiry rather
than silently clamping it — clamping would tell the operator they had until
Friday when they had until tomorrow. The UI filters its presets the same way, so
an option that would forfeit the decision is never offered at all: at a 24-hour
clock you get *2 hours · 6 hours · tomorrow morning*, and as expiry approaches
they disappear one by one.

**The counts use the same clause as the queue.** If the badge counted what the
list hides, the first thing the operator would learn is that the badge lies —
and a snooze that does not move the number is not a snooze, it is a filter.

It renders quiet and last in the action row: an escape, not a verb. Giving it
button weight would put a third equal-looking choice beside approve and reject,
when the entire point is that it is the option with no consequence.

**3 · The rollup I promised another stream, and the deep links that came with
it.** Contracted with `SB.AS` on 2026-08-07 and then not written — recorded here
because an unkept cross-stream promise is worse than one never made: they built
their side against it.

`GET /agent/fleet/approvals/rollup?assignmentIds=…` →
`{ waiting, parked, returned, decided, expired }` per assignment, keyed through
**their** `AgentRun.assignmentId`. This route never reads `AgentAssignment`.

The two exclusions they specifically asked to live *inside* the function rather
than in a comment beside it, because any second implementation would get them
wrong:

- a **parked** row is approved and counting down — the operator has answered it,
  so it is not waiting on them;
- a row returned by a **failed execution** is `pending` *with `decidedBy` still
  set*, so counting pending naively strands an assignment in "awaiting your
  approval" for something already answered.

≤100 ids, **rejected over the cap rather than truncated** — a silently short
answer is a wrong count on a queue that gates every write.

With it, the deep links: **`?assignment=<id>`** lands the queue filtered to what
one assignment produced (their parameter, chosen over the single-card `?item=`
because one assignment can produce many proposals), and **`?item=<id>`** for a
notification landing on one.

**4 · Ordering by consequence.** The queue was `requestedAt` ascending, which is
the wrong default and the study says why: creation order puts a €2 bid nudge
above a budget doubling. Now ranked by what a wrong answer costs — irreversible
first, then high risk, then euro exposure, with age only as the tie-break.

### Verifying snooze and the rollup found a shipped bug in the undo (2026-08-08)

**Snooze, verified on prod:**

| | |
|---|---|
| snooze past the expiry | **refused** — *"this request expires … it cannot be set aside past that, or it would be refused while you were not looking"* |
| snooze into the past | refused |
| valid snooze | accepted; the row left the list **and the count went 1 → 0** |

That last column is the design requirement: a snooze that does not move the
number is a filter, not a snooze — and a badge that counts what the queue hides
teaches the operator to distrust the badge.

**The rollup, verified against the contract:** `waiting: 1` for the stamped
assignment, a **zeroed bucket** for an assignment with no runs (a complete map
beats a sparse one for the consumer), and **101 ids refused** rather than
truncated.

### And the bug it surfaced, which was mine and already shipped

The row did not come back after `unsnooze`. Chasing it found the client sending
`content-type: application/json` with **no body**, which Fastify rejects before
the handler runs — `FST_ERR_CTP_EMPTY_JSON_BODY`, a flat 400.

**Three calls on this page pass no body: `undo`, `commit` and `unsnooze`.** All
three were failing, and failing *silently*, because they are fired as
`void post(...)` and nothing reads the result.

While it lasted, that meant **the twenty-second window could not be taken back
from the UI at all**, and the browser could not commit early — a parked action
simply sat there until the 30-second maintenance sweep collected it. The undo
button looked present and did nothing, which is worse than not offering one.

Fixed by setting the header only when there is a body, then verified end to end
on prod: unsnooze → 200 and listed; approve → `scheduled` with `executeAfter`;
undo → back to `pending` with `decidedBy` cleared.

**The same shape exists in the shipped Overview panel** (`FleetTab.tsx:275`),
which is not this stream's file. Flagged rather than fixed.

Two things worth keeping from how it was found. First: **it was invisible to
every check I had.** `tsc` passes, the build passes, the tests mock `fetch`
away, and the UI shows a button. Only exercising the actual path against the
actual server surfaced it. Second: **I only noticed because a number
disagreed** — the rollup said `waiting: 1` while the queue said 0. Neither
number was wrong; the contradiction was the entire signal.

**Cleaned up**, and the cleanup needed widening again: audit rows from
decide/undo carry the *run's* `agentKey` as `charterKey` with a null note, so
matching on the marker missed them — the same over-narrow-cleanup shape as
before. Final state: **18 approvals, 0 exemplars, 0 audit rows.**

### Partial failure gets a sentence (2026-08-08)

Both bulk endpoints have always returned `{ done, of, failed[] }` and **every
client discarded it**, so a partial failure looked exactly like a success: the
page reloaded and some rows were simply still there.

Partial failure is the *normal* case when writing to a rate-limited third-party
API — Terraform's whole apply model is built around it — and the research is
blunt that presenting it as a stack trace, or not at all, is the weakest part of
every tool surveyed. It now says what happened:

> *"7 of 10 went through — 3 did not. already scheduled; approval not found;
> still inside the undo window. The ones that did not are still in the list
> below."*

The reasons verbatim, capped at four with a count for the rest. A bare number
tells the operator something is wrong and nothing about what — which is the
same silence this page keeps finding in other clothes.

---

# PART 12 — S1 DESIGN STUDY: the header, the standing promise, and the teaching layer

**Status: APPROVED by the operator 2026-08-08, and in build.** Three decisions
taken on the study as written:

1. **Approved as specified — build S1.a–S1.c.**
2. **§12.9's departure is upheld: the promise becomes the page description and
   is NOT sticky.** The approved AQ-S1 wording ("does not scroll away") is
   superseded by this decision, for the reasons in §12.9.
3. **S1.d is taken** — the WCAG 1.4.13 repair to the shared `<Term>` ships as
   its own phase, with its own claim, after S1.c.

Stream tag `SB.AQ-S1R`, opened 2026-08-08 against the operator's judgement on
the shipped page: *"way off, very odd and imperfect."*

That is about the look, not the data. Parts 0–11 stand: the gate-state facts are
true, the card is honest, the queue is empty for three verified structural
reasons. **This part does not re-litigate any of that.** It rebuilds the top of
the page — and only the top.

Scope: **AQ-S1 only** — `page.tsx`'s hand-rolled header, `StandingPromise()`,
`HowThisWorks()`, and the `.aq-promise` / `.aq-how*` rules behind them. S2–S10
are untouched; §12.7 lists what I found in them and left alone.

---

## 12.0 — What S1 is FOR, in one sentence

> **Tell someone who has never seen the fleet what this queue guarantees — in
> the time it takes to read the top of the page — and keep that sentence true on
> the day the queue is full.**

Everything below is judged against that. Two consequences fall straight out of
it and they decide most of the design:

- **S1 is an invariant, not a status.** If a sentence in S1 stops being true
  when the fleet is switched on, it does not belong in S1 — it belongs in S2,
  which exists to say what is true *today*.
- **S1 must be the same height and shape whether the queue holds 0 rows or 400.**
  Anything that only makes sense while the queue is empty is S4's teaching empty
  state, not S1.

---

## 12.1 — What is on screen today, measured

Measured in a browser on live Vercel + Railway, 2026-08-08, viewport
1728×906, dpr 2, against the resolved page background `#f4f6f9`. Every number is
`getComputedStyle` / `getBoundingClientRect` / a canvas text measurement — not a
reading of the source.

### 12.1.1 The type and colour ladder

| Element | Size / weight | Colour | On | Contrast |
|---|---|---|---|---|
| `.acr-head h1` — *Approvals* | 20 / 650 | `#1c2530` | `#f4f6f9` | 14.30 ✓ |
| `.acr-sub` — the purpose sentence | 13 / 400 | `#667485` | `#f4f6f9` | **4.41 ✗** |
| `.aq-promise` — the promise body | 13 / 400 | `#1c2530` | `#f3faf5` | 14.60 ✓ |
| `.acr-fl-checkstoggle` — *How approvals work* | 12.5 / 650 | `#34404f` | `#f4f6f9` | 9.74 ✓ |
| `.aq-howbody` — the drawer prose | 12.5 / 400 | `#3a4658` | `#fbfcfd` | 9.39 ✓ |
| *(S2, for contrast)* `.aq-gate-num` | 19 / 640 | `#1c2530` | `#fff` | 15.48 ✓ |
| *(S2)* `.aq-gate-grid h4` | 11 / 650 | `#6b7688` | `#fff` | 4.59 ✓ |
| *(S2)* `.aq-can` / `.aq-cannot` chip | 10.5 / 600 | `#6b7688` | `#f4f6f9` | **4.24 ✗** |
| *(S2)* `.aq-gate-ok` — the open-pipe line | 12.5 / 400 | `#2f855a` | `#f4f6f9` | **4.20 ✗** |

**Seven distinct font sizes above the queue card** — 20, 19, 13, 12.5, 12, 11,
10.5 — in ten size/weight pairs. Activity's S1 audit called four sizes a wall;
this is seven. The fix for that is *fewer* sizes, not different ones
(hierarchy from weight and spacing on a 4px scale — the mechanic both the
Linear and Vercel teardowns land on, and the one Activity's S1R adopted).

Three of the contrast failures are S2's and are recorded in §12.7. The one that
is S1's — `.acr-sub` at **4.41:1** — is the same shared `control-room.css` value
that Activity, Workflows and Assignments have each already overridden
page-locally. This page would be the fourth.

### 12.1.2 The structural finding: 75% of the header row is dead

`.acr-head` is `display: flex; justify-content: space-between`, and this page
hand-rolls it with exactly **one** child.

| | |
|---|---|
| Header row | **1614px** wide |
| Its only child | **397px** |
| Dead | **1217px — 75% of the row** |

This is the defect Activity measured at 1187px on the shell, fixed by adding an
`aside` slot to `FleetPageShell` — *and this page cannot use that fix, because it
does not use the shell.* The header markup here is byte-identical to what the
shell emits; the only difference is that the second flex child is unreachable and
that every future shell change lands on six pages and not on this one.

**Correction to the brief's framing, because accuracy matters more than a
tidier story:** six of the ten fleet pages use `FleetPageShell` (`activity`,
`assignments`, `assignments/[id]`, `cost`, `files`, `workflows`). Approvals is
one of **four** that hand-roll the same markup — Overview, Controls and Workers
do too — and `map` deliberately does not use it at all, with its reason written
in the file. So this is not "structurally different from every other page in the
section". It is *one of four copies of a component that exists*, and the cost is
specific and measurable: 1217px of unusable header, and no share in the shell's
improvements.

### 12.1.3 The wall, in words and in characters per line

| Block | Words | Measured line length |
|---|---|---|
| `.acr-sub` | 12 | — |
| `.aq-promise` | 33 | **171 chars/line** |
| *How approvals work* toggle | 3 | — |
| `.aq-howbody` when opened | **276** | **261–266 chars/line** |
| *(S2)* gate headline + blockers | ~65 | 112 / **257–268 chars/line** |

[WCAG 1.4.8][wcag148] puts the ceiling at **80 characters**; typographic practice
is 45–75. **The teaching layer runs at 3.3× the WCAG ceiling.** Nothing in S1 has
a `max-width`; `.aq-howbody` computes to `max-width: none` and stretches the full
1590px content width. The only text on the page inside the ceiling is in S2's
tiles — at 65 chars/line — and it is only there because the grid happens to cut
it to 364px.

That is the measurable content of "wall of prose". It is not a matter of taste.

### 12.1.4 The same claim is made twice, in two different shapes

> `.acr-sub`: *"Everything the fleet wants to do and cannot do until you say yes."*
>
> `.aq-promise`: *"Nothing on this page has happened yet. Every card is something
> one of your AI workers wants to do — and nothing the fleet proposes reaches
> Amazon unless you say yes here."*

One page description and one green notification box, 38px apart, asserting the
same guarantee. A reader who reads both learns nothing from the second.

### 12.1.5 The teaching drawer contains a sentence that is no longer true

`.aq-howbody`'s last paragraph, live on production right now:

> *"And it cannot yet let you amend a proposal before approving it; today a
> number you disagree with has to be rejected."*

**AQ.8 shipped edit-then-approve on 2026-08-07 and it was verified end to end on
production** (Part 11: the client bound probed across four values, the server
refusal quoted verbatim from `ads-propose.tools.ts`, the superseded row carrying
the first attributed `decidedBy` in this database's history). The one place on
the page that exists to teach a beginner what they can do is telling them they
cannot do the thing the same engagement shipped.

This is the class this document keeps re-finding: **a read surface stating a
constant no executor honours.** Four instances were logged in Part 7; this is the
fifth, and it is the first one written by this stream about its own feature.

### 12.1.6 Three more, found in the browser

1. **The queue card is painted 347px above where it lands.** Measured: with the
   gate-state section absent (the first paint, before `/gate-state` resolves) the
   queue card's top is **175px**; once the read returns it is **522px**. The
   first screenshot of a cold load shows the skeleton rows sitting directly under
   the *How approvals work* toggle. Nothing reserves that space. *(S2's to fix —
   §12.7.)*
2. **The disclosure control is 142.7 × 18.8px.** Under [WCAG 2.5.8][wcag258]'s
   24×24 minimum, saved only by the Spacing exception (its 24px circle clears the
   gate-state header's box by 12.6px). It passes; it is still an 18.8px-tall
   control on a page for a non-technical operator, and the brief's standing rule
   is visibility over minimalism.
3. **Three border radii inside one section** — 6px (`.aq-promise`), 8px
   (`.aq-gate`), 6px (`.aq-gate-grid > div`), 9px (`.aq-queue`) — and four
   background tints (`#f3faf5`, `#fffdf6`, `#fbfcfd`, `#fff`) chosen per block.

### 12.1.7 Live ground truth, 2026-08-08

Read off the deployed page with the operator's session, so the design is drawn
against what is actually there:

| | |
|---|---|
| Waiting | **0** · Decided **18** · Expired **0** |
| Gate | **closed** — 0 of 7 workers at PROPOSE, 0 of 3 fleet actions executable, next chance *in 2 days* |
| Outside queue | empty |
| Horizontal overflow | none — `documentElement.scrollWidth === innerWidth === 1728` |
| `.acr` width | 1662 of 1662 available — **100%**, no right-hand dead zone |
| S1's vertical footprint | header top **20px** → gate-state top **175px** = **155px**, drawer closed |

---

## 12.2 — What the industry does with this exact strip

Six primary sources, read for anatomy rather than for principles. Where a source
only confirms something Activity's Part 18 already established for the fleet, I
say so and do not re-derive it — two pages agreeing by copying the same source is
the point.

### A · A page header has a fixed anatomy, and a right-hand slot is part of it

[HashiCorp Helios][helios] specifies the order **title → breadcrumb → icon →
badges → subtitle → description → metadata → actions**, with **only the title
required**, and three rules that land on us:

- **Subtitle ≠ description.** A subtitle is metadata that "does not change
  frequently"; a description is "more detailed information about the page",
  limited to 1–2 sentences. Ours is a full sentence, so in Helios terms this page
  has a *description* and no subtitle — which means the promise banner and the
  `.acr-sub` are competing to be the same slot.
- **"Do not communicate page-level information anywhere other than the top of
  the page."** A standing guarantee is page-level information by definition.
- **Actions: 1–3, and never two primary actions.** One quiet secondary control
  in the header is exactly what is allowed.

[GitHub Primer][primer] independently lands on the same split — `TitleArea`
(LeadingVisual / Title / TrailingVisual) · `Description` · `ContextArea` ·
`Actions` — with actions on the right of the title row.

**Steal:** the right-hand slot; one description, not two; a single secondary
control there. **Reject:** breadcrumbs (the rail says where you are), badges (S2
and S3 own the counts, and a badge in the header would be a fourth place the
same number lives).

### B · Help belongs in the UI, and a drawer is the sanctioned place for it

[GitLab Pajamas][pajamas] is the most directly useful source found, because it
ranks the mechanisms instead of describing them:

> *"The UI should be self-explanatory. If extra help is required, it should be
> in the UI itself, as either UI text or as text within a drawer."*

Its order is **inline UI text → drawer → popover → tooltip → documentation
link**, with one hard rule: **essential information must never be hidden behind
a trigger.** [NN/g's tooltip guidelines][nngtool] say the same thing from the
other end — tooltips are "microcontent", never for task-critical information,
and *"users shouldn't need to find a tooltip in order to complete their task."*

That decides two things at once. The 276 words of *How approvals work* are
"supplemental, moderate length" — textbook drawer content, and **not** something
that should sit in the page flow as a disclosure. And the facts that are *not*
supplemental — that nothing has happened yet, that a yes is the only way through
— must stay inline where nobody has to click for them.

### C · Progressive disclosure fails on the label, not on the mechanism

[NN/g][nngpd]: the split must put "everything that users frequently need up
front", the label must create "strong information scent", and designs with three
or more disclosure levels "typically have low usability". Ours has one level and
a good label. The mechanism is fine; the *placement* is the problem — an inline
disclosure occupies a row of the page forever in exchange for content 95% of
readers will open once.

### D · Front-load the answer; do not write headings as questions

[GOV.UK's structure guidance][govukstructure] is unambiguous and it contradicts
how our drawer is written. Headings should be **descriptive, front-loaded,
active**, and — verbatim — they should not be questions, because *"they're hard
to frontload and users want answers, not questions."*

All six leads in the drawer today are questions in noun-phrase clothing: *"What
happens if you say nothing."* The answer — 24 hours, and expiry means refused —
is the fourth clause of the paragraph beneath it. **A reader scanning six bold
leads currently learns six things they do not know, and zero things they do.**

### E · A standing truth stated as a notification stops being read

The habituation literature is settled and this document already cites it
(Part 2E): visual processing of a warning collapses after the **second**
exposure, and polymorphic (appearance-varying) warnings are the only measured
mitigation, effective for at least five days ([Anderson et al., CHI 2015][chi];
[Vance et al.][byu]). The corollary for a *non*-varying element is direct: a
green box that says the same thing on every visit forever is the definition of
the stimulus that habituates fastest.

[Atlassian][atlassian] and [Carbon][carbon] both reserve banner/notification
treatments for **system-level messages and state changes**. A guarantee that has
been true since the page was created is neither.

**Steal:** state the guarantee, do not decorate it. **Reject:** a sticky banner
(it spends viewport forever on the element most likely to be ignored) and any
notification chrome around an invariant.

### F · Empty-first surfaces: encourage, never apologise

[Shopify's empty-state pattern][shopifyempty] is the clearest statement of the
tone rule: rather than making the merchant feel unsuccessful, an empty state
gives *"a clear explanation of what will appear here"* plus a way forward — and
it explicitly covers the case where emptiness persists by design ("prompting
feature activation or configuration"), which is exactly this page for the coming
weeks.

**This confirms a boundary rather than changing S1.** The teaching empty state is
S4's, and it is already built. S1's job in an empty-first world is the opposite:
be identical whether the queue is empty or full, so that the day rows arrive
nothing about the top of the page has to change.

### G · Tooltips: the accessibility contract is a checklist, and we fail two of it

[WCAG 2.2 SC 1.4.13][wcag1413] has three requirements. Measured against our
shared `<Term>`:

| Requirement | Normative wording | `<Term>` |
|---|---|---|
| **Dismissible** | *"A mechanism is available to dismiss the additional content without moving pointer hover or keyboard focus"* | **✗** — no key handler anywhere in `glossary.tsx`; Esc does nothing |
| **Hoverable** | *"the pointer can be moved over the additional content without the additional content disappearing"* | **✗** — `.acr-term-tip` is `pointer-events: none`; hit-testing the centre of an open tooltip returns `.aq-gate-body`, not the trigger |
| **Persistent** | remains until trigger removed / dismissed / invalid | **✓** |

Everything else about it measures well: keyboard-reachable (`tabIndex={0}`,
verified by focusing it with real document focus and watching the tip appear),
12.94:1 contrast, 300px wide, `z-index: 40`, and on this page not clipped —
the closest one has 36px of clearance above it inside `.aq-gate`'s
`overflow: hidden`.

---

## 12.3 — Verdict on each of the seven defects in the brief

| # | Defect | Verdict |
|---|---|---|
| 1 | Bypasses the shared shell | **FIX — and the reason is sharper than "consistency".** Adopt `FleetPageShell`. The cost today is not that the markup differs (it is byte-identical) — it is **1217px, 75% of the header row, that cannot be reached** because the shell's `aside` slot does not exist in this copy. Correcting the brief: 4 of 10 pages hand-roll it, not 1 |
| 2 | Opens with a wall of prose | **FIX, and disagree with the scope.** S1 owns 48 visible words + 276 behind a toggle; **S2's gate-state section is the larger block** (333px tall, 65 words at 257–268 chars/line) and the brief puts it out of scope. Fixing S1 alone takes the top of the page from 155px to ~104px and removes 276 words from the flow — a real improvement that will **not** on its own make the page feel un-walled. Said plainly now rather than discovered after the deploy: **S2 is the obvious next engagement** |
| 3 | Colour semantics are ad hoc | **FIX for S1, by removing the colour rather than repainting it.** The green promise box is deleted; S1 ends up carrying no semantic colour at all, because nothing in it is a state. That is the correct resolution of "green means both safe and informational": S1 was never signalling either. **No new palette is introduced** — a page-wide palette would be a claim over S2's amber and S5's treatment, and those are not in scope |
| 4 | Borrowed classes | **FIX.** `.acr-fl-checkstoggle` belongs to `PlanStory`/`CharterStudio` on another surface. The replacement is not a new bespoke class either: the trigger becomes a real control, and the panel becomes the **DS `Drawer`**, which is what `assignments/HowAssignmentsWork.tsx` already uses for the identical job |
| 5 | The drawer is six unstructured paragraphs | **FIX, plus one thing the brief did not know.** Structure (headed sections, front-loaded answers per GOV.UK) *and* measure: 261 chars/line → ~72 inside a 520px drawer. **And one of the six paragraphs is factually stale** — it tells the operator they cannot amend a proposal, which AQ.8 shipped and prod-verified (§12.1.5) |
| 6 | No tooltip audit | **FIX — audit in §12.5.** Findings: keyboard access works; contrast is 12.94:1; **two of WCAG 1.4.13's three requirements fail in the shared component**; and `gate` is already defined in the glossary as a *workflow* concept, so this page must never tag its own use of the word. The 1.4.13 repair lands on ten pages at once, so it is offered as an **optional, separately-claimed phase**, not smuggled into S1 |
| 7 | Not verified responsive | **PARTIALLY DISAGREE — measured, and the real defect is the opposite one.** No horizontal overflow at any width; `.acr` fills 100% of its available width; the S2 grid is `auto-fit minmax(190px, 1fr)` and reflows 4→2→1 columns cleanly with nothing overflowing at container widths 1400/1100/900/700/560/420; at a 200% zoom proxy the page still does not scroll horizontally. **The genuine width defect is at the wide end, not the narrow one: 261 characters per line at 1728px.** The verification gap is real and is closed by this build |

---

## 12.4 — The proposal

### 12.4.1 The shape

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Approvals                                              ┌────────────────────┐ │
│ Nothing on this page has happened yet.                 │ ? How approvals    │ │
│ Every card is a change one of your workers wants to    │   work             │ │
│ make. It does not happen unless you say yes.           └────────────────────┘ │
│ ───────────────────────────────────────────────────────────────────────────── │
└───────────────────────────────────────────────────────────────────────────────┘
   14px
   ⊘ Nothing can reach this queue right now.  …           (S2 — UNCHANGED)
```

Two blocks where there are four, and the rule is the only new furniture:

1. **Identity** — who this page is and what it promises. Static. Never changes
   with fleet state, queue depth, or a failed read.
2. **A 1px rule**, full content width, carried as `border-bottom` on the header
   itself so no wrapper element is inserted around S2. It says *above is the
   page, below is today* — the exact device Activity shipped at S1R, so the two
   pages read the same way.

The teaching control moves into the header's right slot. That is Helios's and
Primer's actions slot used for its designed purpose, it consumes the 1217px of
dead row, and it takes a row out of the page flow.

### 12.4.2 The copy, and why each line is where it is

**Title:** `Approvals` — unchanged.

**Description**, replacing both `.acr-sub` and `.aq-promise`:

> **Nothing on this page has happened yet.**
> Every card is a change one of your workers wants to make. It does not happen
> unless you say yes.

- Line 1 carries the load and gets **weight, not colour** (13/600 `#1c2530`,
  14.3:1) — the same mechanic, and it ends up *darker and heavier* than the same
  words are inside today's green box.
- Line 2 is 13/400 `#55616f` (6.0:1 — the value Activity settled for this exact
  role, reused so the two pages cannot drift).
- **"one of your workers", not "the fleet".** `worker` has a glossary entry;
  `fleet` does not, and minting one would be a claim on a shared append-only file
  for a word this page does not need. Cheaper copy and better copy.
- **"It does not happen unless you say yes"** is deliberately *not* "nothing
  reaches Amazon unless you say yes here". The second half of that sentence —
  that today a yes writes nothing either — is state-dependent, and S2 and the
  card already say it. **An invariant that will need rewording the day Phase F
  lands is not an invariant.** This wording stays true in both worlds.

**The header control:** `? How approvals work` — the words kept visible, not a
bare `?` icon (the standing preference is visibility over minimalism, and a
non-technical operator should not have to guess an icon).

### 12.4.3 Type, colour, spacing — exact

**Two sizes in S1, not seven.** 20px for the title, 13px for everything else in
the block; 12px only inside the header control, which has its own border and is
therefore allowed its own scale.

| Element | Size / weight | Colour | On | Contrast |
|---|---|---|---|---|
| `h1` *Approvals* | 20 / 650, `-0.01em` | `#1c2530` | `#f4f6f9` | 14.30 |
| Description line 1 | 13 / 600 | `#1c2530` | `#f4f6f9` | 14.30 |
| Description line 2 | 13 / 400 | `#55616f` | `#f4f6f9` | **6.02** (was 4.41) |
| `? How approvals work` | 12 / 500 | `#46536a` | `#ffffff` | 7.66 |
| The rule | 1px `#e4e9ef` | — | — | non-text |
| Drawer heading | 13 / 650 | `#1c2530` | `#ffffff` | 15.48 |
| Drawer prose | 13 / 400, `line-height 1.7` | `#35414f` | `#ffffff` | 10.87 |

Every text value ≥ 4.5:1, each measured **in place against the surface it
actually sits on** — the trap Activity recorded (`#6b7684` passes on white and
fails on `#f4f6f9`).

**Vertical rhythm**, 4px grid:

```
h1                              30px line box
  4
description line 1              19.5px
  2
description line 2 (wraps to 2) 39px
 16
──── 1px rule #e4e9ef ────      full content width
 14
S2 · gate state (unchanged)
```

S1's footprint: **155px → ~104px**, and 276 words leave the page flow.

**Reading measure is specified, not left to the container.** Every prose element
in S1 gets an explicit cap — `max-width: 76ch` on the description, and the drawer
is 520px wide, which puts its body at ~72 chars/line. Nothing in S1 will exceed
[WCAG 1.4.8][wcag148]'s 80-character ceiling at any viewport width. This is the
single change that fixes the "wall" measurably rather than aesthetically.

**Target sizes.** The header control is 30px tall (padding 6/11 at 12px), against
today's 18.8px — comfortably over SC 2.5.8's 24px without relying on the Spacing
exception.

### 12.4.4 The teaching drawer — the specification

A **DS `Drawer`** at `width={520}`, byte-for-byte the pattern
`assignments/HowAssignmentsWork.tsx` already ships: `<h4>` section heads, prose
beneath, portalled, Esc-closable, backdrop-closable. One component for one
concept across the fleet; nothing new is invented.

Six sections, **headings rewritten as answers** per GOV.UK — the reader learns
six facts from the headings alone:

| Today's lead (a question) | Proposed lead (the answer) |
|---|---|
| *Who is allowed to ask you.* | **Only a worker set to PROPOSE can ask you.** |
| *What was already refused before you saw it.* | **The critic has already said no to everything it could.** |
| *What happens the moment you say yes.* | **A yes waits twenty seconds before anything happens.** |
| *What happens if you say nothing.* | **Silence becomes a no after 24 hours.** |
| *Whose name goes on the record.* | **Your name goes on every decision taken here.** |
| *What this page cannot do.* | **This page decides; it does not change what a worker may do.** |

The hours figure keeps reading from the live `gate.expiry.hours` rather than
being retyped — that is how the glossary drifted 7× in the first place (AQ.0).

**The stale paragraph is corrected**, and this is a content fix, not a wording
one: the sixth section now says an operator *can* change a number before
approving it, that the edit replaces the worker's request rather than editing it
in place, and that it is re-checked by the same code that produced the original —
which is what AQ.8 built and proved on production.

**No `<Term>` inside the drawer**, and the reason is checkable rather than
stylistic: `.h10-ds-drawer-b` is `overflow-y: auto`, and `.acr-term-tip` is an
absolutely-positioned box that opens *upward* out of its line — so a tooltip in a
drawer is clipped by its own scroll container. `HowAssignmentsWork` imports no
`Term` either. The drawer *is* the long-form definition surface; tooltips serve
the terse inline copy.

### 12.4.5 Every state S1 must render

The point of making S1 an invariant is that this table is mostly one row. That is
the design working, not a gap in it.

| State | S1 renders | Why |
|---|---|---|
| **First paint / loading** | Identical. Title, description, rule, control — all static, all server-rendered | S1 reads no data, so it cannot flicker, shift or skeleton. The 347px shift below it is S2's (§12.7) |
| **Fleet off, nothing can arrive** *(today)* | Identical | The invariant is still true; S2 says why nothing is here |
| **Fleet on, queue empty** | Identical | |
| **Queue full (1–400 rows)** | Identical | This is the requirement the promise exists for. Because it is the page description and not a banner inside the empty state, it cannot disappear exactly when volume makes rubber-stamping tempting |
| **API unreachable** | Identical; the error paragraph renders **below** the rule, where it already does | An error is about today's data, not about what the page is |
| **Fleet halted** | Identical | The halt is S2's sentence and already rendered there |
| **Narrow / 200% zoom** | Identity block wraps; the control is `flex-shrink: 0` and never wraps; `flex-wrap: wrap` on the header lets it drop to its own line below ~560px | Matches Activity's header behaviour exactly |

### 12.4.6 Colour and spacing decision — am I introducing tokens?

**No new tokens, and no new colour values.** Three reasons, in order of weight:

1. **S1 stops carrying semantic colour entirely.** Nothing in it is a state, so
   nothing in it needs a tone. The green box is removed rather than repainted.
2. **The neighbours are literal hex.** `control-room.css` and `fleet-sections.css`
   hard-code theirs, and `.fleet-surface`'s own comment sets the rule for this
   subtree: *"inside `.fleet-surface` semantic tokens are WHOLE COLOURS"*, with a
   standing prohibition on Tailwind colour utilities that read them as triplets
   (`reference_ds_token_triplet_collision`). Mixing conventions inside one
   section is how that class of defect is born. Activity's S1R made the same call
   and wrote the reasoning into its stylesheet; this copies it.
3. **Every value I use already exists in the fleet for the same role** —
   `#1c2530` (primary ink), `#55616f` (description, from Activity S1R), `#e4e9ef`
   (the rule, from Activity S1R), `#46536a`/`#d7dee7` (the header control, from
   `control-room.css`'s `.acr-refresh`, which was written for this slot).
   Same role → same value → the two pages cannot drift.

The DS **components** are used where a component is the answer: `Drawer` for the
teaching layer. The DS is not used to restyle `acr-*` prose, which would be a
rewrite of two files owned elsewhere to solve a problem scoping already solves.

### 12.4.7 Where the CSS lives

A new page-local root, **`.aq-page`**, set in this page's own `page.tsx` —
matching `.sba-page` (Activity), `.wf-page` (Workflows) and `.as-page`
(Assignments). Deliberately **not** hung on `.acr-fleet` or `.acr`, which
siblings also carry: a page-local stylesheet survives a client-side route change,
so an override on a shared class silently restyles a neighbour's page. That trap
is recorded in the locks file by the Workflows stream, which hit it first.

`.acr-sub`'s 4.41:1 is fixed **under `.aq-page`**, not in the shared file. This
is the **fourth** fleet page to work around that value page-locally, which is the
point at which the central fix costs less than the workarounds — the number is
posted again in §12.8 for whoever wants to take it. I am not claiming
`control-room.css`.

---

## 12.5 — The tooltip inventory

Every piece of jargon in S1, today and as proposed, with a decision for each. The
one-definition rule means a word is either tagged everywhere it is jargon or is
not jargon here.

### 12.5.1 S1's own copy

| Term | In S1 today | Glossary entry | Decision |
|---|---|---|---|
| **worker** | untagged, in the promise (*"your AI workers"*) | ✓ `worker` | **Tag it.** First occurrence in the description, once |
| **the fleet** | untagged, in `.acr-sub` **and** the promise | ✗ none — `running` is titled "Fleet status", which is a different idea | **Remove the word from S1.** The description says "one of your workers". No glossary claim needed |
| **Amazon** | plain | n/a | Leave |
| **card** | plain | ✗ | Leave — plain English for the thing on screen, not jargon |
| **approval** | not in S1 today | ✓ `approval` | Not used in S1's copy; it is tagged in S4's empty state already |
| **gate** | not in S1 today | ✓ — but defined as a **workflow** step gate | **Never tag it on this page.** If S1 copy ever says "gate" in the approvals sense it would collide with a shipped definition. Avoided in the proposed copy |

### 12.5.2 The drawer's vocabulary

No `<Term>` inside the drawer (§12.4.4 — the scroll container clips it). Every
word below is therefore **defined in the drawer's own prose**, which is what a
drawer is for. Listed so the audit is complete and so nobody later "fixes" the
missing tooltips:

| Word | Glossary entry exists | Handled in the drawer by |
|---|---|---|
| PROPOSE | ✓ `propose` | The heading itself is the definition: *"Only a worker set to PROPOSE can ask you"*, then one sentence on OBSERVE and OFF |
| OBSERVE / OFF | ✓ `observe`, `off` | Same sentence |
| critic | ✓ `critic` | *"an adversarial reviewer whose job is to find reasons to say no"* — kept verbatim, it is good |
| undo window | ✓ `undo-window` | The twenty-second section explains it in full |
| expire | ✓ inside `approval` | *"Silence becomes a no after 24 hours"* + the sweep cadence, both read from `gate.expiry` |
| precedent | ✓ `exemplar` | One sentence in the name section |
| preview only | ✓ `preview-only` | One pointer to S2, which is where the live count is |

**Glossary changes required: none.** `glossary.tsx` is not claimed, not edited,
and not appended to by this engagement. Every word S1 needs is already defined,
and the one word it would have needed (`fleet`) is removed from the copy instead.

### 12.5.3 The mechanism, measured

| Check | Result |
|---|---|
| Keyboard reachable | ✓ `tabIndex={0}`; tooltip opens on `:focus`, verified with real document focus |
| Tab order sane | ✓ — in S1 the order is *How approvals work* → (rule) → S2's controls |
| Contrast | ✓ 12.94:1, 12px/18.6px |
| Clipped by an ancestor | ✗ not on this page — 36px clearance inside `.aq-gate`'s `overflow: hidden` |
| Readable at 200% | not measurable in this harness (see §12.6); **verified in the build** |
| **WCAG 1.4.13 Dismissible** | **✗ fails** — no Esc handler |
| **WCAG 1.4.13 Hoverable** | **✗ fails** — `pointer-events: none`; hit-test at the tooltip's centre returns the element behind it |

The two failures are in the **shared** `Term` component and its rules in
`control-room.css`. Fixing them changes the tooltip on all ten fleet pages, so it
is **phase S1.d and it is optional** — offered, costed, and not taken without a
word from the operator (§12.6).

---

## 12.6 — Build order, if approved

Four phases, each independently shippable, each committed, pushed and
prod-verified before the next.

| Phase | What | Files | Risk |
|---|---|---|---|
| **S1.a** | **The shell and the identity block.** Adopt `FleetPageShell` (no change to the shell itself — `aside` already exists); `.aq-page` root; description replaces `.acr-sub` + `.aq-promise`; the 1px rule; the `.acr-sub` contrast fix page-locally; `StandingPromise()` and `.aq-promise` deleted | `approvals/page.tsx`, `ApprovalsClient.tsx`, `approvals.css` | None shared |
| **S1.b** | **The teaching drawer.** New `HowApprovalsWork.tsx` on the DS `Drawer` at 520px; six front-loaded sections; **the stale amend paragraph corrected**; trigger moves into the header `aside`; `HowThisWorks()`, `.aq-how`, `.aq-howbody` and the borrowed `.acr-fl-checkstoggle` retired from this page | `approvals/HowApprovalsWork.tsx` (new), `ApprovalsClient.tsx`, `approvals.css` | None shared |
| **S1.c** | **The tooltip pass and the measured close-out.** Tag `worker` once; re-measure every value in §12.4.3 in the browser on prod; geometry, not presence; 200% zoom; keyboard walk | `ApprovalsClient.tsx` | None shared |
| **S1.d** | ⚠ **OPTIONAL, needs the operator's word — the WCAG 1.4.13 repair.** Make `<Term>` dismissible (Esc) and hoverable (drop `pointer-events: none`, add a small exit tolerance). **Lands on all ten fleet pages at once** and touches `glossary.tsx` + `control-room.css`, both shared. My recommendation: **yes, but as its own engagement with its own claim**, not folded into an S1 commit where a regression on nine other pages would be attributed to a header rebuild | `glossary.tsx`, `control-room.css` | **Shared — a claim in the locks file, and a note to every stream** |

**Verification method for every phase**, since four ways to check this page are
known to fail (curl cannot see the rendered page; the shell chunk hash is not a
deploy discriminator; a relative fetch hits Vercel not Railway; an empty queue
shows no card):

- **Deploy detection** — fetch the deployed route chunk and grep it for a string
  unique to the phase. The bundle is public, so this works unauthenticated.
- **Geometry, not presence** — `getBoundingClientRect` against `innerWidth`; the
  header's second child must be non-zero and the dead space must be gone.
- **Contrast in place** — `getComputedStyle` + the resolved background, not the
  intended one.
- **Measure** — a canvas text measurement per prose element, asserting ≤ 80
  chars/line at 1728px.
- No card seeding is needed: **S1 renders identically at 0 rows and 400**, which
  is the whole design. `_apx-seed-card.mts` is not touched, and the table stays
  at 18.

**One harness limitation, stated rather than papered over.** `resize_window` did
not change this tab's CSS viewport (it stayed 1728 while `outerWidth` went to
756), so media-query behaviour could not be exercised by resizing. The narrow-width
numbers in §12.3 row 7 come from a **container** probe, which exercises the
auto-fit grid and flex wrapping but **does not fire a media query** — a trap the
Workflows stream recorded. Media-query behaviour is verified in the build with a
real window, or it is reported as unverified.

---

## 12.7 — Found while auditing S1, belongs to S2–S5, LEFT ALONE

Recorded so they are not re-derived, and so it is clear they were seen and not
silently absorbed into an S1 commit.

1. **347px of load shift.** The queue card paints at `top: 175` and lands at
   `top: 522` once `/gate-state` resolves; nothing reserves the space. The fix is
   S2's: render the section's box while the read is in flight, or reserve its
   height. Measured by hiding `.aq-gate` and re-reading the queue's top.
2. **Two AA contrast failures in S2/S5**, measured in place:
   `.aq-can` / `.aq-cannot` (10.5px/600) `#6b7688` on `#f4f6f9` = **4.24:1**, and
   `.aq-gate-ok` (12.5px) `#2f855a` on `#f4f6f9` = **4.20:1**. The second is the
   line that will be on screen *every day* once the fleet is switched on — the
   open-pipe state — and it is the least legible thing on the page.
   `.aq-outnone` (S5) is the same `4.24:1`.
3. **S2's tile headings are 11px.** Below the 12px floor the rest of the fleet
   holds, and at 4.59:1 they clear AA by 0.09.
4. **Four background tints and three border radii** across S1+S2. S1's
   contribution disappears in this rebuild; S2 keeps `#fffdf6`/`#fff` at 8px and
   6px.
5. **`FleetTab.tsx:275` on the Overview still sends `content-type:
   application/json` with no body** — the bug fixed on this page on 2026-08-08
   (`FST_ERR_CTP_EMPTY_JSON_BODY`, a silent 400 that made undo do nothing). Not
   this stream's file; flagged again because it is still live.

---

## 12.8 — For the other streams

- **The `.acr-sub` 4.41:1 override is now on its fourth page.** Activity
  (`.sba-page`), Workflows (`.wf-page`), Assignments (`.as-page`) and — if this
  is approved — Approvals (`.aq-page`) will each carry the same one-line fix for
  the same shared value in `control-room.css`. Four workarounds is past the point
  where the central fix is cheaper. **No claim taken, and the value is posted so
  whoever takes it does not have to re-measure: `#667485` → `#55616f` is 4.41 →
  6.02 on `#f4f6f9`.**
- **For Activity (`SB.ACT`): thank you for the `aside` slot, and one ask.** Your
  `Freshness` component is page-agnostic and three pages now want the same
  object — Assignments said so in the locks file, and this page has an `as of`
  stamp buried inside its queue card head. **If you extract it to
  `_shared/Freshness.tsx` I will consume it and delete mine; I will not fork it,
  and I am not asking you to do it on my timetable.** Nothing in S1.a–S1.c
  depends on it.
- **For every stream: a `<Term>` inside a DS `Drawer` is clipped.**
  `.h10-ds-drawer-b` is `overflow-y: auto` and `.acr-term-tip` opens upward out
  of its line. `assignments/HowAssignmentsWork.tsx` already avoids this (no
  `Term` import); now it is written down rather than folklore.
- **For every stream: the shared `<Term>` fails two of WCAG 1.4.13's three
  requirements** (§12.5.3). It is nobody's fault and it is on all ten pages. I
  have offered to fix it as its own claimed unit (S1.d); if another stream would
  rather own it, take it — say so here and I will drop the phase.

---

## 12.9 — What I am explicitly NOT doing

- **S2 through S10.** The gate-state section, the queue card, the lists, the
  decision card, the outside queue, the precedent panel, the record — untouched,
  including the five defects in §12.7. If the operator wants the gate-state
  section rebuilt, that is the next engagement and it is the bigger one.
- **No glossary edits.** No claim on `glossary.tsx`, no new terms, nothing
  appended. Every word S1 needs already has a definition, and the one that did
  not (`fleet`) is removed from the copy instead of minted.
- **No shared-file edits in S1.a–S1.c.** `FleetPageShell` is *used*, not
  modified. `fleet-pages.css`, `control-room.css` and `fleet-sections.css` are
  not touched. S1.d is the only phase that would touch shared ground and it is
  opt-in.
- **No backend, no endpoint, no migration.** S1 reads no data at all — that is
  the design, not an omission.
- **No sticky promise.** The approved AQ-S1 text says "a persistent two-line
  promise that does not scroll away". **This is the one place I depart from the
  approved study, and the operator should overrule me if they disagree.** The
  property that actually mattered — that the promise is not inside the empty
  state, so it cannot vanish when the queue fills — is *better* served by making
  it the page description, which is present in every state including a full
  queue. A genuinely sticky element spends viewport forever on the element the
  habituation literature says will be ignored fastest, and the guarantee is
  restated at the point of decision on every card anyway (AQ.3).
- **No `Cmd+K` palette.** AQ-S1's original text names one. The same argument
  AQ.4 used to defer the keyboard map applies unchanged: a palette over a queue
  with no rows has nothing to move around and cannot be verified by anyone. It
  belongs with AQ.5, where filters and the queue-shape strip give it something to
  act on.
- **No badge, no count, no status in the header.** Helios allows badges; three
  other surfaces already own this number (the rail badge, S2, S3's tiles), and a
  fourth copy is a fourth thing to keep in sync.
- **No new component in the DS.** Everything S1 needs — `Drawer`, the shell —
  already exists.

---

## 12.10 — Sources

**Page-header anatomy** — [HashiCorp Helios · Page Header][helios] ·
[GitHub Primer · PageHeader][primer]

**Help, disclosure and tooltips** — [GitLab Pajamas · Contextual help and
info][pajamas] · [NN/g · Progressive Disclosure][nngpd] · [NN/g · Tooltip
Guidelines][nngtool] · [Adobe Spectrum · Contextual help][spectrum]

**Writing for a non-expert reader** — [GOV.UK · Create a clear
structure][govukstructure]

**Standing statements, banners and habituation** — [Atlassian Design System ·
Section message][atlassian] · [IBM Carbon · Notification pattern][carbon] ·
Anderson et al., *How Polymorphic Warnings Reduce Habituation in the Brain*,
[CHI 2015][chi] · Vance et al., [*A Longitudinal fMRI Study of Habituation and
Polymorphic Warnings*][byu]

**Empty-first surfaces** — [Shopify · Empty state pattern][shopifyempty]

**Accessibility** — [WCAG 2.2 · 1.4.13 Content on Hover or Focus][wcag1413] ·
[WCAG · 1.4.8 Visual Presentation (80 characters)][wcag148] ·
[WCAG 2.2 · 2.5.8 Target Size (Minimum)][wcag258]

**In-repo** — the memory `reference_ds_token_triplet_collision` and the comment
block in `app/fleet/fleet-pages.css` (why this subtree is literal hex) ·
`docs/2026-08-07-naf-sbact-activity-page.md` Part 18 (the header rebuild this
page follows) · `app/fleet/assignments/HowAssignmentsWork.tsx` (the teaching
drawer this page copies)

[helios]: https://helios.hashicorp.design/components/page-header
[primer]: https://primer.style/product/components/page-header/
[pajamas]: https://design.gitlab.com/usability/contextual-help
[nngpd]: https://www.nngroup.com/articles/progressive-disclosure/
[nngtool]: https://www.nngroup.com/articles/tooltip-guidelines/
[spectrum]: https://spectrum.adobe.com/page/contextual-help/
[govukstructure]: https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-structure/
[atlassian]: https://atlassian.design/components/section-message/usage
[carbon]: https://carbondesignsystem.com/patterns/notification-pattern/
[chi]: https://dl.acm.org/doi/10.1145/2702123.2702322
[byu]: https://scholarsarchive.byu.edu/facpub/9293/
[shopifyempty]: https://shopify.dev/docs/api/app-home/patterns/compositions/empty-state
[wcag1413]: https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html
[wcag148]: https://www.w3.org/WAI/WCAG22/Understanding/visual-presentation.html
[wcag258]: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

---

## 12.11 — S1R execution record (2026-08-08)

Four phases, four commits, each one built and pushed on its own and measured on
production before the next.

| Phase | Commit | What landed |
|---|---|---|
| **S1.a** | `2031ed38c` | `FleetPageShell` adopted; the promise became the page description; the `.aq-page` root; the `.acr-sub` contrast fix; the 1px rule; `.aq-promise` deleted |
| **S1.b** | `83aa5a3fb` | `HowApprovalsWork.tsx` on the DS `Drawer`; the trigger into the header's `aside`; six headings rewritten as answers; **the stale amend paragraph corrected**; `.acr-fl-checkstoggle` retired from this page |
| **S1.c** | `626e17d7e` | Two defects the browser found and `tsc` could not (below) |
| **S1.d** | `dd9a179da` | The shared `<Term>` meets WCAG 1.4.13 on all ten fleet pages |

### Measured on live Vercel + Railway, 1728×906, after S1.c

| | Before | After |
|---|---|---|
| S1's vertical footprint | 155px | **124px** |
| Header row children | **1**, leaving 1217px (75%) dead | **2** — identity block + the teaching control |
| Teaching control target size | 18.8px tall (passed 2.5.8 only via the Spacing exception) | **30.8px** — clears the 24px minimum outright |
| Distinct font sizes in S1 | **7** (20/19/13/12.5/12/11/10.5) | **2** (20 and 13), plus 12 inside the bordered control |
| Description contrast | `#667485` — **4.41 ✗** | `#55616f` — **5.83 ✓** |
| Description measure | the promise it replaced ran at **171 chars/line** | **75 chars/line** |
| Teaching prose measure | **261–266 chars/line** | **78 chars/line**, at 10.39:1 in a 520px drawer |
| `<Term>` inside the drawer | n/a | **0** — verified, not assumed |
| Horizontal overflow | none | none; `.acr` still fills 100% of its available width |

### Two defects found in the browser. Neither was visible to `tsc`, the DS ratchet or a full build.

**1 · The reading measure I specified did not bind.** `max-width: 76ch` on the
description bought **96 actual characters per line** — over the WCAG 1.4.8
ceiling that S1.b existed to get under. Measured in place: `1ch` here is
**8.20px** (the advance width of the digit `0`) while the average character in
that sentence is **6.33px**, so a `ch` cap reads about 30% tighter than it
behaves. `58ch` = 476px = **75 real characters**.

**The generalisable form, worth more than the fix:** `ch` is not "characters"
for prose. If a measure matters, assert it with a canvas text measurement
against the actual copy — do not trust the unit. Every "chars/line" figure in
this Part is measured that way for exactly this reason.

**2 · The one tooltip in S1 opened fifty pixels above the viewport.**
`.acr-term-tip` opens upward and is 118px tall; the page description sits ~54px
from the top of the page, so the definition of *workers* rendered at
`top: -50` with half of it unreadable — on the page whose standing requirement
is that a beginner understands every screen. Flipped down page-locally, which
is deterministic here because this element is always near the top; the general
fix (flip on available space) belongs with the shared component.

Both were introduced by S1.a/S1.b and caught by measuring the deployed page.
The through-line this document keeps re-finding holds again: **the defects that
survive every gate are the ones only a browser can see.**

### The bug S1.d nearly shipped, and no gate would have caught it

The first version of the Escape handler registered a `document` keydown
listener from **every** un-dismissed `<Term>` on the page. One Escape anywhere
would have marked all of them dismissed — and a term the pointer had never
touched could never re-arm, because re-arming happens on *its own*
`mouseleave`/`blur`, which never fires for an element you never entered. On the
Controls page that would have silently killed every tooltip until a reload.

It compiled, it passed the ratchet, and it built. It was caught by reasoning
about the fan-out of a shared component across nineteen files — which is the
argument for S1.d being its own phase with its own claim rather than a line
inside a header rebuild.

### S1.d verified on production, on two pages

The shared `<Term>` change lands on nineteen files, so it was verified where the
blast radius is, not only where it was written.

| Check | Before | After |
|---|---|---|
| `pointer-events` on the tip | `none` | `auto` |
| **Hoverable** — hit-test the centre of an open tooltip | returned `.aq-gate-body`, the element *behind* it | returns `.acr-term-tip` ✓ |
| **Hoverable** — hit-test the 8px gap between term and tip | the gap dropped `:hover` before the pointer arrived | returns `.acr-term-tip` — the bridge works ✓ |
| **Dismissible** — Esc | nothing happened | tip hidden, `.dismissed` set, **focus unmoved** ✓ |
| Re-arm | n/a | blur → focus shows it again ✓ |
| Position | the S1 tooltip opened at `top: -50` | fully on screen, `top: 99 → bottom: 217` ✓ |

**And the fan-out test, which is the reason this was its own phase.** On
`/fleet/controls`, which carries **39** `<Term>` instances:

| | |
|---|---|
| Terms dismissed by one Escape | **1** — the one the focus was on |
| Other terms marked dismissed | **0** |
| A different term still opens afterwards | yes |
| The dismissed term recovers on blur → focus | yes |

That is exactly the failure the first implementation would have produced — all
39 dismissed, none able to re-arm — measured on the page where it would have
done the most damage, and proven absent.

### Three corrections to the study, from measuring what shipped

1. **The description's contrast is 5.83:1, not the 6.02 §12.4.3 predicted.** The
   6.0 figure came from Activity's Part 18 and is against a different resolved
   background. Both are above the floor; the measured number is the one that
   counts, and the lesson is the one already in Activity's stylesheet: measure
   in place, not on paper.
2. **The drawer runs at 78 chars/line, not the ~72 §12.4.4 predicted.** Inside
   WCAG 1.4.8's ceiling of 80, and three characters above the 45–75 comfort
   band. **Not chased**, deliberately: closing it would mean either narrowing
   the panel away from the 520px the Assignments drawer uses, or an asymmetric
   internal gutter, and the operator's standing rule on balanced symmetric
   spacing costs more than three characters buys.
3. **The drawer holds 473 words, not the 276 it replaced.** Stated plainly
   rather than buried: the teaching layer got *longer*, because the stale amend
   paragraph had to be replaced with what AQ.8 actually built, and snooze
   needed a sentence. What changed is where those words are — out of the page
   flow, behind one control, structured under six scannable answers, at a third
   of the line length. "Fewer words" was never the goal; "not a wall" was.

### The three checks that were open, now closed

The first pass left three items unverified and said so. All three are closed,
with real keyboard input and against the deployed page.

**1 · Responsive — and the container probe turned out to be the *correct* test,
not a fallback.** `resize_window` never changed this tab's CSS viewport
(`innerWidth` stayed 1728 while `outerWidth` went to 0), and a sized popup was
blocked, so real viewport control is simply not available in this harness. That
matters less than it first appeared, because **S1 contains no media queries at
all** — verified from source: `approvals.css`'s only `@media` targets
`.aq-gate-grid`, which is S2's; `control-room.css` has no `@media` touching
`.acr-head`, `.acr-sub` or `.acr-term`; and the single query affecting S1's
container is `fleet-pages.css`'s `@media (min-width: 768px)` changing
`.fleet-surface`'s margin from −12 to −24px, i.e. **a 24px container-width
change** — exactly what a container probe varies. S1's responsiveness is
`flex-wrap` + `max-width` + `flex-shrink: 0`, all container-driven.

Probed across nine widths on the deployed page:

| `.acr` width | header height | description | control | overflow |
|---|---|---|---|---|
| 1662 → 744 | 110px, one row | 476px = **75 chars** | 160×31, right | none |
| 640 | 160px, **control wraps to its own line** | 476px = 75 chars | 160×31 | none |
| 520 | 160px | 472px = 75 chars | 160×31 | none |
| 420 | 160px | 372px = 59 chars | 160×31 | none |
| 360 | 160px | 312px = 49 chars | 160×31 | none |

The control never shrinks and never wraps its own label; the description never
exceeds 75 characters at any width; there is no overflow anywhere down to 360px.

**2 · The tooltip at 200% zoom.** Focused with the page holding real focus, at
both 100% and 200%: opens, **fully on screen** at both, renders at an effective
**24px** at 200%, and **nothing is clipped**. One number needed chasing rather
than reporting: `scrollHeight − clientHeight` is **9px**, which is exactly the
height of the hover bridge S1.d adds as an absolutely-positioned `::after`, and
the tip is `overflow: visible` so nothing could be cut off in any case. A
9px delta that matches a 9px element is an explanation, not a defect.

**3 · Real-keyboard Escape.** The earlier failure was a harness artifact — key
injection reaches the page only once the document holds focus, the same
condition that made `el.focus()` not match `:focus`. With the page clicked
first:

| | |
|---|---|
| Drawer, real `Escape` | **closes** |
| `<Term>` tooltip, real `Escape` | **hidden**, `.dismissed` set, **focus unmoved** |
| `<Term>` re-arm after blur → focus | **shows again** |

So SC 1.4.13's *Dismissible* is now proven by a real key press, not a synthetic
event, and the drawer's Esc is proven rather than inferred from the DS.

### Reconciling S1R against the ORIGINAL AQ-S1 spec — two items, and one I glossed

Part 12 scoped itself to the *presentation* of section 1 and never checked
itself against AQ-S1's own contents list in Part 4. Doing that now, because a
spec and a build that disagree silently are the exact class this document keeps
finding in other people's work.

| Part 4 said S1 contains | Shipped |
|---|---|
| `FleetPageShell` title and subtitle | ✅ S1.a |
| A persistent two-line promise | ✅ as the page description — the operator approved the departure from "does not scroll away" (§12.9) |
| The "How approvals work" drawer answering six questions | ✅ S1.b, all six, in the spec's own order |
| `<Term>` tooltips on every piece of jargon | ✅ S1.c, audited in §12.5; and S1.d fixed the component itself |
| **A `Cmd+K` palette printing every shortcut beside its action** | ❌ **not built** |
| **Glossary debt: `reversibility-class`, `superseded`, `preview-only`** | `preview-only` landed in AQ.1. **The other two never did** |

**The palette is a deferral, and it is on the record.** §12.9 lists it as
explicitly not done, with the same argument AQ.4 used to defer the keyboard map:
a palette over a queue with no rows has nothing to move around and cannot be
verified by anyone. The operator approved the study containing that sentence. It
belongs with AQ.5, where filters and the queue-shape strip give it something to
act on. Open, not forgotten.

**The glossary debt is mine, and the honest close is not to pay it.** §12.5.2
concluded "Glossary changes required: none" — true of S1's own *copy*, and I
never reconciled it against this list. Reconciled now: **neither word reaches
the operator as jargon**, so a definition would have nothing to attach to.

- `superseded` never renders raw. `ApprovalLists.tsx:72` maps it to *"You
  changed the number"*, deliberately, with the reasoning in a comment — the AQ.8
  record already explains why ("they did not say no; they said not that
  number").
- The reversibility classes render as plain English chips — *can be put back* /
  *only compensated for* / *cannot be undone* — each carrying a full inline
  sentence on the card (`ApprovalCard.tsx:80-89`).

A `<Term>` exists to define a word the UI uses. Minting entries nothing links to
would put two dead definitions into a shared, append-only file that ten pages
import, and GitLab Pajamas ranks inline UI text **above** a tooltip precisely
here. **So the debt is discharged by plain English rather than by two glossary
terms, and this paragraph is the record of that decision** — which is what was
missing, not the terms.

### Where the page stands

S1 is done and S2–S10 are untouched, including the five findings in §12.7 — of
which the two that matter most are the **347px of load shift** under the header
and the **4.20:1 open-pipe line**, the sentence that will be on screen every day
once the fleet is switched on. **S1 was not the bigger half of the wall**, and
that was said before the build rather than after it: the gate-state section is
still 333px of amber carrying 65 words at 257–268 characters per line. It is
the obvious next engagement.

---

# PART 13 — S2 DESIGN STUDY: the gate state, "can anything reach this queue?"

**Status: AWAITING OPERATOR APPROVAL.** No code written. Stream tag `SB.AQ-S2R`,
opened 2026-08-08, immediately after S1R.

Scope: **AQ-S2 only** — `GateStateSection()`, the `.aq-gate*` rules, and the
`GET /agent/fleet/approvals/gate-state` response that feeds them. S1 is finished
and is not reopened; S3–S10 are untouched. §13.8 lists what I found elsewhere and
left.

The facts S2 states are correct and were verified against production in AQ.1.
**This part changes how they are said, not what is true.**

---

## 13.0 — What S2 is FOR, in one sentence

> **Let someone who has never seen the fleet decide, correctly and out loud,
> whether this page is broken or simply quiet — and say what would have to
> change for a request to appear.**

Two consequences fall out of that sentence and they decide most of the design:

- **"What would have to change" is the half that is missing today.** Every
  sentence on S2 currently describes a state. None of them says *whose* state it
  is, and three of the four are not the operator's to change at all.
- **If S2 reads as an alarm, it has failed its own sentence.** The honest answer
  today is "quiet, on purpose" — and the block is painted like a fault.

---

## 13.1 — What is on screen today, measured

Live Vercel + Railway, 2026-08-08, 1728×906, against the resolved surface. Every
number is `getComputedStyle` / `getBoundingClientRect` / a canvas text
measurement.

| | |
|---|---|
| S2's footprint | **332.6px**, from y=144 to y=476 — the largest block on the page |
| Grid | `grid-template-columns` computes to **`387.5px ×4, then 0px 0px 0px`** — **seven tracks for four tiles, three of them zero-width** |
| Blocker prose | **268 and 257 chars/line**, `max-width: none` |
| Head sentence | 112 chars/line |
| Tile prose | 62–65 chars/line — the only text in range, and only because the grid cuts it to 364px |
| Tile label | 11px/650 `#6b7688` on `#fff` — **4.59:1**, clearing AA by 0.09 |
| Tool chip | 10.5px/600 `#6b7688` on `#f4f6f9` — **4.24:1 ✗** |
| Freshness inside S2 | **none** — and `in 43h` is the only value on the page that moves by itself |
| Tool names rendered | `create negative keyword` · `graduate keyword` · `set target bid` — internal identifiers, regex-humanised |
| Standalone 19px figures | `font-variant-numeric: tabular-nums` |

### 13.1.1 The duplication, quoted

The server composes a blocker sentence and the client composes a tile sentence
**from the same fields**, so one fact is written twice, in two places, by two
authors:

> **server** (`agent-fleet-approvals.routes.ts:152`): *"None of the actions the
> fleet can propose is able to run yet. They produce a preview only, so nothing
> can be queued for you — and approving one would record your decision and change
> nothing on Amazon."*
>
> **client** (`ApprovalsClient.tsx:248-256`): *"…of the actions the fleet can
> propose are able to run. All of them produce a preview only, so nothing can be
> queued for you — and approving one would record your decision and change nothing
> on Amazon. This is the part no other page will tell you."*

**Twenty-two words are verbatim identical.** The same is true of the PROPOSE
pair. This is not sloppy copy — it is a structural consequence of the API
sending *only the failures*, as prose, while the client needs to render *all*
the conditions, including the ones that pass. Two composers over one set of
facts is the root cause, and §13.6 fixes it there rather than by editing words.

### 13.1.2 The four numbers are four different kinds of thing

| Rendered | What it actually is |
|---|---|
| `0 of 7` | a count of a **setting** the operator controls |
| `0 of 3` | a count of a **code fact** the operator cannot change at all |
| `in 43h` | a **countdown** to a scheduled job |
| `24h` | a **policy constant** — `EXPIRY_HOURS`, which cannot differ tomorrow |

All four are rendered at 19px/640 in identical boxes. A beginner is being asked
to read a constant and a problem in the same typeface, at the same size, in the
same row.

---

## 13.2 — What the industry does with this exact surface

Seven sources, read for the mechanism rather than for principles.

### A · The strongest finding: "deliberately off" is its own status, and it is not a warning

[Argo CD's health vocabulary][argo] is the clearest statement of the distinction
S2 exists to make. It defines **Suspended** as *"the resource is suspended and
waiting for some external event to resume (e.g. suspended CronJob or paused
Deployment)"* — separate from **Degraded**, which is failure. Intentional pause
and malfunction are **different statuses**, not different intensities of one.

[LaunchDarkly][ld] presents an OFF flag in neutral, operational language — a
deliberate configuration with a configurable outcome, not a fault. [Statuspage's
top-level calculation][statuspage] makes the same point in ranking: **"Under
Maintenance" has the LOWEST precedence** of every status and surfaces only when
nothing worse is happening.

**This is the verdict on S2's palette, and it is not a taste argument.** The
fleet is off because the operator chose that. Painting it amber says *fault*
where the truth is *suspended*. **Steal:** deliberately-off gets its own status
word and a neutral treatment. **Reject:** any severity ramp that puts "switched
off" and "broken" on the same scale.

### B · Conditions: the shape of "not ready, and here is why"

[Kubernetes Pod conditions][k8s] are the most transferable structure found. Each
condition carries `type` · `status` (`True`/`False`/`Unknown`) · `reason`
(machine-readable) · `message` (human) · `lastTransitionTime`, and the set of
them "paint a complete picture of readiness without requiring inspection of
individual container states".

Two properties matter here. **Conditions are enumerated whether or not they
pass** — you can see that `PodScheduled=True` and `Ready=False`, which is what
makes the failing one legible. And **the reason and the message are separate
fields**, so the machine-readable cause never has to be reverse-engineered from
prose.

Today S2 sends `blockers: string[]` — failures only, prose only. Both properties
are absent, and §13.1.1's duplication is the direct cost.

### C · All-must-pass surfaces show every check, not just the failures

[Vercel's Checks][vercel] gates a deployment on a conjunction: *"Vercel waits
until all the created checks receive a `conclusion`"*, and only then does the
deployment go live. [GitHub environment protection][gh] is the same shape — a job
"must follow any protection rules for the environment before running". In both,
the passing checks stay on screen beside the pending ones.

**Steal:** enumerate every precondition, met and unmet. **Reject:** a
progress-bar or "3 of 4 complete" framing — see D.

### D · Activation checklists are the wrong analogue, and it took reading them to see why

[Stripe's activation flow][stripe] and [GitLab Pajamas' "Configuration
required" empty state][pajamas] are the closest-looking analogues: a list of
blocking items, each with a primary action to go and complete it. Pajamas is
explicit that this variant carries *"a primary action for configuring"*.

**They do not fit, and the reason is a safety property rather than a style
preference.** A checklist implies the reader should complete it. Two of S2's
three conditions must **not** be completed by the operator: switching a worker to
PROPOSE arms a fleet that is off by deliberate constraint, and the missing
executors are Phase F engineering the operator cannot act on at all. A surface
that invites its reader to tick off "no worker is set to PROPOSE" is actively
dangerous.

**Steal:** one line per condition, each carrying what to do about it. **Reject:**
completion framing — no progress bar, no "2 of 4 done", no primary action per
row. The disposition of each row is *whose it is*, not *do it now*.

### E · Colour is never the carrier, and the shape must change too

The status-page convention is settled — green operational, yellow degraded,
orange partial, red major, plus maintenance — and so is its accessibility
correction: [colour alone fails][statusdesign], because protanopia and
deuteranopia make the green/red pair nearly indistinguishable. The fix named
there is the one Cloudflare ships: **every state pairs a colour with a distinct
glyph *and* a text label** — a filled circle for operational, a minus for
degraded, an X for outage.

This matches what `approvals.css` already says in its own header comment
(*"Colour is never the only carrier of meaning here (WCAG 1.4.1)"*) and what S1
shipped. S2 keeps the rule and gains the missing half: **the glyph shape must
differ per state, not only its colour.**

### F · When a number deserves a tile — and these four do not

The `dataviz` skill's stat-tile contract is `label` · `value` · optional
**delta** (signed, versus a named period) · optional **trend** (a sparkline).
**None of S2's four numbers can supply a delta or a trend**, because none of them
is a measurement over time: two are counts of configuration, one is a countdown,
one is a constant. Its form table sends "a single ratio against a limit" to a
**meter**, not a tile — and a meter is wrong here too, because a meter implies
progress toward a target and *7 of 7 workers at PROPOSE is not a target anyone
should aim at*.

It also names the exact defect in §13.1's last row: **proportional figures for
standalone values, `tabular-nums` only for columns that must align** — *"a number
like 121 looks loose at display sizes"*.

**Steal:** the number goes inside the sentence it qualifies. **Reject:** the KPI
row entirely.

### G · Progressive disclosure of a diagnosis

[GitLab Pajamas' contextual-help ranking][pajamashelp] — inline text, then a
drawer, then a popover, then a tooltip — already governs this page after S1.
Its hard rule applies directly: **essential information must never be hidden
behind a trigger.** S2's content is the most essential on the page, and it is
currently behind a chevron that defaults open. A disclosure whose correct state
is always "open" is not a disclosure.

---

## 13.3 — The framing decision

> **S2 is a readiness READOUT: an enumerated set of preconditions, each with a
> state, a reason, and an owner. It is not a checklist and it is not a status
> banner.**

Both rejected framings fail for a specific, checkable reason:

- **Not a status banner.** A banner asserts something is wrong. Argo's
  Suspended/Degraded split and Statuspage's ranking of maintenance *below*
  everything both say the opposite of what amber says. Nothing is wrong here.
- **Not a checklist.** A checklist invites completion, and two of the three
  conditions must not be completed by the operator (§13.2 D). The brief proposed
  this framing and it is *nearly* right — the correction is that a readiness
  readout enumerates and explains, where a checklist enumerates and *asks*.

**The organising principle, which is the one genuinely new idea here: split the
conditions by WHO CAN CHANGE THEM.** Every row says *yours*, *ours*, or
*automatic*. That is what turns "nothing can reach this queue" from a complaint
into an answer, and it is precisely the half of §13.0's sentence the current
design does not attempt.

---

## 13.4 — The proposal

### 13.4.1 Three conditions, not four

The `24h` tile is **removed**, and not relocated. It is not a precondition for
anything arriving — it is a policy that applies *after* something has arrived —
and **S1's teaching drawer already states it**, under the heading *"Silence
becomes a no, never a yes"*, reading the same `gate.expiry.hours`. Keeping it
here made it the third copy of one fact.

What remains is a genuine conjunction — all three must be true before a request
can exist:

| # | Condition | Today | Owner |
|---|---|---|---|
| 1 | A worker has to be allowed to ask | **not met** — none of 7 is set to PROPOSE; only 1 ever could be | **yours** → Controls |
| 2 | What it proposes has to be able to run | **not met** — all three of the fleet's actions describe what they would do and stop there | **ours** — not built yet |
| 3 | Something has to be scheduled to ask | **met** — the weekly council, next in 43 hours | automatic |

### 13.4.2 The shape

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⏸  Nothing can reach this queue yet — and nothing is broken.                  │
│    Three things have to be true before a worker can ask you for anything.     │
│    One of them is.                                                            │
│                                                                               │
│    ⏸  Not yet    A worker has to be allowed to ask                            │
│                  None of your 7 workers is set to PROPOSE. Only 1 ever could  │
│                  be — the other 6 are capped lower in code.                   │
│                  Yours to change · Controls →                                 │
│                                                                               │
│    ⏸  Not built  What it proposes has to be able to run                       │
│                  All three of the fleet's actions can describe what they      │
│                  would do and stop there: stop ads showing for a search term, │
│                  promote a search term to its own keyword, change a keyword's │
│                  bid. Approving one would record your decision and change     │
│                  nothing on Amazon.                                           │
│                  Ours to build — nothing you can do here                      │
│                                                                               │
│    ✓  Ready      Something has to be scheduled to ask                         │
│                  The weekly council, next in 43 hours. A nightly sweep cannot │
│                  queue a request, and neither can a one-off run.              │
│                  Automatic                                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

Notes on what changed and why, each traceable to a defect:

- **The headline gains its second clause** — *"and nothing is broken"*. That is
  the sentence §13.0 exists to deliver and no wording on the page says it today.
- **Numbers live inside sentences** (§13.2 F). `0 of 7` becomes *"None of your 7
  workers is"*, which is the same fact in the register a non-technical operator
  reads.
- **Tool names come from `toolCardFor().shortAsk`** — *"stop ads showing for a
  search term"* — the vocabulary **this page already imports** for its card
  (`ApprovalCard.tsx:45`). No new dictionary, no API change, and it closes defect
  6 with the one-dictionary rule AP.3 established.
- **The owner line is new**, and it is the design.
- **Rows are `<li>` in an `<ol>`** with the state word as text, so the readout is
  a list to a screen reader and reads correctly with styles off.

### 13.4.3 Every state, designed

| State | What renders |
|---|---|
| **(a) all three unmet** *(today, minus condition 3 which passes)* | The block above. Headline *"Nothing can reach this queue yet — and nothing is broken."* |
| **(b) some cleared** | Same block; cleared rows collapse to a single `✓ Ready` line with no detail paragraph, so the unmet ones carry the whole visual weight. Headline counts: *"…Two of them are."* |
| **(c) pipe fully open** — never rendered anywhere, ever | **One line, and it keeps the glyph+word contract:** `✓ Ready · A worker can ask you, and the next chance is the weekly council in 43 hours.` No card, no border — it is a fact, not an event. Verified per §13.7 |
| **(d) fleet halted** | The halt is the **only genuine fault state on this surface**, so it is the only one that earns danger colour: a `.acr-banner err` **above** the readout (GOV.UK's placement rule, already adopted by Activity), with the reason verbatim and a link to Controls. The readout still renders beneath it — a halt does not make the other conditions unknowable |
| **(e) non-fleet requests waiting** | Stays, but stops being a warning stripe inside S2 and becomes **one sentence at the foot of the readout** pointing down at S5, which owns those rows and already renders them in full. Today S2 and S5 both explain them |
| **(f) loading** | **A skeleton of the readout at its real height**, which is also the fix for the 347px load shift §12.7 recorded. Today `if (!gate) return null` renders nothing, so the queue card paints at y=175 and lands at y=522 |
| **(f) fetch failed** | **Not silence — that is the current behaviour and it is wrong.** A failed read of *this* endpoint means the page cannot answer its own question, and rendering nothing makes an empty queue look normal. It renders the readout frame with `Unknown` on every row and one line: *"Could not read the fleet's state. This page cannot tell you whether anything is waiting to reach you — the queue below may be empty for a reason it cannot see."* |

**(c) is the state that has never existed**, and it is the one this design is
most likely to get wrong. §13.7 says exactly how it will be exercised.

### 13.4.4 The S2 ⇄ S3 contract, settled now rather than discovered later

Part 4 specified that S2 and S3 trade places: empty queue → S2 is the page;
full queue → S3 is the page and S2 is one line. S3 does not exist, so that has
been half a contract since AQ.1.

**Settled: S2's size is a function of the queue, never of a toggle.**

| Queue | S2 renders |
|---|---|
| empty | the full readout (a)/(b)/(c) |
| **any row waiting** | **one line**, whatever the conditions say — `⏸ Nothing new can reach this queue · 1 of 3 conditions met · why →`, expanding on click |

This is also the answer to defect 5. The chevron disappears because the collapse
is **data-driven, not user-driven**: on the day a request is waiting, the
operator's attention belongs on the request, and S2 shrinks itself. When S3
lands it inherits this contract unchanged and needs nothing from S2.

### 13.4.5 Type, colour and spacing — exact

Continuing S1's ladder rather than starting a second one. **Two sizes**: 13px for
everything, 11.5px only for the state word inside its chip.

| Element | Size / weight | Colour | On | Contrast |
|---|---|---|---|---|
| Headline | 13 / 600 | `#1c2530` | `#f7f9fb` | 13.4 |
| Headline second clause | 13 / 400 | `#55616f` | `#f7f9fb` | 5.6 |
| Condition requirement | 13 / 600 | `#1c2530` | `#fff` | 15.5 |
| Condition detail | 13 / 400 | `#4a5867` | `#fff` | 8.6 |
| Owner line | 13 / 400 | `#55616f` | `#fff` | 6.7 |
| State chip — *Not yet* / *Not built* | 11.5 / 600 | `#4a5867` on `#eef1f5` | — | 7.9 |
| State chip — *Ready* | 11.5 / 600 | `#14724d` on `#f1faf5` | — | 5.6 |
| State chip — *Unknown* | 11.5 / 600 | `#55616f` on `#eef1f5` | — | 6.2 |
| Rule between rows | 1px `#e4e9ef` | — | — | — |

**Every value is measured in place before it ships**, per S1R's lesson that
`#6b7684` passes on white and fails on `#f4f6f9`.

### 13.4.6 The colour decision, stated once

> **S2 carries exactly one semantic colour, and only where there is a genuine
> fault: the halt, and a failed read. Everything else is the page's normal ink.**

Three reasons, in order of weight:

1. **"Switched off" is not a warning** (§13.2 A). Amber on a deliberately-dark
   fleet tells the operator something is wrong every single day, which is both
   false and the fastest possible route to the habituation S1 already designed
   against.
2. **The invented amber was a *fourth* palette, not a first.** The fleet already
   has a status vocabulary — `.acr-banner` `err`/`warn`/`ok` in
   `control-room.css`, used by **seven** fleet surfaces (Controls ×3, Workflows
   ×4, Activity ×2). `.aq-gate` is `#fffdf6`/`#e6d6b8`/`#a16207`;
   `.acr-banner.warn` is `#fff8ec`/`#ecd9ae`/`#8a6320`. Two ambers, one intent.
   **Where S2 genuinely needs a fault colour it uses `.acr-banner`, read-only,
   exactly as Activity does** — no new palette, no claim on a shared file.
3. **The DS status ramp is available and dark-safe, and I checked rather than
   assumed.** `--status-warning-*` / `--status-danger-*` resolve through
   `--h10-amber-*` / `--h10-red-*`, and **tokens.css's single `.dark` block never
   redefines those ramps** — so they are whole colours in both themes with no pin
   needed. They are the right tool the day S2 needs a second tone. It does not
   need one now, and inventing a use for an available token is how a fourth
   palette gets born.

The neutral chip greys (`#eef1f5`, `#4a5867`) are the page's existing ink, not
new values.

---

## 13.5 — Verdict on each of the nine defects

| # | Defect | Verdict |
|---|---|---|
| 1 | Invented amber palette | **FIX — by removing the colour, not repainting it.** Deliberately-off is not a warning (Argo, LaunchDarkly, Statuspage all agree). And the sharper version of the finding: it was a **fourth** amber, when `.acr-banner.warn` already serves seven fleet surfaces. One semantic colour, faults only |
| 2 | The same information twice | **FIX AT THE ROOT.** Not a copy-editing job — 22 words are verbatim identical because the API sends *failures as prose* and the client re-composes *all conditions* from the same raw fields. §13.6 moves composition server-side, once |
| 3 | Four kinds of fact, one visual weight | **FIX, and go further than the brief.** One of the four (`24h`) is not a condition at all and is **removed**, because S1's drawer already says it. The remaining three get a state word each, so "problem" vs "how it works" is carried by the state, not inferred from the number |
| 4 | Accidental grid | **FIX.** Confirmed: `387.5px ×4 + 0px 0px 0px` — seven tracks, three collapsed. Replaced by rows, which is what a conjunction of preconditions is |
| 5 | Borrowed disclosure affordance | **FIX.** The chevron goes entirely. A disclosure whose correct state is always "open" is not a disclosure (Pajamas: essential information must never be hidden behind a trigger). Collapse becomes **data-driven** via the S2⇄S3 contract, §13.4.4 |
| 6 | Raw tool names | **FIX, with no new dictionary.** `toolCardFor().shortAsk` — *"stop ads showing for a search term"* — already imported by this page for its card |
| 7 | No freshness | **FIX, partially, and say what I am not doing.** The council countdown becomes `<time dateTime>` with the absolute instant in its accessible name — so the one self-moving value is checkable. **I am not building a second freshness instrument:** the page-level "as of" belongs in S1's header `aside`, and that needs Activity's `Freshness` extracted to `_shared/`, which is an open ask (§12.8), not S2's to fork |
| 8 | The healthy state has never rendered | **FIX, and verify it for real.** Designed as one line in §13.4.3(c) and exercised against a stubbed payload per §13.7 — not reasoned about |
| 9 | No tooltip audit | **FIX** — §13.7.1, to the standard S1 set: every term listed, keyboard, 200% zoom, and no term minted that the UI does not show |

---

## 13.6 — The API change, and why it is the fix rather than a refactor

**Yes, the response shape changes**, in this stream's own file. `blockers:
string[]` becomes an enumerated conditions array, modelled on
[Kubernetes conditions][k8s]:

```ts
interface GateCondition {
  key: 'worker-may-ask' | 'action-can-run' | 'something-scheduled'
  met: boolean
  /** Null when the read failed — renders as Unknown, never as met. */
  known: boolean
  /** The precondition, in the operator's words. Server-composed, rendered verbatim. */
  requirement: string
  /** Why it is / is not met, with the numbers already in the sentence. */
  detail: string
  /** Who can change it. The organising idea of the whole section. */
  owner: 'operator' | 'engineering' | 'automatic'
  href: string | null
}
```

`conditions: GateCondition[]` replaces `blockers`. `canAnythingArrive` stays and
becomes `conditions.every(c => c.met)`.

**Why this is the defect-2 fix and not tidying.** Today the server can only
describe failures, so the client *must* re-derive sentences for the conditions
that pass — which is why two authors ended up writing the same 22 words. With
every condition enumerated and composed once, server-side, there is exactly one
place a sentence can come from, and a met condition has a sentence for the first
time. It is the same argument AQ.1 made for computing the blockers server-side
and rendering them verbatim; it was simply applied to half the set.

`workers`, `tools`, `arrival`, `expiry`, `outside`, `halted` all stay — the
client still needs `tools` for the per-action list and `arrival.councilNext` for
the countdown's `dateTime`. **Nothing is removed that another consumer reads:**
`gate-state` has exactly one caller, `ApprovalsClient.tsx`, verified by grep.

No migration, no schema change, no new endpoint.

---

## 13.7 — How each state gets verified, including the one that has never existed

**⚠ The safety rule is absolute and is restated here because it is the whole
reason (c) is hard: nothing in this engagement enables a charter, moves an
autonomy dial, sets `AgentDefinition.enabled`, or turns on a cron.** States are
produced by stubbing the *response*, never by changing the world.

**Chosen method for (b), (c), (d) and (f): option (1) — a local dev run against a
read-only stub**, per `reference_web_verify_without_local_api`, whose two newest
traps are exactly the ones that would cost the time: browse **`localhost`, never
`127.0.0.1`** (Next dev blocks its own HMR resources from a foreign origin, the
page never hydrates, and the console is clean), and use **one hostname for both
ends** so Private Network Access does not block the fetch. The stub serves
`gate-state` from a fixture file and nothing else; `apps/api` is never booted, so
no cron can touch prod Neon.

If the stub proves unreliable I fall back to **option (2)** — a component test
per state — and will **say which was used**. A state will not be described as
verified on the strength of having been reasoned about.

| State | How |
|---|---|
| (a) today's | prod, in the browser, geometry measured |
| (b) partial | stub: one condition flipped `met: true` |
| (c) fully open | stub: all three `met: true` — **the state no human has seen** |
| (d) halted | stub: `halted: true` with a reason |
| (e) outside pending | prod — `_apx-seed-card.mts seed`, then `clean`, then `_apx-probe.mts` back to exactly **18 approvals, 0 exemplars, 0 audit rows** |
| (f) loading / failed | stub: a delayed response, then a 500 |

Plus, on prod, to S1's standard: nine widths, 200% zoom, real keyboard input,
`getBoundingClientRect` against `innerWidth`, and deploy detection by grepping
the public route chunk for a string unique to the phase.

### 13.7.1 Tooltip inventory

| Term S2 will show | Entry | Decision |
|---|---|---|
| **PROPOSE** | ✓ `propose` | tag |
| **cap** | ✓ `cap` | tag — used in "capped lower in code" |
| **council** | ✓ `council` | tag |
| **sweep** | ✓ `sweep` | tag |
| **preview only** | ✓ `preview-only` | tag |
| **worker** | ✓ `worker` | already tagged once in S1's description; **not tagged again** — one tooltip per page per term |
| *refused*, *halted*, *scheduled*, *condition*, *ready* | ✗ | **plain English, deliberately untagged.** S1 set the precedent: never mint a term the UI does not actually show as jargon |
| **`gate`** | ✓ — but defined as a **workflow step gate** | **must never be tagged here.** The word is avoided in S2's copy for the same reason S1 avoided it |

**Glossary changes required: none.** No claim on `glossary.tsx`.

⚠ **One S1R finding applies directly:** `.acr-term-tip` opens *upward* and is
118px tall, so any `<Term>` within ~120px of the viewport top needs the
page-local downward flip S1.c added. S2 begins at y=144 today and will begin
higher once the readout is shorter — **the flip must be extended to S2's rows and
measured**, not assumed.

---

## 13.8 — Found while auditing S2, belongs elsewhere, LEFT ALONE

1. **`.aq-outnone` (S5) is 4.24:1** — same failing chip colour as S2's, on the
   line that renders when nothing is waiting from outside the fleet.
2. **The 347px load shift is S2's and is fixed here** (§13.4.3(f)) — recorded in
   §12.7 as S2's to fix, and this is that.
3. **`FleetTab.tsx:275` on the Overview still sends `content-type:
   application/json` with no body** — the silent-400 bug fixed on this page on
   2026-08-08. Not this stream's file. Third time flagged.

---

## 13.9 — What I am explicitly NOT doing

- **S1 and S3–S10.** The header, the drawer, the queue card, the lists, the
  card, the outside queue, the record. S5 keeps its own full treatment of
  non-fleet rows; S2 only points at it.
- **No second freshness instrument.** The page-level "as of" belongs in S1's
  header `aside` once Activity extracts `Freshness` to `_shared/` (§12.8's open
  ask). S2 will not fork it.
- **No glossary edits, no claim on `glossary.tsx`.**
- **No new shared-file edits.** `control-room.css` is *used* (`.acr-banner`),
  not modified. `fleet-pages.css`, `fleet-sections.css` untouched.
- **No migration, no schema change, no new endpoint.** One response shape
  changes, in this stream's own routes file, with one caller.
- **No progress bar, no "N of 3 complete", no per-row primary action.** §13.2 D:
  completion framing on this surface invites arming a fleet that is off by
  operator constraint.
- **Nothing that enables anything.** No charter, no dial, no cron, no
  `AgentDefinition` row — including to make a screenshot look better.

---

## 13.10 — Proposed build order

| Phase | What | Shared files |
|---|---|---|
| **S2.a** | The API: `conditions[]` replaces `blockers[]`, composed once server-side, with `owner` | none — own routes file |
| **S2.b** | The readout: three rows, state chips, numbers inline, real tool names, the chevron and the grid retired, the `24h` tile removed | none |
| **S2.c** | The states: loading skeleton at real height (kills the 347px shift), the failed-read readout, halted, outside-pointer, and **the open pipe** — each exercised per §13.7 | none |
| **S2.d** | The S2⇄S3 collapse contract + the tooltip pass (flip extended, keyboard, 200% zoom) and the measured close-out | none |

---

## 13.11 — Sources

**Readiness and conditions** — [Argo CD health status][argo] ·
[Kubernetes Pod conditions][k8s] · [Vercel Checks][vercel] ·
[GitHub environment protection rules][gh]

**Deliberately-off vs broken** — [LaunchDarkly flag targeting][ld] ·
[Statuspage top-level status calculation][statuspage]

**Checklists and empty states** — [Stripe account activation][stripe] ·
[GitLab Pajamas empty states][pajamas] · [GitLab Pajamas contextual help][pajamashelp]

**Status vocabulary and colour** — [status-page design patterns and the
colour-alone failure][statusdesign]

**Numbers and tiles** — the `dataviz` skill: `references/choosing-a-form.md`
(is it even a chart), `references/marks-and-anatomy.md` (the stat-tile contract,
proportional vs tabular figures), `references/anti-patterns.md` (status colour
is reserved)

**In repo** — Part 12 (the S1 study this one continues) ·
`reference_web_verify_without_local_api` (the stub method and its two traps) ·
`reference_ds_token_triplet_collision` (whole colours under `.fleet-surface`)

[argo]: https://argo-cd.readthedocs.io/en/stable/operator-manual/health/
[k8s]: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
[vercel]: https://vercel.com/docs/deployments/checks
[gh]: https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
[ld]: https://launchdarkly.com/docs/home/flags/toggle
[statuspage]: https://support.atlassian.com/statuspage/docs/top-level-status-and-incident-impact-calculations/
[stripe]: https://docs.stripe.com/get-started/account/activate
[pajamas]: https://design.gitlab.com/patterns/empty-states/
[pajamashelp]: https://design.gitlab.com/usability/contextual-help
[statusdesign]: https://www.pttrns.com/status-page-design-patterns-how-the-best-saas-companies-communicate-downtime/

---

## 13.12 — S2R execution record (2026-08-08)

Approved by the operator on the study as written. Five phases and three repairs,
each committed, pushed and measured on production before the next.

| Phase | Commit | What landed |
|---|---|---|
| **S2.a** | `799f365c7` | `blockers[]` → enumerated `conditions[]` with `owner`, on the Kubernetes-conditions model |
| *repair* | `894810de4` | `blockers` restored — **S2.a took the page down** (§13.13) |
| **S2.b** | `d777c6247` | The readout: three rows, state chips, real tool names; the amber, the tiles, the grid, the chevron and the `24h` tile all retired |
| *repair* | `e8d28bd53` | Four rules S2.b deleted that belonged to S4 and S5 |
| **S2.c** | `de012f37a` | The `ch` trap again, and 113px of avoidable height |
| **S2.d** | `41999c81d` | The loading skeleton and the failed-read state; deprecated `blockers` dropped |
| **S2.e** | `cc146a160` | Tooltips restored; narrow-width overflow |
| *repair* | `72fccc782` | `withTerms` typed so `next build` agrees with `tsc` |

### Measured on live Vercel + Railway, 1728×906

| | Before | After |
|---|---|---|
| S2's footprint | 332.6px | **362.8px** |
| Font sizes in the section | **7** (20/19/13/12.5/12/11/10.5) | **2** (13 and 11.5) |
| Line length | 257–268 chars | **75** |
| Worst contrast in the section | `.aq-can` **4.24 ✗** | **5.57 ✓** (that chip is now 6.43) |
| Grid | `387.5px ×4, 0px 0px 0px` — 7 tracks, 3 collapsed | rows |
| Tool names | `create negative keyword` | *"stop ads showing for a search term"* |
| Semantic colours | a fourth invented amber | **one**, faults only, from the shared `.acr-banner` |
| Horizontal overflow | overflow below ~300px | **none at any width down to 220px** |
| 200% zoom | — | no overflow; chip at an effective 23px |
| Tab stops in S2 | a full-width chevron button | one link + **three `<Term>`s**, all keyboard-reachable and fully on screen |

**The footprint went UP by 30px and that is the one number that did not improve.**
Stated plainly rather than buried: the old block was smaller because it crammed
four unlike facts into a grid. Three fully explained conditions, each with an
owner and the evidence under the one that needs it, cost 30px more. That trade
is deliberate. 475.6px — where S2.b first landed — was not, and S2.c took 113px
back out of it.

### Every state, and how each was actually exercised

**Method, stated because the brief requires it: option (3) — the gate-state
RESPONSE was intercepted in the deployed page.** Not a local stub, and the
reason is that this is *stronger* evidence here, not weaker: it exercises the
production bundle rather than a dev build, needs no local API (so no cron can
touch prod Neon), and needs no auth. Read-only, client-side, nothing persisted.
**Nothing in the world was changed — no charter, no dial, no cron, no
`AgentDefinition` row**, including to make a screenshot look better.

| State | Exercised | Result |
|---|---|---|
| (a) all unmet | real prod data | readout, 362.8px |
| (b) some cleared | stub | chips → `Ready / Not built / Ready` |
| **(c) the open pipe** | stub | **one line, 19.5px** — *"Ready — a worker can ask you, and the next chance is the weekly council in 42h."* **The first time this state has rendered anywhere in this fleet's history.** |
| (d) halted | stub | shared `.acr-banner err`, `role="alert"`, above the readout, which still renders beneath |
| (e) outside pending | stub | one sentence at the foot pointing to S5; 426.1px |
| (f) loading | intercept + SPA remount | skeleton at **363px**, the readout's exact height, `aria-busy` |
| (f) read failed | intercept + SPA remount | renders the admission; **invents zero condition rows** |
| **S2 ⇄ S3 collapse** | stub `counts.waiting: 1` | **362.8px readout → 19.5px one line**: *"1 of 3 conditions met — nothing NEW can reach this queue yet."* Restored to the readout when the count returned to 0. The contract settled in §13.4.4, proven |

**One harness fact worth recording, because it silently defeats every state
test:** the automation drives the tab offscreen, so `document.visibilityState`
is `hidden` and `useVisibilityPoll` never fires — correctly. No stub takes
effect until the document is presented as visible. The first two attempts read
as "the interceptor does not work" and were neither.

### Five defects of my own, every one caught by measuring rather than reviewing

Recorded together because the pattern matters more than any single one.

1. **S2.a took the page down.** Removing `blockers` and updating its reader in
   one commit ignored that Railway and Vercel deploy independently. The live
   client called `gate.blockers.map()` on a response without it; `main` fell to
   84 characters of text. §13.13 has the rule.
2. **S2.b deleted four rules belonging to S4 and S5** by replacing a
   marker-to-marker range. Only one was visible enough to notice.
3. **S2.c: I walked back into the `ch` trap I documented in S1.c**, one phase
   earlier, in the same stylesheet. `76ch` bought 99 characters.
4. **S2.e: server composition had silently removed every tooltip.** Once
   `requirement` and `detail` are composed on the server the client cannot wrap
   a word in `<Term>`. Caught by auditing tab stops — one, where §13.7.1
   expected five.
5. **The repair to S2.e passed `tsc` and failed `next build`**, blocking every
   parallel session's push.
6. **My deploy probe gave a false positive**, and this one is in the
   verification rather than the code — see §13.14. It is the reason rows in the
   table above are marked pending rather than verified.

**Not one was visible to `tsc`, the DS ratchet, the security suite or the
build** — except the fifth, which only the build could see. The thing that
caught them was opening the deployed page and measuring it. That is the
argument for this engagement's verification discipline, made against my own
work rather than someone else's.

### Two corrections to the study itself

1. **§13.4.3(f) specified "the readout frame with `Unknown` on every row" and
   that is not implementable.** Every requirement sentence is composed
   server-side, so a failed read has no rows to label — and inventing three
   from a client-side constant would be the stale-constant class this page
   exists to stop. Shipped as the frame plus one sentence admitting the page
   cannot answer its own question.
2. **The `known` field was dropped** from the `GateCondition` interface the
   study proposed. The server can never return a condition it does not know;
   "unknown" is a client state for when there is no response at all.

### What is NOT done

- ~~**The S2 ⇄ S3 collapse is built but has never rendered.**~~ **Now
  exercised and verified** — see the row added to the state table above. It was
  the last unverified line of S2, and closing it needed only the COUNT stubbed
  (`approvals: []` with `counts.waiting: 1`), which hits the `waiting > 0`
  branch without fabricating an approval row.
- **`.aq-outnone` (S5) is still 4.24:1** — §13.8, left alone.
- **S3–S10** untouched.

---

## 13.13 — The rule S2.a produced: a commit is TWO deploys

Posted to `docs/2026-08-07-naf-sb-session-locks.md` §6c as well, because at
least two other streams ship API and client in single commits.

> **On a split deploy, a field may only be REMOVED one deploy after its last
> reader stops reading it.** Adding the replacement and deleting the original in
> one commit is a breaking change dressed as an atomic one.
>
> So renaming a response field is always **three** commits, never one: add the
> new one → move every reader → delete the old one. The middle commit is the one
> people skip.

**Why no gate catches it:** web keeps a hand-written mirror of the API type, so
both `tsc` runs are green either way; the ratchet and the security suite never
look at a response shape; and a vitest that mocks Prisma asserts what the server
*sends*, not what a *previously deployed* client expects. Only the browser sees
it, minutes after the push looked successful.

The locks file already said *a commit is a deploy*. This is the same class one
level down: **a commit is two deploys, and they do not land together.**

---

## 13.14 — The sixth defect, and it is in the verification

Worth its own section because it nearly put a false claim into §13.12.

To detect that S2.e had deployed I grepped the public bundle for
`aq-condowner`. It reported READY, so I measured — and found **zero tooltips
and the narrow-width overflow still present at 280px and below.** The probe was
wrong: **`aq-condowner` shipped in S2.b.** It was present in the bundle either
way, so the probe could only ever say yes.

Had I not measured the thing the probe was supposed to be gating, §13.12 would
have recorded S2.e as verified on the strength of a signal that could not fail.

This is the same trap this page's own verification notes already warn about —
*"the shell chunk hash does NOT change when a route chunk does"* — wearing a
different costume. The general form:

> **A deploy discriminator must be unique to the CHANGE, not merely present in
> it.** Grep for a string that did not exist one commit earlier — a new class
> name, a new literal, a changed declaration — and confirm it returns 0 against
> the currently-deployed build *before* trusting it to return 1 later.

**And the corrected probe was ALSO wrong, which is the more useful half.** It
grepped the deployed stylesheet for `aq-condowner{flex:0 1 auto` — a declaration
that exists only after S2.e. It returned 0 against the live build, exactly as a
good discriminator should… and kept returning 0 after the deploy landed, because
**the minifier had rewritten it**: the shipped rule is
`.aq-condowner{color:#55616f;flex:0 auto;min-width:0;font-weight:400}` —
properties reordered, and `flex: 0 1 auto` collapsed to the equivalent
`flex: 0 auto`.

So the rule needs a second clause:

> **A CSS discriminator must survive minification.** A class NAME does; a
> declaration's exact text does not — values get collapsed to equivalent
> shorthands and properties get reordered. Grep for a name that is new, or read
> the rule back and compare semantically.

It was caught by sanity-checking the probe's MECHANISM rather than trusting its
answer: confirming it could find the stylesheet at all, and printing the rule it
found. That printout is what revealed the change had been live for some time.
S2.e was then measured properly and is verified in §13.12.

---

# PART 14 — S4 DESIGN STUDY: the list, and the empty state that is this page

**Status: AWAITING OPERATOR APPROVAL.** No code written. Stream tag `SB.AQ-S4R`.

Scope: **AQ-S4 only** — the queue card, its heading, the view tabs, the empty
states, and the `.aq-emptywhy` line. S1, S2, S3 and S5–S10 are untouched.

---

## 14.0 — What S4 is FOR, in one sentence

> **Be the screen an operator opens every morning for the next several weeks and
> come away correctly informed — which today means an empty queue that teaches
> instead of apologising, and never claims something that is not true.**

The study's own words for this section are *"the empty state IS this page for
weeks"*. That is not a hedge — it is the design constraint. **S4 has been
rendered as an empty list every single day since AQ.1, and it will be until
Phase F.** So the empty state is not a fallback: it is the primary state, and
it should be designed first.

---

## 14.1 — What is on screen today, measured

Live prod, 1728×906, `getComputedStyle` / `getBoundingClientRect`.

### 14.1.1 The headline defect: the page contradicts itself, 57px apart

Two sentences render inside the same card, 57 pixels apart:

> **"Nothing is waiting for you. Approvals appear here when a plan passes the
> critic — and every yes or no you give becomes precedent the workers read on
> their next run."**
>
> **"This is empty because nothing can arrive yet, not because the fleet looked
> and found nothing — see above."**

**The first sentence is false, and this document proves it in Part 1.1.** A plan
that *passes* the critic queues nothing: `runOrQueueTool` creates no row for a
tool with no `execute()`, six of seven charters cap below PROPOSE, and
`executeCharter` never reaches the queueing path at all. The locks file
(§5 row 8) warns every stream about this exact sentence in these words: *"any
page that says or implies 'approvals appear here when a plan passes the critic'
is currently false."*

It is on the Approvals page itself, written by this stream, directly above a
line that contradicts it.

[NN/g][nng] is blunt about the cost: inaccurate status messages are
*"particularly harmful"* — users *"either develop distrust or abandon tasks"*.
The whole reason S2 exists is to tell a blocked queue from a quiet one, and S4
undoes it in the sentence a reader hits first.

### 14.1.2 The rest, measured

| Element | Size / weight | Colour | Contrast |
|---|---|---|---|
| `.acr-cardhead h3` — *Waiting for you* | 16 / **400** | `#1c2530` | 15.48 ✓ |
| `.aq-asof` — the freshness stamp | 11.5 / 400 | `#7b8798` | **3.65 ✗** |
| `.acr-fl-empty` — **the empty state** | 12.5 / 400 | `#7b8798` | **3.65 ✗** |
| `.aq-emptywhy` | 12 / 400 | `#6b7688` | 4.59 ✓ |

- **The two worst-contrast elements on the page are the freshness stamp and the
  empty state** — and the empty state is the single most-read piece of text on
  this page, at **3.65:1**.
- **Seven size/weight pairs inside one card** — 10/700, 11.5/400, 12/400,
  12.5/400, 12.5/550, 12.5/650, 16/400. S1 went to two and S2 to two; S4 still
  has the wall both of them removed.
- **The heading is 16px/400** — a heading with no weight, and the only 16px on
  the page.
- **One empty state where the approved spec calls for three.** There is no
  "the fleet ran and found nothing" and no "your filter hides N".
- The card is 220.5px at `top: 520`.

---

## 14.2 — Research, and the one thing it changes

Two lenses only; the rest of what S4 needs was already settled by S1's and S2's
research (Pajamas' help hierarchy, Polaris' empty-state tone, the status-colour
rules).

### A · An empty state is an onboarding surface, not a failure message

[NN/g][nng] separates empty states by cause — unfilled container, *unconfigured
feature*, no search results — and says each needs different content: a system
status confirmation, a feature explanation, or a path to the task. Ours is the
**unconfigured** kind, and it is being written as the unfilled kind.

[Shopify][shopifyempty] (from S1's research) adds the tone rule and explicitly
covers persistence: an empty state exists to say *"what will appear here"*, and
is a legitimate long-term state for *"prompting feature activation or
configuration"*.

### B · Show a worked example rather than a blank space

The convergent finding across the onboarding literature is that **users who
start from something real outperform users who start from a blank workspace**,
and that the best products treat the empty state as their primary onboarding
surface rather than as an error. The approved AQ-S4 spec already calls for *"a
worked sample card, visibly inert"* — the research supports it, and for a queue
that **cannot** fill for months it is worth more here than in a product where
real data arrives on day two.

**What this changes:** the sample card moves from a nice-to-have at the bottom
of the spec to **the centre of the design**. An operator who has never seen an
approval should be able to read one — clearly labelled as an example, not
decidable — before their first real one arrives. That is the only way the first
real decision is not also the first time they have seen the interface.

---

## 14.3 — The framing

> **S4's default state is "configured but dormant", and it should read as a
> demonstration, not an apology.**

Three consequences:

1. **The false sentence goes.** What replaces it is the true one S2 already
   computes, and S4 should not re-derive it — that would be a second composer
   over one set of facts, which is precisely the defect S2.a fixed.
2. **The `.aq-emptywhy` line and the empty state merge.** They are two halves of
   one statement rendered 57px apart, one of them wrong.
3. **The sample card becomes the body of the empty state**, not a footnote to
   it.

---

## 14.4 — The proposal

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Waiting for you                                         ● Live · updated 4s  │
│ ┌ Waiting 0 ─┬─ Decided 18 ─┬─ Ran out of time 0 ─┐                          │
│                                                                              │
│   Nothing is waiting for you, and nothing can arrive yet.                     │
│   The three conditions above have to be true first — one of them is.          │
│                                                                              │
│   ┌────────────────────────────────────────────────────────── EXAMPLE ─────┐ │
│   │  This is what a request will look like. It is not real and cannot be   │ │
│   │  decided.                                                              │ │
│   │                                                                        │ │
│   │  Bid tuner wants to change a keyword's bid                             │ │
│   │  On "casco integrale" (EXACT) in AIREON-IT-Generic · IT                │ │
│   │  €0.31 → €0.84  (+171%)          can be put back · 24h to answer       │ │
│   │  [ Apply — bid €0.31 → €0.84 ]  [ Why not? ]        (both inert)       │ │
│   └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

**The empty sentence is one sentence, not two**, and its second clause is
**passed down from S2's own `conditions`** rather than recomposed — the same
single-source rule S2.a established.

**The example card is the real `ApprovalCard`**, rendered from a constant
fixture with every control disabled and an `EXAMPLE` marker on the frame. Not a
screenshot, not a mock-up: the actual component, so it cannot drift from what a
real card looks like. Fixed data, no fetch, nothing seeded — the fixture that
AQ.3's prod verification used is already committed in `_apx-seed-card.mts` and
its shape is known-good.

### The states

| State | Renders |
|---|---|
| **Waiting, nothing can arrive** *(today, and for months)* | the sentence + the example card |
| **Waiting, fleet on, nothing found** | the sentence, second clause becomes *"the fleet ran and found nothing"*; example card **hidden** — it has done its job once real runs exist |
| **Waiting, rows present** | the list; no empty state, no example |
| **Decided / Ran out of time, empty** | one line each, unchanged |
| **Loading** | skeleton rows at the list's real height |
| **Read failed** | the existing error banner, unchanged (S5's `.aq-err`) |

### Type and colour

Continuing the ladder S1 and S2 set: **13px throughout, 11.5px only inside
chips**; the heading gains weight rather than size (13/600, not 16/400); every
value measured in place. `.aq-asof` and `.acr-fl-empty` at 3.65:1 both move to
`#55616f` (5.83:1 on white — the value S1 settled).

---

## 14.5 — Verdict on the approved AQ-S4 spec, bullet by bullet

| Spec bullet | Verdict |
|---|---|
| Grouped by worker under the real name | **Already built** (AQ.3), unchanged |
| Ordered by consequence, not `createdAt` | **Already built** (2026-08-08), unchanged |
| Row carries money + target so most decisions need no opening | **Already built** (AQ.3) |
| **Three distinct empty states** | **FIX** — there is one, and its first sentence is false |
| **A worked sample card, visibly inert** | **BUILD, and promote it to the centre** (§14.2 B) |
| A one-time band above the first genuine approval | **DEFER, and say why.** It can never fire while the queue is unreachable, and a surface that cannot render is one nobody can verify. Ship it deleted, not empty — the rule the Assignments stream established and this document has followed for AQ.5/.7/.9/.10 |
| Deep-link anchor per item, `?assignment=` | **Already built** (2026-08-08) |

**Most of AQ-S4 is already shipped.** What is left is the empty state — which is
the part that is on screen every day.

---

## 14.6 — What I am explicitly NOT doing

- **S1, S2, S3, S5–S10.** No new endpoint, no API change, no migration.
- **No glossary edits**, no claim on any shared file.
- **Not the first-approval band** (§14.5), and not AQ.5's filters — the study's
  reasoning that filters over an empty table teach a concept and give nothing
  still holds.
- **Not re-deriving S2's conditions.** The empty sentence's second clause comes
  from the `conditions` S2 already fetches; S4 composes nothing about the gate.

---

## 14.7 — Build order

| Phase | What |
|---|---|
| **S4.a** | The empty state: the false sentence removed, the two lines merged into one, the second clause sourced from S2's conditions, and the two 3.65:1 colours fixed |
| **S4.b** | The example card — the real `ApprovalCard` from a fixture, inert, marked, and hidden once the fleet has run |
| **S4.c** | The type ladder (7 pairs → 2) and the heading's weight; measured close-out at nine widths, 200% zoom, keyboard |

---

## 14.8 — Sources

[NN/g · Empty-state interface design][nng] · [Shopify · Empty state pattern][shopifyempty] ·
onboarding/sample-data convergence (see §14.2 B) · and, unchanged from Parts 12
and 13: Pajamas' contextual-help hierarchy, the status-colour conventions, and
the `dataviz` skill's rule that status colours ship with an icon and a label.

[nng]: https://www.nngroup.com/articles/empty-state-interface-design/
[shopifyempty]: https://shopify.dev/docs/api/app-home/patterns/compositions/empty-state
