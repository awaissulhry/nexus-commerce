# UI/UX Rebuild Strategy

**Status:** PROPOSAL — awaiting approval. Phase-by-phase, test along, approval before each phase.
**Date:** 2026-06-17.
**Goal:** a super-modern, high-contrast, readable, consistent operator console — and simpler (cut the bloat). Dense *and* legible.

---

## 0. Diagnosis (audited, quantified)

Your two complaints are real and measurable:

**"Too thin to read" — a readability crisis:**
- **14,665+** low-contrast text classes: `text-slate-400` (6,485×), `slate-500` (5,227×), `slate-300` (2,540×). `text-slate-400` on white = **4.2:1 contrast → fails WCAG AA for body text.**
- Tiny type dominates: `text-xs`/`text-sm` = **10,151** vs `text-base`/`lg` = **1,840** — a **5.5 : 1** skew toward small text.
- No custom font, no weight tokens (system stack + Tailwind defaults).

**"Transparency in highlights hard to see":**
- **2,334+** translucent backgrounds: `/40` opacity (1,365×), `/30` (251×), `/20` (135×). Worst: `bg-rose-950/40` (376×), `blue-950/40` (275×), `amber-950/40` (265×), `emerald-950/40` (248×). These **wash out over dense tables** — exactly the "hard to see" effect.
- **6,547+** faint borders: `border-slate-200` (3,590×, ~1.4:1 contrast → invisible), `slate-100` (681×). Grid lines don't anchor the eye.

**"Too extra" — feature/page bloat:**
- **293 pages.** ~40–50 are redundant: **3 competing Ads UIs** (ads-console + advertising + trading-desk), analytics drill-downs scattered across ~12 pages, stale redirects (`/inventory/*`, `/marketing/promotions`), out-of-scope channels (Etsy, WooCommerce), overlapping monitoring surfaces (monitoring + sync-logs + inbox + reconciliation). Could go **293 → ~160**.

**Good news — the foundation is ~75% systematic, not greenfield:** a real token config (`tailwind.config.ts`, U.1), 24 mature UI primitives (`components/ui/`), dark-mode class strategy, `docs/DESIGN-SYSTEM.md`. **We extend + sweep, we don't rewrite the logic.** Gaps: no font/weight tokens, dark-mode *surface* tokens incomplete (50+ hardcoded `dark:bg-slate-900`), no density tokens, z-index migration incomplete.

---

## 1. Strategy — three thrusts

1. **Rebuild the design language** (tokens) so the *same* semantic classes render legible + modern.
2. **Systematic sweep** to kill the 14k thin-text / 2.3k translucent / 6.5k faint-border instances — token redefinition + guided codemod + lint guardrails so it can't regress.
3. **Simplify the IA** — delete stale pages, consolidate the 3 Ads UIs to one, fold analytics into the `/insights` hub, restructure nav.

Keep all business logic. This is a **presentation + IA** rebuild, executed page-section by page-section.

## 2. Visual direction (per your "best-in-class = Airtable/Salesforce density, not Linear minimalism")

**Dense, data-first, *and* crisp & legible** — premium operator console: Retool/Airtable information density with Stripe/Linear finish. Principles:
- **Solid surfaces + elevation** for hierarchy (shadows, not transparency). Translucent tints are banned for highlights.
- **High contrast everywhere** — WCAG AA minimum (4.5:1 body, 3:1 UI/large). Secondary text = `slate-600`, not `400`.
- **Readable type** — real variable font, body ≥ 14px, headings 600–700, *no thin weights*.
- **Defined structure** — visible borders, clear sections, anchored grids.
- **Purposeful colour** — semantic status/accent with solid fills + a defining ring/border.
- **Subtle motion** — fast, intentional, `prefers-reduced-motion` honoured.

## 3. Token changes (the heart of P0)

| Token group | Now | Rebuild |
|---|---|---|
| **Type** | system font, xs/sm everywhere | variable font (next/font); scale w/ readable minimums; weight tokens (body 450, label 550, heading 650) |
| **Text colour** | slate-400/500 body (fails AA) | semantic `text-primary/secondary/tertiary` — all AA; secondary=slate-600 |
| **Surfaces** | translucent `/40` tints | solid `surface-{base,card,raised,sunken,overlay}` + elevation tokens; **no opacity tints** |
| **Status/accent** | `bg-*-950/40` | solid `bg-*-50/100` + `ring-*-200` (light), solid `bg-*-900` + ring (dark) |
| **Borders** | slate-100/200 (invisible) | `border-{subtle,default,strong}` ≥ slate-300 light |
| **Density** | ad-hoc px/py | `density-{compact,comfortable}` row/cell/field tokens |
| **Dark mode** | 50+ hardcoded pairs | surface tokens auto-flip (finish Phase-2 dark) |

---

## 4. Phases (each: build → contrast-lint + build pass → your visual review → commit)

- **P0 — Design language + tokens.** Font, type scale + weights, semantic text/surface/border/status/density/elevation/motion tokens; finish dark-mode surfaces. Ship a **`/design` living style-guide page** (every token + primitive, before/after). *Foundation; nothing else moves until this is signed off.*
- **P1 — Core primitives rebuild.** Re-skin the 24 `ui/` components + add `PageHeader/Section/Panel/DataTable` to the new tokens. Fixing the atoms propagates to every page.
- **P2 — App shell + navigation.** Sidebar, top bar, shell — the most-seen frame — rebuilt + restructured to the simplified IA (fewer, clearer sections).
- **P3 — Contrast/transparency sweep.** Token redefinition + guided codemod across all pages to eliminate thin-text / translucent / faint-border; **eslint rules** to ban regression. This makes the *whole app* legible fast.
- **P4 — Simplify (cut bloat).** Delete ~15–20 stale pages, consolidate 3 Ads UIs → 1, fold analytics drill-downs into `/insights` lenses. *Destructive → per-item approval.*
- **P5…N — Section rollout.** Rebuild each core section's pages to the system + simplified IA, one section per phase, verified: Dashboard → Products → Orders → Fulfillment → Pricing → Insights → Listings → Customers → Content/Ads → Settings.

**Cross-cutting (every phase):** WCAG AA contrast, keyboard/focus, dark-mode parity, responsive, consistent empty/loading/error/skeleton states, motion + reduced-motion.

## 5. Testing & guardrails (honest about auth-gating)

- **Automated:** `tsc` + `next build` (structural), a **contrast linter** (token pairs must pass AA), eslint rules banning the bad patterns, optional Playwright screenshots.
- **The real test is your eyes** — the UI is auth-gated, so each phase ends with you reviewing the live deploy (and the `/design` page from P0 gives a single screen to judge the whole system).

## 6. Research add-ons (things to fold in)
Variable font + modular type scale · WCAG 2.2 AA contrast pass · solid-surface elevation system · density modes · consistent state components (empty/skeleton/error) · motion tokens + reduced-motion · IA simplification (one Ads cockpit, analytics-in-hub) · component-discipline lint (no ad-hoc Tailwind) · a living `/design` style guide · finish dark-mode + mobile.

## 7. Open decisions (before P0)
1. **Aesthetic direction** — dense-cockpit (max info) vs balanced (more breathing room).
2. **Pilot section** for the P5 rollout (Dashboard most-seen, Products most-core).
3. **Bloat aggressiveness** — delete stale pages now, or conservative (hide from nav first).
4. **Font** — Inter / Geist / other.
