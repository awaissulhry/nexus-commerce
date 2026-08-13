> ## ⚠ Superseded numbers — read this first
>
> **This document is committed unedited, as it was written on 2026-08-11.** It is the basis eight
> section briefs and eight execution records cite, so its body is left exactly as it was rather than
> quietly corrected. Five of its figures were superseded by measurement during NEG.0–NEG.9, and each
> was superseded because the number was **right in a different unit**, not because it was wrong.
>
> | this study says | superseded by | the correct reading |
> |---|---|---|
> | "132 negatives contain a protected term" | NEG.5 | **132 (negation × protected term) PAIRS across 128 distinct negations.** `_neg-study.mts:71-83` has no `break`, so four `xavia gale` rows are counted twice |
> | §6 "1 blocking conflict" | NEG.4 | **0** under the full blocking predicate; the overlapping negation is ARCHIVED. And the count is window-dependent: 0 at 30d, 2 at 60d, 6 at 120d |
> | §7.3 "`_EXACT` is a 62-row fringe" | NEG.1 | `expressionType` is **rewritten continuously** by two crons (~65 rows/min). It has no stable value; normalise at read time and never filter on the raw column |
> | §8 the n-gram `terms` column | NEG.6 | **overstates a 2-gram's reach by up to 4.7×** — the tokenizer strips stop words before pairing, so `moto protezioni` claims 61 terms where 13 queries contain the phrase |
> | §4.0 "archive is the only removal" | NEG.3b | Amazon **accepts `PAUSED`** on a negative — proven in practice. Its **semantics remain unresolved**: no documentation says whether a paused negative still excludes |
>
> A sixth, added by NEG.9: §2.2's account of the write paths the whitelist covers is correct about
> *our* paths and silent about the other door — **1,227 of 2,059 negatives (59.6%) arrive by the v1
> sync and pass no gate at all.** That gap is what NEG.9's third detector exists to surface.
>
> Full close-out: [`2026-08-13-neg-page-closing-note.md`](2026-08-13-neg-page-closing-note.md) ·
> open items: [`2026-08-13-neg-open-items.md`](2026-08-13-neg-open-items.md).

# NEG — Negative Targeting: study 7 of 11

*Rules & Automation, tab-by-tab, right to left.
[1 · Keyword Tracker](2026-08-11-kt-keyword-tracker-study.md) · [2 · Share of Voice](2026-08-11-sov-share-of-voice-study.md) · [3 · Placement](2026-08-11-plc-placement-study.md) · [4 · Budget Schedules](2026-08-11-bs-budget-schedules-study.md) · [5 · Rank & Dayparting](2026-08-11-rd-rank-dayparting-study.md) · [6 · Budget](2026-08-11-bud-budget-study.md).*
**Read-only study. Nothing was changed. No code was written.**

Measured on production 2026-08-11 with `apps/api/scripts/_neg-study.mts` and `_neg-study2.mts`.

---

## 0 · The one-sentence version

**132 of 2,059 negatives contain a term on the 10-word protected whitelist** — including the brand
name `xavia`, negated in **16 ad groups** across the very Brand-Phrase and Brand-Broad campaigns
built to capture it — because the whitelist is a **going-forward gate that cannot see the base it
was added to**; and there is still **no retirement path**, which is the one thing standing between
this tab and the AUTO you asked for.

---

## 1 · What the tab is, and every wire behind it

```
?tab=negative-targeting
└── RulesAutomationClient.tsx:402
    ├── <ProtectedTermsPanel />                    ← the whitelist, above the rules that negate
    └── <RuleListTab liveType="negative-targeting" />
        └── RULE_TAB_ACTION_TYPES['negative-targeting'] =
              ['harvest_and_negate','add_negative_exact','add_negative_phrase','sync_negatives_across_campaigns']

Handlers  automation-action-handlers.ts
          :840  harvest_and_negate            → ads-harvest.service (previewHarvest/applyHarvest)
          :1011 add_negative_exact
          :1049 sync_negatives_across_campaigns
Storage   AdTarget { isNegative: true, kind, expressionType, expressionValue }
Guard     AdKeywordProtection (WHITELIST) enforced in ads-write-gate.ts:307
Sibling   /marketing/advertising/ngrams — n-gram analysis, a different page
```

**`ProtectedTermsPanel` sitting above the rule list is the single best design decision on this
tab**, and its own comment says why: *"those rules decide what gets negated, this decides what never
can be."* Enforcement is in `ads-write-gate.ts` — the one chokepoint every write passes — *"not in
the harvest service, because harvest is not the only caller that can negate a term, and a protection
only some callers honour is not a protection."* That reasoning is correct.

