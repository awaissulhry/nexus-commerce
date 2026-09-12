# AUTO — Automations: the page, its sections, and what each one owns

*Structure proposal, 2026-08-12. Written for approval before any code.
Evidence: [`2026-08-11-auto-automations-page.md`](2026-08-11-auto-automations-page.md) (the study).
Arbitration: [`2026-08-11-substrate-spec.md`](2026-08-11-substrate-spec.md) §4, §5, §7.
Every number below was measured on production 2026-08-11; none is re-derived here.*

---

## 0 · The one job

> **What can change my account, under what limits, and what did it change today?**

The page today answers a third of that. It lists **51 rules** and gives each an honest mode dial. It
cannot say:

- **who else acts** — `ad-rank-defend` made **29,749 of 44,435 writes (67%)** and has no row;
- **under what limits** — `maxExecutionsPerDay` **has not tripped for any rule since 2026-08-04**;
- **what changed** — 44,435 writes exist, are attributed, and are rendered nowhere.

### The structural flaw, in one line

**The page is a list of rules. Rules are 2.95% of what happens.** Everything else — the model, the
ceiling, the scope form, the readiness board — is well built and applies to the wrong population.
The rebuild does not replace the model. It **applies the existing model to every actor.**

---

## 1 · Boundaries

### 1.1 What this page owns — ratified by the substrate arbitration (§4)

| subject | this page owns | evidence |
|---|---|---|
| **the actor row for every engine** | name · posture · scope · ceiling · health · last tick · writes | SUB §4.1 — *"Yes. Engines get rows on Automations"* |
| **the conflict detector** | replaced, not tuned; **by entity, not by trigger** | SUB §4 row 15, §9.6 |
| **the change ledger** | the **account-wide** view | SUB §4 row 8 |
| **the proposal queue** | the section's **one** inbox | SUB §4 row 5 |
| **account posture** | halt · kill · autonomy dial — the control `automation_halted` links to | SUB §5.5 |
| **the values of the per-scope spend ceilings** | set on this page's scope form | SUB §4 row 1 |
| the autonomy dial · the graduation ceiling · readiness · scope **binding** | unchanged, already here | — |

### 1.2 What this page must NOT do

| | why |
|---|---|
| **own the write gate** (82 of 220) | **11 · Apply Rules** owns it. SUB §4 row 4 |
| **own the rank plan** | **5 · Rank & Dayparting** owns *which target governs which hour*. This page owns the **actor**; RD owns the **plan**. Two objects, two owners — SUB §9.1 |
| **enforce** a spend ceiling | enforcement is one check in `ads-write-gate.ts` (substrate). This page sets the numbers |
| **render the queue's items on other pages** | 7 and 8 show their own pending items inline on the row they concern; nobody else renders the queue |
| **author a rule** | the builder route owns authoring |
| **fork a lens** | Placement, Bid and Budget render outcomes and link here. Neither duplicates |

I read *"features should not be mixed with any other page"* as: **one feature, one owner, no
duplication and no reaching in.** Correct me if you meant the opposite.

### 1.3 🔴 Three facts that changed since the study

1. **Automations becomes the section's landing page** — SUB §10 Q5 redirects `/rules-automation` →
   `/automations`. That changes the default view (D1).
2. **Phase S has not landed, and pages are shipping anyway.** Verified today: no `useAdsScope`, no
   `useAdsPulse`, no `/advertising/pulse`, `/action-log` or `/freshness`, no stub routes — while KT,
   NEG, HV and BID have all shipped page code. **The substrate spec puts Automations last (Phase F);
   if it waits for a Phase S that is not being built, it waits indefinitely.** D4.
3. **`ads-auto-harvest` has been armed down** (`42af69317`, HV.0) — the ceiling hole I found in
   study §3 is closed by a neighbouring session. One less argument to make; the finding stands.

---

## 2 · The control model — two scopes, and they are not the same thing

Your ask — *"everything market-specific, portfolio-level, campaign-level"* — is **two** features
that share one vocabulary. Conflating them is the mistake to avoid.

```
                market  ⊃  portfolio  ⊃  product line  ⊃  campaign
```

