# EV0 — Visual & UX Audit (eBay console vs Amazon console)

Run 2026-07-04. Evidence: the Owner's chooser screenshot + fresh same-viewport captures of
the Amazon Campaign Builder (chooser, SP Super Wizard steps 1–3, product selector) and the
eBay builder (chooser, Setup, Targeting, Listings) + two code censuses (Amazon builder
anatomy; eBay-tree visual-consistency sweep). Companion: `EV0-BUILDER-SPEC.md` (listing
picker + advanced-settings gap map).

## 1 · Screenshot divergence report — the builder (Owner's priority #1)

### 1a. Chooser (`/ebay/campaigns/new` vs `/campaign-builder`)
The eBay chooser already consumes the shared `.h10-cb-*` chrome, but only half of it:

| Amazon reference | eBay today | Divergence class |
|---|---|---|
| 64px circular tinted icon medallion (`.h10-cb-ic`, `#e9f4fe`) with 46px glyph | small bare lucide icon, no medallion | card anatomy |
| Centered column: icon → 17px/700 title → "**Best for:** …" line → 13px desc | left-aligned, no Best-for line, chips row at bottom (ragged 0–3 chips per card) | card anatomy |
| Cards inside `.h10-cb-panel` (white 12px-radius frame) with `.h10-cb-sec` headers (17px/700 h3 + 13px intro) | sections hand-styled via inline `h3 style={{fontSize:13.5}}` — overrides the shared 17px rule | section chrome |
| Profile selector row (mark + flag + market dropdown) | absent (market picked later, in the wizard Setup) | page anatomy |
| 26px/800 page title + BETA pill + Exit Builder button | slim back-link + 19px title | header |
| hover: `#1f6fde` border + `#f6faff` bg + shadow | hover border only (template chips: bare pills, no tooltips) | affordance |
| page fills its frame | ~50% dead whitespace below the fold | composition |

### 1b. Wizard steps (`/ebay/campaigns/new/general` vs SP Super Wizard)
- **Setup**: one small floating card, ~85% dead space; native `dd/mm/yyyy` date input;
  labels crammed inside the card. Amazon: section-title-OUTSIDE-card pattern
  (`h3 + subtitle` above each white card), sticky left scroll-spy subnav, styled inputs,
  ⓘ InfoTips on every field.
- **Targeting**: bare unlabeled `Min €/Max €` boxes; guidance as inline grey prose
  paragraphs instead of tips; the key/rules mode cards use `eb-goalcard` — a near-duplicate
  of `.h10-cb-card` with different border (`#d6dbe2` vs `#e6e9ee`), radius (12 vs 10) and
  alignment (census §6) — two card systems for one affordance.
- **Listings**: the picker is text-only rows ("€21.93 · qty 78 · BE add cost · 30d €0.00")
  with no thumbnails, no SKU chips, no grouping, cramped ~400px scroll area, bare
  "Staged (0)" tray. Amazon: `.h10-spw-ps` two-panel with 44px thumbnails, 2-line title
  clamp, SKU/ASIN code chips + copy, family expansion with lazy variation loading, Search
  and Enter-Products tabs, Add All, skeleton loading rows, pager, sortable tray with
  Remove All. **The `.h10-spw-ps-*` CSS is already in shared ads.css — the eBay wizard
  can adopt it without touching a shared file.** Full spec in EV0-BUILDER-SPEC.md.
- **Footer/validation**: "1 item(s) need attention" as plain text vs Amazon's
  `.h10-spw-err` styling + modal guards.

## 2 · Console-wide visual census (code-verified)

What's already right: 6 pages on AdsPageHeader, 4 on DateRangePicker, 15 files on
AdsDataGrid, detail pages on CampaignDetailHeader + `.h10-cd-*`, chooser/wizard on
`.h10-cb-*`/`.h10-spw-*` chrome, grids inherit `.skb` skeletons + header HoverCards.

The debt is concentrated in six classes:

