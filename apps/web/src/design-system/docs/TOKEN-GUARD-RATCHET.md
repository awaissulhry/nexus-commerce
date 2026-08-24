# The token-guard ratchet — holding the line while Phase 9 runs

**Status:** PROPOSAL — awaiting approval.

**Revised 2026-08-24: `scripts/ds-conformance-guard.mjs` already IS this ratchet.** The first draft
described building one. It exists, it runs in pre-push, and it already counts two of the four
checks. §0 replaces §4–§5; the real gap is three narrow extensions.

Not a sub-phase: a **hard rail** that spans 9.1, 9.4 and 9.5, and the thing that stops each of them
leaking back. Slots into `MIGRATION.md` §"Hard rails (every sub-phase)".

**One sentence:** token adherence is 74.8% inside the design system and 5.5% in the ads console
for tokens that exist and are reachable from both — the difference is that the DS is governed by
`token-guard` and nothing else is, so every codemod Phase 9 runs will refill at the rate new code
lands unless the guard grows a scope beyond `design-system/`.

---

## 0. 🔴 The ratchet already exists — this is an extension, not a build

`scripts/ds-conformance-guard.mjs` (Wave 1, owner directive 2026-07-04) runs in `.githooks/pre-push`
and already has every mechanism §4 below proposes: a committed baseline
(`scripts/ds-conformance-baseline.json`, 39 sections), per-section counts, `--census` / `--baseline`
/ `--check` / `--manifest <section>` modes, an allowlist, and the exact semantics —
*"waves lower these, pushes may never raise them."*

It already counts two of the four checks proposed here: **inline-style hex colours** and
**inline-style `fontSize`** (plus native `<select>` and `<input type="date">`).

So the genuine gap is three things, not a new tool:

| # | gap | why it matters |
|---|---|---|
| 1 | **It scans `.tsx` only** (`p.endsWith('.tsx')`) | Inline styles are 477 of the 10,804 declaration-position hexes. **The other 10,327 are in `.css` files and are invisible to it.** This is the single biggest miss. |
| 2 | **No spacing or radius check** | 4,961 + 1,619 lines. Radius is the 4%-adherence control group from §1. |
| 3 | **`marketing/ads/` is allowlisted** (`ALLOW`, line 33) | That is where 14,493 of the 17,815 lines are — but it is a deliberate policy call ("the Amazon H10 pixel-match world"), not an oversight, and Phase 9.1 changes it anyway. **Do not quietly un-allowlist it.** |

Rewrite §4 and §5 accordingly: extend the existing guard's file walk to `.css`, add two counters,
and leave the allowlist policy to whoever owns Wave 1.

### 0a. This guard and Phase 9.1 collide — canary added

The `ebay.css ⊆ ads.css` palette check compares **literal hex sets**. Phase 9.1 rewrites `ads.css`
to reference `var(--h10-*)` instead of hex — at which point the Amazon palette set empties and the
check either passes vacuously or fails everything, depending on which file tokenizes first.
**A canary now prevents the silent version:** `--check` fails if the Amazon palette resolves to
fewer than 200 literal colours (317 today; tokenizing `ads.css` alone drops it to 30). It names the
two real options — resolve both sides through `tokens.css`, or retire the check — so 9.1 has to make
the decision rather than sail past a vacuously-green guard. Verified by simulating the rewrite.

The decision itself still belongs to whoever runs 9.1.

This coupling is already fragile: the split in `f4ba90df1` moved `#b87503` from `ads.css` into
`_shared/shared-shell.css` and the guard failed the push, correctly — `ebay.css`'s conformance
depended on which file a colour happened to live in. Fixed by reading the palette from both files,
but the underlying design assumes hex literals forever.

---

## 1. The evidence that this, not availability, is the constraint

Measured across `apps/web` on 2026-08-24, at `57e644218`.

**Radius is the control group.** It has had eight CSS-reachable steps (`--h10-radius-*`) since
long before this audit. Nothing about it was missing or hard to find:

| | |
|---|---:|
| declarations using `var(--h10-radius-*)` | **78** |
| declarations using a raw px radius | **1,879** |
| distinct raw radius values in use | 18 |

**4% adherence, with the token sitting right there.** Colour says the same thing once you count
`var()` *use* rather than value *match*:

| area | `var(--token)` | raw hex | adherence |
|---|---:|---:|---:|
| `design-system/` | 862 | 291 | **74.8%** |
| `app/` (non-ads) | 219 | 1,631 | 11.8% |
| `components/` | 4 | 51 | 7.3% |
| `app/marketing/ads` | 568 | 9,723 | **5.5%** |
| **total** | 1,653 | 11,696 | **12.4%** |