---

## 2 · The seven rules — all proposing, none writing

| rule | on | level | trigger | executions | cap/day |
|---|---|---|---|---|---|
| Wasted keyword instant negate | ✓ | PROPOSE | KEYWORD_WASTED_SPEND | **17,753** | 200 |
| Account-wide negative sync | ✓ | PROPOSE | KEYWORD_WASTED_SPEND | 9,083 | 20 |
| Auto match-type migration (broad → exact) | ✓ | PROPOSE | SEARCH_TERM_CONVERTING | 5,917 | 100 |
| Auto harvest & negate | ✓ | PROPOSE | SCHEDULE | 4,908 | 3 |
| Daily automation digest | ✓ | PROPOSE | SCHEDULE | 4,833 | 1 |
| Harvest & negate search terms | ✗ | PROPOSE | SCHEDULE | 128 | 3 |
| Exact match discovery engine | ✗ | PROPOSE | SCHEDULE | 85 | 2 |

**Every one is capped at PROPOSE** — deliberately. `ads-graduation.ts` refuses to let a negation
rule graduate to AUTO, with the reason recorded: *a negative is the hardest thing in an account to
notice later.* You have since asked for negation to write automatically (2026-08-10); **this study
is the evidence for whether that is safe yet.**

### So who created the 2,059 negatives?

| writer | negative writes, 60d |
|---|---|
| `user:anonymous` | **614** |
| *(no userId)* | 204 |
| `automation:auto-harvest` | 22 |
| `htest` | 16 |
| **from a rule execution** | **0** |

**856 writes, none of them from the tab's rules.** Negation in this account is a manual and
engine-side activity; the tab is a proposal surface that nothing acts on.

---

## 3 · The 2,059 negatives

| | |
|---|---|
| KEYWORD | 2,056 · PRODUCT 3 |
| by market | IT 1,542 · DE 282 · FR 170 · ES 65 |
| created on | 21 distinct days — **1,155 on 2026-05-20 alone**, 408 on 07-31, 204 on 07-28 |

🔴 **Six vocabularies for two match types:**

```
_EXACT  1,416   ·   _PHRASE  591   ·   NEGATIVE_EXACT  22
PHRASE     18   ·   EXACT      9   ·   PRODUCT_EXACT    3
```

`expressionType` holds the **match type**; negativity lives in `isNegative`. Six spellings of two
concepts means any code branching on `expressionType` to decide match type has to know all six, and
any code branching on it to decide *negativity* — `NEGATIVE_EXACT` invites exactly that — is wrong
for 2,037 of 2,059 rows.

---

## 4 · 🔴 The whitelist did not hold — but read this carefully

**132 negatives contain one of the 10 protected terms.** A sample:

| negated phrase | protected term | campaign |
|---|---|---|
| `xavia` | xavia | IT-AIREON-SP-**Brand-Phrase** |
| `xavia` | xavia | IT-AIRMESH-SP-**Brand-Broad** |
| `gale` | gale | GALE \| IT \| **Broad \| Brand** |
| `aireon` | aireon | IT-AIREON-SP-**Brand-Broad** |
| `xavia gale` | xavia, gale | GALE \| IT \| **Phrase \| Brand** |
| `giacca MOSS` | moss | IT-MOSS-SP-**Brand-Phrase** |
| `AIRMESH pant` | airmesh | IT-AIRMESH-SP-**Brand-Broad** |
| `xavia` | xavia | IT-AIREON-SP-Auto |
| `giacca xavia` | xavia | GALE \| IT \| Auto |

**Not all of these are mistakes.** Negating a brand term inside an **Auto** or **Category** campaign
is standard funnel architecture — you push brand traffic out of the catch-all so it lands in the
dedicated Brand-Exact campaign at a lower CPC. Six of the rows above are that pattern and are
probably deliberate.

**The ones that are hard to defend are the brand term negated inside a campaign whose own name says
it exists to capture that brand term** — `xavia` in `IT-AIREON-SP-Brand-Phrase`, `gale` in
`GALE | IT | Broad | Brand`, `aireon` in `IT-AIREON-SP-Brand-Broad`. If the brand term is negated in
Auto *and* Brand-Broad *and* Brand-Phrase, there is no funnel left — the traffic has nowhere to go.

### Why the guard did not catch them

`ads-write-gate.ts:307` checks the whitelist **on the way out**. It cannot remove what was already
there. The 10 protected terms were added *after* the 1,155-negative bulk import of 2026-05-20.