- **D1 · Hand-rolled rows/tables where AdsDataGrid (or a shared row skin) exists.** The
  same inline flex-row idiom copy-pasted 8× — AutomationTab ×4 (rules/proposals/applied/
  drift mini-lists), ListingsStep ×2, ActivityTab, DriftTab — plus raw `<table>`s in 8
  files (`eb-difftable`, ReviewStep, RatesStep, KeywordsStep, digest movers, ImportCsv,
  WhyModal, CriterionCard) duplicating `.h10-am-grid` styling by hand.
- **D2 · Inline-style debt.** 58 hardcoded inline `fontSize` values (8 distinct sizes) and
  81 inline hex colors across the eBay tree; the 5 Amazon reference files carry ~0 static
  inline styles. Worst files: AutomationTab (35), ListingsStep (23), ReviewStep (21).
- **D3 · Missing tokens (root cause of D2).** ads.css defines only rail + 3 semantic
  tokens on `.h10-shell`; there are NO general text/muted/border/divider surface tokens —
  so both consoles hardcode `#1c2530/#5b6573/#8a93a1/#eef1f5` as literals, and eBay adds
  14 hexes that match no token at all (`#283441`, `#37495b`, `#12855f`, `#667085`…).
- **D4 · Tooltip gaps.** eBay has zero direct InfoTip/HoverCard imports; metric tips flow
  only through the grid `tip:` prop. Untipped: Ad Fees/Ad Sales/ACOS/ROAS/Sold on the
  eBay Ad Manager, all of AppliedTab and Change Log, most of SuggestionsTab; hand-rolled
  controls use 136 native `title=` attributes where Amazon renders styled tips.
- **D5 · Loading states.** The six dashboard cards + automation panels + editor show
  plain "Loading…" text; Amazon shows shimmer skeletons (`.skb` / `.h10-cd-skel` — both
  already exist and are already used by eBay's grids and detail shells).
- **D6 · Duplicate card system.** `eb-goalcard` vs `.h10-cb-card` (census §6) — fold.

## 3 · Proposed EV phase order (each double-gated: spec → approval → build → verify)

| Phase | Surface | Core deltas |
|---|---|---|
| **EV1** | Builder chrome — chooser + wizard shell | Full `.h10-cb` anatomy (panel, sec headers, icon medallions, Best-for line, market row, title/BETA/Exit); wizard steps adopt the section-outside-card pattern + subnav + footer/validation chrome + styled date fields + InfoTips; `eb-goalcard` → `.h10-cb-card` (D6) |
| **EV2** | Listing picker + thumbnails everywhere | `imageUrl` migration + sync parse (GalleryURL — free in responses we already fetch); `.h10-spw-ps` adoption for ListingsStep; thumbnails on the Products page rows + PromoteModal (spec: EV0-BUILDER-SPEC.md) |
| **EV3** | Builder content + advanced settings | Targeting/Rates/Keywords/Budget/Review rebuilt on the section pattern; Advanced sections per the gap map (scheduled start, key-based DYNAMIC, wizard bid suggestions, name grammar); suggested-value chips in the Amazon "Suggested · Use" idiom |
| **EV4** | Detail + hub tab interiors | Replace the 8 hand-rolled row lists + raw tables (D1) with AdsDataGrid/shared skins; AutomationTab rebuild (35 inline styles → classes); Activity/Drift rows; WhyModal/CriterionCard tables |
| **EV5** | Console-wide consistency | New shared surface tokens (`--h10-text/-muted/-border/-divider` — additive to ads.css, unused by Amazon until adopted) + de-inline the 58 font-sizes/81 hexes; tooltip fill (D4); skeleton fill (D5); title=→InfoTip on controls |
| **EV-QA** | Final sweep | Side-by-side at 3 viewports, a11y/keyboard, tooltip + skeleton coverage checks, scorecard + changelog |

Amazon-gated touches anticipated: ONLY the additive token block in EV5 (new variables,
zero consumers on Amazon until Amazon opts in) — identical-after snapshots regardless.
Everything else lands in eBay files or consumes shared CSS that already exists.
