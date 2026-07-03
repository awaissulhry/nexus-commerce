# ER0 — Owner Decision Register + Proposed ER3 Order
<!-- ER0 deliverables 5+6. Each decision: recommendation, why, what it touches.
     Nothing here is implemented until the Owner rules and the phase that owns it builds it. -->

## Decision register

### D1 — Dates: adopt the `{start, end}` DateRangePicker on all eBay pages — **recommend YES**
Amazon pages use `_shell/DateRangePicker` with real `{start,end}` ranges; eBay pages use preset strings (`'last30'`) with the picker stubbed on the detail header and a `<select>` buried in grid toolbars (critique X3/D-6). Adopt the picker as the UI paradigm everywhere; `ebay-ads.routes.ts` handlers gain additive `startDate/endDate` acceptance (presets remain valid for digest/automation jobs and existing links); `ads-core/date-range.ts` stays the single conversion point. Cost: one additive API change + per-page swap during ER1/ER3. Risk: none identified — `resolveRange` already accepts explicit dates.

### D2 — Metric naming: Amazon-style at the UI boundary (`acos`, `roas`, `ctr`, `cpc`) — **recommend YES**
eBay payloads keep their honest server-side names (`acosPct`, `avgCpcCents` — cents-safe); one mapping in the new `_lib/types.ts` converts at the boundary (C8). ROAS becomes available on eBay surfaces for the first time (sales ÷ fees — computed from existing sums; labeled any-click like everything else). No API change.

### D3 — Nav label: "Rules & Automation" on both rails — **recommend YES**
One-line change in `_shell/nav.ts` (eBay entry currently "Automation"). Zero risk; do it in ER1 alongside the detail rebuild (the detail page's new Automation tab will cross-link to the hub, so naming should agree first).

### D4 — Add eBay "Change Log" and "Settings" rail entries (ER3) — **recommend YES, Change Log first**
The global audit endpoint (`GET /api/ebay-ads/actions`) already exists and is consumed only by the per-campaign Activity tab. A Change Log page is nearly free and answers "what did Nexus/automation do while I was away" account-wide — the Amazon rail has this concept; parity demands it. Settings (account-level: ceilings, write mode, quota posture — today split between the Automation posture card and env vars) is real but second: recommend Change Log in ER3 slot 4, Settings evaluated after ER3 experience.

### D5 — Tab wording: "Campaign Negative Keywords" (Amazon-parallel) — **recommend YES**
Mirrors Amazon's `NegativeTargetsTab` label ("Campaign Negative Targets") in eBay vocabulary. Also adopt Amazon's "Details" as the settings-tab name (v1 says "Settings"). Pure label changes inside ER1.

### D6 — Legacy consoles (`ads-console/`, `advertising/`, `campaigns/`) — **flag only (out of ER scope)**
The nav.ts header comment marks transfer/cleanup pending. Nothing in ER0–ER4 touches them; recommend a separate cleanup task after the ER workstream, sequenced by the Owner. Recorded here so it isn't lost.

### D7 — Rollout mode per ER1/ER2 gate (Part VIII gives the Owner the choice) — **recommend atomic replace**
Both rebuilt pages keep their routes and payload contracts; the guarded write layer doesn't change. With prod click-through verification at each gate (the ER protocol), a route flag adds a second copy of every surface for no audience — there is one Owner, who approves the gate before deploy. Recommendation: atomic replace at each approved gate, with the old component preserved in git history only. If the Owner prefers a flag, `?v=1` fallback per page is cheap to add at build time.

## Proposed ER3 page order (deliverable 6)

Recommended: **Ad Manager → Rules & Automation hub → Dashboard → Products → Weekly Digest** (a deliberate re-order of the default Dashboard-first):

1. **Ad Manager** — receives ER1 spillover immediately (Protected/automation column, normalized status vocabulary, DateRangePicker, the duplicate-export fix, rate/budget column tooltips). Fixing it first makes the whole console feel upgraded because it's the daily entry surface.
2. **Rules & Automation hub** — the largest capability delta of ER3 (condition-stack rule editor with selectable benchmarks per the Pacvue verdict; posture card decompression; deep links). ER1's per-campaign Automation tab will already exist, so the hub upgrade completes that story while it's fresh.
3. **Dashboard** — Recommendations panel + budget-pacing/ceiling visual + Status-card decomposition land best *after* the hub exists (recommendation cards deep-link into hub/detail surfaces).
4. **Products** — smallest deltas (band-label prose → tips, promoted-state deep links, inventory-state column, Change Log cross-links); also the ER3 slot where D4's Change Log page ships.
5. **Weekly Digest** — week picker/history + per-item deep links; last because it consumes everything else's URLs.

Default order (Dashboard first) remains acceptable if the Owner prefers the visual-impact-first sequence; the recommendation optimizes for dependency flow instead.