| | **VIEW scope** | **BINDING scope** |
|---|---|---|
| question | *what am I looking at* | *what may this actor touch* |
| lives in | the URL | four columns on the rule |
| effect | filters every section on the page | enforced by `ruleMatchesScope` on every tick |
| today | market only, via the header | **8 of 51 rules — and all 8 are switched off** |

**Three laws, and the first is the one that gets broken.**

**L1 · The view filters by REACH INTERSECTION, never by equality.** An unscoped rule acts in IT, so
narrowing the view to IT must **keep** it. An equality test hides 43 of 51 rules and reads as a data
bug. *(Already correct at `AutomationsClient.tsx:161`; it must survive the rebuild.)*

**L2 · The view scope pre-fills the binding scope.** You are looking at IT + the GALE line; you press
**Bind**; the form opens on IT + GALE with the reach stated. That is how the account gets from
**0 scoped live rules** to most-of-51 — one click each, not a form each.

**L3 · A scope is always two numbers.** *"IT · GALE line → 27 of 220 campaigns · 22 writable."*
A rule can match campaigns it may not write to; no cell may let those be confused. (SUB §5.3.)

### ⚠ The scope spine is a CONTRACT, not a new component

The substrate's "What NOT to build" #1: **a new scope-and-date bar was built, shipped and reverted.**
Market lives in the header; portfolio and campaign already exist as **grid filters**. This page adds
the *product line* grain to the existing filter set and puts all four in the URL. **Nobody builds a
bar.** The law from that revert governs: *name the pixel that changes when you move the control, or
it does not go there.*

---

## 3 · The section map

One route, a persistent header, and **five views under a segmented control** — because the four
bodies are all large tables and stacking them is a scroll nobody finishes.

```
┌─ AdsPageHeader (market) · RulesTabs ────────────────────────────────┐
│  A1  Exposure band — scoped; every tile is a filter                 │
│  ──  Actors │ Conflicts │ Ledger │ Queue │ Limits   ← ?view=        │
│  A2/A4/A5/A6/A7  the body                                           │
└─────────────────────────────────────────────────────────────────────┘
              A3  Actor inspector — a drawer, from A2/A4/A5
```

| § | section | grain | what it owns | gate |
|---|---|---|---|---|
| **A0** | **Foundation** | — | route shell · the four-grain scope contract + URL · view switcher · **the unified Actor model server-side** · section slots | — |
| **A1** | **Exposure band** | scope | the one-glance answer, scoped; every tile filters A2 | A0 |
| **A2** | **Actors** | actor | rules **∪ engines**, one dial, one ceiling, one scope, one cap, one health | A0 |
| **A3** | **Actor inspector** | actor | When/If/Then · ceiling · readiness · scope form · caps · record · its own history · **Simulate** | A2 |
| **A4** | **Conflicts by entity** | campaign × field | *"what else can touch this"* — the detector, rewritten | A2 |
| **A5** | **Change ledger** | write | 44,435 writes, attributed, with evidence, undo, and **honest about its own completeness** | A0 + S4 |
| **A6** | **Approval queue** | proposal | the section's one inbox, grouped, priced, expiring | A0 |
| **A7** | **Limits** | scope | account posture · **per-scope spend ceilings** · notifications | A1 |

**Proposed build order: A0 → A2 → A3 → A1 → A4 → A7 → A5 → A6.**
The grid is the page; the band summarises the grid, so the grid comes first. A5 and A6 sit last
because both depend on substrate work that does not exist yet (§4).

---

### A1 · Exposure band

Six tiles, each a filter onto A2, **all scoped to the current view**. Measured account-wide today:

| tile | today | meaning |
|---|---|---|
| **Writing to Amazon** | 8 rules + 7 engines | on AUTO **and** able to reach Amazon — not merely on AUTO |
| **Unscoped and writing** | **5–7** | the account's actual exposure; nothing shows it today |
| **Contested campaigns** | **220 of 220** | ≥2 actors on one field |
| **Awaiting you** | **225** | the queue, in one number |
| **Refused today** | **unsourceable** | ⚠ see §4 — no durable record since 2026-08-04 |
| **Off** | 29 | includes all 8 scoped rules |

*(Tiles overlap by design. The band reports states, not a partition.)*

### A2 · Actors — the section that makes the argument