**The protection is a going-forward gate over a base it has never audited, and nothing on any screen
compares the two.** The panel says "nothing can negate these" — true of tomorrow, false of today.

---

## 5 · Did a negative kill revenue? — the careful answer

**26 negated phrases have order history in the last 120 days**, totalling €8,376.95 in sales against
€2,477.53 of spend (30% blended ACoS).

That figure on its own would be alarming and **it would be wrong to report it as loss**. A negative
is scoped to **one ad group**. The same phrase can be negated in twelve ad groups and still run in
sixty others. So I measured whether each one is still getting traffic:

| | phrases |
|---|---|
| **still running elsewhere** — funnelled, not blocked | **21** |
| no traffic at all in the last 30 days | **5** |

The 21 are the architecture working: `giacca moto uomo` is negated in **66 ad groups** and still
took **66,914 impressions** in 30 days. That is deliberate routing, not damage.

### The five that went dark, and what actually explains them

| phrase | historic | ACoS | negated in | verdict |
|---|---|---|---|---|
| `giacca pelle moto` | €122.91 / 1 order | **5%** | MISANO BROAD, MISANO PHRASE | campaigns are **paused** — the negative is not the cause |
| `giacca in pelle moto uomo` | €122.94 / 1 order | **2%** | MISANO BROAD, MISANO PHRASE | same — **paused** |
| **`xavia`** | €122.91 / 1 order | **1%** | **16 ad groups** incl. Brand-Phrase, Brand-Broad, Auto | 🔴 **brand term, protected, negated everywhere** |
| `chaqueta moto verano hombre` | €105.00 / 1 order | 13% | AIRMESH JACKET ES *(paused)*, **ES_Phrase_3_Keywords** *(live, 88% budget-utilised)* | 🔴 plausibly blocked in a live campaign |
| `chaqueta moto hombre verano` | €105.00 / 1 order | 15% | **ES_Phrase_3_Keywords** *(live)* | 🔴 plausibly blocked in a live campaign |

**So: not 26 losses, and not zero. Two or three genuine candidates, on single-order evidence.**
The volumes are small — one order each — so this is a governance finding, not a revenue emergency.

**The real finding is that nobody could have known.** There is no screen anywhere that answers
*"this term is negated here and earning there"*. I had to write a script joining `AdTarget` to
`AmazonAdsSearchTerm` to see it, and the conclusion flipped twice while I did.

### And there is still no way back

| | |
|---|---|
| negative writes rolled back in 60 days | **0** |
| a UI to list, review or remove a negative | **none** |

`ProtectedTermsPanel` can add a *future* protection. Nothing lists the 2,059 negatives that exist,
nothing shows which ad group each sits in, and nothing removes one. **This is precisely the
"negative-retirement path" the graduation code names as its blocker for AUTO — and it is still
missing.**

---

## 6 · How the industry does this

### 6.1 The platforms

| platform | approach |
|---|---|
| **Pacvue** | works in **real time** — *"the moment a term crosses your spend threshold, it gets negated automatically"*; campaign-level rules over the search-query report |
| **Ad Badger** | **n-gram analysis across the whole account at once** — *"if 'cheap' is quietly wasting spend across twelve campaigns, you see that pattern in one place instead of finding it twelve times"* |
| **Scale Insights** | highly customisable rule-based negation, ASIN-level, for operators who want full control |
| **Perpetua** | AI-assisted; negation folded into the optimisation loop rather than exposed as rules |
| **Karooya** | specialises in negative-keyword management as its own discipline |

### 6.2 The four things they have that we do not

1. **An n-gram view that is account-wide.** A single wasteful *word* across many campaigns is one
   decision, not twelve. We have `/marketing/advertising/ngrams` — **on a different page, in a
   different section, unconnected to this tab.**
2. **A negatives inventory.** Every serious tool lists what is negated, where, when, by whom — and
   lets you remove it. We have 2,059 negatives and **no list**.
3. **Conflict detection.** "This term is negated in ad group A and converting in ad group B" is a
   standard alert. Ours would have surfaced `xavia` immediately.
4. **Negation as reversible.** Pacvue and Scale Insights treat a negative as an object with a
   lifecycle. Ours is an append-only fact.

### 6.3 What we have that they do not

**The protected-terms whitelist enforced at the write gate.** No competitor in the research ships an
account-wide "these words can never be negated by any automation, enforced at the single chokepoint"
guard. Pacvue negates on a threshold; nothing sits above it saying *never this word*.

