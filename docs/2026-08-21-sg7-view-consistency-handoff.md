# SG.7 — Make the Recommendations and A.I. Bids tabs LOOK AND BEHAVE like every other Suggestions tab

You are working in `/Users/awais/nexus-commerce` on the **Suggestions page rebuild** (`/marketing/ads/suggestions`).
Phases SG.0–SG.5 are BUILT and locally verified by another session, **entirely uncommitted (LOCAL-FIRST — do not
commit or push anything; one batch commit happens later on the operator's explicit command)**. Read
`~/.claude/projects/-Users-awais-nexus-commerce/memory/project_sg_suggestions_rebuild.md` and the plan at
`~/.claude/plans/memoized-leaping-frost.md` before touching anything — they carry the full history, the operator's
decisions, and the traps already hit.

## The operator's ask (verbatim intent)

> "The recommendation page is actually supposed to be the same as the others. I mean, the appearance, the filters
> that we have: it's the filter bar, and then also the same case for the grid. I think also for the AI bids page as
> well — currently it looks very off and inconsistent."

Two of the seven type tabs on the Suggestions page render their own bespoke layouts today; the other five share one
anatomy. Rebuild the two outliers onto that shared anatomy:

```
AdsPageHeader (already shared — do not touch)
DS Tabs size="lg"  (already shared — do not touch)
AdsFilterBar card  ("Filters" panel — the SAME component, same placement, same gap)
AdsDataGrid        (same toolbar, same column conventions, same pinned decision columns, same pager)
```

**`?view=bids` is the pixel exemplar.** Open it side-by-side and match its rhythm exactly: tabs → 18px gap →
Filters card → grid card. The gap comes from `.h10-sug .h10-am-fpanel { margin-top: 18px }` in
`suggestions.css` — render through the same container classes and you inherit it.

## Current state (what you are replacing)

- `apps/web/src/app/marketing/ads/suggestions/SuggestionsClient.tsx` (~1900 lines) — the page. The render fork is
  near the bottom: `view === 'recommendations'` → `<RecommendationsView />`; `view === 'ai'` → a bare
  `AdsDataGrid` with NO Filters card; everything else → the shared filter-bar + grid path.
- `apps/web/src/app/marketing/ads/suggestions/RecommendationsView.tsx` — the old Recommendations page moved in
  verbatim (SG.4): sandbox/live banner, alerts strip, AI action brief, summary tiles, AccountPlanPanel,
  its own small Pending/Applied tabs, a strategy rail, and a card deck. **None of that matches the page.**
- `apps/web/src/app/marketing/ads/recommendations/` — old route (now a redirect), `RecommendationsClient.tsx`
  (⛔ PARKED — leave it), `AccountPlanPanel.tsx` and `recommendations.css` (both LIVE, imported by
  RecommendationsView).

## Data contracts (all verified working against prod data)

**Recommendations** (all `GET` unless noted, base `getBackendUrl()` + `/api`):
- `/advertising/recommendations` → `{ generatedAt, windowDays, counts: Record<category, number>,
  potentialMonthlyImpactCents, recommendations: [{ id, category: 'bid'|'negative'|'graduate'|'budget'|'sov'|'retail',
  severity: 'high'|'medium'|'low', title, detail, estImpactCents, apply: {kind, payload} | null,
  metrics?: RecMetrics }] }`. Ids are deterministic across reloads. ~63 real rows on prod right now.
- `RecMetrics` (`@/app/_shared/ads-ui`): impressions/clicks/ctr/spendCents/salesCents/orders/acos/roas/cvr — all
  nullable. **null renders "—", never 0** (house law).
- `POST /advertising/recommendations/apply { kind, payload }` — the write. There is NO client dry-run; the
  server-side 4-check write-gate (sandbox-default) is the real guard.
- `/advertising/summary` → `{ mode: 'sandbox' | ... }` — drives the mode-aware confirm.
- `/advertising/recommendations/brief`, `/advertising/alerts` — the brief/alerts strips (fate = operator decision,
  see below).
- Applied-set persistence: `localStorage['ax.recs.applied']` (per-viewer; recommendations have no stored status
  server-side). Dismissed is session-state only.

**A.I. Bids**:
- `GET /advertising/suggestions/ai-bids` → `{ items: [{ id, at, module, cycle, action, campaignId, campaignName,
  before, after, reason, planId, planName }], total }` — PROPOSED `AutopilotDecision` rows, source ≠ 'rule-setting'.
- `GET /advertising/suggestions/count` → `{ pending, families, aiBids }` (the tab pill).
- **Read-only BY DESIGN**: no decision approve/dismiss route exists (verified). The grid renders NO verbs; the
  toolbar note says "Read-only — approve or decline these on the plan in AI Advertising". Keep that truth.
  The ⚙ Bid Settings button on this view's toolbar (SG.5) must survive.

## Target design

### Recommendations tab
- **Grid rows = recommendations.** Suggested columns (match the other tabs' conventions — first column frozen via
  `renderFirst`, metrics right-aligned, decision verbs pinned right via `freezeRight`):
  Source (severity dot/chip + title; `title` attr for the full text) · Category (Tag) · Detail (truncated, tip) ·
  Impact €/mo (`estImpactCents`, sorted desc by default — the feed is impact-ranked) · Impr · Clicks · CTR · Spend ·
  Sales · Orders · ACoS · ROAS · CVR (nullable → "—"; use the page's existing `AcosCell`/`RoasCell` dot treatment
  if values are fractions — CHECK the encoding: RecMetrics `acos` is a FRACTION, the suggestions metrics are not;
  convert deliberately, never blindly) · ✓ Apply · ✕ Dismiss pinned right (the page's `.h10-sug-iconbtn` verbs,
  28px explicit boxes).
- **✓ keeps the mode-aware confirm modal** (sandbox = simulated · live = gated writes). That confirm is a safety
  feature, not chrome — port it, don't drop it. After apply: mark applied (localStorage set), toast with the same
  copy family the page uses.
- **Row click → DS Drawer** with the provenance flow + full metric grid (RecommendationsView already has this
  drawer — port it, don't rebuild it).
- **Filters card** (AdsFilterBar, `filterState` mode like the other views): Strategy/Category select (folds the
  strategy rail's six entries + counts into the bar — the rail dies), Severity select, Status select
  (Pending | Applied — replaces the small inner Tabs; mirrors how the family views fold Status into the bar,
  H10's own placement), Impact € min/max range. **Scope grains (product line / portfolio / campaign / ad group)
  do NOT apply — recommendations are account-wide aggregates.** Do not render scope pickers that filter nothing
  (100%-honest law); a short `notesSlot` line saying the feed is account-wide is the honest substitute.
- **The extra chrome — STOP AND ASK THE OPERATOR (AskUserQuestion) before deciding**: sandbox/live banner, alerts
  strip, AI action brief, summary tiles, AccountPlanPanel, "Apply all high-priority" button. Precedent that
  matters: this operator REMOVED the Suggestions page's top strips TWICE (see the memory file, SG.2e — "not
  really liking the top bit"). Likely answers: banner survives only as something small (mode matters for the
  confirm), Apply-all-high becomes a grid `selectionActions`/toolbar action, AccountPlanPanel/brief/alerts get
  parked or move elsewhere — but the operator decides, not you. AccountPlanPanel is an ACR.6 feature; park,
  never delete (⛔ KEEP law).

### A.I. Bids tab
- Keep the existing grid + read-only truth + Bid Settings gear; **add the same Filters card above it** so the
  rhythm matches. Honest facets only (client-side cut over the loaded items is fine at this volume): Campaign
  (select from loaded rows), Module (bid/budget/…), Action, Plan. No scope grains here either (decisions carry
  only campaignId) — same honest `notesSlot` treatment. An empty A.I. queue should still show the EmptyState CTA
  (not an empty grid inside a filter chrome — match how the family views handle it).
- The two seeded preview decisions (plan `sg4-preview-plan`, "SG.4 preview (delete me)") are your test data.
  The plan is inert (`enabled:false, autonomy:'OFF'`). **Never delete or modify them; never approve anything.**

## Laws (non-negotiable, from the operator's standing feedback)

1. **LOCAL-FIRST**: no commits, no pushes. The working tree must stay `tsc`-green at ALL times — the pre-push hook
   builds the WORKING TREE, so one broken file blocks every parallel session's push.
2. **Design system first**: DS `Modal`/`Drawer`/`Tabs`/`Tag`/`Button`/`Input`/`Select`/`EmptyState`; tables are
   `AdsDataGrid`; tokens only in CSS (no raw hexes; beware DS surface/border/text tokens that are RGB CHANNELS —
   probe COMPUTED values). All 4 stylesheets loaded.
3. **100% honest UI**: null ≠ 0 ("—" with a reason in the tip); no controls that don't act; a disabled control
   must explain itself (aria-disabled + answering click — the silent-disabled ratchet counts `disabled`+`title`
   pairs); read-only means saying so in copy.
4. **Shared means exactly the same**: reuse `AdsFilterBar`, `AdsDataGrid`, the page's cell components
   (`AcosCell`, `RoasCell`, `dash`, `.h10-sug-iconbtn` verbs). No copy-forks.
5. **Never approve/apply/dismiss the seeded preview rows** (`sg2-preview` rule rows, `sg4-preview-plan`
   decisions) or any REAL pending suggestion. Recommendations applies are sandbox-gated but still: verify apply
   plumbing with ONE low-stakes recommendation only if the mode is sandbox (`/advertising/summary` says), else ask.
6. **Extend, don't add pages/routes.** Everything happens inside `SuggestionsClient.tsx` + a view component.

## Guards you must leave green (run before finishing)

```
cd apps/web && npx tsc --noEmit            # and apps/api if you touch it
node scripts/check-button-vocabulary.mjs   # exit 0; baseline 286 — link-verbs are h10-am-link,
                                           # labelled buttons h10-am-btn/DS Button; unclassed <a>
                                           # inside a wrapper span for grid links (see .h10-sug-agx)
node scripts/ds-conformance-guard.mjs      # exit 0
npm run tokens:check                       # in sync
```

## Traps that WILL fire on this exact task (each already fired once; details in memory)

- **AdsDataGrid defaults `selectable` to TRUE** — a read-only or verb-column grid must pass `selectable={false}`
  or you ship a checkbox column that promises nothing.
- **The frozen first column paints its overflow OVER the next column** (sticky, z-index 3). One-line cell content
  needs `overflow:hidden` on the cell + `min-width:0` on EVERY flex item in the shrink chain (a HoverCard anchor
  span in the middle silently refuses to shrink). Cap at 100%, never px.
- **The JSX build strips the space after `</b>`** — write `<b>x</b>{' '}y`. Verify copy by geometry/textContent,
  not by reading the diff.
- **`display:flex` on a copy paragraph** splits text around inline tags into flex items and scrambles the
  sentence — wrap prose in ONE span.
- **Browser probes lie**: screenshots are SCALED (~0.875) so coordinate clicks miss silently — click by `ref`
  from `read_page`/`find`, or drive transient UI (toasts) with ONE in-page `javascript_tool` script. localhost,
  never 127.0.0.1. Read the SCREEN after every visual change — a screenshot taken to confirm your edit is not
  one you read.
- **RecMetrics `acos`/`ctr`/`cvr` are FRACTIONS** (0.31 = 31%); the suggestions grid's own metrics are already
  percent. Convert at ONE place and label it, or the dots/bands lie.
- **Toast link verbs are `h10-am-link`** (the dark toast surface adapts it via `.nds-toast .h10-am-link` in
  ads.css); undoable toasts pass `{ duration: 8000 }`.

## Environment

- Local API: `cd apps/api && npm run dev` (port 8080). It dies on Neon idle timeouts and tsx-watch RESPAWNS on
  file edits — recover with `for pid in $(pgrep -f "tsx watch src/index.ts"); do kill -9 $pid; done` then one
  clean restart. Ads crons do not start locally.
- Web: port 3000 with `NEXT_PUBLIC_API_URL=http://localhost:8080`. Both may already be running.
- Data is REAL PROD (local API talks to the prod DB). Reads are free; writes are governed by the laws above.

## Multi-session rules (live right now)

- Several Claude sessions share this working tree on `main`. **Shared files carrying OTHER sessions'
  uncommitted work**: `advertising.routes.ts`, `automation-action-handlers.ts`, `schema.prisma`,
  `advertising-rule-evaluator.job.ts`. You should not need any of them — this task is web-only
  (`SuggestionsClient.tsx`/`RecommendationsView.tsx`/`suggestions.css`/`ads.css`). If you believe you need an API
  change, message the SG session first (ListAgents → SendMessage) and say what and why.
- The SG session may be live and owns `SuggestionsClient.tsx`'s ongoing work (SG.6 is still open: Automations
  Queue link-out + docs record). **Announce yourself via SendMessage before editing `SuggestionsClient.tsx`** so
  you don't collide mid-file.
- Never run `git commit`/`push`; never `--no-verify`; leave the vocabulary ratchet at its baseline.

## Definition of done

- [ ] `?view=recommendations`: tabs → Filters card → grid, visually indistinguishable in rhythm from `?view=bids`;
      filter facets work (strategy/severity/status/impact); drawer + mode-aware confirm preserved; chrome fate
      decided BY THE OPERATOR via AskUserQuestion, implemented accordingly; strategy rail and inner tabs retired.
- [ ] `?view=ai`: Filters card above the existing read-only grid; Bid Settings gear + read-only note intact;
      EmptyState when the store is empty.
- [ ] Verified in the browser on real data (63 recs; 2 preview decisions), BOTH themes, screenshots read.
- [ ] `tsc` both apps green, all three guards green, no console errors.
- [ ] Memory updated: `project_sg_suggestions_rebuild.md` gains an SG.7 section (what changed, what the operator
      decided about the chrome, traps hit); MEMORY.md index line updated.
- [ ] Nothing committed. Preview rows untouched. Prod state as found.
