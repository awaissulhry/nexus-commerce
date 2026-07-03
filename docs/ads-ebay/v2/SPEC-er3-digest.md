# ER3.5 — Weekly Digest (`/ebay/digest`)

Mini-spec per Part VIII (double gate). Source: CURRENT-STATE-CRITIQUE §2.7 (severity
**Low** — the one-page week-review concept is kept; four findings). The smallest ER3
page; deltas sized accordingly.

**Ground truth** (verified 2026-07-03):

- `EbayDigestClient.tsx` (144 lines — no monolith problem): KPI band + movers bars +
  autopilot + awaiting-decision + anomalies + missing-cost + Generate now + Mark reviewed.
- `GET /ebay-ads/digests` (last 12 weeks: id/weekStart/generatedAt/reviewedAt) **already
  exists and nothing consumes it** — the week picker is nearly free. Only `/digest/latest`
  returns a payload; fetching a chosen week needs one additive endpoint.
- The digest payload already carries `pendingProposals[].id` — the deep-link target
  exists; the hub just has no way to receive it (tab state is local, no URL params).
- `generateWeeklyDigest()` aggregates ALL marketplaces; the page header hardcodes an
  `EBAY_IT` chip — an honesty bug, not a data bug.
- Payload carries `prior` (fees/sales/sold) — week-over-week deltas are render-only.

## The 6 deltas

**1 · Week picker + history.** Chips for the last 12 weeks (from the unconsumed
`/digests` list), newest first, ✓ mark on reviewed weeks; selecting fetches that week via
**additive** `GET /ebay-ads/digests/:id` (full row). Latest stays the default; Generate
now / Mark reviewed semantics unchanged (Mark reviewed applies to the shown week).

**2 · Movers as an aligned mini-table.** The plain `eb-results` bars become columns —
campaign · fees · sales · sold · share-of-week bar — so the eight movers scan vertically
(the critique's "mini-metrics alignment").

**3 · Awaiting-decision deep links.** Each pending item links to
`/ebay/automation?tab=suggestions&highlight=<proposalId>`; the hub (page-scoped change)
reads `?tab=` to open the right tab and the Suggestions tab highlights + scrolls to the
row (subtle flash, then normal). Falls back gracefully if the proposal was decided
meanwhile (chip: "already decided").

**4 · Honest market label.** The header chip stops claiming `EBAY_IT`: the digest
aggregates every marketplace, so the chip reads "All markets". (A per-marketplace split
inside the payload is real work on the generator — backlog, not smuggled in.)

**5 · Week-over-week deltas.** The KPI band gains ▲▼ deltas vs `prior` (fees — down is
good; sales/sold — up is good), matching the dashboard's Delta idiom.

**6 · API surface.** ONE additive endpoint: `GET /ebay-ads/digests/:id` → the stored
digest row (404 when absent). Everything else — list, latest, generate, reviewed — is
already there. **No migration.**

## Non-negotiables honoured

- **Amazon untouched** — no shared files anywhere in this phase's plan.
- **No fake data** — history renders stored payloads verbatim (old weeks show what was
  true then); deltas come from the recorded `prior` block; decided-meanwhile proposals
  are labelled, not hidden.
- **Guarded writes only** — Generate/Mark-reviewed already exist; nothing new writes.
- Reversible: single revert.

## Verification script (gate 2)

Smoke (`_er35-smoke.mts`): /digests lists rows; /digests/:id returns the stored payload
(and matches /digest/latest for the newest); 404 on unknown id; generate is idempotent
per week (upsert). Prod click-through: week chips switch payloads; reviewed ✓ persists;
movers table aligns; pending item deep-links into the hub's Suggestions tab with the row
highlighted; "All markets" chip; WoW deltas. Digest before/after screenshots; builds +
`tsc` green.

## Rollback

Single revert (no migration; one additive endpoint).
