# Phase 9.0b — The token-form collision

**Status:** ✅ **SHIPPED 2026-08-24.** Approved and executed the same day. Execution record
in §11 — one step was deliberately narrowed after the audit, and two extra live defects
were found and fixed. Original proposal text kept intact below for the record. Blocks 9.2 and 9.3; slots into `MIGRATION.md`
between 9.0 (pre-flight) and 9.1 (tokenize `ads.css`).

**One sentence:** the DS and the app define the same 25 token names in two incompatible
forms, so 289 DS declarations are discarded by the browser on every page inside
`.h10-shell` — silently, with no error and no visible breakage.

---

## 1. The defect

`tokens/css-vars.ts` publishes a **platform-semantic alias tier** — `--text-*`,
`--surface-*`, `--border-*`, `--color-primary`, `--status-*` — as **colours**:

```css
:root { --surface-card: var(--h10-surface); }   /* → #fff */
```

`globals.css:33` and `ads.css:93` define the **same names** as **space-separated RGB
channels**, because Tailwind composes them as `rgb(var(--x) / <alpha-value>)`:

```css
.h10-shell { --surface-card: 255 255 255; }
```

Used as a colour, the channel form is **invalid at computed-value time** and the whole
declaration is dropped: `background: var(--surface-card)` → `background: 255 255 255` →
`rgba(0,0,0,0)`. A border becomes `0px none`. A colour silently inherits.

🔴 **This is not a cascade-order bug and reordering imports cannot fix it.** Custom
properties resolve from the **nearest defining ancestor**, not from source order.
`.h10-shell` is a descendant of `:root`, so its definitions shadow the DS's `:root`
definitions for every element inside the shell — which is the entire ads console.

**Measured on `/marketing/ads/reporting`, 2026-08-24:** 11 of 16 probed aliases are in
channel form inside `.h10-shell`.

| resolves inside `.h10-shell` | tokens |
|---|---|
| **channels — every consumer dead** | `--text-primary` `--text-secondary` `--text-tertiary` `--text-disabled` `--text-link` `--surface-canvas` `--surface-card` `--surface-sunken` `--border-default` `--border-subtle` `--border-strong` |
| real hex — consumers fine | `--color-primary` `--color-primary-soft` `--status-*` |

That split is exactly why this has survived so long: pills, links and accent borders render
correctly while the surfaces behind them are invisible. The page looks *half* styled, never
*unstyled*, so it reads as a design choice rather than a defect.

## 2. Scope — 398 declarations, 289 of them at risk

Uses of the contested names across `styles/{primitives,components,patterns,a11y}.css`:

| dead inside the shell | n | | survives | n |
|---|---:|---|---|---:|
| `--text-primary` | 55 | | `--color-primary` | 68 |
| `--border-subtle` | 42 | | `--status-danger-strong` | 8 |
| `--surface-card` | 40 | | `--color-primary-soft` | 6 |
| `--text-tertiary` | 39 | | `--status-danger-line` | 4 |
| `--text-secondary` | 34 | | `--status-*` (rest) | 23 |
| `--border-default` | 28 | | | |
| `--surface-sunken` | 16 | | | |
| `--border-strong` | 16 | | | |
| `--text-disabled` | 15 | | | |
| `--text-link` · `--surface-canvas` | 4 | | | |
| **subtotal** | **289** | | **subtotal** | **109** |

For comparison, the same stylesheets already make **271** collision-free `var(--h10-*)`
references. The DS is most of the way there; this finishes it.

**Known casualties of this exact mechanism, already paid for:**
`reporting.css` 155 of 155 declarations dead (fixed 2026-08-19) · the SGX2 page-level tab
bar, 3 declarations including the separator the operator reported as a styling complaint ·
`.h10-ds-burn-tip`, transparent for months behind a `var(--x, #fff)` fallback that could
never fire (fixed 2026-08-24).

## 3. Why the obvious fixes do not work

| candidate | why not |
|---|---|
| Flip `globals.css` to colours | Breaks Tailwind. `tailwind.config.ts` is built on `rgb(var(--x) / <alpha-value>)`; `border-default` alone feeds **636 files**. |
| Alias more names in the DS | Moves the failure rather than removing it. **Tried and reverted on 2026-08-24**: aliasing `--surface-raised` fixed the burn-tip and would have broken `reporting.css`'s `rgb(var(--surface-raised))` on pages that load both. |
| Reorder stylesheet imports | Cannot work — ancestor scope beats source order. |
| Use `rgb(var(--x))` in the DS | Breaks at `:root`, where the alias is a hex. `rgb(#fff)` is invalid — the same silent failure in the other direction. |

## 4. The fix

**DS stylesheets consume `--h10-*` only, and the platform-alias tier is deleted.**

`--h10-*` is DS-owned. No other stylesheet redefines it, it is a real colour in every
scope, and `.dark` already overrides it — so a DS component renders identically regardless
of what else is on the page. This is the same fix the SGX2 tab bar landed on independently
(`--h10-text-2` instead of `--text-secondary`), generalised.