**It is the right idea, implemented in the right place, and it has never been reconciled against the
data it governs.** Fixing that is a query, not a feature.

### 6.4 The UI shape

- **Negatives as a first-class grid**: term · match type · scope (campaign › ad group) · added when,
  by whom · spend saved since · **remove**.
- **An n-gram panel beside it**, account-wide, one row per wasteful word.
- **Conflict badges** — negated here, converting there.
- **The whitelist audited against the base**, not only against new writes.
- **A proposal queue** where each negation shows the term's full history before you approve it.

---

## 7 · What could be implemented, cheapest first

### Tier 0 — see what you have already negated *(hours)*
- **Audit the whitelist against the base.** One query — the one in `_neg-study.mts` — surfaces the
  132. Put it on the panel that claims those terms are protected.
- **A negatives list.** 2,059 rows exist and no screen shows one.
- **Flag the conflicts**: negated somewhere, converting elsewhere. 26 today, 5 of them dark.
- **Normalise `expressionType`** — six spellings of two match types.

### Tier 1 — the retirement path *(days, and it is the gate for AUTO)*
- **Remove a negative from the UI**, with the same confirm-and-audit shape as every other write.
- **Bulk-remove by term**, since one phrase spans up to 72 ad groups.
- **Record why each negative was added** — rule id, threshold, the numbers at the time — so a review
  a month later is possible at all.

### Tier 2 — then, and only then, arm it
With a list, a conflict check and an undo, negation on AUTO becomes defensible. The order matters:
today an AUTO negation rule would append to an unreviewed base of 2,059 with no way back.

### Tier 3 — bring the n-grams home
`/marketing/advertising/ngrams` already exists. Account-wide wasteful *words* are the industry's
primary negation surface and ours is orphaned on another page.

---

## 8 · How this tab is *supposed* to be

> **Two questions: what am I blocking, and what is it costing me?**

- **The inventory first** — 2,059 negatives, searchable, scoped, removable.
- **Protected terms audited both ways** — what they will block tomorrow *and* what already
  contradicts them today.
- **Conflicts surfaced**, not discoverable only by writing a join.
- **Every negative carries its reason and its numbers at the time.**
- **Proposals show the term's full history** before you approve — orders, sales, ACoS, which ad
  groups it already runs in.
- **Undo everywhere**, because a negative you cannot remove is a permanent decision made on
  seven days of data.

---

## 9 · What I need from you

1. 🔴 **`xavia` is negated in 16 ad groups, including Brand-Phrase and Brand-Broad.** Deliberate
   funnel design, or an accident from the 2026-05-20 bulk import? This decides whether the other 131
   need reviewing individually.
2. **The two Spanish terms negated in a live campaign** (`ES_Phrase_3_Keywords`) — intended?
3. **The retirement path — build it?** It is the stated blocker on the AUTO negation you asked for,
   and I would not arm negation without it.
4. **Should the n-gram page fold into this tab?** It is the industry's primary negation surface and
   ours is in another section.
5. **1,155 negatives were added on one day (2026-05-20).** Do you know what that import was? It is
   the origin of most of the whitelist contradictions.

---

## Appendix — scripts

| script | measures |
|---|---|
| `_neg-study.mts` | the 7 rules · 2,059 negatives by kind/type/market/date · who wrote them · whitelist violations · negated phrases with order history · rollbacks |
| `_neg-study2.mts` | for every negated converter: still running elsewhere, or genuinely dark — and exactly which ad groups negate it |

Read-only. `NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/<name>` from `apps/api`.

### Sources

- [Karooya vs Perpetua vs Pacvue: three approaches to Amazon PPC optimisation](https://www.karooya.com/blog/karooya-vs-perpetua-vs-pacvue-amazon-ppc-optimization/)
- [Amazon Ads negative keywords: PPC guide for 2026 — Sequence Commerce](https://sequencecommerce.com/amazon-negative-keywords/) ·
  [Best Amazon PPC automation tools — Sequence Commerce](https://sequencecommerce.com/best-amazon-ppc-automation-tools/)
- [Best Amazon PPC automation tools 2026 — SalesDuo](https://salesduo.com/blog/amazon-ppc-automation-tools/) ·
  [Best Amazon PPC tools: 15 platforms compared — SalesDuo](https://salesduo.com/blog/best-amazon-ppc-tools-comparison/)
- [Top 10 Amazon PPC tools — Jarvio](https://jarvio.io/blog/top-10-amazon-ppc-tools)
