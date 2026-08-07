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