The mapping already exists in `tokens.css` and is **1:1 for 24 of 25**:

```
--text-primary → --h10-text          --surface-card   → --h10-surface
--text-secondary → --h10-text-2      --surface-sunken → --h10-surface-sunken
--text-tertiary → --h10-text-3       --surface-canvas → --h10-bg
--text-disabled → --h10-text-disabled  --border-default → --h10-border
--text-link → --h10-text-link        --border-subtle  → --h10-border-subtle
--color-primary → --h10-primary      --border-strong  → --h10-border-strong
--status-{success,warning,danger}-{soft,line,strong} → --h10-{…}
```

🔴 **The one exception:** `--status-info-strong: var(--h10-blue-700)` maps to a **numbered
ramp**, which `token-guard` check B bans in component stylesheets. It needs a real
component token (`--h10-info-strong`) created first — step 1 below.

## 4b. Step-2 audit — RESULT (run 24 Aug 2026, static pass)

The static half of step 2 is done. Exact counts, replacing the §2 estimate:

| | |
|---|---:|
| raw grep, including prose mentions | 289 |
| **real declarations** | **285** |
| mentions inside comments (not declarations) | 4 |

**Batch order for step 3** — three commits, not four; `a11y.css` has none:

| stylesheet | dead declarations |
|---|---:|
| `styles/components.css` | 157 |
| `styles/primitives.css` | 68 |
| `styles/patterns.css` | 60 |
| `styles/a11y.css` | 0 |

**What starts painting**, by property:

| property | n | visible effect inside the shell |
|---|---:|---|
| `color` | 138 | text hierarchy separates into three inks instead of one inherited near-black |
| `border` | 79 | hairlines, field outlines and dividers appear |
| `background` | 63 | chips, wells and raised surfaces stop being transparent |
| `box-shadow` | 3 | elevation returns |

**Affected component families** — this is not localised; it is most of the system:
`grid` · `field` · `dp` (date picker) · `acctp` · `builder` · `taginput` · `ms` (multi-select)
· `banner` · `prefs` · `imgup` · `modal` · `combo` · `step` · `acct` · `range` · `btn` ·
`textarea` · `seg`, and more.

The remaining half of step 2 — the in-browser computed-value probe that confirms which of
these render inside a shell *today* — runs against the dev server before step 3 begins.

## 5. Sub-steps

| # | step | gate |
|---|---|---|
| 1 | Add `--h10-info-strong` to `css-vars.ts`; `npm run tokens:gen` | `tokens:check` |
| 2 | **Audit** which of the 289 actually render inside a shell today, by computed-value probe on the catalog + 3 ads surfaces + `/products/next`. Records what will *change*, does not gate the fix | probe output recorded in the PR |
| 3 | Substitute, **one stylesheet per commit**: `primitives.css` → `components.css` → `patterns.css` → `a11y.css` | `token-guard` + `tsc` after each |
| 4 | Delete the platform-alias tier from `css-vars.ts`; regenerate | `tokens:check`; zero contested names left in DS CSS |
| 5 | `token-guard` **check D** — ban the 25 contested names in DS stylesheets and DS `.tsx`, so the tier cannot creep back | negative test: inject one, confirm it fails |
| 6 | Full verification (§6) | all green |

## 6. Verification

- **Computed-value probe in BOTH scopes** — the only proof that matters here. A `:root`
  page (`/design-system`) and a shell page (an ads surface + `/products/next`). Every DS
  element's `backgroundColor` / `borderBottomWidth` / `color` read back as real values.
- **Before/after screenshots** of the catalog and three ads surfaces at native res.
- `token-guard` · `api-guard` · `tokens:check` · `tsc` · `next build`.
- Negative-test check D (a guard that got quieter is worse than one that was noisy).

## 7. 🔴 This is NOT a no-op — expect visible change

289 declarations that are currently **discarded** will start painting. On ads surfaces
expect backgrounds to appear on chips and wells, hairlines and borders to appear, and the
text hierarchy to separate into three inks where it currently renders as one.

That is the entire point, but it means **the ads console will look different after this
lands** — closer to its own design, and not identical to today's screenshots. Step 2's
audit exists so the change is known in advance rather than discovered in review. This
step wants its own visual review before push.

## 8. Blast radius — what this does and does not touch

**Touches:** `design-system/styles/*.css`, `design-system/tokens/css-vars.ts`,
`design-system/tools/token-guard.mjs`. That is all.

**One amendment to "no app CSS", found in the step-2 audit.** Exactly one app declaration
depends on the DS publishing the alias tier as colours:
`app/fulfillment/stock/sync-control/styles.module.css:30` uses `var(--border-default)`,
renders at `:root` (no shell), and imports DS `tokens.css` — so today it wins the source-order
race and gets a colour. Step 4 would silently kill it. It changes to `var(--h10-border)` in the
same commit: one line, same bug class. Every other app consumer is either inside `.h10-shell`
(already channels, unaffected) or re-pins the aliases itself (`/products/next`).