**One `AdsDataGrid`, one segmented control: `All (63)` ⇄ `Rules (51)` ⇄ `Engines (12)`.**

Columns: Actor (+kind) · **Mode** · When · **Scope** (two numbers) · **Ceiling** (three facts) ·
This week (acted / proposed / **refused** / failed) · Last run.

Four contracts land here verbatim from SUB §5:

- **Mode** — `autonomyLevel` through `resolveAutonomy`, never a column; `dryRun` never rendered. An
  engine has no `autonomyLevel`, so it renders its own posture in the same four-notch shape **with
  the notches it actually has**, and says which it is.
- **Ceiling** — *"Daily cap 10 — 10 used, 1,947 refused today. Further matches are refused, not
  queued."* Never a bare "10/day". 🔴 **Unrenderable until the cap counter is repaired** (§4).
- **Scope** — two numbers, always.
- **Refused ≠ failed** — four outcomes, four words, on every figure.

### A3 · Actor inspector

The drawer that exists (`RuleDetail`), extended: conflicts from A4, the actor's own slice of the
ledger, and **Simulate** — which is allowed **only here** (SUB §8.12), and **only after
`POST /automation-rules/:id/simulate` is fixed**: it currently `void`s
`runAdvertisingRuleEvaluatorOnce()`, i.e. **all 21 triggers with no forced dry run**.
`simulateOneRule` is the fixed path. Until then the button does not exist.

### A4 · Conflicts by entity

The prototype is written and run (`_auto-page-conflicts.mts`). Reach × field × four classes
(**SAME-FIELD · OPPOSED · DUPLICATE · CADENCE**), reported per campaign:

> *"15 actors can change this campaign's bids: 5 on Auto, 7 proposing, rank-defend, you, and a script."*

Server-side, at `GET /advertising/autonomy/conflicts` — reach resolution needs `Campaign`,
`AdGroup`, `AdTarget` and the action log, none of which the browser has. Every other page renders
this; **none computes it.**

### A5 · Change ledger

The account-wide view over the substrate's `GET /advertising/action-log` (S4).

🔴 **This section's defining feature is that it states its own completeness**, because three
independent measurements say it cannot claim otherwise:

- **9,589 of 44,435 writes carry a `null` actor** — a fifth of the account has no author.
- **41% of the audit chain is broken** — 937 of 2,304 consecutive budget writes have
  `payloadBefore` ≠ the previous `payloadAfter`, because the pacer and the budget rules overwrite
  each other holding stale reads.
- **The log is not complete** — 4 MOSS campaigns' last logged write says €1 while
  `Campaign.dailyBudget` reads €10. Something moves budgets writing no audit row.

⚠ **`payloadBefore/After.dailyBudget` is in EUROS, not cents** — nearly every other money field in
the ads schema is cents or micros. Assuming cents inflates every ratio 100×.

⚠ **Evidence coverage is uneven and must be rendered as such:** `update_placement_bidding` 100% ·
`AD_BID_UPDATE` 4% · **`AD_BUDGET_UPDATE` 0%**. A blank where a reason should be is a claim; the
cell says *"no reason recorded"*.

### A6 · Approval queue

**225 pending = 8 distinct decisions** (`proposedKey × entityType`). The unique key
`(ruleId, entityId, proposedKey)` means a repeat cannot create a second row, so this is a
**standing wave at ~20/day, not a backlog to drain** — any design assuming a pile is designing for
the wrong object. Grouped by (kind × field), priced, expiring at 7 days, with **apply-as-proposed**
and **apply-with-edit** as visibly different acts, because the graduation model treats them
completely differently and nothing tells the operator that.

### A7 · Limits — your standing ask, made concrete

**Per-scope spend ceilings — market · product line · portfolio · campaign, never one global number.
At the cap: refuse the write and say so.** Substrate: *"Nobody yet — it does not exist at any
layer."* Four pages claim it. **The values are set here.** Proposed shape:

```
AdsSpendCeiling {
  grain    MARKET | PORTFOLIO | PRODUCT_LINE | CAMPAIGN
  key      the id at that grain
  period   DAY | MONTH
  limitCents
  enabled
}
```

- **Ceilings stack.** A write passes only if it clears **every** ceiling whose scope contains it
  (campaign ⊂ line ⊂ portfolio ⊂ market). The **tightest binding one** refuses, and the refusal
  **names it**.
