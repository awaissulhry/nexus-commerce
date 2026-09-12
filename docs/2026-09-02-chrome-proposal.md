# App chrome — CH.1 measurements (design §4.1)

Lane CH.1 (`nexus-commerce-71 [d10de1]`, ruling #492). This file is **4.1 only**: the measurements
the Owner's pick rests on. The two mocks (4.2) and the recommendation inputs (4.3) follow in this
same file as they land. **Nothing here changes a product file.**

---

## 0. Instrument, and why you can trust the 1440 column

| | |
|---|---|
| Build measured | local dev `http://localhost:3000` (`next-server` v16.2.4), the **working tree** at 2026-09-02 — i.e. including the uncommitted rebuild-programme work. Not prod: prod is behind that work. |
| Shared Chrome window | `innerWidth` **1728** × `innerHeight` **906**, `devicePixelRatio` 2. **Not resized** — other lanes share it. |
| 1728 column | measured **top-level**, in that window. |
| 1440 column | measured in a **same-origin iframe** with the layout viewport pinned to 1440×906; `innerWidth` asserted `1440` *inside the frame*, not assumed. |

**The iframe was validated before it was used.** The same page (`/dashboard/overview`) measured
top-level at 1728×906 and inside a 1728×906 iframe returned byte-identical chrome numbers:

```
topbar l0 t0 r1728 b56 h56      brandCell 0–66       tbContext 66–1099
tbSearchReg 1099–1619            tbField 1111–1607    rail w66 @t56 h850
#main-content l66 t56            content pad 24px     h1 l197 baseline 98.5
```

The only divergence was page-body height (content that had not finished loading), not chrome. The
iframe is therefore a faithful instrument for the 1440 column, and the two columns below are
comparable.

> **Honest limit on what was measurable.** Chrome and page headers rendered on all five pages, but
> page **bodies** were frequently stuck at `Loading…`. **I did not establish why**, and an earlier
> draft of this file asserted a cold/slow prod API — that was an inference, not a measurement, and
> it is withdrawn. The machine was **starved** at the time (load average **21.91**, several
> concurrent repo-wide `tsc --noEmit` runs from other lanes; PES.0 hub #517 reported the same), and
> starvation is indistinguishable from a slow backend without a two-host probe
> (`reference_quiet_measurement_is_not_a_negative_result`). Treat the cause as **unknown**.
>
> What this does **not** touch: **every number in this file is chrome or page-header geometry,
> which renders before data**, and none depends on row data. What it cost: I could not read a real
> sheet at max scroll, so §1.3's "what scrolls" is a synthetic scroll test of the shell rather than
> a scroll of real content.

---

## 1. Chrome geometry (4.1.1)

### 1.1 Per page

| page | route | top bar | rail | shell + content gutter |
|---|---|---|---|---|
| **studio** | `/products/[id]/edit/studio` | **0px** — opted out via `NO_TOPBAR_PATTERNS` | 66 @ `t0`, h **906** | `.h10-shell` `padding-left:66px`, **no gutter** |
| **/products/next** | `/products/next` | 56 | 66 @ `t56`, h 850 | `.h10-shell` + `.h10-main` `padding:26px 30px` |
| **mapping** | `/channels/mapping` | 56 | 66 @ `t56`, h 850 | app shell, `#main-content > div` `padding:24px` |
| **ads** | `/marketing/ads` | 56 | 66 @ `t56`, h 850 | `.h10-shell` + `.h10-main` `padding:26px 30px` |
| **dashboard** | `/dashboard/overview` | 56 | 66 @ `t56`, h 850 | app shell `padding:24px` **+ `max-w-[1400px] mx-auto`** |

Identical at 1440 and 1728 — chrome geometry is width-invariant. The one width-dependent number in
the whole app is the dashboard's centring margin (delta **D6** below).

### 1.2 The two chrome elements

- **Top bar** — `position: relative`, `z-index: 60` (`--nds-z-topbar`), `height: 56px`,
  `flex: 0 0 auto` inside `.nds-chrome-host { height: 100dvh; overflow: hidden }`.
  Regions: brand `0–66` · context `66–…` (`flex:1 1 auto`, `padding:0 12px`) · search
  (`flex:0 1 520px`, `padding:0 12px`) · utility (`flex:0 0 auto`, w **109**).
- **Rail** — `position: absolute; left:0; top:0; height:100%`, width **66** collapsed →
  **344** on hover / `:focus-visible` / pinned, `z-index: 50`. Reserved by the shell's
  `padding-left: var(--rail-reserve, 66px)`.

### 1.3 What is fixed, what scrolls — **measured, not derived**

**Nothing in the chrome is `position: fixed` or `position: sticky`.** The bar stays on screen
because the shell is a fixed-height flex column and only the content pane scrolls.

Measured on `/dashboard/overview` at 1728×906, scrolling `#main-content` by 500px:

| element | moved |
|---|---|
| content at the top of the page's own content pane | **−500.0px** (scrolled fully away) |
| `.nds-topbar` | **0.0px** |
| `.h10-rail` | **0.0px** |

`#main-content` is `overflow-y: auto`, `clientHeight` 850, and `main.contains(topbar) === false`.
The `h1` of **all five** pages was measured to sit inside `#main-content` / `.h10-main` (DOM
ancestor chains in §2.2).

> 🔴 **This is the single most consequential finding for the Owner's question.** The Owner asked for
> a header that "moves up and vanishes as we scroll, exactly how it is on Amazon". **The per-page
> header already does exactly that, on every page, today.** What does *not* scroll away is the 56px
> app top bar. So Option A is not "make headers scroll" — that behaviour exists. Option A is
> **"delete the 56px bar band and rehouse its four controls in the rail."** That materially changes
> A's cost (§4).

### 1.4 Vertical budget per page

| page | app chrome (top bar) | first content pixel (y) | rail (horizontal) |
|---|---|---|---|
| studio | **0** | 0 | 66 |
| /products/next | 56 | 82 | 66 |
| mapping | 56 | 80 | 66 |
| ads | 56 | 82 | 66 |
| dashboard | 56 | 80 | 66 |

The top bar costs **56px on four of the five**. The studio pays **0** — §2.3 already removed it
there, buying the sheet 56px.

---

## 2. Alignment — the deltas (4.1.2)

### 2.1 The deltas table

Every delta is a measured pixel offset with the declaration that causes it.

| # | delta | @1440 | @1728 | cause |
|---|---|---|---|---|
| **D1** | **The content box's left edge takes three different values** | 66 · 90 · 96 | 66 · 90 · 96 | three shells: studio `.h10-shell` `padL:66` **+ 0 gutter**; app shell `p-3 md:p-6` → **24**; `.h10-main` → **30**. Nothing reconciles them. |
| **D2** | **The page title's left edge is different on all five pages** | 165.3 · 120 · 90 · 96 · 90 | 165.3 · 120 · 90 · 96 · **197** | per-page, see §2.2 |
| **D3** | Top bar's context slot inner left (78) vs the page title | Δ **+12 / +18 / +42 / +87.3** | Δ **+12 / +18 / +42 / +87.3 / +119** | bar context `padding:0 12px` off a 66px brand cell → **78**; every page title starts further right. The slot is empty today (TB.5 opt-in), so the defect is **latent**: it appears the moment a page calls `usePageChrome()`. |
| **D4** | **The search field is right-anchored and aligns with nothing below it** | field `l823 r1319` | field `l1111 r1607` | `flex: 0 1 520px` + `padding:0 12px`. Its right edge sits **121px** from the viewport edge at *both* widths; its left edge moves **288px** between them. |
| **D5** | Search field's right edge vs the content's right edge | Δ **97** (app shell) / **91** (h10) | Δ **97** / **91** | the bar's right gutter is **12px**; the content's is **24px** (app shell) / **30px** (h10). Bar and page use different gutters — Δ **12 / 18**. |
| **D6** | **The dashboard's title moves 107px between the two widths** | l **90** | l **197** | `max-w-[1400px] mx-auto`. At 1728 the column is 1614 wide, so the auto margin is `(1614−1400)/2 =` **107px**; at 1440 the column is 1326 < 1400 and the margin collapses to **0**. The dashboard is the only one of the five with a max-width cap. |
| **D7** | Everything in the bar centres **0.5px above** the bar's own centre | cy **27.5** vs 28 | cy **27.5** vs 28 | `height:56px` **+ `border-bottom:1px`** with `box-sizing:border-box` → children get a **55px** content box (measured `h55` on brand, context, search and utility) and centre at 27.5. |
| **D8** | The page title's first baseline lands at five different heights | 28.75 · 130 · 110 · 132 · 98.5 | same | four different page-header implementations (§2.3) at three different font sizes: **15 / 18 / 27px**. |

### 2.2 Cause of D2, page by page (measured DOM ancestor chains)

| page | title left | arithmetic | causing declaration |
|---|---|---|---|
| **studio** | **165.3** | 66 + 16 + 83.3 | `.h10-shell` `padL:66` → `.nds-detailhdr.dense` `padL:16` → the `‹ Products` **back link precedes the `h1` in the same flex row** (`gap:10px`). *(The 83.3 is the measured gap between the title row's left edge at 82 and the h1 at 165.29; the back link's own width was not separately measured.)* |
| **/products/next** | **120** | 66 + 30 + 24 | `.h10-main` `padL:30`, then a page wrapper `styles-module__…__wrap` adds a **second** `padL:24` |
| **mapping** | **90** | 66 + 24 | `p-3 md:p-6` → 24. `.nds-pagehdr` adds nothing ✅ |
| **ads** | **96** | 66 + 30 | `.h10-main` `padL:30`. `.h10-hdr` adds nothing ✅ |
| **dashboard** | **90 → 197** | 66 + 24 (+107 @1728) | `p-3 md:p-6` → 24, then `div.max-w-[1400px].mx-auto` → `margin-left:107px` at 1728 only |

Only **mapping** and **ads** have a title flush with their own content box. They still disagree with
each other by **6px**, because their shells' gutters are 24 and 30.

### 2.3 Four page-header implementations

`.nds-pagehdr` (DS `PageHeader`) · `div.mb-5 > h1.text-2xl` (legacy `components/layout/PageHeader`)
· `.h10-hdr` (h10 shells) · `.nds-detailhdr` (DS `DetailHeader`, studio). Title sizes 27 / 18 / 27 /
15px. This is the root of **D2** and **D8** — there is no single page-header, so there is no single
left edge and no single baseline.

---

## 3. Global actions in the header (4.1.3)

From `AppTopBar.tsx`, left to right:

| control | width | reachable elsewhere? |
|---|---|---|
| brand / home link | 66 | rail's brand mark |
| page-context slot (TB.5) | flexes | **empty today** — pages opt in via `usePageChrome()` |
| search trigger | field **496** | **yes** — it only dispatches `nexus:open-command-palette`; ⌘K reaches the same palette |
| `ProfileSwitcher` | in the 109px utility region | no |
| theme cycler | ″ | no (moved here from the rail's footer in TB.4) |
| `NotificationsBell` | ″ | no |

**On "how often a page needs them while scrolled":** operator frequency is not something I can
measure, and I am not going to infer it from the DOM. What *is* measured: the studio already runs
with **none** of them (top bar 0px), using `‹ Products` as its way out — so the app demonstrably
functions without the band. And the search field is a **trigger, not a search** — the palette it
opens is keyboard-reachable wherever `CommandPalette` is mounted. The 56px therefore buys a
*visible* search affordance, the profile chip, the theme cycler and the bell.

---

## 4. What Option A actually costs (task 3)

Because §1.3 measured that **per-page headers already scroll away**, A is not a per-page rebuild.

| bucket | files | note |
|---|---|---|
| the chrome itself | **7** | `components/layout/AppShell.tsx`, `_shared/AppTopBar.tsx`, `_shared/app-topbar.css`, `_shared/AppNavRail.tsx`, `_shared/shared-shell.css`, `design-system/tokens/topbar.ts`, `tokens/chrome.ts` |
| gutter unification (D1) | **3** declarations | `AppShell.tsx` (24) · `shared-shell.css` `.h10-main` (30) · the studio's shell (66) — but **8** files reference `.h10-main` and **37** reference `.h10-shell`, so all 45 need verifying |
| pages carrying their own centring container (D6) | **65** | files matching `max-w-… mx-auto` — these are what visibly move under one layout grid |

**≈75 files, not 773.** The 773 Tailwind-dependent files
(`project_tailwind_legacy_migration`, 2026-08-24) are a *content* migration; A changes the **shell**,
and a shell change does not require the pages inside it to leave Tailwind. Those 773 remain the
constraint on the *rebuild programme*, not on this chrome change. Scale for context: **335** route
`page.tsx` files, **10** `layout.tsx`.

**What the one layout grid needs from DS.2** — four tokens/patterns that do not exist yet:
1. **one gutter token** (today 24 / 30 / 66 → one value),
2. **one content container** (full-bleed vs capped — today 65 pages cap themselves and the other ~270 do not; D6 is entirely this),
3. **one page-header pattern** (today four — §2.3),
4. **one title type step** (today 15 / 18 / 27px).

---

## 5. Inputs 4.3's rule needs

| 4.3 asks | measured answer |
|---|---|
| *"the top bar costs ≥ 48px on every page"* | **56px on 4 of 5; 0px on the studio.** Literally, the rule's antecedent is **false** — but only because the studio **already took Option A's vertical move unilaterally** (§2.3 of the design doc). Read as "≥48px on every page that still has it": **true, 56px**. The hub should decide which reading it meant; they point opposite ways. |
| *"the sidebar can carry search without widening"* | **Yes.** The rail is 66 collapsed / **344** expanded. At 344, minus the brand's `padding-left:19px` each side, a field has **≈306px**; the bar's field is 496px today, but it is only a **trigger** (§3), so at 66px collapsed it becomes a 36px icon that opens the same palette. **No widening required.** |

---

## 6. The two mocks (4.2)

**Lab:** `http://localhost:3000/design/chrome` — file `apps/web/src/app/design/chrome/page.tsx`,
the only file CH.1 creates. Verified in the browser at load 8.56 (not asserted from source).

Controls, in focus order: **Option** (A · B) · **Scenario** (studio at max scroll · list · narrow)
· **Width** (1440 · 1728) · **Theme** (light · dark) · **Sidebar** (66 collapsed · 344 expanded)
· **Zoom** (Fit · 1:1) · **Grid** (guides on · off). Each stage renders at true CSS pixel size
(1440 or 1728 × 906) and is scaled to fit, with the live percentage printed beside the controls —
the shared Chrome window is 1728×906 and CH.1 must not resize it. Fit sizes to **height** as well
as width: the vertical budget is the thing being judged and cannot be judged with the bottom of
the stage below the fold.

### 6.1 The sheet exception (PES.0 ruling #529)

A sheet page keeps **0 side gutters under either option** — a sheet's edge is the viewport's edge,
every pixel is a column, and GridSheet already makes the sheet the page. The studio stage therefore
renders flush in **both** mocks (verified: the studio content box computes `padding: 0px`, guides
read `content left 66` / `content right 1440`), so the Owner compares like with like. This is a
named rule, **not** a cost either option imposes, and no dense grid variant is needed.

### 6.2 Vertical budget — what each option gains, per page

| page | today | Option A | Option B |
|---|---|---|---|
| studio | 0 | 0 | 0 |
| /products/next | 56 | **0** (+56) | 56 (0) |
| mapping | 56 | **0** (+56) | 56 (0) |
| ads | 56 | **0** (+56) | 56 (0) |
| dashboard | 56 | **0** (+56) | 56 (0) |

**A returns 56px to four of five pages. B returns nothing anywhere.** At 906 tall that is 850 → 906
of content height, +6.6%. The studio gains nothing under either option because it already pays 0.

### 6.3 Horizontal — the one grid

| page | now | one grid | effect |
|---|---|---|---|
| studio (sheet) | 66 | **66** | unchanged — the §6.1 exception, under both options |
| /products/next | 96 | 90 | gains 6px each side |
| mapping | 90 | 90 | unchanged — already on the grid |
| ads | 96 | 90 | gains 6px each side |
| dashboard | 197 (@1728) | 90 | the `max-w` cap goes; **D6 disappears** |

The grid moves three pages by 6px or less and removes D1–D6 outright. It is the floor under both
options, exactly as §4.3 says.

### 6.4 Focus order — measured by walking the tab order, not read off the markup

| | order |
|---|---|
| **A** | search → Home…Advertising (9 nav) → profile → theme → notifications → **page** |
| **B** | search → profile → theme → notifications → Home…Advertising (9 nav) → **page** |

Both reach page content at tab stop **14**. The difference is shape: **A presents one chrome region
before the content; B presents two** (the bar's utilities, then the rail's nav).

> Two defects this measurement caught in the mock itself, both now fixed: the chrome controls were
> `div`/`span`, so the first tab walk found **nine** stops (the nav) and nothing else — on the very
> option whose pitch is "the sidebar carries search"; and the content was rendered **before** the
> sidebar, so A tabbed page → sidebar, the opposite of the "sidebar first" consequence A claims.
> Reading the markup would have confirmed neither.

### 6.5 🔴 Dark mode — a finding neither option fixes (ruled in §7.1)

`--nds-chrome-bg` is `#18263b` and theme-independent. Dark `--nds-bg` is `#14223a`. Measured
contrast between them: **1.05:1** — indistinguishable. So on any page whose ground flips dark, the
chrome/page boundary carries on a single 1px border and nothing else.

This is a **token-level** fact (both values read from `tokens/chrome.ts` and `tokens/css-vars.ts`),
not an artifact of the mock, and it is visible in both dark screenshots. It is a DS.2 input the
design doc does not currently name.

> **CH.1 raised this as a reason A ships a weaker dark frame — that part was wrong, and the hub
> ruled it (§7.1).** The argument was that under A the sidebar is the only chrome, so a 66px strip
> at 1.05:1 is the entire frame. But the separation is carried by the **boundary**, and B's rail
> edge meets the same two grounds — so the exposure is the same under either option and it is not
> a reason to prefer B. The original claim is left here rather than deleted, because the record of
> what was claimed and on what evidence is the point of this file. §7.1 has the ruling and the
> measurement of how far the boundary actually is from the rule.

> Scope note: the app-shell pages (dashboard, mapping) flip their ground dark, so this applies to
> them. The h10 shells pin their content light in both themes (`app-topbar.css`), so they do not
> hit it today.

---

## 7. 4.3 — the recommendation to the Owner (**the hub's**, PES.0 #540)

> Attribution matters here and is stated deliberately: **the recommendation below is the hub's, not
> CH.1's.** CH.1 measured, mocked both options honestly, and surfaced the one finding that
> complicates the pick. The hub ruled it. It reaches the Owner as **item 34**.

**Recommendation: Option A, plus a chrome/page separation task.**

The reasoning, against §4.3's own rule (the measurements are §5's, restated here so this section
stands alone for the Owner):

| §4.3 asks | measured | reading |
|---|---|---|
| top bar ≥ 48px on every page | **56px on 4 of 5; 0 on the studio** | the studio reads 0 only because it **already took A's vertical move** unilaterally (§2.3). A is therefore *one chrome for every page*; B keeps a band four pages pay 56px for that the fifth does not. |
| sidebar carries search without widening | **yes** | rail 66 → 344; a field gets ≈306px at 344, and at 66 it is a 36px icon opening the same ⌘K palette. Verified in the mock. |

A returns **56px to four of five pages** (850 → 906 of content height, +6.6%) at a cost of ≈**75
files**, not 773. B returns **0px anywhere**. The alignment grid is the floor under both.

### 7.1 The dark-mode finding — ruled, not carried

CH.1 measured `--nds-chrome-bg` (`#18263b`, theme-independent) against dark `--nds-bg` (`#14223a`)
at **1.05:1** and raised it as a reason A ships a weaker dark frame. **The hub ruled otherwise, and
the ruling is right on its own terms:** the finding applies to *either* option, because B's rail
edge meets the same two grounds. It is therefore not a reason to prefer B.

The separation is carried by the **boundary**, not by the two grounds: the rail's edge border must
reach **≥ 3:1 against both grounds** — the same non-text rule every other DS edge meets — and DS.2
mints a dark `--nds-chrome-bg` step that measurably reads as chrome, sequenced **after** the
provenance tokens.

**How far that task actually is, measured** (`--nds-chrome-border` = `#26323f`):

| pair | ratio | vs the ≥ 3:1 rule |
|---|---|---|
| border vs chrome ground | **1.17:1** | ✗ |
| border vs **dark** page ground | **1.22:1** | ✗ |
| border vs **light** page ground | 12.27:1 | ✓ |
| chrome ground vs light page ground | 14.33:1 | ✓ (light mode was never the problem) |

So the boundary as it stands **cannot carry the separation either** — it is 1.17–1.22:1 where the
rule wants 3. DS.2's task is a real move, not a nudge, and it is dark-only: every light-mode pair
already passes comfortably.

### 7.2 Banked for whoever builds the winner

Two defects the tab walk caught in CH.1's own mock, both **invisible to a markup read**:

1. chrome controls rendered as `div` / `span` — the focus walk found **nine** stops (the nav) and
   nothing else, on the option whose pitch is "the sidebar carries search";
2. content rendered **before** the chrome in DOM order — A tabbed page → sidebar, the exact
   opposite of the "sidebar first" consequence A claims.

Walk the tab order; do not read the JSX.

---

## 8. DS conformance of the lab page (PES.0 #601)

The DS gates began reading untracked files at 08:06, and `design/chrome/page.tsx` was red on two.
Both are now clean **for this file**: `ds-conformance-guard --manifest design` and
`check-raw-primitives-ratchet --check` (and `check-help-cursor`, still 0/baseline 0).

- **Inline `fontSize`: 24 → 0.** The guard's rule is `style=\{\{[^}]*fontSize`, which sees only
  **14** of the 24 — the rest sit in `const` style objects or after a nested brace. Fixing only the
  visible 14 would be a scanner passing for the wrong reason, so all 24 went.
- **Raw controls: 7 → 0** (`button` ×6, `table` ×1). The ratchet greps **comments** as well as code,
  so two of those six were prose; the explanatory comments now describe the tags instead of
  spelling them.
- **DS components adopted:** `SearchTrigger`, `ToolbarButton` ×3, `Button` ×3, `SegmentedControl`
  ×6, `DataGrid` ×2, `Kbd` ×2.
- **No new stylesheet.** DS controls are light-surfaced and this chrome is dark — the already-filed,
  still-open gap at `.claude/DS-GAPS.md` §TB ("no DS control has a variant for sitting on dark
  chrome"). That entry names the sanctioned answer: re-surface via `--nds-chrome-control-*` scoped
  to `.nds-topbar`, without forking. `app-topbar.css` already implements it and is loaded app-wide,
  so the lab **reuses** those rules through a `display: contents` scope element rather than copying
  them into a second stylesheet — a copy is exactly the fork the DS fork-drift guard cannot see.

### 8.1 🔴 The first conformance pass was wrong, and this is the correction

**What I did first:** replaced every inline size with Tailwind `text-xs|sm|base|md|lg|2xl|3xl` and
`font-heading|label`, then reported that the mock had been "showing six sizes the platform type
scale does not contain — 9.5, 11.5, 12.5, 15, 20, 22".

**That finding was wrong, and so was the remedy.** Tailwind is the kit the Owner declared LEGACY;
the DS is the substrate. `ds-conformance-guard` cannot see Tailwind classes at all, so it went
green **for the wrong reason** — the same failure mode as
`reference_a_scanner_passing_for_the_wrong_reason`. Two contributing facts, recorded because they
are not this lane's to be smug about: the hub's brief said "DS type classes" when none existed, and
the guard's own remedy text was corrected only at 08:32:49, two minutes after the edit.

**Measured against the real DS scale** (`design-system/styles/tokens.css:393–406`):

```
nano 9 · micro 10 · micro-plus 10.5 · xs 11 · xs-plus 11.5 · sm 12 · sm-plus 12.5 ·
base 13 · base-plus 13.5 · md-minus 14 · md 15 · lg 18 · xl 22 · 2xl 27
```

…the mock was **already almost entirely on the DS scale**. Of the six sizes I called off-scale,
**four are published DS steps** — 11.5 `xs-plus`, 12.5 `sm-plus`, 15 `md`, 22 `xl` — and 14 is
`md-minus`. The Tailwind pass had snapped each of them to a neighbour for no reason, and pushed the
lab's own h1 from 22 to Tailwind `3xl` **24, which is not a DS size at all**.

> Worth one line for the hub's own list: the scale relayed in #623 omitted `nano 9`,
> `micro-plus 10.5` and **`md-minus 14`**. The last one matters — it is why the rail's 14px
> navigation label needed no change. A list of members is a set claim; I read the file.

### 8.1a The redo — page-local classes that read DS tokens

`apps/web/src/app/design/chrome/chrome.module.css` (77 lines), FX.1's
`formula-lab.module.css` pattern: ten classes, each `font-size: var(--nds-font-size-*)`, plus
`font-family: var(--nds-font-sans)` on the page root. Dated header states it is deleted and swapped
for DS.2's `.nds-type-*` utilities the day those land. **No `text-*` / `font-*` Tailwind utility
remains in the file** (verified by regex over the source), and every class was confirmed to
*resolve* in the browser — an undefined token or a mistyped CSS-module key both fail silently.

| class | token | computed | elements |
|---|---|---|---|
| `.micro` | `--nds-font-size-micro` | 10px | 6 |
| `.xs` | `--nds-font-size-xs` | 11px | 14 |
| `.xsPlus` | `--nds-font-size-xs-plus` | 11.5px | 6 |
| `.sm` | `--nds-font-size-sm` | 12px | 72 |
| `.smPlus` | `--nds-font-size-sm-plus` | 12.5px | 2 |
| `.base` | `--nds-font-size-base` | 13px | 6 |
| `.mdMinus` | `--nds-font-size-md-minus` | 14px | 18 |
| `.md` | `--nds-font-size-md` | 15px | 2 |
| `.lg` | `--nds-font-size-lg` | 18px | 4 |
| `.xl` | `--nds-font-size-xl` | 22px | 2 |

### 8.1b Type, original → now (1:1, computed `font-size`/`line-height`)

| role | original | now | Δ |
|---|---|---|---|
| guide label | 9.5 / 14.25 | **10 / 15** | **+0.5 — stated** |
| avatar monogram | 10 / 15 | 10 / 11 | size 0; line-height from the DS `Button`'s 1.1 (control swap, not type) |
| control-group label | 11 / 16.5 w600 | 11 / 16.5 w600 | **0** |
| scale readout | 11.5 / 17.25 | 11.5 / 17.25 | **0** |
| back link | 12 / 18 | 12 / 18 | **0** |
| lab paragraph 2 | 12.5 / 18.75 | 12.5 / 18.75 | **0** |
| lab paragraph 1 | 13 / 19.5 | 13 / 19.5 | **0** |
| rail nav label | 14 / 21 w600 | 14 / 21 w600 | **0** |
| brand monogram | 15 / 22.5 w800 | 15 / 22.5 w800 | **0** |
| sidebar wordmark | 18 / 27 w700 | 18 / 27 w700 | **0** |
| mock page title | 20 / 28 w650 | **18 / 27** w650 | **−2 — role call, below** |
| lab page title | 22 / 33 w650 | 22 / 33 w650 | **0** |

**Ten of twelve type roles are pixel-identical to the original.** Line-heights come back too: the
DS publishes no line-height tokens (and FX.1's module sets none), so they return to the page's own
defaults — which is what the original had, and what the Tailwind pass had overwritten.

**The two that moved, both deliberate:**
- **9.5 → 10** (`micro`), the guide labels. 9.5 sat exactly between `nano` 9 and `micro` 10; the hub
  ruled `micro`, and up is right for 9.5px text carrying a number the Owner reads.
- **20 → 18** (`lg`), the mock's page title — **not** `xl` 22. 20 sat exactly between them, so role
  decides: this stage exists to show the **vertical budget**, and a title that grows eats the thing
  being measured. 18px is a real page-title size in this app (the dashboard's h1 measures 18; the
  studio's own measures 15). `xl` 22 would inflate the header on the one page whose spare height is
  the subject.

**Two weight regressions from the Tailwind pass, also fixed:** `font-label` is 550, but the rail's
nav label and the control-group label were both authored at **600**. Restored.

> A divergence the hub should reconcile: FX.1 keeps its off-scale sizes as **literals**, expressly
> so they stay visible rather than being "quietly snapped to a neighbour", while #623 directed this
> file to snap its two. Both are defensible; they should not both be the rule in one lab.

### 8.2 What did **not** move — the part the Owner is judging

| invariant | A/light/66 | A/dark/344 | B/light/66 | B/dark/66 |
|---|---|---|---|---|
| top bar | 0 | 0 | **56** | **56** |
| rail width | 66 | 344 | 66 | 66 |
| rail height | 904 | 904 | 848 | 848 |
| sheet at max scroll | 336/336 | 336/336 | 392/392 | 392/392 |
| guides | 66 / 1440 | 66 / 1440 | 66 / 1440 | 66 / 1440 |
| sheet gutter | 0px | 0px | 0px | 0px |

**Every A-vs-B number in §6 is unchanged**, because they come from explicit constants
(`M.topbarH` 56, `M.railW` 66, `M.railExpanded` 344, `gutterFor()` 0/24), not from type. The
conformance could not move the comparison, and measurement confirms it did not — **re-measured
after the DS-token redo and identical again**. The sheet's max scroll moved 336→341 (A) and
392→397 (B) between the two passes: that is page-content height following the restored
line-heights, not chrome, and the sheet is still at max scroll in every state.

### 8.4 The grid-kit ratchet — complied by leaving the grid family (PES.0 #632)

`check-grid-kit-ratchet` went red at `DS DataGrid 71 → 72`. It counts **retiring** kits (GDS §8.7,
the rebuild backlog) and fails on any rise. So the `<table>` → `DataGrid` swap the raw-primitives
ratchet asked for moved between two backlog items rather than off the backlog. **Two ratchets, and
between them every available answer was forbidden.**

> One correction to the hub's framing: the `DataGrid` was **not** the mock's sheet stage. The sheet
> stage is plain `div`s at an explicit `height: 34` and has never been on any grid kit — it is a
> *picture* of a sheet, not a sheet. The `DataGrid` was only the two small ledgers **below** the
> stage, which report numbers.

Measured, before refusing the ratchet's preferred primitive:

| option | what it costs | verdict |
|---|---|---|
| raw table element | raw-primitives ratchet | forbidden |
| DS `DataGrid` | grid-kit ratchet — retiring kit | forbidden |
| `NexusGrid` | `ag-grid-react` + `ag-grid-community`, a **7,090-line** subsystem, its own stylesheet, and `registerGridModules()` at module scope registering **38 AG modules** as an import side effect | wrong instrument |
| **the payload** | **10 rows × 4 columns = 40 cells, all literal strings**, no sort/filter/selection/editing/virtualisation | — |

**Resolution: the ledgers stop being a table.** They are now the DS `KeyValue` — a real `<dl>`,
label → value, with `hint` carrying the per-row note. Every number stays on the page; the full
4-column matrix lives in §6.2–6.3, which is where a finding stays visible anyway. All four ratchets
green, and the ten type classes still resolve.

**Filed, not worked around:** `.claude/DS-GAPS.md` now carries *"the DS has no lightweight STATIC
table"* — `DataGrid` is retiring, `NexusGrid` is an engine, `KeyValue` is two columns, so a genuine
4-column static comparison has nowhere to land. The transpose works for *these two* ledgers because
they read fine as label/value; it is a workaround, not a fix.

### 8.5 🔴 A correction to §6.1: a patch I reported as landed had not

§6.1 states the second ledger's footnote was reworded to the #529 ruling. **It was not.** The edit
used a string replace with no assertion, the anchor did not match, and the file kept the superseded
text — *"the studio is the exception worth arguing… 48px of sheet width… or the grid needs a dense
variant"* — the exact framing #529 overturned. I then **reported it to the hub as done**.

It survived a full guard sweep, a type redo and four screenshots, and was caught only by reading
the rendered footnote in a screenshot taken for another purpose. This is
`reference_a_mutation_that_does_not_mutate` verbatim: *assert the replacement landed*. Now applied
under an assertion, and verified in the DOM (`oldFramingStillOnPage: false`, `#529` cited).

### 8.3 One regression the guards could not catch

Swapping in `ToolbarButton` dropped the `{expanded && …}` guards on the sidebar's theme and bell, so
three controls tried to fit the 66px collapsed rail and the foot spilled. **Both ratchets stayed
green across it**; a screenshot caught it. Restored, and confirmed by measurement: in A/collapsed the
toolbar buttons are absent and the profile is 46 × 36, inside the 66px rail.

Also banked, from PES.6 via the hub: a DS `Button` is `inline-flex`, so `text-overflow: ellipsis`
on the button itself does nothing — long labels clip. `ProfileButton` already truncates on an inner
`<span>`, so it is correct **by construction rather than by test**: the mock has no long label there.

---

## 9. Status

- 4.1 measurements: **complete**, ratified (PES.0 #517).
- 4.2 mocks: **complete and verified in the browser** — both options × {1440, 1728} × {light, dark},
  studio at max scroll, list, narrow page.
- **No product file touched.** `apps/web/src/app/design/chrome/page.tsx` is the only file created.
  `scripts/check-help-cursor.mjs`: **0 occurrences (baseline 0)**.
- Not run, deliberately: repo-wide `tsc`/`vitest` — the box was saturated by six concurrent
  repo-wide `tsc --noEmit` runs from other lanes (PES.0 #520/#532); CH.1 holds tsc slot D.
- 4.3: **written as the hub's recommendation** (A + the separation task), to the Owner as item 34.
- Next: the Owner picks; CH.1 builds the winner on a separate ruling.