The one governed directory is 6–13× more adherent than every ungoverned one, for the same tokens.

> ⚠️ An earlier draft of the audit reported "66.5% adherence" for colour. That number is
> **expressibility** — the share of hardcoded values a codemod *could* convert because they match
> an existing token within ΔE 2.3. It is a useful number for sizing the codemod and it is not
> adherence. Real adherence is 12.4%.

**`components/ui` is the exception that confirms the mechanism.** It scores ~0 violations — not
from discipline, but because Tailwind utility classes *are* its token layer, resolved through
`tailwind.config.ts`. Where a token vocabulary is the only way to write the code, it gets used.

## 2. Scope — 17,815 guardable lines, 160 files

Counted with `token-guard`'s own semantics: **line-based, comment-masked** (`commentMask()`),
excluding the palette's definition sites (`tokens/`, `styles/tokens.css`, `tools/`, `docs/`).

| scope | hex | font-size | spacing | radius | total | files |
|---|---:|---:|---:|---:|---:|---:|
| `design-system/styles` | 0 | 143 | 259 | 23 | **425** | 3 |
| `design-system` primitives/components/patterns `.tsx` | 0 | 6 | 0 | 0 | 6 | 2 |
| `design-system/catalog` | 0 | 91 | 53 | 7 | 151 | 1 |
| `components/` | 45 | 13 | 4 | 3 | 65 | 10 |
| `app/` minus ads | 1,318 | 445 | 741 | 171 | **2,675** | 51 |
| `app/marketing/ads` | 6,295 | 2,879 | 3,904 | 1,415 | **14,493** | 93 |
| **total** | 7,658 | 3,577 | 4,961 | 1,619 | **17,815** | 160 |

Note the DS's own stylesheets carry **425**. Its hex column is zero — `token-guard` check A has
enforced that for months — while font-size, spacing and radius were never checked, and until
`57e644218` two of the three had no CSS token to point at. That is the shape of the whole problem
in one row: **the checked axis is clean and the unchecked axes are not.**

## 3. Why a ratchet and not a fix-then-guard

`app/marketing/ads` alone is 14,493 lines across 93 files, and **Phase 9.1 already owns that
codemod** ("Tokenize `ads.css`", the keystone). A guard that fails on existing debt would either
block every push until 9.1 lands or force 9.1 to be one unreviewable commit. A ratchet inverts
it: the debt is recorded, new debt is refused, and each tranche of 9.1/9.4/9.5 lowers the number
it inherited. The guard becomes useful on day one instead of after the migration.

## 4. Design

**A committed baseline, per scope, per check.** `token-guard --ratchet` counts violations,
compares against `docs/token-baseline.json`, and fails only when a count **exceeds** its
baseline.

```jsonc
{ "app/marketing/ads":     { "hex": 6295, "font-size": 2879, "spacing": 3904, "radius": 1415 },
  "app":                   { "hex": 1318, "font-size":  445, "spacing":  741, "radius":  171 },
  "design-system/styles":  { "hex":    0, "font-size":  143, "spacing":  259, "radius":   23 } }
```

Four properties this needs, each because of something already true in this repo:

- **Scope granularity is per top-level route section, not per file.** Six sessions share one
  working tree ([[project_concurrent_sessions]]); a per-file baseline is a merge conflict on every
  parallel edit. Per-section keeps the conflict surface to one line per directory.
- **It auto-lowers and tells you to commit.** When a count drops the guard prints the new number
  and fails *once* with `run --ratchet-write and commit the baseline`. A silently self-lowering
  baseline can be reverted by a rebase without anyone noticing.
- **Counting must be the guard's own `commentMask()`.** A raw `grep -c` overcounts: across
  `apps/web` there are 11,696 hex matches but only 10,804 in a declaration-value position — 357
  sit in comments, including the block in `css-vars.ts` that documents which foreign hexes were
  replaced. A guard that fails on its own explanation is worse than no guard.
- **One escape hatch, requiring a reason**: `/* token-guard-ignore-next-line: <reason> */`. The
  guard has no ignore mechanism today; the ratchet needs one for the genuine exceptions in §6.

### 4a. 🔴 The rail must not fail a push over someone else's half-written file

`.githooks/pre-push` runs `token-guard` against the **working tree**, not against the commit being
pushed — the same property that makes the build hook miss a `--only` commit's missing dependency
([[reference_concurrent_session_commit_only_trap]]). In a tree six sessions share, that means one
session's mid-write file fails another session's unrelated push.