**Does NOT touch:** `globals.css`, `ads.css`, `tailwind.config.ts`, or any other app page CSS.
The channel form stays exactly where it is — Tailwind needs it, and `ads.css`'s own comment
(*"Pin ALL of them or none"*) is correct and deliberate. Only the DS stops depending on the
contested names.

**`/products/next` keeps its pin.** `products-next-shell.css` re-pins the aliases to real
colours in its own scope, which is why its 41 raw uses are correct rather than dead. After
this phase the DS no longer needs that pin, but the page's own CSS still uses the aliases
raw, so the pin stays until that page is migrated too.

**Check before shipping:** `PerformanceGraph` / `BurnDownChart` pass colours to Recharts as
JS props, not CSS. Those already read from `tokens/colors.ts` (`chart`) and are unaffected —
confirm no other component reads a contested name from JS.

## 9. Follow-on, deliberately out of scope

Same bug class, but app-side rather than DS-side — separate phase, after this one:
`app/marketing/ads/trust/trust.css` (17 raw uses inside the shell) and
`campaign-builder/launch-receipt.css` (16). Both are dead today.
`app/shared/report/[token]/shared-report.css` (13) is **correct** — it renders outside the
shell — and must not be "fixed".

## 10. Effort

~398 mechanical 1:1 substitutions across 4 stylesheets, one new token, one guard check,
one audit pass, one visual review. No component logic changes. Every step reversible; each
stylesheet is its own commit.


---

## 11. Execution record (2026-08-24)

**Done as planned:** step 1 (`--h10-info-strong` created; `--status-info-strong` repointed at
it so the two cannot drift) · step 3 (**394** substitutions — 285 contested + 109 DS-only —
across `primitives.css` 100, `components.css` 226, `patterns.css` 68, `a11y.css` 0) ·
step 5 (check D) · step 6 (verification).

### 🔴 Step 4 was NARROWED — the tier is kept, not deleted

The plan said "delete the platform-alias tier". **The step-2 audit showed that would break
roughly 70 app declarations.** Only **11** of the 25 names are genuinely contested
(`--text-*`, `--surface-*`, `--border-*` — the ones globals.css and ads.css also define).
The other 14 — `--color-primary`, `--color-primary-soft` and the twelve `--status-*` — are
**DS-only**, uncontested, and app CSS actively depends on them:

| consumer | uses |
|---|---:|
| `ads/reporting/reporting.css` | 47 |
| `products/next/styles.module.css` + client | 11 |
| `ads/trust/trust.css` | 9 |

So the tier stays published as the DS's app-facing API, and `css-vars.ts` now carries the
reason plus the rule for adding to it (`grep` the app first — that is why `--surface-raised`
is deliberately absent). What actually prevents the defect is **check D**, which bans the
whole tier inside DS stylesheets. Deleting the tier would have traded a guarded problem for
an unguarded breakage.

### Two extra live defects found by the audit

1. **`/products/next` — two dead declarations.** The page pins nine semantic aliases to real
   colours in `products-next-shell.css` but used **`--text-disabled` and `--text-link`
   without pinning them**, so both fell through to `globals.css`'s channels and were dropped:
   `.invManageLink` was a link that did not render as a link, and the sort chevron was not
   muted. Both inherited near-black. Measured in-browser, then pinned. *"Pin ALL of them or
   none"* — the rule that block already stated.
2. **`GOVERNANCE.md` documented the defect as the rule.** Its tier model said components
   consume the semantic alias tier — the exact thing that was silently failing. Rewritten to
   four tiers, with tier 4 marked app-only and the reason recorded.

### Verification actually performed

- **Both scopes probed in-browser.** Inside `.h10-shell`: 6 of 6 sampled tokens went from
  `rgba(0,0,0,0)` (dead) to a real colour. At `:root`: values identical before and after, as
  the substitution is value-preserving there by construction.
- Every rendered DS class on `/marketing/ads/suggestions` returns a real token colour; the
  page tab hairline measures `1px solid rgb(230,233,238)`; no pure-black inherited text.
- **Check D negative-tested twice** — first version reported only the first alias per line and
  was fixed to report every match, because under-reporting lets someone fix one and believe
  the line is clean.
- `token-guard` · `api-guard` · `tokens:check` · `tsc` · `next build` all green.

### Still open (unchanged from §9)

`ads/trust/trust.css` (17) and `campaign-builder/launch-receipt.css` (16) — app-side, same
bug class, dead today. `fulfillment/stock/sync-control/styles.module.css:30` joins them: it
uses `var(--border-default)` at `:root` and currently resolves via source order, which is
luck rather than design. `shared-report.css` (13) is correct and must not be touched.