- **Enforced at `ads-write-gate.ts`** — the single chokepoint, for the same reason the
  protected-terms whitelist is there: *"a protection only some callers honour is not a protection."*
- **Refuse, never halt.** ⚠ `AdsAutomationState.maxHourlySpendCentsEur` **is** the global ceiling,
  it is **NULL**, and it **halts the whole account** rather than refusing one write. Setting it is
  not a substitute.

Also here: **account posture** (kill · halt · autonomy dial — the control every `automation_halted`
refusal links to) and **notifications**: daily digest · failures and refusals on the page ·
immediate for anything large.

---

## 4 · Data contracts the sections need

| need | today | required | owner |
|---|---|---|---|
| **one actor list** (rules ∪ engines) | two endpoints, two vocabularies | `GET /advertising/actors` — level/posture · ceiling · scope + reach · caps · health · writes in window | **A0** |
| conflicts by entity | client-side, rule-only, flags 0 | `GET /advertising/autonomy/conflicts` | **A4** |
| the ledger | none | `GET /advertising/action-log` (S4) | **substrate** |
| refusals, durably | 🔴 **nowhere since 2026-08-04** | persist a refusal; repair the cap counter | **substrate S5** |
| per-scope ceilings | 🔴 no schema, no route, no gate check | model + gate check | **substrate**, values here |
| the `automation:*` → human name resolver | three pages want one | `<ActorCell>` (S5); the id is an **`AdSchedule.id`**, not a group id | **substrate** |
| URL state | market only | `?view= &market= &portfolio= &line= &campaign= &kind= &level= &field= &actor= &q=` | **A0** |
| real-time | none | **poll a cursor ~30s.** ⚠ the ads SSE bus carries **0.21%** of writes and is blind to every engine — do not wire pages to it | **substrate S2** |

---

## 5 · Decisions I need from you

| # | decision | my recommendation |
|---|---|---|
| **D1** | **Default view**, now that this page is the section's landing page | **Actors**, not Ledger. *(I recommended Ledger in the study — before the landing decision. A person arriving at the section wants the control plane; the band answers "what changed today" in one line and links to A5.)* |
| **D2** | Five views under a segmented control, or one long scrolling page | **Segmented.** Four large tables; the DS `SegmentedControl` exists; one URL param |
| **D3** | CSS home | **Append at EOF of `rules-automation.css` under `h10-au-*`**, claimed in the locks doc. RD took a page-scoped file because the builder boundary names the shared stylesheet; **mine does not**, and the `h10-au-*` namespace already lives there — splitting one namespace across two files is the documented source-order failure |
| **D4** | 🔴 **Phase S has not landed and pages are shipping without it.** Does A0 wait, or build? | **Build the two pieces Automations owns anyway** — the actor model and (later) the ledger route — and **consume the existing market header + grid filters** for scope rather than inventing `useAdsScope()`. That way A0 neither blocks nor forks. If the substrate session lands S1/S2 later, A0's scope hook is a thin adapter |
| **D5** | Build order | **A0 → A2 → A3 → A1 → A4 → A7 → A5 → A6** |
| **D6** | 🔴 **The three live P0s** — the cap counter, the ratchet's missing cooldown, refusal persistence — in this programme or separate? | **Separate and first.** All three are engine files, not page files, and all three change what every page can truthfully render. They also need a claim on shared files. Say the word and I write that prompt before A0 |

---

## 6 · What this structure deliberately does NOT do

- **It does not rebuild the autonomy model.** The dial, the reversibility ceiling and the readiness
  board are the best-designed things in the section and the field independently arrived at the same
  axis five months later. They get *applied more widely*, not replaced.
- **It does not build a scope-and-date bar.** Built, shipped, reverted. Header + grid filters + URL.
- **It does not build a twelfth "Overview" page.** A1 is the overview.
- **It does not touch the write gate, the rank plan, or the builder.**
- **It does not wire SSE.** 0.21% coverage, blind to every engine.
- **It does not render `dryRun` anywhere.** Dead field for all 51 rules.
- **It does not arm anything.** Every section ships as a truthful view first. Widening the write
  gate, raising a ceiling and turning on a spend limit are separate, explicit decisions.