**This is not hypothetical: it happened while this document was being committed.** The commit added
one markdown file and nothing else. The push failed on
`styles/tokens-global.css:262  raw hex — --h10-rail-ft: #6f7b8b`, an **untracked** file another
session had created four minutes earlier and was still editing. Re-running the guard a minute later
reported zero violations.

Today `token-guard` sees ~50 design-system files. This proposal points it at **160 files across
`app/`**, which is where the parallel work actually happens — so it multiplies that collision
window by roughly three, on the busiest directories in the repo. Any version of this rail that
ignores that will be experienced as the guard randomly blocking people, and it will be disabled.

**✅ RESOLVED — untracked files are now skipped** by both `token-guard.mjs` and
`ds-conformance-guard.mjs`. A file git does not track is not in the commit being pushed; in this
tree it is another session's work in progress. Tracked-but-dirty files are still checked, because
those may be exactly what you are pushing. Negative-tested both ways on both guards: an untracked
file with violations passes, the same file `git add -N`'d fails.

Still open, and the better answer if the team wants it: **scope the check to
`git diff --name-only origin/main...HEAD`** instead of the working tree. That also makes the check
proportional to the change, but it alters how every DS guard is invoked, so it is a team call
rather than a bug fix.

## 5. Rollout — cheapest and most credible first

| # | scope | lines | why here |
|---|---|---:|---|
| 1 | `design-system/styles` | 425 | The DS's own house, and the two families it needs (`--h10-space-*`, `--h10-font-size-*`) landed in `57e644218`. Proves the tokens work before asking 93 ads files to adopt them. Not a ratchet — **drive to zero.** |
| 2 | `components/` + DS `.tsx` | 71 | 12 files. Finish it, then ratchet at 0. |
| 3 | `app/` minus ads | 2,675 | 51 files, nothing in motion here. Ratchet at baseline. |
| 4 | `design-system/catalog` | 151 | Demo surface, one file. Ratchet at baseline; fix opportunistically. |
| 5 | `app/marketing/ads` | 14,493 | Ratchet at baseline **only** — Phase 9.1 owns the reduction. |

Steps 1 and 2 remove 496 lines and leave two scopes permanently at zero, which is what makes the
rail credible before it is pointed at anyone else's code.

## 6. Decisions needed — do not guess these

- **Chart and data-visualisation colour.** Recharts takes colour as a **prop**, not a class, so an
  SVG presentation attribute cannot resolve `var(--h10-*)` — these must reach the component as
  literals. `tokens/colors.ts:115` already exports a `chart` ramp for exactly this reason
  (`actual` · `cap` · `reference` · `axis` · `grid` · `cursor`), and two of its six members are
  chart-only hues with no ramp counterpart. So the question is **not** whether to add a ramp — it
  exists. **Decide:** does the guard require chart literals to come from `chart.*` (today only
  `PerformanceGraph` and `TokenCatalog` import it, while `BurnDownChart` and `Heatmap` take colour
  from their callers), or does it exempt chart-colour props by name and leave the convention to
  review? A hard requirement is the stronger rail but needs `chart` extended first — a
  multi-series graph has no categorical set to draw from.
- **Third-party surface overrides.** `@xyflow/react` (8 files) and `@dnd-kit` (13) are styled by
  overriding their own class names with literal values, in four stylesheets: `control-room.css`,
  `allocation-canvas.css`, `autopilot-canvas.css` and `fleet/map/map.css`. **Decide:** exempt a
  vendor-override allowlist, or require those to be tokenized too.
- **Spacing values off the 23-step scale.** The extended scale covers 90.8% of measured spacing;
  the residue is 1,407 uses across 40 values, mostly `0` and page-level sizes above 48px. **Decide:**
  allow bare `0`, exempt values > 48px as layout rather than spacing, or extend the scale again.
- **Whether `font-weight` joins the checks.** 15 distinct weights are in use against a scale of
  four, including 620/640/650/660/680/740/750 — arbitrary stops a variable font made possible.
  Not counted in the 17,815 above. **Decide** before adding, because the count will move.

## 7. Gates

1. `--ratchet-write` on a clean tree reproduces `token-baseline.json` byte-for-byte.
2. Negative test per check: inject one violation into a ratcheted scope, confirm the push fails;
   remove it, confirm the push passes.
3. Negative test for the escape hatch: an ignore comment without a reason still fails.
4. A violation inside a comment does **not** fail — the `css-vars.ts` documentation block is the
   fixture.
5. Scopes 1 and 2 report zero, and their baselines are absent from the file rather than `0`, so a
   regression is a *new key* and shows up in review.
