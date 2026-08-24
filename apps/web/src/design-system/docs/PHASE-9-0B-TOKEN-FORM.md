# Phase 9.0b — The token-form collision

**Status:** PROPOSAL — awaiting approval. Blocks 9.2 and 9.3; slots into `MIGRATION.md`
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

**Does NOT touch:** `globals.css`, `ads.css`, `tailwind.config.ts`, or any app page CSS.
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
