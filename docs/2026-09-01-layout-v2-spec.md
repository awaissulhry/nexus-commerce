# Product Edit Studio — LAYOUT v2 SPECIFICATION

**Lane:** UX.1 · layout v2 & interaction (`nexus-commerce-b7`)
**Status:** 🟢 **APPROVED by the Owner 2026-09-01 (hub ruling #182).** All three §12 questions
answered as recommended, and the four post-audit amendments accepted as spec. BINDING on PES.1
(frame), PES.2 (sheet), PES.3 (channel sheet), PES.4 (drawer), AG.1 and DS.1 — see §11.
**Supersedes:** nothing. Implements hub ruling **#169** (§1b of
`docs/2026-09-01-product-edit-studio-layout.md`) and consumes ruling **#173** (the default-view
rule) and **#172** (PES.1's three measured constraints).
**Everything below marked ⟦measured⟧ was read off the running studio on 2026-09-01, GALE-JACKET
(`cmokmy3a40078pm0p1fvnu523`), local web :3000 against the local API :8091.**

---

## 0. How to read this document

Every geometry claim carries either ⟦measured⟧ (read from the live DOM) or ⟦derived⟧ (computed
from a measured model, with the model stated). Nothing here is an estimate.

**Measurement environment, stated because it bounds three claims:**
- Screen is 1728×1117, `availHeight` 994. Browser chrome costs 177px, so the largest inner
  viewport reachable on this machine is **1728×906** and **1440×817**. A true 1440×**900** could
  not be produced. Every 1440×900 number below is ⟦derived⟧ from the measured model
  `rows = innerHeight − chromeAbove − footer − gutter`, which was verified at three separate
  heights (906 → 545, 817 → 456, 723 → 362 grid viewport; the model predicts all three exactly).
- `/api/auth/me` returns **401** against the local API, so every permission-gated control renders
  disabled. Where a control's disabled state is load-bearing for a layout claim I say so; I do
  not treat a locally-greyed button as a design decision.

---

## 1. THE BASELINE — what is on screen today, band by band

### 1.1 Master scope, 1728×906, drawer closed ⟦measured⟧

```
 y     h    band                                                        selector
──────────────────────────────────────────────────────────────────────────────────────────
   0   56   AppTopBar (global search, theme, notifications)             header.nds-topbar
  56   48   Product header (‹Products · title · SKU · ASIN · status ·   .nds-detailhdr.dense
             Parent · Autosave on · ⋯ · Publish ▾)
 104   44   Scope bar (Scope · 6 channel chips · market ▾ · locale ▾)   .nds-scopebar
 148   34   Tab strip (Sheet · Images · Analytics & Ads · Activity)     .tabStrip
 182   49   Family bar (Parent · 20 variations · Colore × Taglia ·      .nds-grid-footstrip
             4 disabled verbs)
 232   65   Sheet toolbar (21 rows · Find… · Overview ▾ ·               .nds-toolbar
             ⚠ Missing required (42) · Customise · Reload)
 297   87   AG header — column-group strip 30 + header row 28 +         .ag-header
             floating-filter row 29
 384  458   ROWS  (16.4 rows at rowHeight 28)                           .ag-row × 21
 842   40   Footer strips (rows · unsaved · refused · saved-at · hints)
 882   24   GridSheet gutter
──────────────────────────────────────────────────────────────────────────────────────────
 906        total
```

**The number that matters: rows occupy 458 of 906px = 50.6%.**

> **Correction, on the record.** My own first message to the hub said "chrome above the sheet is
> 297px, not 126 — sheet = 60.2%", and it propagated to two lanes before I had loaded data. 297px
> is right; **60.2% is not the honest figure.** It counts the AG header (87px of column-group
> strip, header row and floating filters) as sheet. What an operator sees as *the sheet* — rows
> of data — is **50.6%**. I also reported "8 default columns totalling 1149 of 1660px, 511px of
> unused width"; that was read off the **loading skeleton**, and the loaded sheet has no unused
> width at all (§1.3). Both errors are the same error: measuring while the page was still
> assembling. The corrected numbers are what §1 and §2 use.

### 1.2 The vertical model, verified at three heights ⟦measured⟧

| innerHeight | grid viewport | rows area (viewport − 87) | rows visible @28px |
|---|---|---|---|
| 906 | 545 | 458 | 16.4 |
| 817 | 456 | 369 | 13.2 |
| 723 | 362 | 275 |  9.8 |

`gridViewport = innerHeight − 297 − 40 − 24`. Exact at all three. This is the model every
⟦derived⟧ number below uses.

### 1.3 Horizontal — "barely a few columns", quantified ⟦measured⟧

The master `Overview` view is **2749px of columns**. The pinned-left block (select 43 + tree 76 +
SKU 180 + Master % 90) is **389px**.

| viewport | sheet width | columns FULLY visible | of which carry product data | required-for-OUTERWEAR visible |
|---|---|---|---|---|
| 1728, drawer closed | 1660 | 10 | 6 | **3 of 7** |
| 1440, drawer closed | 1372 | 9 | 5 | **2 of 7** |
| 1280, drawer closed | 1212 | 8 | 4 | **1 of 7** |
| 1728, **drawer docked (519px)** | 1140 | 7 | 4 | **1 of 7** |

**This is the Owner's complaint, exactly.** With the drawer open at 1728 the sheet shows SKU,
Master %, Markenname, Name, Product Type — and clips Status. Four data columns.

And the sharper half: the seven fields Amazon requires for OUTERWEAR are
`brand · item_name · bullet_point · product_description · supplier_declared_dg_hz_regulation ·
fabric_type · country_of_origin`. **Six of the seven are off-screen at every laptop width.** The
columns you can see are the ones already filled; the columns that are the actual work are the ones
you have to scroll to find. 1089px of horizontal scroll at 1728, 1537px at 1280 ⟦measured⟧.

### 1.4 Channel scope (eBay · IT), 1440×817 ⟦measured⟧

```
 y     h    band
   0   56   AppTopBar
  56   48   Product header
 104   44   Scope bar
 148   34   Tab strip (now FIVE tabs — Errors & Sync appears; span 450px)
 214  102   Channel toolbar  ← 102px for FOUR controls on three rows
             row 1 (30px):  ······················· [Warnings (42)] [1 listing · 20 SKUs …]
             row 2 (28px):  [Preflight ★ (20)] ·······························
             row 3 (28px):  ······························· [+ Add listing alias]
 324   29   AG header (one row; no group strip, no floating filters)
 353  424   ROWS (51.9%)
 776   40   Footer
```

- **The channel toolbar spends 102px on four controls whose combined width is 534px in a 1372px
  bar.** Row 1 has 1077px of horizontal emptiness between its left edge and the Warnings pill.
  One 40px row holds all four with room to spare. **62px recoverable, nothing moves off screen.**
- **The channel default view is 15664px of columns** ⟦measured⟧ — 11.4 screens at 1372px, 14292px
  of horizontal scroll. Ruling #173's default-view rule has been applied to the master scope and
  **not** to the channel scopes. Seven columns are fully visible; four carry data.

### 1.5 The strip the Owner named ⟦measured⟧

`button.nds-pill.warning` — **"Warnings (42)"**, x 1144, y 214, 126×30, top-right of the channel
toolbar. On the master scope the same slot holds `⚠ Missing required (42)` (172×28, x 1370) and
`⚠ caps`.

Contrast is fine (8.05:1, `rgb(109,63,16)` on `rgb(253,243,211)` — computed, not eyeballed). The
problem is not the styling. **The problem is that it is a filter dressed as an alarm.** Clicking
it narrows the sheet; it is a view control. It carries a ⚠ glyph, warning tint and a persistent
count, parked in the corner of the screen the eye goes to first when it scans column headers. It
looks urgent, it is never urgent, and it never goes away. That is exactly the thing that becomes
invisible — and it is sitting in the slot a real warning would need.

---

## 2. LAYOUT v2 — the band budget

### 2.1 What each band becomes

| band | today | v2 | how |
|---|---|---|---|
| AppTopBar | 56 | **0** | 🟢 **DROPPED on the studio route** (ruling #182, §2.3). The studio has its own back link and header; ⌘K and the notification bell are reachable one step back. **PES.1 owns the route matcher** |
| Product header | 48 | 48 → **32** on scroll | collapses; §4. 🟢 **D9 (#214): the right side is `autosave state` + `Publish ▾` and NOTHING else.** The `⋯` overflow that held nine link-outs is removed entirely — Owner: *"the grid is the flat file"*, and *"Everything has to be super simple and easy to use and extremely functional and efficient."* Supersedes D5. Parity re-derived in §2.1b |
| Scope bar | 44 | ┐ | |
| Tab strip | 34 | ┘ **40** merged | §3 |
| Family bar | 49 | **0** | descriptor → the toolbar's count slot; **the four family verbs → the toolbar's right-hand group (or one `⋯` beside Customise), NOT the selection bar** — see §2.1c |
| Sheet toolbar | 65 | **40** 🟢 **landed at 41 = 40 + a 1px bottom border** (border-box, padding 6/6) — the border is a wanted divider, so the probe carries ±1 rather than a lane chasing a pixel | 65px hosting a 34px input and 28px buttons is 31px of padding; a 40px bar holds a 28px control on `--nds-space-1`. **40px is written as px on purpose — see the note below the table** |
| AG header | 87 | **57** (28 header + 29 AG floating-filter; the spec's original 56 was a 1px estimate of AG's own filter row — corrected on measurement, and no lane controls that pixel) | drop the column-group strip (30px = `--nds-grid-strip-h`; the 28px header row is `compact.header` — so two of the three numbers in the measured 87 come straight from the tokens, and only AG's 29px floating-filter row is measured ⟦DS.1 corroboration⟧) — a curated ~12-column view does not need "Identity / Attributes" spanning it. Keep the floating-filter row: it is the sort/filter affordance AG.1 owns. **AG.1 CONFIRMED (see §2.1a) — the budget is settled at 56** |
| Footer | 40 | **36** | one row, `--nds-space-1`. ⏳ **still 40 — 4 of the last 20px** |
| Gutter | 24 | **8** | a full-bleed sheet has no bottom gutter to give. ⏳ **still 24 — 16 of the last 20px, the single largest remaining item** |

**§2.1a — AG.1 confirmed the strip's removal, and gave two reasons better than mine** ⟦AG.1,
measured on GALE-JACKET master⟧. My reason was "a curated 12-column view does not need it". Theirs:
1. **The strip renders its header twice the moment the feature is used.** `columns.tsx` marries
   every attribute column under `col.group` with `marryChildren: true`, and its own comment asserts
   "no group here crosses the pinned boundary" — true at load, false as soon as an operator pins a
   column. AG.1 pinned `productType` left through the header menu and **"IDENTITY" appeared twice**,
   once over the pinned block and once over the centre.
2. **`marryChildren` is why a view's declared column order is discarded today** — see §9.2a. That
   makes the strip not merely 30px of cost but the thing blocking this spec's ordering rule.
Grouping survives where it earns its place: the Customise dialog builds its own grouped list from
`c.group`, and that is the surface where ~100 columns genuinely need headings. The strip was
spending 30px on every screen to repeat, permanently, a structure that matters once, in a modal.

**🔴 §2.1c — CORRECTION: my evidence for folding the family verbs into the selection bar was an
artefact, and PES.2 was right to refuse it.** I wrote *"its four verbs move into the existing
selection bar… measured: all four are disabled at zero selection today, so nothing is lost."*
**They are disabled for a reason that has nothing to do with selection.** All four gate on a
permission, and this machine's browser holds no session for the local API — `/api/auth/me` returns
401, `AuthProvider` sits at `anon`, and every `can()` returns false, so **every permission-gated
control in the app measures disabled here regardless of state** (hub #123: no lane may conclude a
permission defect, *or a permission-shaped absence*, from a local screen). I read a disabled control
as evidence of a design fact — the trap this programme had already banked, and which is in my own
memory.

**The substantive point, which the artefact hid:** `demote` and `add-variation` are
`contextOf('product-family')`, not `SELECTION` — **on a real session they are available at zero
selection**, because they act on the family rather than on ticked rows. Folding them into a bar that
renders nothing until rows are ticked would force an operator to select an arbitrary row to reach a
verb that does not act on it — the scope confusion the registry's three scopes exist to prevent.

**Ruled, taking PES.2's shape:** descriptor → the toolbar's count slot · **family/context verbs →
the toolbar's right-hand group, or one `⋯` beside Customise, reachable at zero selection** ·
**the selection bar keeps only selection verbs** (unlink, reparent, delete). Still 49px, without
putting family verbs behind a selection gate.

**And the honest ledger entry for the disabled-state question is "not measurable locally"** — it
needs a session holding `pim.manage`, which no lane on this machine can produce. PES.2 raised it
rather than measuring it, which is the correct move.

**§2.1b — D9: what the nine link-outs become.** ⟦Ruling #214. Each is re-derived as a **sheet verb**;
statuses are what I could verify, and where I could not, the row says so rather than claiming
cover.⟧

| was (header `⋯`) | becomes | status |
|---|---|---|
| Datasheet | **Export** — the sheet *is* the datasheet; the file comes from export | 🔴 **GAP.** `design-system/grid/export/{exportGrid,gridCsv}.ts` exist and are **not wired into `MasterSheet.tsx`** ⟦measured: no export control in the toolbar⟧ → PES.2 |
| Amazon Flat File | **the Amazon channel scope**, per market | 🟢 the scope exists; column set still uncurated (§9.4) → PES.3 |
| eBay Flat File | **the eBay channel scope**, per market | 🟢 same |
| Recover | **History pane time-travel restore** | ⚠ **verify before claiming.** PES.4 built it; PES.5's `/state` `before`-shape bug meant time-travel reconstructed nothing. → PES.4 confirms fixed, or this row is a gap |
| List on… (11 channel×market) | **add a coordinate + `Publish ▾`** | ⚠ PES.3 is verifying the add-a-coordinate path. **If they report a gap, this row's status is "gap", not "covered"** |
| link-out prefetch (8.6) | — | ⛔ N/A — it warmed caches for tabs that no longer open |
| `markNewTabClick` (8.7) | — | ⛔ N/A — no new tabs to instrument |
| Cross-market automation | **navigation** (the rail) | 🟢 the route is unchanged; it is simply not a header control |
| ⌘K "Open route" (1.26) | — | 🔁 superseded with the destinations |

🔴 **By D9 a link-out to an old surface is a parity DEFECT, not a parity feature.** A row that reads
"the old page did X and we link to it" is not covered — it is the thing being removed. See §11.

**🔴 On the 40px bars, and why this spec writes a number instead of a token.** ⟦DS.1, grepped:⟧ the
DS has **no control-height scale at all** — the only height tokens that exist are
`--nds-grid-strip-h` 30, `--nds-grid-footer-row-h` 48, `--nds-topbar-h` 56 and
`--nds-topbar-slot-h` 36; `components.css` sets no explicit control heights, because buttons and
inputs size from padding plus line-height. That is why nothing on this page lands on a 40px rhythm
today. `var(--nds-toolbar-h)` would resolve to nothing and **silently collapse the bar**
(`var(--nope)` is transparent/empty with no error and no guard). So: **40px stays a literal here.**
🟢 **Ratified (#182): DS.1 mints `--nds-toolbar-h: 40px` and converts both bars in one pass, and
this table then cites it.** The ordering was the point — a token minted to satisfy an unapproved
spec is a token nobody else adopts; a token minted on ratification is the DS's answer to a real
question. Until it lands, 40px stays a literal; **do not write `var(--nds-toolbar-h)` before DS.1
says it exists**, because it would resolve to nothing and silently collapse the bar.

### 2.2 The result ⟦derived from the §1.2 model⟧ — WITH the AppTopBar dropped (#182)

**1728 × 906, master, at rest, drawer closed:**

```
 y     h    band
   0   48   Product header          (collapses to 32 — §4)
  48   40   Scope chips + tabs + market/locale  (ONE row, stays)
  88   40   Sheet toolbar
 128   56   AG header (header 28 + floating filters 28)
 184  678   ROWS  ◄── 74.8% of the viewport (was 50.6%)
 862   36   Footer
 898    8   gutter
 906
```

| | today | v2 at rest | v2 collapsed |
|---|---|---|---|
| rows area @1728×906 | 458 (50.6%) | **678 (74.8%)** | **694 (76.6%)** |
| sheet (toolbar→footer) | 700 (77.3%) | **810 (89.4%)** | **826 (91.2%)** |
| rows area @1440×817 | 369 (45.2%) | **589 (72.1%)** | **605 (74.1%)** |
| rows area @1440×900 ⟦derived⟧ | 452 (50.2%) | **672 (74.7%)** | **688 (76.4%)** |

**+220px of rows at every viewport height** — the saving is vertical-only, so it is
width-independent. On a 21-row family at 36px rows (§8.3) that is **18.8 rows visible at 906**,
against 16.4 today at 28px with no thumbnail: **more rows AND a picture**, which is not the trade
either half of ruling #169 looked like it was asking for.

The sheet reaches **89.4% at rest / 91.2% collapsed** — inside ruling #169's 90–95% band once
collapsed, and one point under it at rest. That is the honest position and it is stated rather than
rounded up.

### 2.3 🟢 DECIDED (#182) — the AppTopBar is dropped on the studio route

Ruling #169 asked for a sheet at ~90–95% of viewport height. **With the global AppTopBar it reaches
83.2% and no further**, and the reason is arithmetic rather than effort:

```
906 total
− 56  AppTopBar          ← the only removable term
− 48  product header     collapses to 32; cannot go to 0 and stay honest about which product
− 40  scope + tabs       ruling #169: this row STAYS
−  8  gutter
= 754  sheet  = 83.2%
```

To reach 815px (90%) everything above the sheet must total ≤ 91px, and the header plus scope row
are 72 before the AppTopBar's 56. So the target was reachable exactly one way, and I put it to the
Owner as a question with its cost named rather than assuming either answer.

**The Owner took it.** Dropping the AppTopBar on this route only: **sheet 810/906 = 89.4% at rest,
826 = 91.2% collapsed; rows 678 = 74.8%.** The cost stands as stated — global ⌘K search and the
notification bell are one navigation away while an operator is in the studio. **PES.1 owns the
route matcher** (`components/layout/AppShell.tsx`, already in their claim).

**The rail stays.** It is 66px of horizontal chrome and no part of this decision; the studio starts
at y = 0 and x = 66.

### 2.4 Channel scope v2 ⟦derived⟧

The 102px three-row channel toolbar becomes one 40px row:

```
[Preflight ★ (20)]  [+ Add listing alias]      1 listing · 20 SKUs on eBay · IT
```

(the Warnings pill leaves this bar entirely — §6). ⟦derived, AppTopBar dropped⟧ Rows at 1440×817:
**616 (75.4%)**, up from 424 (51.9%). The channel scope gains more than master because it pays the
102px toolbar today: **+192px**.

---

## 3. THE MERGED CHIPS + TABS ROW

### 3.1 The measured widths ⟦measured at 1440⟧

| piece | width |
|---|---|
| "Scope" label + gap | 50 |
| 6 channel chips (Master 99 · Amazon 107 · eBay 87 · Shopify 71 · WooCommerce 117 · Etsy 50 + gaps) | **561** |
| tabs — 4 on master (Sheet 60 · Images 70 · Analytics & Ads 123 · Activity 72) | **337** |
| tabs — 5 on a channel (+ Errors & Sync 109) | **450** |
| market ▾ + locale ▾ | **192** |
| 2 group gaps | 32 |
| **total, channel scope (the worst case)** | **1285** |

Container width = viewport − 66 (rail) − 2×16 (page padding) → **1662 @1728 · 1374 @1440 ·
1214 @1280.**

### 3.2 The verdict, and it differs from PES.1's ⟦measured⟧

PES.1's constraint (#172) says one compact row needs ~1520–1550px of container ≈ 1620px+ viewport
and **overflows at 1440**. Measured against the real components, **it does not**: 1285 ≤ 1374, with
89px to spare. PES.1's figure came from a faithful DS mock of **9 channel×market chips**; the
studio's actual scope bar carries **6 channel chips plus a separate market switcher**. The
constraint is real for the thing PES.1 mocked and does not bind the thing that exists.

**It does bind at 1280: 1285 > 1214, overflowing by 71px.**

### 3.3 🟢 DECIDED (#182): chips stay CHANNEL-ONLY. Channel×market chips are refused

If chips became channel×market ("Amazon · IT 71%", ~137px each), nine of them need
1281 + label 50 + tabs 450 + locale 104 + gaps 32 = **~1917px of row ≈ a 1983px viewport.** No
laptop, no desktop we have, and not 1728 either. And nine is not the real number: 6 channels × 4
markets ⟦measured: `availableMarkets: ['DE','ES','FR','IT']`⟧ = **24 chips**, not 9.

A dimension with four values is a switcher, not a chip row. The market switcher stays. This
contradicts nothing the Owner decided — they asked for chips and tabs on one row, and the chips
are already channel-only.

### 3.4 The three tiers — what happens at each breakpoint

Chosen on the **container's** measured width (the rail is 66px and the slide-over does not change
it — §5 — so container is a pure function of viewport):

**Tier A — container ≥ 1300px (viewport ≥ 1400):** one row, everything with its label.
```
│ Scope [Master 71%][Amazon 71%][eBay —][Shopify][WooCommerce][Etsy]   Sheet  Images  Analytics & Ads  Activity   [IT · Italy ▾][Italian (it) ▾] │
└─ 40px ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Tier B — container 1000–1299px (viewport 1066–1399):** one row; **non-active tabs become
icon-only**, the active tab keeps its text.
```
│ Scope [Master 71%][Amazon 71%][eBay —][Shopify][Woo][Etsy]    ▦ Sheet  ▣  ◔  ↻  ⚠    [IT ▾][it ▾] │
```
Icon-only tabs: 4 × 40 + gaps 24 = 184; active tab with text ≈ 90. Row = 50 + 561 + 274 + 192 + 32
= **1109 ≤ 1214 at 1280** ✓ ⟦derived from measured part widths⟧. Every icon tab carries
`aria-label` and a DS tooltip; the active one is never reduced to an icon, so the operator can
always read where they are without hovering.

**Tier C — container < 1000px:** two rows again (chips+switchers, then tabs). Below 1000 there is
no single row that is both complete and legible, and pretending otherwise is how the current
layout got its 102px toolbars.

### 3.5 Chip overflow — the mechanism exists, the affordance does not ⟦measured⟧

`.nds-scopebar-chips` is already `overflow-x: auto; flex-wrap: nowrap`. It has never overflowed
(561 of 1036 available at 1440), so nobody has seen it scroll. Required in v2:
- a 24px edge fade on whichever side has hidden content — never a scrollbar in a 40px row;
- **on mount and on scope change, the ACTIVE chip is scrolled into view.** A scope you cannot see
  is a scope you will not switch back to;
- chips are `<button>`s, so Tab already reaches them and the browser already scrolls them into
  view — do not intercept it;
- **the chips box scrolls; the document never does.** See §7.

---

### 3.5a 🔴 CHROME STATE CHANGES ON SCROLL, NEVER ON NAVIGATION ⟦SR.1, measured⟧

Switching scope moves the scope chips **16px under the cursor**: the sheet reloads at `scrollTop 0`,
the header un-collapses, and the chip centre moves from y≈51 to y≈67. **A second click aimed where
the first one landed hits below the chip.** It broke SR.1's first task-10 run, and it will break an
operator's — switching between two scopes is a two-click gesture and the target moves between the
clicks.

> **RULED: collapse state survives a scope, market or tab switch, and arming is re-evaluated on the
> next SCROLL — never on load.** Chrome may change shape because the operator scrolled. It may not
> change shape because they navigated.

**Why not "re-arm on load and expand if the new sheet is too short":** that is the behaviour causing
the bug, and it fails exactly when it is most disruptive — mid-gesture. If the new sheet genuinely
cannot sustain collapse, the row moves on the operator's next scroll, when they are not aiming at a
chip. **A control used to navigate must not move as a side effect of arriving somewhere.**

This may also vanish once PES.1 stops the sheet remounting (§9.5) — but the rule stands regardless,
because the remount is not the only thing that can re-run arming.

### 9.5 🔴 WHAT AN OPERATOR SETS SURVIVES SCOPE, MARKET AND TAB ⟦SR.1, task 10⟧

**Nothing survives a scope round trip today** — sort, selection and scroll all reset, because a
scope switch is a URL change and the RSC round-trip remounts the sheet.

> **RULED: within a session, what the operator set persists across scope, market and tab —
> sort, column state, scroll position, and selection.** PES.1 owns the remount; PES.2 owns the
> preserved state once it stops.

**One honest exception, and it needs a statement rather than silence:** a selection cannot always
carry, because the rows differ between scopes — a channel scope has alias rows a master scope does
not. **Carry a selection by identity where the identity exists in the new scope; where rows cannot
carry, the footer says how many were dropped.** A selection that silently shrinks between scopes is
the dismissable-into-silence family (§6.2 rule 4) wearing a navigation costume: the operator acts on
a set they believe they still have.

### 3.6 🔴 READINESS IS SLOW, SO THE SHEET NEVER WAITS FOR IT — and today's timeout manufactures a false failure

⟦BE.1, measured: cold readiness on GALE-JACKET · IT is **62.8s**, then **1.49s** warm.⟧

**🔴 First, a defect that falls straight out of that number.** `contracts.tsx:343` aborts readiness
at **15 seconds** and `:369` then renders *"Readiness did not answer within 15s."*
**15s < 62.8s, so on any cold process readiness is aborted every time and the UI reports a failure
that is not one.** The message is honest about what the client did and wrong about what happened:
readiness was not unavailable, it was still being read. An operator is told the system is broken at
the exact moment it is working slowly. Whatever PES.5's dedupe saves, **a cold process still pays
the schema reads**, so this is not a wait-for-the-fix.

> **RULE 1 — a deadline is not a failure boundary.** Distinguish *slow* from *failed*. A short
> deadline may change what is DISPLAYED; it may not convert a pending read into a reported failure,
> and it may not abort a request that would still be useful. Failure is an error, or a ceiling set
> **above the measured cold worst case** — cited, and re-measured when the path changes. **Do not
> pick the ceiling from taste: 15s was a plausible-looking number chosen before anyone measured
> 62.8.** → PES.1 / PES.5 set it from data.

**RULE 2 — the sheet never waits on readiness.** The sheet and the chip row load independently.
Scope-chip *identity* comes from the Marketplace table (PES.3, #235), so the row renders complete
and immediately with readiness still pending.

**RULE 3 — the readiness slot is THREE states, and the third is the one that gets forgotten:**

| state | shows | never |
|---|---|---|
| **measuring** | a skeleton on the value slot, `aria-busy`, accessible name "measuring" | a number, and **never `—`** |
| **known** | the value (`71%`) or the readiness state | — |
| **unavailable** | a stated reason, in the footer (§6.2 rule 6) | a silent blank, or a pulse that never ends |

> **🔴 `—` IS ALREADY TAKEN.** ⟦measured⟧ the absent/unlisted state renders as `eBay —` — *"not set
> up on this channel"*. **A measuring dash is indistinguishable from a real state**, and it fails in
> the expensive direction: it tells an operator a channel is not set up when the truth is that we
> have not finished asking. Same family as §6.4's `?? 'DRAFT'` — claiming a state is as wrong as
> claiming confusion.
>
> And **never a plausible zero**: `0%` while measuring reads as "nothing is ready", which is a
> statement about the product rather than about the request. **Never an empty row**: an empty chip
> bar reads as "this product has no channels".

**RULE 4 — after a threshold, say so in visible text, in the footer.** A skeleton pulsing for a
minute is its own defect: the operator concludes it is broken. Past a few seconds the footer carries
*"Readiness still measuring…"* — visible, not hover, in the strip §6.5 already reserves for exactly
this. **Never as a band above the grid** (§6.2 rule 6, and the ledger's retired `.scopeNote` row is
the worked example of why).

**Owners:** PES.1 the bar and the three-state slot · PES.3 the readiness consumer · PES.1/PES.5 the
deadline, from a measurement.

## 4. THE COLLAPSING HEADER

> **🔴 READ THIS BEFORE ANY READING OF THIS FEATURE: THE REFERENCE FIXTURE IS THE MARGINAL CASE.**
>
> Collapse arms only when the grid has enough scroll range to sustain it, and at a 906px viewport
> with 36px rows that boundary is **`n ≥ 20.2` rows**. **GALE-JACKET has 21.** A 20-row family does
> not collapse; a 21-row family does, by one row.
>
> Everything about this feature has been read differently by three lanes in one night — armed, not
> armed, verified, disarmed — **and nobody was wrong.** They were reading a fixture sitting on the
> boundary, on builds whose vertical budget was moving underneath them. Before reporting collapse
> behaviour, state the viewport height, the row count and the row height; a bare "it works" or "it
> doesn't" about this feature carries no information.
>
> ⟦DS.1's editorial call, adopted: this belongs at the top of §4, not in a footnote.⟧

### 4.1 What collapses

On grid scroll, the **product header only**: 48px → **32px**. It keeps, in one line: back link,
product name (truncated), status dot, autosave state, `Publish ▾`. It drops: the SKU/ASIN
monospace pair, the `Parent` pill, the `⋯` menu (which moves into `Publish ▾`'s menu while
collapsed).

The merged chips+tabs row **does not collapse** — ruling #169: it "stays".

### 4.2 🔴 The oscillation rule, stated as an invariant

Let, all measured with chrome **EXPANDED**:
- `S` = grid content height = `rows × rowHeight + agHeaderHeight`
- `H` = grid viewport height
- `R = max(0, S − H)` = scroll range
- `C` = height freed by collapsing = **16px**
- `T` = collapse threshold = **32px** (one row)
- `h` = hysteresis = **16px** (expand at `scrollTop ≤ 16`)

> **Collapse is ARMED if and only if `R − C ≥ T`, where `R` is measured against EXPANDED
> geometry. When it is not armed, the header does not collapse at all.**

The failure PES.1 predicted is real and this is what prevents it: collapsing frees `C`, which
*shrinks* the remaining range to `R − C`; if that is below the threshold the grid can no longer
hold the scroll position that caused the collapse, so it expands, so the range returns, so it
collapses. Hysteresis alone cannot fix it because the range itself moves. **The arming test must
never be recomputed from collapsed geometry** — that is the loop, in one sentence.

Re-evaluate the arming test on: row-count change (filter, view chip, search), viewport resize,
view change, drawer open/close. Evaluate it against expanded geometry every time, even while
collapsed.

### 4.3 The numbers for this product ⟦measured + derived⟧

`C` = 16 (header 48→32), `T` = 32, `h` = 16. `S = rows × rowHeight + 56` (the v2 AG header).
With §8.3's ratified 36px rows, `S = 21 × 36 + 56 = 812`.

| state | S | H (grid viewport) | R | armed? (`R − 16 ≥ 32`) | R after collapse |
|---|---|---|---|---|---|
| today, 906, 28px rows, 87px AG header | 675 | 545 | 130 | — | — |
| **v2, 906, 36px rows** | 812 | 678 | 134 | **yes** | 118 |
| **v2, 906, 36px rows, drawer open** | 812 | 678 | 134 | **yes** | 118 |
| **v2, 817, 36px rows** | 812 | 589 | 223 | **yes** | 207 |
| v2, 906, 28px rows (not chosen) | 644 | 678 | 0 | **no** — cannot scroll at all | — |
| a 12-row family, 906, 36px rows | 488 | 678 | 0 | **no** | — |

Two things this table says that are worth reading rather than skimming:

- **The ratified 36px row is what makes collapse work at all.** At 28px the v2 budget leaves
  `R = 0` — the sheet cannot scroll, so the trigger can never fire and the header would never
  collapse. The taller row that pays for the thumbnail is also what restores the scroll range. The
  two Owner decisions in #182 are not independent; each rescues the other.
- **A short family correctly never collapses.** A 12-row family has nothing to scroll, so there is
  nothing to gain and the chrome stays put. That is the arming rule, not a defect, and nobody
  should "fix" it.

### 4.3a 🔴 THE BUDGET CONSUMES ITS OWN TRIGGER — §2.3's win disarmed §4's feature

**Correction, on the record.** An earlier draft of this section explained a `R=92` vs `R=36`
disagreement between PES.1 and me as a real-Chrome-window vs Playwright-viewport effect. **That
explanation was wrong** — it was offered in relay and I built a section on it without checking it.
PES.1 measured in the same window at the same `innerHeight: 906`. The truth is arithmetic and much
more interesting: **`583 + 56 = 639`. The 56px is the AppTopBar, which PES.1 removed between their
reading and mine.** Same window, same viewport, different build.

> **The rule that replaces the bad explanation: when two readings of "the same thing" disagree,
> establish they share a BUILD before reaching for an instrument difference.** An instrument story
> is seductive because it makes both parties right and nobody wrong — and it costs the finding. Here
> the difference was a 56px band one lane had just deleted, which is a fact about the product; the
> window/viewport story would have filed it as a fact about the tooling and closed it.

Note also what the honest version buys and the story did not: the geometry carries the conclusion on
its own. **My derivation below uses only my own two readings** (906 → H 639, 900 → H 633), so it
never depended on the disputed comparison at all.

So the two readings are not a contradiction and never were a measurement artefact. They are a
before-and-after:

| build | H | R | armed? (`R − 16 ≥ 32`) |
|---|---|---|---|
| before §2.3 (AppTopBar present) | 583 | **92** | **yes** |
| after §2.3 (AppTopBar removed, +56 to the grid) | 639 | **36** | **no** |

> **🔴 The principle, and it belongs beside the arming rule rather than in a density footnote:
> every vertical pixel this spec wins is handed to the grid, which SHRINKS `R` — and the collapsing
> header is the one feature that requires `R` to exist. §2.3 and §4 partially cancel.**

A pure win, approved by the Owner, silently disarmed a feature approved in the same ruling. Nobody
did anything wrong and nothing in either lane's code is at fault; the budget and the trigger are
drawn from the same 906 pixels.

**What follows for anyone who wins height later.** On the current build `H = innerHeight − 267`
⟦my own two readings agree: 906 → 639, 900 → 633⟧, and arming needs `R ≥ 48`, so at 28px rows
collapse arms only while `innerHeight ≤ 894` — it is disarmed at every viewport taller than that.
**At the ratified 36px row it is armed to `H ≤ 764` — which at 906 leaves 30px of headroom, not the 86 an earlier draft claimed; see §4.3b for the correction and the arithmetic.**

### 4.3b 🔴 THE VERTICAL LEDGER — I own the arming budget (ruling #204)

**🔴 CORRECTION FIRST, because the number is already binding four lanes. I told the hub the budget
had 86px of slack at 906. It has 30px.** The error was units, and it is the exact one §1's own
correction warns about: I compared an arming bound expressed in **grid-viewport** pixels
(`H ≤ 764`) against the **rows area** (678) instead of against the grid viewport (734). `764 − 678 =
86`; `764 − 734 = 30`. Any lane that spent 86px on that assurance would have disarmed the feature
and seen nothing in its own diff. Withdrawn and replaced everywhere below.

**The arithmetic, stated once so it can be checked.** Both terms include the AG header ⟦verified:
measured `scrollHeight` 675 = 21 rows × 28 + header 87⟧:

```
H (grid viewport) = viewportHeight − 128 (header 48 + scope/tabs 40 + toolbar 40) − 44 (footer 36 + gutter 8)
S (content)       = rowCount × rowHeight + 56 (AG header)
R                 = S − H          armed iff R ≥ C + T = 48
```

**Full v2 budget · 36px rows · the 21-row GALE-JACKET family:**

| viewport height | H | rows area | R | armed? | slack |
|---|---|---|---|---|---|
| 817 | 645 | 589 | 167 | yes | 119 |
| **906** | **734** | **678** | **78** | **yes** | **30** |
| 936 | 764 | 708 | 48 | yes | **0 — the boundary** |
| **962** | **790** | **734** | **22** | **NO** | −26 |
| 1000 | 828 | 772 | −16 | NO | −64 |

**Two things this table says that nobody has said yet:**
- 🔴 **At 962 the full v2 budget does NOT arm, even at 36px rows.** 962 is the viewport PES.1
  baselined the whole programme on. The row height fixes 906; it does not fix 962.
- 🔴 **A 21-row family is one row above the boundary at 906.** Armed iff `n ≥ (H − 8) / 36`, which
  at 906 is `n ≥ 20.2`. **A 20-row family does not collapse; a 21-row family does.** GALE-JACKET is
  the marginal case, which is precisely why it kept producing contradictory readings.

### The ledger — declare pixels BEFORE landing them

Every lane changing a band's height declares the pixels here first, the way a file edit is disclosed
before editing; I answer with the R that remains. **A vertical change not on this ledger is
undisclosed drift.**

| band | Δ | direction | lane | status | R at 906 after |
|---|---|---|---|---|---|
| *(baseline: full v2 budget, 36px rows, 21 rows)* | — | — | — | — | **82 measured (34 slack)** — the ideal-arithmetic 78/30 is withdrawn |
| AppTopBar 56 → 0 | +56 to grid | spend | PES.1 | 🟢 landed | counted in baseline |
| scope+tabs 84 → 40 | +44 | spend | PES.1 | 🟢 landed | counted in baseline |
| sheet toolbar 65 → 40 | +25 | spend | PES.2 | ⏳ planned | counted in baseline |
| family bar 49 → 0 | +49 | spend | PES.2 | ⏳ planned | counted in baseline |
| AG header 87 → 56 | +31 | spend | AG.1 | ⏳ planned | counted in baseline |
| gutter 24 → 8 | +16 | spend | PES.2 | ⏳ planned | counted in baseline |
| row 28 → 36 (`rowMediaLine`) | **returns 168px of R** | return | DS.1 + PES.2 | 🟢 **LANDED, measured** | the reason there is any slack at all |

**Landing report + reconciliation (PES.2, measured).** `rows="media-line"` is on the master sheet.
Both §8.3 assertions now pass, and the clip is gone **measured rather than inferred** —
`cutTop −1 / cutBottom −2`, so a 32px thumbnail sits clear inside a 36px row with 1px above and 2px
below; it was 3px over the top and 4px under the bottom.

PES.2 measured **`R = 204` at 906** and flagged it against my predicted 78 rather than picking a
side — correctly, and it reconciles **exactly**. The two numbers describe different builds, which is
the trap this document already carries once (§4.3a): **theirs is now, mine is the end state.**

| step | H | S | R |
|---|---|---|---|
| current build (PES.2's reading) | 640 | 843 | **203–204** ✓ |
| + sheet toolbar 65 → 40 | 665 | 843 | 178 |
| + family bar 49 → 0 | 714 | 843 | 129 |
| + gutter 24 → 8 | 730 | 843 | 113 |
| + footer 40 → 36 | 734 | 843 | 109 |
| + AG group strip (S, not H) 87 → 56 | 734 | 812 | **78** ✓ |

Note **why `S` moves in the last row and `H` does not**: the AG header lives *inside* the grid
viewport, so removing the group strip shrinks the CONTENT, not the container. It is the one item on
this ledger that reduces `R` by reducing `S` — and PES.2's "my two items spend ~74, leaving ~130" is
right for those two items and stops three rows early. **The ledger's baseline is the end state: 78,
with 30px of slack.**
| DS1-3 sheet gutters | **0** | **neither** | DS.1 | 🟢 **declared 0px, both axes** | **78 (unchanged)** |
| ~~`.scopeNote` refusal strip~~ | ~~31, conditionally~~ | — | PES.1 | 🟢 **RETIRED (#230)** — the band was removed when §6.2 rule 6 landed; no component references it, the frame's bands are exactly `StudioHeader` + `StudioBar`, both unconditional, and the dead CSS is deleted. DS.2's 31px reading was of an earlier build. | **78 (unchanged)** |

**🔴 The rule this row produced OUTLIVES the row, which is why it is still here.** DS.2 measured
`.scopeNote` displacing every band below it — tab strip 148 → 179 — so a readiness failure arriving
after first paint resized the grid under the operator. It cost 31px *while shown*, taking the slack
from 30 to **−1: the collapsing header would disarm the moment a refusal appeared** and re-arm when
it cleared. **PES.1 had already removed the band (#230); DS.2's reading was of an earlier build.**
The rule stands because nothing stops the next lane re-introducing the shape.

> **RULE: nothing that appears in response to an event may change the grid's height.** A conditional
> surface either lives in the footer (§6.2 rule 6, where the honesty statements already are) or
> overlays without reserving height. **No band above the grid may be conditional.** §6's "nothing
> dismissable into silence" is satisfied by the footer home — the count persists there; it just
> stops moving the sheet.

This is the first entry on the ledger that is not a one-time spend, and it is the reason the ledger
tracks events as well as bands.

**First use of this ledger changed a decision, which is the argument for having one** ⟦DS.1⟧. DS1-3
was framed as "make the sheet card's 0-top / 0-right / 24-bottom gutters symmetric" — against 30px
of slack at 906 and **zero at 962**, that would have spent up to a third of the programme's
remaining vertical headroom on symmetry, and a right-hand gutter would have spent horizontal width
on a sheet §1.3 measures as short of screen. Instead DS.1 found the actual defect: **a full-bleed
surface is rendering as a floating card** — `border-radius: 12px` and a 1px border on edges that
meet the tab strip above and the viewport to the right, so **three of its four corners are rounded
against nothing and the radius is already invisible while still being paid for.** Squaring the
flush corners removes what made it read as "slipped up and right" rather than compensating for it.
**Zero pixels, either axis.** The scarcity numbers are what produced the better answer.

### 🔴 THE TARGET IS 674, NOT 678 — the 4px was in MY budget, not in PES.2's work

PES.2 landed footer 40→36 and gutter 24→8, measured **674 (74.4%)** and `R=82`, and **handed back
the 4px rather than finding four pixels somewhere to make my number come out.** That was the right
call and the discrepancy is mine:

```
my stated target   906 − 48 − 40 − 40 − 36 − 8 = H 734 − agHeader 56 = rows 678
measured bands     906 − 48 − 40 − 41 − 36 − 8 = H 733 − agHeader 57 = rows 676
PES.2 measured                                   H 731               = rows 674
```

**I built the target from idealised band heights.** The toolbar is **41** (40 + a 1px border) and
the AG header is **57** (28 + AG's 29px filter row) — both already recorded in this document as
correct-by-design, and both still counted at their ideal values in the budget arithmetic. That is 2
of the 4; the remaining **2px are seams** (a 1px gap at the scope-bar/toolbar boundary and the
sheet card's top border, both visible in the §2.2 band trace).

> **RULED: the §2.2 target is 675 (74.5%) at 906** (674 while the toolbar floored at 41; the band gained the pixel the toolbar gave up), derived from MEASURED band heights. The
> ideal-arithmetic 678 is withdrawn. **Nobody goes looking for 4px.**

**The consistency check that proves this is one term and not four mistakes:** `R` measured **82**
against my predicted **78** — the same 4px, in the direction a shorter grid predicts. Rows and
scroll range disagree with my forecast by exactly the same amount, which is what a single wrong
term in one budget looks like.

**Consequence for the ledger: the slack is 34px, not 30.** `R=82` against the 48 threshold.

> **The rule: 34px is the slack at 906, and it is zero at 962. The next lane to win more than 34
> vertical pixels disarms the collapsing header with a clean diff, and the symptom will be
> "collapse stopped working" with nothing changed in the collapse code.** Re-run
> `npm run layout:v2` and read the `§4.2 collapse-arming` line after any vertical change. **The fix
> is never the threshold.**

### 4.3c 🔴 COLLAPSING MORE MAKES ARMING WORSE — the comparison is `R − C ≥ T`, never `C ≥ T`

The arming rule invites one wrong reading, and it is the reading a reasonable person reaches first:
*"collapsing frees 16 against a 32 threshold, so free more."* **`C` is on the wrong side of the
inequality.** Every pixel the collapse frees is handed to the grid and comes straight back out of
`R` — the range the trigger needs. Measured across three collapse depths:

| | C=16 (48→32) | C=32 (48→16) | C=48 (48→0) |
|---|---|---|---|
| **906** (R=78) | armed (62) | armed (46) | **not armed (30)** |
| **962** (R=22) | not armed (6) | not armed (−10) | not armed (−26) |

**A deeper collapse disarms the feature at 906 and never rescues it at 962.** The header collapsing
to nothing — the most "generous" version — is the one that stops working. This is §4.3a's principle
applied to the collapse's own depth: the budget and the trigger are drawn from the same pixels, and
that includes the pixels the collapse itself frees.

**Nothing to add to the UI when it does not arm.** At 962 the grid has 22px of total scroll — under
two thirds of one row. An operator scrolling there sees the sheet barely move; chrome that stayed
put is not a surprise needing explanation, and a message about a non-event would be worse than
silence. **No lane should add "the header will not collapse because…" anywhere.** This is the one
place in this spec where saying nothing is the honest option, and it is stated so nobody reads §6's
honesty rules as requiring a notice here.

**Do not "fix" it by lowering the threshold.** `T` is what stops a 1px scroll flapping the chrome.
The fix is the row height that is already ratified — this is the third independent reason for it,
after the clipped thumbnail and the disarm at 906.

**PES.1's "verified" is correctly qualified:** the mechanism is proven on a real wheel; the demo is
not reproducible on the current build until the row lands. The probe's "not armed" reading is right,
and so is their verification. Both describe the build they were taken on.

### 4.4 Wiring (for PES.1, who implements)

- 🔴 **A programmatic `scrollTop` plus a dispatched `scroll` event does NOT fire the collapse —
  only a real wheel does** ⟦PES.1⟧. Any test or probe that exercises collapse *behaviour* (rather
  than merely asserting the scroll source exists) must drive it with `mouse.wheel`. A synthetic
  scroll that silently does nothing reads exactly like a collapse that is broken.
- Scroll source is **`.ag-grid-viewport.ag-layout-normal`** — confirmed independently:
  it exists, `overflow-y: auto`, `scrollHeight` 675 / `clientHeight` 545 ⟦measured⟧.
  `.ag-body-viewport` does not exist in AG 36.
- Collapse state is **view state**: a `ref` + a class toggle on the frame element. Not the URL, not
  the provider — a provider change re-renders every consumer including the sheet on every
  threshold crossing.
- **The transition must not animate height.** `GridSheet` re-measures its top through a
  `ResizeObserver` on `document.body`; animating 48→32 over 200ms makes AG re-virtualise on every
  frame. Animate the header's inner content (`opacity`, `transform`) and **snap the height in one
  step**. 150ms, `--nds-ease-standard`.
- `prefers-reduced-motion`: no transition, snap both.

---

## 5. THE SLIDE-OVER DRAWER

### 5.1 🔴 The one decision: **NON-MODAL. The sheet behind stays live.**

Four reasons, and the last one is the one that settles it:

1. **The drawer's job is comparison.** An operator opens a row, reads history/compare, then edits
   the next row. A modal forces a close-and-reopen per row.
2. **The sheet owns the keyboard.** `Type to edit · F2 · Enter ↓ · Tab → · drag to fill · ⌘Z` is
   the sheet's contract ⟦measured: it is printed in the footer⟧. A focus trap removes all of it
   for as long as the drawer is open. Ruling #19 made "two grids claiming the arrow keys with no
   visible focus owner" a programme rule; a modal drawer is the inverse failure — *no* grid
   reachable.
3. **It already exists.** PES.4 built this shape as the `<1280px` fallback on `.nds-drawer-dock`
   (`position: fixed`, `z-index: --nds-z-rail`). Promoting it to the default is a handful of lines.
4. **It dissolves the confirm-stacking problem instead of solving it.** `ActionConfirm` portals a
   DS `Modal` at `--nds-z-overlay` (1400). A modal drawer sits at `--nds-z-drawer` (1410), so every
   shared registry confirm would open *behind* the drawer that raised it — the third recurrence of
   `reference_drawer_confirm_overlay`. At `--nds-z-rail` the drawer is **below** 1400 and the
   confirm lands on top by construction. **No new token, no re-routing of the shared confirm
   through the Drawer's `overlay` slot, no z-race to maintain.** Choosing modal would have made a
   DS token change (DS.1's call) a prerequisite for a layout change.

### 5.2 The consequences, which are consequences and not separate choices

| | ruling |
|---|---|
| Backdrop | **None.** A backdrop that does not block input is a lie about interactivity. |
| Focus trap | **None.** Tab leaves the panel and reaches the sheet. Correct for non-modal. |
| `aria-modal` | **Absent.** `role="complementary"`, `aria-label="Record: <SKU>"`. |
| Announce | The existing polite live region, not a dialog role. |
| Focus on open | Move focus to the panel's heading (`tabindex="-1"`). Do not trap. |
| Focus on close | **Return to the grid cell that opened it.** Losing your place in a 21-row family is the real cost of a slide-over, and this is the whole fix. |
| **Esc** | **Owned by the innermost focused thing.** Focus inside the drawer → Esc closes the drawer. Focus in a cell editor → Esc reverts the edit (`SHEET_GRID_OPTIONS`). Focus in the grid, not editing → Esc closes the drawer. This is the only rule under which Esc never surprises. |
| Close affordances | ✕ in the panel header · Esc per above · Back (PES.4's history contract: PUSH on open, REPLACE on cell change) · clicking a different row **re-targets** the drawer rather than closing it. |

### 5.3 Geometry ⟦measured + derived⟧

- Width **520px** (today's dock is 519 ⟦measured⟧). Resizable by the existing `.nds-drawer-grip`,
  min 380, max 720, persisted per user.
- `position: fixed; right: 0; top: 0; bottom: 0` — the AppTopBar is gone on this route (#182), so
  the panel runs the full viewport height. It overlays the sheet; **the
  sheet keeps its full width underneath.**
- Enter: 180ms `transform: translateX(100% → 0)`. Reduced-motion: no transform.

**What this buys, measured:** at 1728 the sheet stays **1660px** wide with the drawer open instead
of dropping to **1140px** ⟦measured⟧ — 10 fully-visible columns instead of 7, and 3 of the 7
required OUTERWEAR fields on screen instead of 1.

### 5.4 🔴 The cost the slide-over introduces, and its fix

An overlay hides the right 520px of the sheet. Two mitigations, both required:

1. **The identity block is pinned LEFT** (389px ⟦measured⟧), so the row being edited is never the
   thing that gets covered.
2. **On open, if the focused cell falls under the drawer, scroll the grid horizontally so that
   cell sits at least 16px left of the drawer's left edge.** Without this, opening a record hides
   the cell you opened it from. The check is `cellRight > viewportRight − 520`.

   🔴 **REJECTED (#557): the transient viewport inset is NOT adopted, and the reason is measured
   rather than argued.** ⟦open vs closed grid-viewport width, drawer open, all three widths⟧

   | viewport | drawer closed | drawer open | displaced by |
   |---|---|---|---|
   | 1728 | 1660 | **1140** | **520** |
   | 1440 | 1372 | **852** | **520** |
   | 1280 | 1212 | **692** | **520** |

   **The inset displaces the sheet by exactly the panel width whenever a record is open — which is
   what §5.1 was chosen to prevent.** The non-modal slide-over was ruled partly because the sheet
   keeps its full width with the drawer open: **1660 instead of 1140, ten fully-visible columns
   instead of seven** — the measurement that quantified the Owner's *"barely a few columns"* at the
   start of this work (§1.3). **The transient inset gives that back at precisely the moment a record
   is open.** It is option (b), the displacement rejected at #249, applied per interaction rather
   than permanently.

   **That is a CERTAIN cost against the frame reading's UNCERTAIN one**, and the debate never named
   it — it ran on rendering cost and the uncoverable band. The frame reading is moot: it could have
   shown no perceptible hitch and the sheet would still be 520px narrower whenever a record is open.
   **The overlap form plus the reveal sequence is the design.**

   ⚠ **A method note, because the anomaly was mine.** I reported 1728 as passing this check and
   could not explain it. It was not passing: the whole §5 block **abstained** there (no dock in that
   run), and **I read its absence from the failure list as a pass** — after building the abstain
   mechanism precisely to stop that conflation. Measured directly, 1728 displaces by 520 like the
   others; there is no anomaly. The check is now exact (`open width === closed width`) rather than a
   `> W − 200` tolerance a partial displacement could clear.

   ⟪superseded — kept for the record⟫ **RULED (#249): OPTION (a) — a trailing SCROLL PAD.** ⟦AG.1, measured with the paint forced: the reveal fires and
   `ensureColumnVisible` scrolls 1079 → 1409, which **is** max scroll — and the cell's right edge
   still sits at 1397 against a panel left edge of 1208, 205px short. Once a column is within a
   panel-width of the end of the column list, **the grid has no scroll left to give**, so no amount
   of scrolling can satisfy §5.4 for trailing columns. The mechanism works; the rule had a gap.⟧

   **Why (a) and not the alternatives:**
   - **It is invisible by construction, which is the part that makes it honest rather than a
     phantom.** The pad is *exactly* the width of the thing covering it, so at max scroll the last
     real column's right edge lands precisely on the panel's left edge and **the operator never sees
     blank grid**. At any other scroll position the pad is off-screen to the right.
   - **(b) — narrowing the panel or insetting the sheet — undoes §5.1's entire win.** The slide-over
     was chosen so the sheet is NOT displaced: 1660px and 10 columns instead of 1140px and 7
     ⟦measured⟧. Insetting for trailing anchors reintroduces the thing the decision removed.
   - **🔴 (c) — "scrolled as far as possible", said in the UI — is forbidden by a rule written two
     sections earlier.** §6.4 rule 4: *do not narrate the absence to the operator; a gap in our own
     payload is a programme item, not an operator-facing message.* A notice explaining why a cell is
     covered is us confessing a layout limitation into the operator's eye-line. (c) is not a weaker
     option, it is an inconsistent one.

   **Constraints on the build:**
   1. **A viewport pad, never a phantom column.** A phantom column would appear in column counts,
      export output, keyboard navigation and the Customise dialog — four surfaces that would each
      have to special-case it, which is how a phantom becomes permanent.
   2. **It exists only while the panel does**, and only on the trailing edge.
   3. **On close, clamp `scrollLeft` back into range without a visible jump.**
   4. **Accepted edge case, stated rather than discovered:** if the column set is narrower than the
      viewport the sheet has no horizontal scroll, and the pad creates some. That is accepted — the
      only alternative is insetting, i.e. (b).

   **Probe witness — BUILT and running** (`§5.4 reveal` and `§5.4 no-phantom-column` in
   `layout:v2`). The spec asserted it was added before it was; it is now, and the build corrected
   the second assertion:

   - **`reveal`** — with the drawer open, the originating cell's right edge ≤ the panel's left edge.
   - **`no-phantom-column`** — 🔴 **not "the rendered column count is identical", which is wrong.**
     My first implementation compared the rendered sets drawer-open vs drawer-closed and fired on
     five real attribute columns, because the reveal had *scrolled* the grid and AG virtualises
     columns. **A comparison across two scroll positions measures the scroll, not the columns** —
     the banked virtualisation trap, inside a check written to catch someone else's mistake. The
     scroll-independent form: wheel **both** states fully right and compare the **last** rendered
     column id. A viewport pad leaves the last real column last; a phantom appears after it.
     Currently `ready:scope` in both states at all three widths, scrollWidth 2749 either way.

   **🔴 And the witness immediately found a second gap, distinct from the trailing-column one this
   ruling fixes** ⟦measured⟧:

   | viewport | focused cell | panel left | scrollLeft | result |
   |---|---|---|---|---|
   | 1728×906 | `item_name` right 642 | 1208 | 0 → 650 (max 1089) | ✅ clear |
   | 1440×900 | `status` right 566 | 920 | 0 → 380 (max 1377) | ✅ clear |
   | **1280×900** | `name` right **836** | **760** | **0 → 0 (max 1537)** | ❌ **COVERED by 76px** |

   **At 1280 the reveal does not scroll at all, with 1537px of scroll available** — so this is not
   the "no scroll left to give" case (a) addresses. Something declines to run.
   **🔴 THE OVERLAP HYPOTHESIS IS DEAD — killed by a sweep, and it was mine.** I proposed a
   partial-coverage threshold; the hub found PES.4's and AG.1's readings agreed with it (76px fails,
   189px passes, 76 appearing twice independently) and made it the leading explanation. **A sweep of
   25 focus positions across three viewports refutes it outright:**

   | viewport | column | overlap | scroll | |
   |---|---|---|---|---|
   | 1440 | `status` | **27px** | 0 → 380 | **FIRED** |
   | 1728 | `item_name` | **59px** | 0 → 650 | **FIRED** |
   | **1280** | **`name`** | **77px** | **0 → 0** | **no-op** |
   | 1280 | `status` | 187px | 0 → 380 | FIRED |

   **27px fires and 77px does not. Overlap does not predict it.** Three lanes agreeing on a number
   was three lanes sampling near the same point, not a mechanism.

   🟢 **RE-MEASURED ON THE FIXED BUILD (#281/#283) — the mechanism holds, and the alternative is
   ruled out.** The first sweep ran on a build where a StrictMode double-invocation had cleared
   PES.4's retry timers, so the drawer emitted **zero** reveal calls — which meant a mechanism
   inferred from that pattern was inferred from the wrong thing, and I suspended it rather than let
   it stand. Re-run on the fixed build, 21 positions:

   | viewport | leftmost scrollable | overlap | result |
   |---|---|---|---|
   | 1728 | `name` −371 · `status` −261 · `brand` −101 | not covered | no-op, **correct** |
   | 1440 | `name` −83 | not covered | no-op, **correct** |
   | **1280** | **`name` +77** | **covered** | **no-op — the bug** |

   Every covered position from `status` (27px) rightwards fires; the scroll targets are still
   column-derived and viewport-independent (380 · 490 · 650 · 810 · 970 · 1130). **The only failure
   at any width is the leftmost scrollable column when it happens to be covered** — exactly what
   `ensureColumnVisible(col, 'start')` predicts.

   **And the alternative I was worried about is dead:** `vpW` is unchanged across the open —
   1660 → 1660, 1372 → 1372, 1212 → 1212 — so the drawer does **not** narrow the grid, and AG's own
   keep-the-focus-visible-on-resize cannot be what moved the scroll. ⚠ One row is not evidence and
   is marked so: 1280 `item_name` shows `no-op (no drawer)` — the drawer failed to open in that
   iteration, so it says nothing about the reveal.

   **The real cause, from the same data.** The scroll TARGETS are identical at 1280 and 1440 for the
   same column — `status` → 380, `brand` → 490, `item_name` → 650, `bullet_point` → 810 —
   **so the target is derived from the COLUMN and is independent of the viewport.** That is
   `ensureColumnVisible(col, 'start')`: scroll so the column sits at the grid's left edge.

   > **And for the LEFTMOST scrollable column that target is 0, which is where you already are — so
   > it no-ops, however covered the column is.** `name` is the first column after the pinned block
   > at every width; at 1728 and 1440 it is not covered (overlap −371, −83) and the no-op is
   > correct; at 1280 it is covered by 77px and the no-op is the bug. **One column, one width — and
   > it looked like a threshold because it is the only case where "put the column at the left edge"
   > and "clear the column of the panel" disagree.**

   **🔴 THE URL PATH IS A SECOND, INDEPENDENT FAILURE — baselined before the fix so it can be
   proven fixed** ⟦measured 02:0x, cold loads of `?rec=&cell=`⟧:

   | viewport | target cell | scrollLeft | result |
   |---|---|---|---|
   | 1280 | `bullet_point` | **0** / 1537 | COVERED by 666px |
   | 1280 | `supplier_declared_dg_hz_regulation` | **0** / 1537 | **target column not even RENDERED** |
   | 1728 | `bullet_point` | **0** / 1089 | COVERED by 218px |
   | 1728 | `supplier_declared_dg_hz_regulation` | **0** / 1089 | COVERED by 508px |

   **`scrollLeft` is 0 in every case, measured 3.5s after the rows appear** — well past the 1.3s
   early fire. The URL path never scrolls **at all**, at any width, including for columns the verb
   path reveals correctly (`bullet_point` at 1728 goes 0 → 810 via the verb). **That isolates the
   two causes**: the leftmost-column no-op is a property of `ensureColumnVisible`, and this is the
   reveal firing at 1.3s before the grid exists and never re-firing (AG.1's diagnosis, fixed
   separately by hold-until-`gridReady`-and-replay).

   ⚠ **The 1280 `supplier_declared_dg_hz_regulation` row is the worst shape of the two:** the target
   column is not merely covered, it is **virtualised out entirely** — an operator following a deep
   link lands on a record whose named cell is nowhere on screen, with nothing to indicate where it
   went. A covered cell is at least findable by scrolling; an absent one gives the operator no
   signal that the link took them anywhere.

   🟢 **VERB PATH: FIXED, 17 of 17** ⟦post-re-fix sweep, 21 positions × 3 widths⟧. Every covered
   position is **rendered and clear**; every uncovered position correctly does not move. And the
   deltas are exact — `overlap + 16` in all seventeen (59→75, 219→235, 379→395, 509→525, 27→43,
   187→203, 347→363, 507→523, **77→93**) — which is `cellRight − panelLeft` plus the 16px margin
   §5.4 asks for. **`name` at 1280, the leftmost-scrollable case that started this, is 77 → 93 and
   clear.** Distance, not destination, is what the numbers now show.

   🟢 **URL PATH: 6 of 6 — AND MY "3 of 6" WAS MY OWN UNPINNED INPUT, NOT A DEFECT.**
   ⟦re-run with `&market=DE&locale=de` pinned⟧

   | viewport | `bullet_point` | `supplier_…` |
   |---|---|---|
   | 1728 | 235 → CLEAR | 525 → CLEAR |
   | 1440 | 523 → CLEAR | 813 → CLEAR |
   | 1280 | 683 → CLEAR | 973 → CLEAR |

   **Those are the verb path's exact values** (235/523/683 and 525/813/973). The two paths *are*
   sharing the fixed code; my "decisive reading" of 235 vs 1089 compared two runs that differed in
   the market, not in the path.

   > 🔴 **THE RULE THIS COST: the same-BUILD rule has a sibling — the same-INPUT rule.** I checked
   > that AG.1 and I were on the same build. I never checked we were on the same **market** — and a
   > studio deep link without `market`/`locale` resolves a *remembered* coordinate, so it is not a
   > fixed input. **A comparison is decisive only when every input except the one under test is
   > pinned**, and mine differed in exactly the variable that made it look decisive. `layout:v2` now
   > pins the coordinate on every URL it builds.

   ⚠ One thing I cannot explain and am not going to paper over: each Playwright page is a fresh
   context with empty storage, so a remembered market should not have varied between my runs. The
   *measured* fact is solid — unpinned gave 3/6, pinned gives 6/6 with verb-path-identical values —
   but the resolution mechanism is not purely `localStorage`, and whoever owns it should know that.

   ⟪superseded, kept for the record⟫ **URL PATH: 3 of 6, and the 1728 passes are the luck shape.**

   | viewport | target | scrollLeft | result |
   |---|---|---|---|
   | 1728 | `bullet_point` | **max** 1089 | clear ⚠ |
   | 1728 | `supplier_…` | **max** 1089 | clear ⚠ |
   | 1440 | `bullet_point` | **max** 1377 | **NOT RENDERED** |
   | 1440 | `supplier_…` | **max** 1377 | clear ⚠ |
   | 1280 | `bullet_point` | **max** 1537 | **NOT RENDERED** |
   | 1280 | `supplier_…` | **max** 1537 | **NOT RENDERED** |

   **`scrollLeft` is at maximum in all six.** Compare the verb path on the same build, same columns:
   `bullet_point` goes to **235**, not 1089. **The two paths are not sharing the fixed code.** The
   three passes are passes because max scroll happens to leave that column visible at that width —
   the same luck shape as before, and it is why the assertion is *rendered AND clear* rather than
   *not covered*: a not-covered check scores this 6/6.

   ⚠ **AG.1 verified the URL path at 1728 only** (they cannot resize), on `fabric_type`, which
   scrolled 0 → 655 — a real distance. **My two columns hit max at the same width**, so the
   difference is the column, not the viewport, and 1728 was never the safe place to test this.

   ⟪superseded — kept for the record⟫ 🔴 **THE EARLIER FIX OVER-SCROLLED — the failure has inverted, not gone** ⟦re-measured
   02:2x, same four cases plus 1280⟧. `scrollLeft` was **0** in every case before; it is now
   **max** in every case:

   | viewport | target | scrollLeft | result |
   |---|---|---|---|
   | 1728 | `bullet_point` | 1089/**1089** | clear |
   | 1728 | `supplier_…` | 1089/**1089** | clear |
   | 1440 | `bullet_point` | 1377/**1377** | **NOT RENDERED** |
   | 1440 | `supplier_…` | 1377/**1377** | clear |
   | 1280 | `bullet_point` | 1537/**1537** | **NOT RENDERED** |
   | 1280 | `supplier_…` | 1537/**1537** | **NOT RENDERED** |

   **It scrolls to the maximum rather than by the computed distance.** At 1728 that lands the target
   left of the panel and looks correct — **it passes by luck of the geometry, not by doing the right
   thing.** At 1440 and 1280 it overshoots and the named column is virtualised out **to the left**:
   3 of 6 cases are the silent shape, where the operator follows a deep link and the cell is nowhere
   on screen.

   > **This is why §5.4 specifies `cellRight − panelLeft`, clamped — a distance, not a destination.**
   > "Scroll to the end" satisfies "the cell is not under the panel" for any cell that ends up
   > anywhere left of it, including off-screen. The assertion that catches it is the one already in
   > the harness: **the target cell must be RENDERED and clear**, not merely not-covered.

   **Caught by the pre-fix baseline**, which is the argument for taking one: without the four
   before-readings this would have read as three viewports where the fix "mostly works".

   ⚠ **An engine note that removes a dead end:** AG has **no horizontal scroll setter** ⟦AG.1⟧. The
   fix is an engine helper over `.ag-grid-viewport.scrollLeft` — writing that alone does not inform
   AG's rendered column range (the banked trap), so the helper must scroll the way a person does and
   let AG react.

   **The fix follows directly, and §5.4 already said it before the implementation chose otherwise:**
   compute the delta that clears the panel — `cellRight − panelLeft`, clamped to the scroll range —
   and apply it. **Do not ask AG whether the column is "visible": AG's viewport does not know the
   panel exists**, so its answer is about a different question. → PES.4.

   → **PES.2** builds the pad in the engine (grid chrome); **PES.4** keeps the rule. Reading 2
   (a visible column moves nothing) passes ⟦AG.1⟧.

   🔴 **The mechanism I specified does not currently exist.** I wrote "AG exposes
   `ensureColumnVisible`"; ⟦AG.1, measured⟧ **it throws, because `ScrollApiModule` is not registered
   in `design-system/grid/modules.ts`** — there is today no supported way to scroll a column into
   view. No app code calls it yet, so nothing is broken; but this requirement and the
   `Missing required (42)` chip's stated job of taking the operator *to* those cells both depend on
   it. **→ AG.1 registers the module; PES.4 must not build §5.4 against a call that throws.**
   (Related but distinct from `reference_ag_module_silent_omission`: an unregistered module usually
   fails *silently* — this one fails loudly, which is the better of the two.)

### 5.5 🟢 THE GESTURE MAP — double-click, Enter, and opening a record (#182b)

Written into the spec at the hub's instruction. It generalises §7.3's local ruling, because the
collision is **the normal case, not an edge**: ⟦AG.1⟧ **95 of 100 columns are editable**, so
double-click lands on an editable cell almost always. And ⟦PES.3⟧ their double-click handler was
already opening an editor **on the wrong cell** after the drawer's reflow moved the grid underneath
the pointer.

> **Double-click EDITS. Everywhere. It never opens the record.**
> **A record opens only from an explicit affordance:** the identity cell's own open control, the
> `open-record` verb (⋯ menu and right-click menu), or **Enter on the identity cell.**

**🔴 Owner of that affordance: PES.2, and PES.2 only** (ruling #186). It already exists as the
registry `open-record` verb, which the adapters put on both menus from one declaration. **PES.4's
drawer-side entry point, if it has one, CALLS that verb — it does not build its own.** This is
written inline because the trailing routing line below was not enough: both lanes read the sentence
above, both built it, and PES.4 landed into PES.2's `MasterSheet.tsx` with an import of a file that
does not exist, leaving tsc red on a shared file within the hour.

**Enter, exactly — and this closes a real gap, not a preference.** Today the sheet advertises
`Type to edit · F2 · Enter ↓ · Tab → · drag the corner to fill · ⌘Z`, which means:
typing **replaces** the cell's contents (destructive), F2 edits non-destructively (undiscoverable),
and Enter navigates. **There is no discoverable, non-destructive way to start editing** — an
operator who wants to append a word to a 200-character title must either know F2 or retype the
field. That is the gap.

| key | cell state | v2 behaviour |
|---|---|---|
| **Enter** | focused, editable, not editing | **START editing, value PRESERVED, caret at end.** The discoverable non-destructive path. |
| **Enter** | editing | Commit and move **down** (unchanged — `enterNavigatesVerticallyAfterEdit`) |
| **Enter** | focused, **identity cell** (not editable ⟦measured: `sku.editable === false`⟧) | **Open the record.** Safe precisely because the cell cannot be edited, so Enter has no other meaning there |
| **Enter** | focused, non-editable, not the identity cell | Nothing, and the cell says why it is not writable (§6 honesty rules) |
| **F2** | focused, editable | Alias of Enter-to-edit. Kept for spreadsheet muscle memory |
| **printable key** | focused, editable | Replace and edit. Kept — it is the spreadsheet norm — but it is no longer the *only* discoverable way in |
| **double-click** | editable | Edit, value preserved |
| **double-click** | not editable | Nothing. **Not** an open-record gesture |
| **Tab / ⇧Tab** | any | Move right / left (unchanged) |
| **↓ / ↑** | not editing | Move down / up. **This is where "Enter ↓" goes** |
| **Space** | focused | Toggle the row's selection checkbox |
| **Esc** | see §5.2 | Owned by the innermost focused thing |

**Two consequences to implement, not just to read:**
1. `enterNavigatesVertically` must become **`false`** in `SHEET_GRID_OPTIONS`
   (`enterNavigatesVerticallyAfterEdit` stays `true`). Vertical movement moves to the arrow keys,
   which is where every operator already looks for it.
2. **The footer hint string is wrong the moment this lands.** It currently advertises `Enter ↓`.
   It becomes: `Type or Enter to edit · ↓↑ to move · Tab → · drag the corner to fill · ⌘Z`.
   A hint that describes the old contract is worse than no hint —
   [[reference_docs_describe_deleted_code]] in the one place an operator actually reads.

**PES.3's wrong-cell bug is fixed twice over by decisions already in this spec**, and it is worth
saying which does what: the **slide-over** (§5) removes the reflow that moved the grid under the
pointer, and **this ruling** removes the second handler that was racing the first. Either alone
would have hidden the other.

**Routing — one item, one lane, no item appears twice:**

| item | sole owner |
|---|---|
| the key map + `enterNavigatesVertically: false` in `SHEET_GRID_OPTIONS` | **AG.1** |
| the footer hint string | **PES.2** |
| the identity cell's open control / the `open-record` verb | **PES.2** |
| the drawer stops listening for double-click, and calls PES.2's verb for any entry point of its own | **PES.4** |
| delete the channel sheet's own double-click handler | **PES.3** |


---

## 6. WARNINGS, REFUSALS, AND THE STRIP THE OWNER NAMED

### 6.1 The diagnosis

`⚠ Missing required (42)` and `Warnings (42)` are **filters wearing a warning's clothes**. They
narrow the sheet when clicked.

⟦DS.2, measured at 1440⟧ `⚠ Missing required (42)` is **171.7 × 27.8px**, class `nds-btn sm` — the
plain DS secondary button, **no tone variant** — on `rgb(255,255,255)` with a 1px `rgb(216,221,228)`
border, label contrast **9.87:1**, `aria-pressed="false"`, `title="42 missing required"`, sitting in
the toolbar's right cluster between `Overview ▾` (ends 1074) and `Customise` (starts 1261).

**The control is three things at once: an alarm (the ⚠ glyph + a count), a metric (the number), and
a filter toggle (`aria-pressed`) — and the styling commits to none of them.** It reads as an alarm
and behaves as a filter while being painted as a neutral button. **The contrast is fine, so this is
a role-clarity finding and not an accessibility one, and a proposal that only re-tones it misses the
point** ⟦DS.2⟧. That is very likely why the Owner said *"I don't really like it"* rather than naming
a defect: there is nothing wrong with any one of its three jobs, only with their being one control. Three jobs, one control, and
the only one it is actually good at is the third. That is the same diagnosis as §6.1 reached from
the DS side, and it is why the fix is a split rather than a restyle — a control cannot be de-alarmed
without deciding which of its three jobs it keeps.

⟦DS.1, grepped the sheet and the DS:⟧ **there is no warning strip above the grid at all.** Refusals
surface only per-cell (`.nds-cell-is-refused` / `-invalid` / `-warned`, grid.css:397-410) and in the
bottom `GridSheetStatus`. So the thing the Owner dislikes is definitively this filter chip and not
some separate banner — which also means §6.2's rules are a *placement* change, not a rescue of a
broken component. On master it is a plain `.nds-btn.sm`, 172×28, sitting 187px from the right edge
with `Customise` and `Reload` outboard of it. They carry a ⚠ glyph, a warning tint and a permanent count, in the
corner the eye reaches first. The Owner is right to dislike them, and the fix is not to soften
them — it is to stop calling a view a warning.

### 6.2 The rules

1. **A count of cells that need work is a VIEW, not a warning.** `Missing required (42)`,
   `AI drafts (3)`, `Refused (2)` move into the view control beside `Overview ▾`, as selectable
   views carrying their counts, in neutral tone. The count stays — visibility over minimalism —
   the ⚠ and the amber go.
2. **A genuine sheet-level warning is a statement about the data's provenance** (schema stale, no
   cached schema for a product type, contract mismatch, adapted read). It belongs **inline in the
   footer strip**, beside the save state — where `adapted read`, `N refused — hover a red cell for
   why` and `N rows changed elsewhere — refresh` already live ⟦measured⟧. **One honesty surface,
   not two.** Two means neither is trusted.
3. **A refusal stays on the cell.** `.nds-cell-is-refused` plus the footer count. Never a toast
   alone; a toast that has been dismissed is a refusal that never happened.
4. **Nothing here may be dismissable into silence.** A warning may COLLAPSE (detail behind a
   count) but the count persists until the condition clears. No ✕ on any of it. Stated as an
   invariant so no lane "tidies" it later.
5. **Never the top-right of the grid.** That corner belongs to the column headers the operator is
   scanning.
6. The scope-readiness note band (`.studio-module scopeNote`, 31px ⟦measured: it appeared when
   readiness timed out at 15s⟧) was correct in kind — it stated a real failure in visible text — but
   it pushed the grid down. **The band is now REMOVED (#230).** In v2 a refusal renders **inside the
   sheet's footer strip**, never as a band above the toolbar.

   🔴 **AND THE FOOTER HOME IS NOT BUILT YET, WHICH IS AN HONESTY GAP, NOT A TIDY-UP.** With the band
   gone, a readiness refusal's visible text now lives **only in the scope chips' tooltips and in
   `Publish ▾`** ⟦#230⟧ — i.e. on hover. **A failure an operator can only discover by hovering is
   not disclosed**, and this spec's own rule 4 ("nothing dismissable into silence") is about
   exactly that: a refusal that no longer moves the grid but also no longer says anything has been
   made quiet, not honest. Removing the band without landing its replacement traded one defect for
   a subtler one.

   **The invariant, written so it can be convicted:** *if a coordinate carries a readiness refusal,
   the sheet's footer strip contains that refusal as visible text.* `layout:v2` gets a witnessed
   check — refusal present on a coordinate → footer text present — so this cannot sit unnoticed
   again. It folds into §6.3's single change: **DS.1's warning component gains a refusal form;
   PES.2 mounts it in the footer.**

### 6.3 🔴 THE GLYPH BELONGS TO THE CHIP'S KIND — do not sweep the triangle ⟦DS.1⟧

The cause of rule 1's problem is one line: **`MasterSheet.tsx:891` renders
`<AlertTriangle size={11} /> {chip.label}` unconditionally inside the chip bar's `.map()`**, under
`key={chip.id}` with no guard. So the triangle is a property of **the bar**, not of any chip's
meaning, and PES.8's `AI drafts` count inherits an alarm glyph for free. That is §6.1's diagnosis
one layer down: **the glyph is the part doing the lying.**

**But the fix is NOT "remove the triangle".** ⟦DS.1, read at source⟧ `:904` puts the same glyph on a
`Pill tone="warning"` for `caps` — *"no cached Amazon schema for X, so those columns carry no length
caps or closed lists"* — and **that one is a real warning and keeps its glyph and its tone.** It is
a rule-2 provenance statement, so it moves to the footer; it does not become a view and it is not
de-toned on the way.

> **The rule: a warning glyph and a warning tone belong to a control's KIND, never to the bar it
> sits in.** A count of work carries neither. A provenance warning carries both, in the footer.
> A sweep that strips the triangle from the chip bar must not strip it from `caps`.

🟢 **LANDED 2026-09-02 02:51:43, and the sequencing above is SUPERSEDED** (#348). PES.2 gated the
glyph on **`ViewChip.tone`** — a field **every lane already produced.** `AI drafts` no longer wears
an alarm; `caps` keeps its real warning.

> **The kind was always in the contract; the renderer was ignoring it.** That is why §6.3's rule
> turned out to be cheap rather than a refactor: I ruled that *the glyph belongs to the chip's kind,
> never to the bar it sits in*, and the kind was already sitting in the payload unread. **A renderer
> that discards information its contract carries produces exactly the symptom of a contract that
> lacks it** — and the two are told apart by reading the contract, not the screen. Worth checking
> before any future "the data doesn't distinguish these" conclusion.

⟪superseded — kept because the reasoning still applies to the next shared-markup change⟫
**Sequencing, so the same markup is not touched twice** ⟦DS.1's ask⟧: the glyph fix travels **with**
the warning component's new home (rule 1 + rule 2 together), not as a separate patch — otherwise the
second pass reads as churn over the first. **It did not apply here because the fix turned out to be
one field in one renderer, touching none of the markup DS.1's component move will touch.**

⚠ Note for anyone reading the conformance script's §6.2 failure: it flags *any* warning-glyphed or
warning-toned control **above the grid**, which is correct — a real warning above the grid is drift
too, because rule 2 sends it to the footer. The failure means "this does not belong here", never
"delete this glyph".

---

### 6.4 🔴 AN UNLISTED COORDINATE: nothing may report a count about a listing that does not exist

⟦PES.3, #235: on a channel × market with no listing, the sheet renders `Preflight ★ (20)` **and**
`Warnings (42)` — a preflight and a warning count for a listing that does not exist.⟧

**Ruled:**

> **1. State first, work second, in one line.** An unlisted coordinate shows exactly one thing:
> **"Not listed · N fields required to list"**. The state is the subject; the count is a property of
> the work needed to change it, and it is named as such rather than presented as a defect of
> something live.
>
> **2. No control may display a count attributable to a listing that does not exist.**
> `Warnings (N)` and `Preflight ★ (N)` both do. Both are gone while `readiness.state === 'unlisted'`.
>
> **3. But preflight SURVIVES as an action, without a count** — *"Check before listing"*. Validating
> the payload that *would* be sent is genuinely useful, and it is the only safety check before a
> create; removing it outright would take away the check at the one moment it earns its keep. The
> lie was never the preflight, it was the **number** — a count reads as a property of an existing
> listing.
>
> **4. The count must be the CREATE count.** "N fields required to list" and "N fields the channel
> schema requires in general" are not necessarily the same set. Whichever is shown must be the one
> the sentence claims. If they are identical, that has to be measured, not assumed — §1's rule about
> naming which thing you measured applies to counts as much as to pixels.
>
> 🟢 **AND IT SHIPPED WITHOUT THE N, WHICH IS THE RULE WORKING.** ⟦PES.3, #248⟧ **All three
> candidate numbers were wrong**: `42` was 21 rows × 2 warn fields (a product of the view, not a
> requirement), `rowsMissingRequired` was `0`, and `requiredBy` was contaminated. A designer picking
> "the count" from whatever the payload offered would have shipped one of the three, and it would
> have looked authoritative. **The line reads "Not listed" with a countless "Check before listing"
> until the contract carries a real create count** (PES.5 asked).
>
> **The rule that generalises: when no count can be justified, the line degrades to the STATE
> ALONE. It never borrows the nearest available number.** "Not listed" is true and complete on its
> own; a number is an additional claim, and an unjustified one is worse than none.
>
> ⚠ **But do not then narrate the absence to the operator.** "Not listed (count unavailable)" would
> be noise about our own contract. **A missing count is a PROGRAMME gap — tracked in the ledger and
> owned by PES.5 — not an operator-facing message.** The distinction matters because §6's honesty
> rules are about not hiding things that happened to the operator's data, not about confessing every
> gap in our own payload.

**§3 note — do NOT add a new state to the chip/band vocabulary; it already exists.** ⟦measured⟧
`design-system/grid/renderers/readiness.ts:56` already defines
`unlisted: { tone: 'neutral', label: 'Not listed', vocabulary: 'row' }`. PES.3's fix is therefore not
a new state but the removal of a **local default** — a `?? 'DRAFT'` that overrode the server's honest
`listing: null` / `state: 'unlisted'`. That is precisely the local-mapping failure rulings #3 and #11
forbid, and it is worth stating as the general form:

> **A `??` fallback over a server state is a local vocabulary.** It cannot be spotted by grepping for
> a mapping table, because it is one token long — and it fails in the most expensive direction: it
> invents a *live* state for something that does not exist. Consume `readinessMeta(state, 'row')`;
> never default.

### 6.5 🔴 THE REFUSAL'S HOME COSTS ZERO PIXELS — the reserved track already exists

DS.2 asked what height §4.3b reserves for a refusal track, offering 24–32px permanent. **The answer
is zero, and a new track would be the wrong shape twice over.**

**The arithmetic first, because it is counter-intuitive.** A taller footer makes the grid *shorter*,
which *increases* `R` — so a reserved track would help arming (H 734 → 706, R 78 → 106). It costs
**rows**: 28px is 0.8 of a row at 36px, and it takes the sheet from 89.4% to **86.3%**, back below
the band ruling #169 asked for and that §2.3 spent the AppTopBar to reach. **We would be paying the
Owner's headline number for a strip that is empty almost all the time.**

**And it is unnecessary, because the unconditional strip is already there.** The footer is a fixed
36px band that always renders. It currently carries `21 rows · 2 selected · autosave ✓` and the
keyboard hint `Type or Enter to edit · ↓↑ · Tab → · drag to fill · ⌘Z`.

> **RULED: a refusal takes the KEYBOARD HINT's place in the existing 36px footer. The strip's height
> never changes.** Zero permanent cost, no reflow, and the invariant is satisfied. The hint is
> precisely the thing you can afford to lose while something is wrong: it teaches a gesture the
> operator will learn once, and it is competing with a statement that something is broken right now.

**The many-refusals case — never a list, and never hover.** One line: the count, then the worst case
named.

```
⚠ 3 coordinates blocked · Amazon · DE needs 7 fields          ← replaces the hint, same 36px
```

> **The detail is reached by CLICKING that line, which narrows the sheet to the affected
> coordinates** — i.e. it is a **view**, exactly as §6.2 rule 1 requires of every count of work.
> Hover may elaborate; hover may never be the only way. That is what stops this rebuilding the
> surface §6.2 rule 6 just removed.

**Token constraint, from DS.2's own sweep and ratified here:** use the `*-soft` / `*-text` /
`--nds-pill-*` pairs. ⚠ `--nds-danger`, `--nds-warning`, `--nds-success` and every `--nds-note-*` /
`--nds-tonal-*` are **absent from both `.dark` blocks**, along with the palette steps they alias, so
they hold their light values on a dark surface. It does not bite on the studio (pinned light via
`body:has(.h10-shell)`) — **but a shared warning component will not stay on the studio**, which is
exactly when it would.

### 6.6 A settling popover and a mis-clamped one are indistinguishable in one sample ⟦DS.2⟧

Recorded here rather than only in a probe comment, because it is a property of measuring popovers
and not of any one script:

| | panel | trigger | lifetime |
|---|---|---|---|
| DS.2's real bug | 1232.5, w 115.2 | 1308.8 | permanent |
| UX.1's false positive | 1455–1728, w 273 | 1598–1712 | ~200ms |

Both are "correct size, wrong X". **Any assertion strong enough to convict the first will convict
the second unless it settles first.** And it is not a race that can be tuned away: the DS panel
positions in a `useLayoutEffect` after the portal mounts, starting at `left: -9999` **deliberately**
so it never paints in the wrong place — so a pre-positioned frame genuinely exists, at every width.
**Settle before measuring any popover, always; three consecutive identical rects is the bar this
spec uses.**

## 7. 🔴 THE DOCUMENT MAY NEVER SCROLL HORIZONTALLY

The Owner: *"the dropdown sometimes opens to the right side of the page, and I have to scroll the
whole page, which disturbs the UI."*

**The invariant:** `document.documentElement.scrollWidth === clientWidth` at all times, in every
state, with every popup open. ⟦measured: it holds today at 1728, 1440 and 1280 with no popup
open — so anything that breaks it is a popup, not the layout.⟧

Rules, enforced by DS.1 in the primitives and by AG.1 for AG's own popups:
- it flips to the other side when it would cross the viewport edge, and clamps when flipping is
  not enough;
- it never widens the document — a popup that cannot fit gets an internal scroll, never the page;
- the sheet's own horizontal scroll lives in `.ag-grid-viewport`, and the chips' in
  `.nds-scopebar-chips`. Those two are the only horizontal scrollers on the route;
- **portalling to `document.body` is the DS's mechanism for achieving the above, not the
  invariant itself** — see the next paragraph.

### 7.1 🔴 The suspect list is NOT "every popup" — and one suspect passed for the wrong reason ⟦DS.1 + AG.1, measured at 1440⟧

DS.1 opened every popup they could reach and **the invariant held for all of them**: the DS combo
on both scope-bar switchers, the `Publish` menu (629px wide), and **AG's own column menu on the
rightmost column, which landed at r=1439 against a 1440 edge — it flipped correctly on its own.**

⚠ **One clearance is narrower than an earlier draft of this section claimed, and I wrote it too
strongly.** The rich-select measurement was taken **at the cell's default position, not at the right
edge**, and the popup list had not rendered (`rowsRendered: 0` — the panel is torn down before it
positions, §7.1's worked example below). `scrollWidth === clientWidth` held throughout, but held
where nothing was being tested. **So the select editor is untested where §7 actually bites — the
rightmost column — and only AG's column menu has been measured against a real viewport edge.**
A clearance is only as wide as the position it was taken at.

AG.1 then went after the two remaining surfaces and **ruled one of them out — for a reason far worse
than the invariant** ⟦AG.1, traced with focus + MutationObserver, ms timestamps⟧:

```
510010  focusout  BUTTON.nds-listbox-btn → relatedTarget INPUT   (the panel's search box)
510011  focusin   INPUT
510012  focusout  INPUT → relatedTarget null
510012  listbox-added   parent: BODY        ← the panel portals OUTSIDE the grid
510012  cellEditingStopped                  ← AG tears the editor down
```

**The sheet's select editor never opens at all.** The DS `Listbox` portals its panel to
`document.body` and autofocuses its search input (268 options on `country_of_origin`, past the
7-option search threshold); because the panel is outside the grid's subtree, AG sees focus leave the
cell, stops editing, and unmounts the editor and the panel with it — the whole sequence inside 2ms.
The operator gets a trigger that cannot be opened. It satisfies §7's invariant only because it never
exists long enough to widen anything.

### 🟢 §7 IS CLOSED FOR THE SHEET'S SELECT — measured at the right edge, at three widths

`npm run layout:v2` now opens the rightmost **editable select** and measures the rendered list
against the viewport (witnessing `.ag-virtual-list-viewport` with options, never `.ag-popup` — a
full-width zero-height container that answers "no border, no shadow" and looks like a measured
negative):

```
1728×906  right 1728/1728   bottom 348/906   document 1728/1728
1440×900  right 1440/1440   bottom 348/900   document 1440/1440
1280×900  right 1280/1280   bottom 348/900   document 1280/1280
```

Exactly to the edge, no overflow, no widening, at every width. **The teardown AG.1 measured is
fixed, not contradicted** — AG.1-b (#199) replaced the DS `Listbox` (whose autofocusing search box
took focus out of the cell) with `agRichSelectCellEditor`, which has no search input. Their reading
and mine describe opposite sides of a landing.

⚠ **Still open, and a different column: `supplier_declared_dg_hz_regulation` does not open at all**
⟦measured⟧ — a real defect that the option-count hypothesis does not explain. → AG.1.

🔴 **A method note that cost a wrong reading first:** the check originally targeted the rightmost
**cell**, which was `ready:scope` — a readiness chip that is not editable — and abstained with "the
list never rendered". **An abstain about the wrong control is worse than a failure, because it looks
like a measurement.** It now targets the rightmost cell whose column is `kind: 'select'`.

**So the suspect list narrows to the floating-filter popups — and to a better candidate found in
§7.3, which satisfies this section's invariant and is still the bug.** Tell the Owner not to look
at the sheet's dropdowns for the widening complaint — and note that this is a *different* and
larger finding against their complaint (5), "the dropdown / select editors — the UX isn't really
great": on the master sheet those editors do not work at all. → **AG.1**, who found it and owns it.

This is also the second time tonight a surface passed a check for the wrong reason
(cf. `reference_a_scanner_passing_for_the_wrong_reason`): a popup that cannot widen the document
because it is destroyed 2ms after mounting is not a popup that respects the rule.

This matters for how the section is read: it is a rule to keep, not an indictment. A sweep that
starts from "every popup is suspect" will churn the DS and find nothing.

### 7.2 🔴 AG's popups are NOT body-portalled, and GRID.md §10 says they are ⟦DS.1⟧

AG's column menu is `position: absolute; z-index: 5`, parented to `.ag-popup` — **not**
`document.body`. It clamps correctly today, so this is **not a defect**; but GRID.md §10's blanket
"popups parent to `document.body`" is not true of AG's own, and a guard or review written against
that sentence would either fail AG wrongly or pass a real violator by looking in the wrong place.
The portal rule therefore binds **DS primitives**; AG's popups are held to the *outcome*
(flip/clamp/never widen), which they currently meet. GRID.md §10 needs the qualification —
PES.2 owns that document.

### 7.3 🔴 THE INVARIANT IN §7 IS INCOMPLETE — a live complaint satisfies it ⟦AG.1 + DS.1⟧

Double-clicking `item_name` / `bullet_point` / `product_description` opens **two things bound to the
same gesture**: AG's `agLargeTextCellEditor` popup *and* the record drawer. The drawer's reflow
shrinks the sheet by ~430px, and the popup ends up floating over the drawer's photo gallery —
detached from its cell, and from a column now hidden behind the drawer.

**`documentElement.scrollWidth` stays 1440 throughout.** Measured by both lanes. §7 as written
**passes it**, and the Owner is still looking at a dropdown-shaped panel on the right-hand side of
the page, over unrelated content. Their words were *"the dropdown sometimes opens to the right side
of the page"* — this matches them better than a clipped dropdown does.

**So §7 gains a second clause, and "never widens the page" is demoted to necessary-but-not-
sufficient:**

> **A popup must remain ANCHORED to the element that opened it** — same viewport region as its
> anchor — and it must **close or reposition when its anchor moves, is occluded, or is scrolled out
> of view.** A popup that outlives the position of the thing it belongs to is a defect even when
> the document never widens.

This is the clause DS.1's guard (DS1-8) must assert, and it is why that guard must test the
**outcome** rather than portal parentage: parentage would fail AG's correctly-clamping column menu
(§7.2) and pass this one.

**Two notes on the mechanism, because half of it is already fixed elsewhere in this spec:**
- The reflow half disappears under §5. A **slide-over does not resize the sheet**, so the popup's
  anchor never moves. The docked drawer is what moves it. That is a second, independent argument
  for §5's ruling, arrived at from the opposite direction.
- The occlusion half does not. A 520px overlay still covers the popup's anchor, which is exactly
  what §5.4 exists to prevent — and §5.4 is blocked on `ScrollApiModule`. **These are one problem.**

**And the gesture conflict is mine to rule on, not AG.1's or DS.1's** — it is the same class as
§5.2's Esc-ownership rule: one gesture may not have two owners, and here the editor has the better
claim, because the operator double-clicked a *cell*, not a *row*.

**Do not build the gesture from this section.** The full ruling, generalised to every column and
extended to Enter, is **§5.5**, and §5.5's table is the only place gesture ownership is assigned.
This section owns exactly one buildable statement: **the anchoring clause, whose sole owner is
DS.1.**

---

I own the invariant; DS.1 owns the primitives and the enumeration of violators; AG.1 owns AG's
popups and the surfaces above.

---

## 8. THE IDENTITY CELL — "a picture on the left"

### 8.1 The precedent, measured ⟦measured on /products/next⟧

Row height **85px**, thumbnail **56×56**, identity cell **320px**, AG header 47px. That is
`gridDensity.spacious` (`rowText 49 / rowMedia 85 / thumb 56`) — the Owner's own choice on that
page.

### 8.2 🔴 Copying it literally would undo everything §2 just won

At v2's **678px** of rows area ⟦derived, AppTopBar dropped⟧:

| tier | row height | thumb | rows visible |
|---|---|---|---|
| `compact.rowText` (today's height, no thumb) | 28 | — | **24.2** |
| 🟢 **RATIFIED (#182): 36px one-line row + 32px thumb** | 36 | 32 | **18.8** |
| `compact.rowMedia` (photo·title·sub stack) | 52 | 32 | **13.0** |
| `spacious.rowMedia` (/products/next exactly) | 85 | 56 | **8.0** |

The last row is worse than the layout the Owner just rejected. **A 56px thumbnail costs more rows
than the entire chrome saving wins.**

### 8.3 The recommendation

**A 32px thumbnail on a 36px single-line row — and the identity cell carries the THUMBNAIL ONLY.**

> 🟢 **AMENDED by the Owner (D12, §15.2): "There is no point having the SKU with the image… we
> already have a dedicated column for the SKU."** This section originally put a thumbnail *beside*
> the SKU in the identity cell and never said what happened to the text. **The SKU text appears in
> exactly one column — the dedicated `sku` — and nowhere else. The thumbnail stays; `rowMediaLine`
> is unchanged.** The Owner removed a duplication, not the picture.
>
> ⚠ **Take the consequence rather than discovering it:** the identity block was sized at 389px for a
> thumbnail *plus* text. With the text gone it needs a tree expander and a 32px thumb, so **it
> should shrink — and that width returns to the required columns**, which §9.1 is still 87px short
> of fitting at 1280. → PES.2 re-measures the block after the change rather than leaving it at 389.

**The thumbnail half needs nothing new — it is already token-correct.** `compact.thumb` is **32px**
(`tokens/grid.ts:46`, exposed as `--nds-grid-thumb-compact`), at the very tier the studio sheet
already runs. ⟦DS.1, verified against the tokens.⟧

**The row half is the ask, and it is a new ROW KIND, not a fourth density tier.** `rowMedia` is 52px
*because* `tokens/grid.ts:37` defines it as "a row whose identity cell carries a thumbnail
(photo · title · sub-line)" — the extra height buys the stack. The studio's identity cell has no
stack: SKU and Name are already their own columns. Adding a fourth number to the three tiers would
make "media" stop meaning one thing; adding a **non-stacking media row** beside it is additive and
disturbs no existing consumer. Geometry: 32px thumb + 2px above + 2px below = **36px exactly**.

**Status: 🟢 RATIFIED (#182) — the Owner chose the 36px row.** (Before the ruling this read "open, and nobody has refused it", which was the point: DS.1 stopped me costing a refusal that had not happened.) `tokens/grid.ts` sits in DS.1's claimed path but is
grid substrate by function. **Sole owner: DS.1** — ownership on this programme is by path, and
`design-system/tokens/grid.ts` is DS.1's. PES.2 consumes the new row kind; it does not add it.

**And the ratified row height is load-bearing beyond the thumbnail** — see §4.3: at 28px the v2
budget leaves the grid **zero scroll range**, so the collapsing header could never fire. The 36px
row is what restores it. The Owner's two answers turn out to depend on each other.

Why 32px is enough for the actual job: this family is 20 children differing by **Colore × Taglia**.
A 32px image separates BLACK from YELLOW instantly. It is not there to show the product — **the
full picture belongs at the top of the drawer's Record pane**, where opening a row shows the
product at 120px without spending a pixel on the other 20 rows.

Density stays operator-controlled through the existing `GridDensityToggle` (compact · cozy ·
spacious); the studio sheet's default is the ratified 36px one-line media row.

---

## 9. THE DEFAULT COLUMN SET — order and widths (content is ruling #173's)

Ruling #173 owns **which** columns. This spec owns **the order and the widths**, because those are
what decide whether the chosen columns are actually on screen.

### 9.1 The invariant

> **The identity block plus every column that is REQUIRED for this row's product type must fit
> without horizontal scroll at 1440.**

⟦measured: today at 1440, 2 of 7 required columns are visible. Under this rule, 7 of 7.⟧

### 9.1a 🔴 THE INVARIANT IS SCOPE-WIDE AND WAS ONLY EVER POINTED AT MASTER (#679/#684, measured 2026-09-02)

The sentence above says *this row's product type*. It does not say *master*, and for the life of this
spec it was measured on master OUTERWEAR and nothing else — so a suite that asserted on one scope
read as though it covered them all. **The check had never been pointed at half its own subject, and
no number in it was wrong.** The fixture now carries three coordinates permanently, every width,
every run of `npm run layout:v2`.

**Two things the first pointing found, and neither is a width budget.**

**(1) The rule itself was wrong on any scope with a right-pinned column.** §9.1 compared each header
against the grid ROOT box and subtracted no pinned section, so a column sitting *underneath* a pinned
column counted as visible. Master pins nothing on the right, so the defect was unobservable there for
as long as master was the only arm. A required column is visible when it lies inside the **scrollable
centre band** — root minus the pinned-left section minus the pinned-right section. One implementation
now, in the runner, band-aware, run at every coordinate; the in-page copy is deleted rather than
fixed, because two implementations of one rule drift.

**(2) The required set is a function of the COORDINATE, not of the product type.** ⟦measured, GALE-JACKET,
`/studio/columns`⟧ master·DE, master·IT and Amazon·IT each declare the same **seven**; **eBay·IT
declares ONE** (`brand`). §9.1 on eBay·IT is therefore 1-of-1 and cannot fail. A green that cannot go
red is not evidence, so the suite's W-4 control derives the set per coordinate, ASSERTS only on the
coordinates §9.1 actually measures, and prints the others' denominator so nobody counts a vacuous
pass. The invariant's wording should be amended to say *required at this coordinate* — a hub matter,
filed rather than decided here.

### 🟢 THE CONVERGENCE RECORD — after #724/#725 merged the identity band (#747, 18:11:05–18:13:40)

⟦`npm run layout:v2`, FULL suite, **18 states, ZERO drift, ZERO disturbance** — taken inside a
six-minute write hold with both writing lanes frozen. Verbatim run:
**`docs/2026-09-02-layout-v2-convergence-run.txt`** (sha1 `3722424b`), which carries the 📌 BUILD STAMP
of all twenty files with their sha1 digests.⟧

**The pinned geometry converged.** #724 moved the ⋯ verb menu into the identity band and retired the
channel's 56px `actions` column and both scopes' auto group column; #725 took the name off the band's
second line. The result is not merely "identical in shape", which is what the acceptance asked:

| | 1728 | 1440 | 1280 |
|---|---|---|---|
| master · DE/de | 7/7 (303 spare) | **7/7 (15 spare)** | 5/7 (+145) |
| master · IT/it | 7/7 (303 spare) | **7/7 (15 spare)** | 5/7 (+145) |
| Amazon · IT/it | 7/7 (303 spare) | **7/7 (15 spare)** | 5/7 (+145) |
| eBay · IT/it | 1-of-1 recorded | 1-of-1 recorded | 1-of-1 recorded |

**Pinned band: `447 = selection(43) + AutoColumn(404)`, identical on ALL FOUR coordinates at ALL
THREE widths, no right pin anywhere** — every side-by-side row reads delta 0. Confirmed by two
instruments taking different routes: this suite reads the header container, PES.3 derives from a
variant row via the engine's `findKeyBearingBand`. Same number, independent derivations.

**§9.1's 1440 margin is now 15px on every scope**, down from 73/73/122 before the merge. D11 is met;
it is met by the width of any further band content, which is the number the next change spends first.

**1280 re-baselined to 5/7 at +145 on all three** (#747, hub-confirmed). It moved by design — the band
grew — and the ratchet fired on all three as #733 predicted. See §9.1a's note on who may move a floor.

**eBay·IT is measured against its OWN required set**, which is one column (`brand`), and printed as
`1-of-1 … cannot go red at any width or any layout`. Its acceptance is the pinned clause only.

⚠ **One defect the full suite caught that a §9.1-only pass would have missed** — the reason the hub
overruled the focused mode for this run: **`§5.4 url-path-reveal:bullet_point @ 1280 — cell right 784
vs panel left 760, COVERED by 24px, `writes []`.** The reveal rule declined to move a grid the
operator cannot read. New since the band grew (the same check read `writes [38]` and clear pre-merge);
routed to PES.2 in `_studio/drawer/revealCell.ts`.

**§5.4's re-measured pair**, the banked `[64]/[82]/[112]` having been invalidated by the band moving
376 → 404: verb **`[122]` @1728 · `[140]` @1440 · `[40]` @1280**; URL path **clear / `[140]` / COVERED**.

🔴 **And §5.4's verb path had STOPPED MEASURING before this run.** Its anchor was
`.ag-cell[col-id="sku"]`, and #724 absorbed `sku` into the band — so on the merged build it returned
"ABSTAIN — no sku cell to start from" at all three widths. **Not a wrong number: an absent one wearing
an honest label**, which would have spent a held six-minute window producing three abstains on the
clause the window was called for. It now anchors positionally on the first scrolling-section cell and
prints which (`[from brand]`), with a guard that Escapes if the click opens an editor.

---

### 🟢 THE RECORD — D11 IS MET AT 1440 ON EVERY COORDINATE (#690, 2026-09-02 14:55:48–14:59:11)

⟦`npm run layout:v2`, 15 states measured, **no disturbance and no build drift** — the first run of the
day clean on its own terms, taken inside a write window PES.2 held open. Build, sha256 verified before
and sampled between viewport blocks: `MasterSheet.tsx` 14:47:36 `d91b159fba3e` · `ChannelSheet.tsx`
14:23:19 `bc46ef8a0ab6` · `views.ts` 14:31:27 `b6d73e5a53c4` · `presets.ts` 14:32:33 `f3b4d74abf20` ·
`contracts.tsx` 14:50:15 `2d50c655d145` · `grid.css` 14:23:09 `8e8e44e5bf58`. Load 2.24–3.29 inside
every reading.⟧

| coordinate | 1728 | **1440** | 1280 |
|---|---|---|---|
| master · DE/de | 7/7 (361 spare) | **7/7 (73 spare)** | 6/7 (+87) |
| master · IT/it | 7/7 (361 spare) | **7/7 (73 spare)** | 6/7 (+87) |
| Amazon · IT/it | 7/7 (410 spare) | **7/7 (122 spare)** | 6/7 (+38) |

Nine of nine cells match the prediction stated before the build landed, and four independent readings
agree — three runs of this suite and PES.3's own instrument with a different selector set.

**Two things worth reading off the table rather than the verdict.** With the axes behind the required
block the MARKET no longer moves the result: master·IT is identical to master·DE at every width, which
is what the third coordinate was added to detect. And the asymmetry #679 opened with has **reversed** —
at 1280 the CHANNEL is 49px better than master (284 + 56 beats 389 + 0). Anyone re-reading the old
"the channel is the deficient scope" into this table would have it backwards.

**1280 is RULED not to be D11's bar (#693).** What remains there is the required block's own 910px
(160/110/130/130/160/110/110, contract-declared and identical on both scopes) against an 823/872px
band: no chrome term is left to spend, so it is a question about the seven declared widths and it is
recorded as the residual, not chased.

**Before that change, on the same day** ⟦PES.3, `ChannelSheet.tsx` 14:23:19; measured 14:27–14:35⟧ —
the reading that showed **the residual was the SHARED RULE, not the channel**:

| coordinate | 1728 | 1440 | 1280 |
|---|---|---|---|
| master · DE/de | 7/7 (361 spare) | **7/7** (73 spare) | 6/7 (+87) |
| master · IT/it | 7/7 (201 spare) | **6/7 (+87)** | ⚠ NOT MEASURED — no rows in 30s |
| Amazon · IT/it | 7/7 (186 spare) | **6/7 (+102)** | 4/7 (+262) |

master·IT failed D11 at 1440 with no channel involved. The controlled pair (market fixed) read
`required block 910 wide on both, 0px of non-required columns inside it on both`, and the verdicts were
equal at 1728 and 1440 — the 15px of pinned-band difference decided nothing at any width. What was
left was `color` in front of the block wherever the market makes it `per_variant`, which #690 moved.

⚠ **A prediction of mine that missed, recorded because the miss is the useful part:** I predicted
Amazon·IT 1280 at 5/7. It measures **4/7**. The shortfall I gave (+262) was exact; the count was not —
I missed that `fabric_type` ends at 1134 against a band ending 1092, and listed only two covered
columns. The shortfall and the fits count are different questions and getting one right is not
evidence for the other.

**Before that change, same day** ⟦stamp: `MasterSheet.tsx` 14:17:06 · `ChannelSheet.tsx` 13:22:40 ·
`views.ts` 06:14:05 · `columns.tsx` 13:22:38 · `grid.css` 13:30:12; load 3.4–4.6 captured inside each
reading; GALE-JACKET; fresh browser context, so the DEFAULT view and no persisted column state⟧:

| coordinate | 1728 | 1440 | 1280 |
|---|---|---|---|
| master · DE/de | **7/7** (361px spare) | **7/7** (73px spare) | 6/7 (+87) |
| Amazon · IT/it | 5/7 (+144) | **3/7 (+432)** | 2/7 (+592) |

Every arm passed an arithmetic closure control — `pinnedLeft + Σ(centre widths) + pinnedRight ===
root.scrollWidth` — and the verdict ABSTAINS when it does not close, because a stitch that missed
columns under-reports rather than failing. Master@1440's 73px spare independently reproduces §9.3b's
own recorded figure, which is what says the instrument is reading true.

**Where the 505px goes at 1440** ⟦root 1372 on both⟧ — and it is *not* the leading band, which the
channel spends 105px LESS on:

| | master · DE | Amazon · IT | delta |
|---|---|---|---|
| pinned LEFT band | 389 (selection 43 + auto 76 + sku 180 + completeness 90) | 284 (auto 44 + `__identity` 240) | **−105** |
| pinned RIGHT band | 0 | 120 (`actions`) | **+120** |
| centre band available | 983 | 968 | −15 |
| the required block itself | 910 | 910 | 0 |
| non-required columns INSIDE that block | 0 | **490** (`name` 220 + `productType` 160 + `status` 110) | **+490** |
| last required column ends at | 1299 | 1684 | +385 |
| **shortfall** | **−73 (spare)** | **+432** | **+505** |

**The mechanism, read from source rather than inferred:** `orderColumnKeys` — §9.2/§9.3b's RENDER
order — has exactly two call sites, both in `MasterSheet.tsx` (`:932`, `:1115`). `ChannelSheet.tsx:84`
imports only `defaultViewColumns`, which decides what is VISIBLE. So the channel renders in CONTRACT
order, which is precisely the arrangement §9.3b measured on master as *"only 3 of the 7 required
columns reachable"* and fixed by moving `name`/`status` behind the required block. **The channel never
received the fix.** D11 is one missing shared import plus a 120px right pin, not a budget to re-cut.

**🔴 RETRACTED, and it was mine: #679's channel line (1728 7/7 · 1440 6/7 · 1280 4/7).** It is not
reproducible. One cause is proven — the root-box rule above, worth 120px on this scope — and it does
not account for the whole gap, so the residue is recorded rather than explained away: channel
`scrollWidth` reads **2444** today against **2599** at #679, on a `ChannelSheet.tsx` whose mtime has
not moved and whose content cannot be diffed because nothing is committed.

**🔴 A §9.1 READING IS NOT A FUNCTION OF THE BUILD ALONE, so it must carry its column SET.** The
default view admits readiness-`flagged` keys (`views.ts:210`) and the family's variation axes ahead of
everything (`:195`), both of which depend on the fixture's DATA — and several lanes write GALE-JACKET.
Pinning the coordinate is necessary and not sufficient. Every §9.1 verdict now prints the pinned
bands, the centre band, `scrollWidth` and the full centre column set beside it, so two runs are
comparable and a changed set is visible instead of silently moving the number.

**🔴 AND THE COORDINATE IS THE MARKET AS WELL AS THE SCOPE — a confound I published before catching.**
I reported `color.scope` as a master-vs-channel difference from two payloads that differed in *both*
scope and market. PES.3 varied one at a time; it is the MARKET. ⟦measured: master·DE `global` ·
master·IT `per_variant` · Amazon·DE `global` · Amazon·IT `per_variant`⟧ At IT, `color` is
`per_variant` and matches `variationAxes ["Colore","Taglia"]`, so rule 1 hoists it ahead of the
required block on *either* scope. **`master · IT/it` is therefore a permanent third coordinate**, and
the suite prints two side-by-sides per width: master·IT vs Amazon·IT with the market held fixed — the
only pair that can name a scope difference — and the historical master·DE pair, labelled in the output
as one where both variables move.

Two grid defects found on the way, filed to the hub, not decided here: the axis match is
**orthographic** — `color` matches "Colore" only because `'colore'.includes('color')` (`views.ts:137`)
while `size` matches "Taglia" by no clause, so a family varying on two axes hoists one; and rule 1
does not consult `defaultVisible`, so `defaultVisible: false` does not predict what is on screen.

### 9.2 The ordering rule — and it inverts today's

**identity → required-and-incomplete → commerce spine → the attribute band → NON-INTERACTIVE LAST.**

> 🔴 **AMENDED (#690): the variation axes stay in, IMMEDIATELY AFTER the required block — not in
> front of it.** Rule 1 of `defaultViewColumns` put them first, and the reasoning was sound on the
> coordinate it was written against: on a family varying by Colore × Taglia those columns are how an
> operator tells one row from another, so they belong early. But "early" was implemented as "before
> everything", and at any market where an axis column is `per_variant` that is 160px in front of the
> required block — which is the same displacement §9.3b removed when it moved `name` behind it.
> ⟦measured 2026-09-02, GALE-JACKET: master·IT and Amazon·IT both 6/7 at 1440, +87 and +102, with a
> required block that is otherwise identical on the two scopes.⟧ The axes are still ahead of the
> spine and still in the default view; they are simply no longer between the operator and the fields
> the sheet exists to fill. **This was never a channel defect** — it failed on master at the same
> market, which is what a coordinate-complete §9.1 fixture is for (§9.1a).

> 🟢 **The attribute band is ordered BY GROUP, then schema order within a group** (#475). "The rest"
> is most of the 95 columns, and schema order alone is cache order — ⟦PES.2: a column enabled in
> Customise lands at the cache-ordered end of the band⟧, which is arbitrary from the operator's
> side. **The Customise dialog already sections by `col.group`; the sheet should agree with the
> dialog an operator just used to turn the column on.** A grouped tail is navigable at 75 columns
> where a cache-ordered one is not.
>
> The required block and the spine are unaffected by construction — they are named by the rule
> before the band begins. → PES.2 implements, then re-measures §9.1.

> 🟢 **The tail is ruled (#448), and it comes from a measurement rather than a preference.** The
> last 520px of the column model can never be cleared of an overlay panel — ⟦measured: on master
> those are `productType`, `dsa_responsible_party_address`, `gpsr_safety_attestation`,
> `ready:scope`; on eBay·IT just `actions`⟧. **Two of master's four are fields ruling #173 puts in
> the view precisely because they are flagged on 104 of 120 rows**, so an operator opening a record
> from the cells the view exists to surface lands in the one region no scroll can rescue.
>
> **Put only columns an operator never opens a record from in that band** — `ready:scope`,
> `actions`, chrome. Then the uncoverable region is harmless **by construction, at zero rendering
> cost and no layout change.** eBay·IT already satisfies it by accident; master needs two columns
> moved.
>
> ⚠ **It shrinks the problem rather than removing it:** a Customise'd view can put anything last,
> and a wide required set could still push an attribute into the band. The §5.4 inset stays **held**
> for exactly that residue, pending the frame reading.
>
> 🔴 **AND THE TAIL DOES NOT APPLY TO A FITTED SCOPE AT ALL — a consequence I left implicit and the
> hub drew out (#470).** On a scope whose columns flex to fill (eBay·IT: `content === client` at
> every width), **the band at 1440 is 520 of 1,372px — 38% of the sheet.** No ordering of real
> columns can keep 38% of a sheet non-interactive; there are not enough chrome columns, and
> inventing some would be worse than the problem.
>
> **So: the tail mitigates SCROLLING scopes only. For fitted scopes the §5.4 mechanism is the only
> fix** — which *raises* the value of the frame reading rather than lowering it, and is the opposite
> of what my third option looked like when I proposed it. **A lane that applies the tail to a fitted
> scope and calls the case closed has fixed nothing at the width where it bites.**

Today the order is identity → filled columns (brand, name, productType, status) → required ones.
The result ⟦measured⟧ is that the columns you can see are the ones already done and the columns
off-screen are the work. Inverting it costs nothing and is the single highest-value change in this
section.

### 9.2a 🔴 The ordering rule has THREE preconditions, none of which is met today ⟦AG.1, measured⟧

§9.2 is not a config change. 🟢 **All three are settled with AG.1 and accepted as spec (#182).** They must land together:

1. ~~**No married column groups.**~~ 🟢 **MET (#232, verified by grep as the caveat instructed).**
   `columns.tsx:323` returns before the grouping branch (`if (!grouped) return built`) and `grouped`
   defaults to `false` at :130 — the studio sheet never opts in, so `marryChildren` is **unreachable
   for this sheet**. The code path survives for a caller that passes `grouped: true` and never pins;
   that is deliberate, and it is why the check is a grep and not a DOM read.
2. 🟢 **`applyOrder: true` — MET (#232)**, so §9.2's declared order now reaches the screen.
3. **A decision about whose order wins on reload.** `useGridState` writes AG's entire
   `api.getState()` — column order and pinning included — to
   `localStorage['nds-grid:product-edit:master:v1']` on **every** `stateUpdated` (400ms debounce)
   and feeds it back as `initialState` at mount. **Anyone who has ever dragged a column carries
   that order forward across reloads**, and `applyOrder: false` means the landing view can never
   correct it. → **The rule wins on a fresh load; an explicit operator reorder wins until they
   reset — and "Reset columns" becomes a real menu item.** It is not offered today: `columnDialog`
   passes only `customise`, so AG's own Reset was removed and nothing replaced it. AG.1's
   recommendation, adopted. 🟢 **MET (#232): Reset columns restores order, sort, pins, widths and
   hidden state.**

**A separate defect found in the same sweep, which this spec does not own but records because it
would eat §9.2's benefit:** a view change **destroys operator state**. AG.1 set `name:asc` and
pinned `productType` left, switched Overview → Content, and measured **sort gone, pin gone, width
kept** — `prefsToColumnState` emits an explicit `sort: null` / `pinned: null` for every column while
`applyPreset` hard-codes `sortBy: ''`. Reordering columns for the operator is worth little if
changing view throws away the sort they came for. → AG.1 / PES.2.

### 9.2b 🟢 HEADERS ARE ENGLISH ON EVERY SCOPE; THE CHANNEL'S LABEL IS IN THE TOOLTIP (D10)

⟦measured: on market DE the master sheet renders `Markenname *`, `Aufzählungspunkt *`,
`Gefahrgutvorschriften *` — the **channel's own localised labels**, as column headers.⟧

> **RULED (Owner, D10): the header carries the ENGLISH attribute name on every scope. The channel's
> own label moves into the header tooltip — and the tooltip NAMES THE CHANNEL.**

**The naming clause is not decoration.** The same field has a different label per channel, so a bare
foreign string in a tooltip does not say *whose* it is; an operator seeing `Gefahrgutvorschriften`
needs to know that is Amazon·DE's name for it, not a second field. Same rule as §9.6's provenance
mark and §9.3a's `near`: **an adornment names its source.**

**And it removes a comparability hazard that the scale frame (§16) makes worse.** Today an operator
moving between Amazon·DE and eBay·IT reads two vocabularies for one field, so **a column cannot be
recognised across scopes by sight** — at a thousand SKUs across many coordinates that is the
difference between a sheet you can scan and one you must decode. → PES.5 (contract),
PES.2 / PES.3 (headers).

### 9.3 Widths

| column | today | v2 | why |
|---|---|---|---|
| `name` | 380 | **220**, on EVERY scope | ⟦re-measured, see §9.3c⟧ 21 rows, **3 distinct** values, and the first difference falls at **character 127** — so no practical column width distinguishes them. My earlier "all 21 identical" was imprecise; the corrected reading is a stronger argument, not a weaker one |
| `description` | 320 | out of default | long-form; the drawer's job |
| `item_name`, `bullet_point`, `product_description` | 160 each | **110 each** | 160px cannot show a bullet point either. In the sheet their job is *filled / empty / over-cap*, not content. **The expanded editor already exists** ⟦AG.1⟧ — `longTextEditor()` → `agLargeTextCellEditor` with `cellEditorPopup: true`, an 8×60 textarea, so editing has never happened in the cell. **But 110px only works with §9.3a** |
| identity block | 389 | **389 + thumb delta** | §8 |

**§9.3a — "state, not count", and it is the condition on the 110px** ⟦AG.1⟧.

> 🟢 **AMENDED (#369): FOUR marks, not three — `empty · filled · near · over`.** The line
> *"render the state as a MARK (filled · empty · over-cap)"* enumerated three states because those
> were the three I knew about; **`near` (amber at ≥80% of the tightest channel cap,
> `cells.tsx:339`) already exists and I did not list it.** My argument was about the **counter** —
> "127/200" occupying most of a 110px cell — and never about how many states there are, so the
> superset is consistent with it rather than a deviation from it.
>
> **And it earns its mark on §9.6b's test, applied to a different vocabulary: does the state change
> what the operator does next?** Four genuinely different next actions — *nothing here yet* ·
> *fine* · *you have about a fifth of the room left* · *already refused*. **`over` is too late to
> be the first notice**: by then the value is one a channel will reject, and the operator has
> written it. A warning that only arrives after the refusal is a receipt, not a warning.

**Three conditions on `near`, because it is the one that can mislead:**
1. **It must name WHICH channel imposes the cap** ⟦§9.6's rule: a mark names its source⟧. "80% of
   the tightest cap" is meaningless alone — a master-sheet value near eBay's cap but far from
   Amazon's needs to say *eBay*, or the operator cannot tell whether shortening it is worth it.
2. 🔴 **Where no cap is known, there is no `near` and no `over` — and the cell must not imply a cap
   exists.** ⟦measured: the `caps` pill exists precisely because a product type can have no cached
   schema, so "those columns carry no length caps or closed lists"⟧ **The absence of a cap is not
   compliance with one.** A cell that looks `filled`-and-fine because nothing was checked is the
   §6.4 family again: a state asserted from missing information.
3. **`near` and `over` must be distinguishable without colour.** Amber and red are the same mark to
   a large minority of operators; the glyph carries it, the tone reinforces it.

> 🟢 **RULED (#373): a FIFTH state `unchecked`, and it is SILENT in the cell.** ⟦AG.1: `maxLength`
> is absent on **60 of 96** columns, so "no known cap" is the majority case, not an edge.⟧
>
> **A mark on 60 of 96 cells is the "hundred marks saying one thing" failure** (§9.6c) — the marks
> that matter (`empty`, `near`, `over`) lose their salience when most cells carry one. And the fact
> is a property of **our knowledge**, not of the row: repeating it per cell states 60 times what is
> true once.
>
> 🔴 **The condition that makes silence honest, and it is a dependency rather than a preference:
> `filled` MUST carry a visible mark.** Silence only means *"no cap is known here"* if *"within a
> known cap"* looks different. **If a later design makes `filled` silent too, this ruling flips and
> `unchecked` takes the mark** — the distinction has to live somewhere, and it is cheaper on the
> minority state. Whoever changes `filled` owns re-reading this line.
>
> **The sheet-level fact has a home already: the `caps` notice** — *"no cached Amazon schema for X,
> so those columns carry no length caps or closed lists"* — which §6.3 correctly let keep its
> warning glyph because it is a real warning. That is §9.6c's mark/notice split applied again: the
> **mark** answers "what about this cell", the **notice** answers "did we know at all". The cell's
> tooltip says it plainly for the operator who asks.

> 🔴 **AND `unchecked` MEANS "NO CAP KNOWN HERE", NEVER "NO CAP EXISTS"** — a distinction AG.1's own
> second finding makes load-bearing rather than pedantic: `product_description` carries
> `maxBytes: 20000`, and it **reaches the cell as a unit flag with the cap itself dropped**.
> *"A cap that was never passed is not an absent cap."* So some of the 60 are not uncapped, they are
> **undelivered** — the model must not let `unchecked` harden into a claim about the field. Third
> variant tonight of the same class: the information exists upstream, something in the middle drops
> it, and the consumer cannot tell absence from loss (cf. §6.3's renderer ignoring `tone`, and the
> `?? 'DRAFT'` default). → PES.2 has the wire half. `LongTextCell` renders
a numeric counter ("127/200") *beside* one line of text. At 160px it already truncates to
`XAVIA G…`; at 110px the counter would be most of the cell — the width saving would be spent on the
least useful half of the cell's content. **So: render the state as a MARK (filled · empty ·
over-cap) and move the numeric counter to the tooltip.** That is exactly the argument used to
justify 110px in the first place, applied to the cell's own contents rather than only to its width;
keeping both at 110px would be taking the saving without honouring the reason for it. AG.1 owns the
renderer and has taken it.

⟦derived⟧ Identity 389 + 7 required at 110–130 (810) = **1199 of 1372 at 1440**, leaving 173px for
the commerce spine before the fold. The invariant holds.

### 9.3d 🟢 `item_name` / `bullet_point` / `product_description` = 110 ON EVERY SCOPE

Same question as §9.3c, same answer, and **the reason is even less scope-dependent than `name`'s
was.** §9.3's argument was never about the master scope: *160px cannot show a bullet point either;
in the sheet these cells' job is `empty · filled · near · over · unchecked`, not content* (§9.3a).
**That is a fact about the FIELD KIND — long text against a channel cap — and it is the same field,
with the same marks, on every scope.** There is no scope on which 160px starts showing a bullet
point.

> **RULED: 110 on every scope. PES.5 does both in one write.**

⚠ **One thing to watch rather than pre-solve, and it is genuinely channel-specific:** the channel
scope is where a cell can carry **two** marks at once — §9.3a's long-text state *and* §9.6's
provenance mark (a `mapped` value resolved by a rule). At ~20px a chip that is ~40px of a 110px
cell. **The cell's job is state, so two states in a state cell is the design working** — but if the
pair does not read legibly at 110, **bring me the measurement rather than widening the column**: the
answer would be a combined mark or a smaller chip, not 160px back, because widening returns us to a
cell that shows neither the content nor the state clearly.

### 9.3c 🟢 `name` = 220 ON EVERY SCOPE — and checking the premise made the case stronger

⟦#376: PES.5 serves 220 from the contract on master only, because §9.3 said "master".⟧

**I checked my own premise before extending it, and it was wrong in the detail.** §9.3 said *"all 21
rows carry the identical 100-char parent title"*. Measured on eBay·IT: **21 cells, 3 distinct
values, 127 characters long** — 19 identical, plus one `(XS, Nero)` and one `(XS, Giallo)`.

**But the correction strengthens the ruling rather than weakening it**, and this is the number that
settles it:

> **The first difference between any two of the three values falls at character 127 (and 133).**
> They are byte-identical for their first 127 characters.

A 380px column shows roughly 45–50 characters; a 220px column shows roughly 26–30. **Neither reaches
character 127.** So widening `name` from 220 to 380 buys **nothing in discrimination** — it spends
160px to show more of a prefix that is the same on every row. The text that actually distinguishes
these rows is `(XS, Nero)` / `(XS, Giallo)` at the tail, and the **Colore × Taglia variation axes
already carry it as their own columns**, legibly, at a fraction of the width.

> **RULED: `name` is 220 on every scope. PES.5 adds the line; PES.2 deletes their client map.**
> Serving it from the contract for one scope and not the other would leave the client compensating
> for a contract that disagrees with itself.

**And it pays for itself immediately on the channel scope, where the arithmetic differs from
master's** ⟦measured at 1440⟧: eBay·IT is **1,404px of columns against a 1,372px grid area — a 32px
overflow.** Narrowing `name` saves 160. **The eBay channel sheet then fits entirely at 1440 with no
horizontal scroll at all** — the first scope in this programme to do so.

### 9.3b 🔴 THE WIDTHS ALONE ARE NOT ENOUGH — `name` must move, and it is not identity here

⟦measured 1440, post-§9.2⟧ `name` is still **380**, and `item_name` / `bullet_point` /
`product_description` are still **160** — §9.3's widths have not landed. But applying them alone
does **not** satisfy §9.1, because the order puts `name` (380) and `status` (110) *between* identity
and the required block:

```
with §9.3's widths only:  identity 389 + name 220 + status 110 = 719
                          7 required need 910 → 1,629 of 1,372   ✗ still fails
with `name`/`status` moved after the required block:
                          identity 389 + 910 = 1,299 of 1,372    ✓ 73px spare
```

> **RULED: `name` is NOT an identity column on a family sheet, and §9.2's order takes it
> literally — identity, then required-and-incomplete, then the spine.** The evidence is already in
> §9.3: all 21 rows carry the **identical** 100-character parent title, so it is the least
> discriminating column on the sheet while being the widest. It identifies the *family*, which the
> header already names; it does not identify the *row*.

**So §9.1 needs both changes, and neither is sufficient alone** — the widths *and* `name`/`status`
after the required block. That is the difference between 3 of 7 and 7 of 7 at 1440.

⚠ **And the honest limit: 7 of 7 does not fit at 1280** (1,299 needed, 1,212 available). §9.1's
invariant is stated *at 1440* and that remains the bar; **1280 is below it by 87px and no width
change closes that without hiding a required column.** Stated so nobody reads a 1280 failure as
unfinished work.

### 9.5a 🔴 WHAT PERSISTS, AND THE DISTINCTION THAT SETTLES THE SCROLL QUESTION

> 🟢 **AMENDED 2026-09-04 (Owner, design V.2/V.8):** `columnVisibility` and `columnOrder` are no
> longer persisted on either scope — membership and order come from the active VIEW, and the sheet
> lands on every column unless an explicit default view exists. Widths, pins and sort still persist,
> per scope key, through `useGridState`'s `persistKeys` (`['columnSizing','columnPinning','sort']`,
> `_studio/sheet/useSheetColumns.ts`). The scroll rule below is unchanged.

⟦#429: `ChannelSheet.tsx` uses `useGridState` zero times and passes no `initialState`; master does
at `:1392`. So the deep-link race cannot happen on a channel scope — **because the channel scope
remembers nothing at all.**⟧

That is §14.1's finding again from the persistence side: **a scope is not a different application.**
An operator who widens a column on eBay·IT and returns to find it reset is being told the two
surfaces are different products.

**🔴 The distinction the whole question turns on, which §9.5 did not draw and should have:**

> **CARRY WITHIN A SESSION is not the same as PERSIST ACROSS SESSIONS.** §9.5 ruled that sort,
> column state, scroll and selection survive a scope/market/tab switch — that is *carry*, and it
> stands. Writing the same things to `localStorage` so they outlive the browser is a **different
> decision**, and it is the one that produced #425's race.

**(1) What a channel scope persists** — per coordinate:

| | persists across sessions | why |
|---|---|---|
| column **order, width, pinning, visibility** | **yes** | the operator set them; §14.1 says the scope is not a different application |
| **sort** | **yes** | same |
| **view** | **nothing to persist yet** | #173's default is *derived*, and Views is `absent` on a channel scope — an operator's Customise choices are already column visibility, above |
| **selection** | **NO** | a selection is an in-session intent about what you are about to act on. Restoring one a day later lets an operator run a bulk verb against a set they do not remember choosing. §9.5's cross-scope carry is within a session and stays |
| **horizontal scroll** | **NO** — see (2) | |

🔴 **The key must include the coordinate.** Channels have different column sets; one key for all of
them lands eBay's widths on Amazon's columns. `product-edit:<scope>:<market>`, not
`product-edit:master`.

**(2) Master's `scroll` persistence — I am withdrawing it across sessions, and the reason is not the
race.**

#425's omit-when-the-URL-names-a-cell fix is correct and stays. But there is a stronger argument
against cross-session horizontal scroll that I had not seen when I wrote §9.5:

> **A restored horizontal scroll silently undoes §9.2.** The ordering rule exists so that an
> operator opening the sheet sees **the work** — identity, then required-and-incomplete, then the
> spine. Restoring a 1,227px scroll on every load lands them past all of it, on whatever they
> happened to be looking at last time. **The default view's ordering is a decision about what
> matters; a restored scroll is an accident of where someone stopped, and it overrides the decision
> on every single load.**

- **Horizontal scroll: not persisted across sessions.** Carried within one (§9.5).
- **Vertical scroll: may persist.** It competes with nothing — there is no ruling about which *row*
  an operator should see first — and on a long sheet it is genuinely useful.
- This makes #425 belt-and-braces rather than the only guard, which is the right relationship: the
  within-session carry could still race a deep link, and the omit still catches it.

→ **PES.2** (the `useGridState` option and master host), **PES.3** (channel host, coordinate-keyed).

### 9.6 🔴 A DERIVED VALUE IS A PROVENANCE STATE, NOT A COLUMN

⟦#337: `mapped` — PES.6's resolver output, provenance and all — is carried by the sheet contract and
**rendered nowhere**. #295 asked PES.2 to wire a notice "beside the 🔗 column"; there is no 🔗
column. PES.2's `mappingNotice()` is built and waiting.⟧

> **RULED: a derived value renders in the CELL THAT HOLDS IT, as a provenance mark. Not a column.**

**Why not a column.** A column duplicates the value and spends width the sheet does not have — §9.1
already fights to fit identity plus the required set at 1440, and §1.3's whole finding is that the
sheet is short of screen. A second column showing where the first one came from is the most
expensive possible way to say it.

**Consume the existing vocabulary — do not mint one.** `classifyProvenance` + `ProvenanceMark` +
the `.nds-cell-is-*` classes already exist and already carry inherited / pinned / ai-draft /
inheritedOverride. **A derived value is another layer in that cascade**, and ruling #11's anti-fork
directive applies: extend `classifyProvenance`, never add a local mapping. Tell PES.2 what the
cascade cannot express; they extend it.

**Three requirements on the mark:**
1. **It names its source** — which rule produced the value — reachable without hover being the only
   way (§6's rule: hover may elaborate, never carry).
2. **Distinguishable without colour** — a glyph, per the tag-identity rule. It sits beside ✎ and 🔗
   and must not rely on tint to be told apart from them.
3. **No fallback.** If mapping fails the cell shows the honest absence, never a substituted value —
   §6.4's `?? 'DRAFT'` class exactly.

### 9.6a 🔴 `productLevelOnly` IS ITS OWN STATE, and it is the one that will be got wrong

Mapping succeeded at **product** grain, so every alias of that product shares the value.

> **On a channel scope with multiple aliases, rendering that value identically on every alias row
> WITHOUT saying it is shared asserts something false**: it reads as N independent resolutions that
> happen to agree. It is one resolution shown N times.

And it has a consequence the operator must see **before** they act, not after: **editing it in one
row changes it for every alias.** A per-row-looking cell that is actually a shared value is the same
failure family as §6.4's invented state — the display implies a grain the data does not have.

> **RULED: `productLevelOnly` gets its own mark, distinct from the ordinary derived mark, and the
> cell states that its scope is the product rather than this alias.**

**Is the display v1 scope? Yes — and this is the line to put to the Owner:** without the mark, a
derived value on screen is **indistinguishable from a value someone typed**. Every honesty rule in
§6 exists to stop exactly that, and a mapped value silently wearing a typed value's clothes is a
worse instance than the ones already fixed, because it is *correct data* — nobody will ever notice
it is wrong to trust it as hand-entered. **The value shipping without its provenance is the
regression; the mark is not decoration on top of a feature, it is the half that makes the feature
honest.** → PES.2 (mark + `mappingNotice()`), PES.6 (source naming), PES.3 (channel-scope aliases).

### 9.6b 🔴 PRECEDENCE: `ai`/`aiStale` > `mappedShared` > `mapped` > the existing chain

> 🔴 **SELF-CORRECTION (03:3x), found by applying #369's lesson to my own ruling within the hour.**
> I ruled a precedence over a set I named from other lanes' messages rather than from the code.
> The real union is **eight** members — `own · inherited · inheritedOverride · pinned · ai ·
> aiStale · mapped · mappedShared` (`provenance.ts:49`) — **and I named six**, omitting `own` and
> **`aiStale`**. The ordering I ruled is correct and PES.2 implemented it correctly, including
> placing `aiStale` at the top with `ai`; but *"the existing chain"* was me gesturing at a set I had
> not read. **A spec that lists states is asserting a set — the second time in an hour, and this
> time in the ruling that was written to stop a vocabulary sprawling.**
>
> - **`aiStale` sits WITH `ai` at the top**, and it is right under the stated principle: *a machine
>   proposed this, nobody agreed, and the value it was drafted from has since changed* demands a
>   decision more urgently than `ai`, not less.
> - **`own` is the terminal state, not a precedence question** — it is what remains when nothing
>   else claims the cell.
> - **The member is `mappedShared`, not `productLevelOnly`.** `productLevelOnly` is the CONTRACT
>   field; `mappedShared` is the vocabulary member derived from it. Naming the contract field in a
>   spec sends the next reader grepping for a member that does not exist.


PES.2 asked where `mapped` ranks, and offered the case against their own recommendation. Ruled with
their placement — **and on a sharper principle than the one they cited.**

**The stated principle in `classifyProvenance` is "the weaker claim wins the mark", but that is not
what makes `ai` outrank everything.** `ai` wins because *"a machine proposed this and nobody has
agreed"* is the fact that most changes what the operator does next — it demands a decision. So:

> **PRECEDENCE IS BY WHICH FACT MOST CHANGES THE NEXT ACTION**, not by which claim is weakest.
> Weakness correlates; it is not the rule.

Under that, `mapped` above `inherited` is right, and for a stronger reason than "weakest":
**`mapped` is the mark that redirects the operator to a different surface.** An inherited cell is
edited *here* (and editing pins it); a mapped value is computed at read time and stored nowhere, so
the click that changes it is the **rule**, not the cell. Marking it `inherited` promises that reset
returns the master's value — **and what is on screen was never the master's value, it is a function
of it.** That is #16's defect shape exactly: a mark that misdescribes what the next click does.

**The case against, answered rather than dismissed.** PES.2's objection — a mapped value derived
from an inherited one is still inherited, and the `mapped` glyph hides which layer fed the rule —
is real, and it is **already answered by a requirement in §9.6**: the mark must name its source. The
provenance *chain* is genuinely secondary information; the primary fact is that this cell is not
where the value is decided. A tooltip is the wrong home for a primary fact and the right home for a
chain.

> 🔴 **AND THE RULE THAT STOPS THE VOCABULARY EXPLODING, since #16 set the precedent for splitting
> a combination out: a combination earns its own member ONLY when it changes where the next click
> lands.** `inheritedOverride` earned one because reset lands somewhere different.
> "mapped-from-inherited" and "mapped-from-pinned" do not — in both, the cell is not the place —
> so they share `mapped` and the tooltip carries the chain. Without this rule the vocabulary is
> layers × sources.

**`mappedShared` (from the contract's `productLevelOnly`) ranks ABOVE `mapped`**, and is its own member as PES.2 proposed. It *implies*
mapped (it is a mapping that resolved at product grain), so it is a refinement rather than a
sibling — and it outranks because **editing one row changes N**, which changes the next action more
than "this is derived" does.

### 9.6c 🟢 THE MARK AND THE NOTICE ARE NOT REDUNDANT — `mappingNotice()` survives

PES.2's boundary, ratified in their terms because it is right:

> **The MARK answers "where did THIS CELL's value come from". The NOTICE answers "did the RUN answer
> at all".**

The cold-process state needs both to be silent in different ways: **no mark** (nothing was derived,
so there is nothing to mark) plus a **footer note** — *"Derived values unavailable — retrying"*.

**If the mark tried to carry that, every cell in the sheet would wear a mark meaning "we couldn't" —
a hundred marks saying one thing.** That is §6.4's rule from the other side: a value that was never
measured must not wear a measured value's explanation. The notice goes in the footer, where §6.5
already put the refusal; the height does not change, only the content.

### 9.4 Channel scopes get the same rule

The eBay·IT default view is **15664px** ⟦measured⟧. Ruling #173's rule was applied to master and
not to channels. **Sole owner: PES.3** — the channel sheet is theirs
(`_studio/sheet/channel/**`). PES.2 owns the substrate the rule runs on, not the channel column set.

> 🔴 **2026-09-02 (#684): this section was right and had never been measured.** §9.1a quantifies it —
> the channel takes `defaultViewColumns` (what is visible) and not `orderColumnKeys` (the order), so
> §9.3b's fix is master-only and 490px of non-required columns sit inside the channel's required
> block. Not a width budget: one shared import. The 120px right-pinned `actions` column is a second,
> separate question and is the hub's to rule on PES.3's report.

---

## 10. MOCKUPS

### 10.1 Master · 1728×906 · scroll = 0 · drawer closed

```
┌──┬───────────────────────────────────────────────────────────────────────────────────────────────────────┐ 48   y=0 — no AppTopBar (#182)
│  │ ‹ Products  XAVIA GALE Giacca Da Moto…   GALE-JACKET  B0F7J163XJ  ●Active  Parent   Autosave ✓  ⋯  [Publish ▾]│
│▦ ├───────────────────────────────────────────────────────────────────────────────────────────────────────┤ 40
│  │ Scope [Master 71%][Amazon 71%][eBay —][Shopify][WooCommerce][Etsy]   Sheet Images Analytics&Ads Activity   [DE ▾][de ▾]│
│▤ ├───────────────────────────────────────────────────────────────────────────────────────────────────────┤ 40
│  │ Parent · 21 rows · 20 variations · Colore × Taglia   ⌕ Find…      [Overview ▾]  [Customise]  [Reload] │
│▥ ├───┬────┬──────────────┬─────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬─────────┤ 28
│  │ ☐ │ ▸  │ SKU          │ M%  │Marken │Artikel│Aufzähl│Beschr │Gefahr │Gewebe │Ursprg │ Name    │  ← header
│  ├───┼────┼──────────────┼─────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┼─────────┤ 28
│  │   │    │ Filter…      │     │Filter…│Filter…│Filter…│Filter…│Filter…│Filter…│Filter…│ Filter… │  ← floating filters
│  ├───┼────┼──────────────┼─────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┼─────────┤
│  │ ☐ │ ▾  │[▣] GALE-JACK…│ 71% │ Xavia │⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│ XAVIA … │ 36
│  │ ☐ │  ▸ │[▣] …BLACK-3XL│ 22% │ Xavia │⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│ XAVIA … │
│  │ ☐ │  ▸ │[▣] …BLACK-4XL│ 22% │ Xavia │⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│⚠ requ.│ XAVIA … │
│  │ …                              18.8 rows visible at 36px                                            │ 678
│  ├───┴────┴──────────────┴─────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴─────────┤ 36
│  │ 21 rows · 2 selected · autosave ✓ 12:41   ⚠ 2 product types have no cached schema                    │
│  │                                    Type or Enter to edit · ↓↑ to move · Tab → · drag to fill · ⌘Z    │
└──┴───────────────────────────────────────────────────────────────────────────────────────────────────────┘
   ▲ rail 66px                                                                             gutter 8px ▲
```
`[▣]` = the ratified 32px thumbnail. The footer hint is the **new** string (§5.5) — the old one
advertised `Enter ↓`, which stops being true the moment Enter starts editing.
`[▣]` = the 32px thumbnail in the pinned identity cell. Note the column order: the six
required-and-empty attributes sit immediately after identity; `Name` is pushed right.

### 10.2 Master · 1728×906 · **scrolled** (header collapsed)

```
┌──┬───────────────────────────────────────────────────────────────────────────────────────────────────────┐ 32  ◄ 48→32
│  │ ‹  XAVIA GALE Giacca Da Moto…  ●Active   Autosave ✓                                       [Publish ▾] │
│▦ ├───────────────────────────────────────────────────────────────────────────────────────────────────────┤ 40  ◄ stays
│  │ Scope [Master 71%][Amazon 71%][eBay —][Shopify][WooCommerce][Etsy]   Sheet Images Analytics&Ads Activity   [DE ▾][de ▾]│
│▤ ├───────────────────────────────────────────────────────────────────────────────────────────────────────┤ 40  ◄ stays
│  │ Parent · 21 rows …                                               [Overview ▾]  [Customise]  [Reload] │
│▥ ├───────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  │  header + floating filters (56, sticky inside the grid)                                               │
│  │  …rows…                                                              694px  ◄ +16   (76.6%)           │
└──┴───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
Gone on collapse: SKU · ASIN · the `Parent` pill · `⋯` (folded into `Publish ▾`).
Kept: back · name · status · autosave · Publish.
**Armed only if `R − 16 ≥ 32` measured expanded (§4.2).**

### 10.3 Master · 1728×906 · drawer OPEN (slide-over)

```
┌──┬────────────────────────────────────────────────────────────────┬───────────────────────────────────────┐
│  │ ‹ Products  XAVIA GALE…  ●Active  Autosave ✓  ⋯  [Publish ▾]   ┃  GALE-JACKET-BLACK-MEN-3XL       ✕  ┃│
│▦ ├────────────────────────────────────────────────────────────────┨  Record  History  Compare  Listings ┃│
│  │ Scope [Master][Amazon][eBay]…   Sheet Images Analytics Activity ┃ ┌──────┐                            ┃│
│▤ ├────────────────────────────────────────────────────────────────┨ │ 120px│  Colore  Nero              ┃│
│  │ Parent · 21 rows …          [Overview ▾][Customise][Reload]     ┃ │ photo│  Taglia  3XL              ┃│
│▥ ├──┬──┬────────────┬───┬──────┬──────┬──────┬──────┬──────┬──────┨ └──────┘                            ┃│
│  │☐ │▸ │ SKU        │M% │Marken│Artik │Aufzä │Beschr│Gefahr│Gewebe┃  Artikelname   ⚠ required           ┃│
│  │☐ │▸ │[▣]…BLACK-3X│22%│Xavia │⚠ req │⚠ req │⚠ req │⚠ req │⚠ req ┃  Aufzählungsp. ⚠ required           ┃│
│  │  the sheet keeps its FULL 1660px width and stays interactive   ┃  …                                  ┃│
└──┴────────────────────────────────────────────────────────────────┸───────────────────────────────────────┘
                                                                     ◄────────── 520px, fixed, overlays ──►
```
No backdrop · no focus trap · sheet stays live · Esc belongs to whatever has focus · on open the
grid scrolls so the originating cell is left of x = viewportRight − 520.

### 10.4 Master · 1440×900 ⟦derived⟧ · drawer closed — Tier A row

```
┌──┬─────────────────────────────────────────────────────────────────────────────────┐ 48   y=0
│  │ ‹ Products  XAVIA GALE Giacca…  GALE-JACKET  ●Active  Autosave ✓  ⋯ [Publish ▾] │
│▦ ├─────────────────────────────────────────────────────────────────────────────────┤ 40
│  │ Scope [Master 71%][Amazon 71%][eBay —][Shopify][Woo][Etsy]  Sheet Images Analytics&Ads Activity  [DE ▾][de ▾] │
│▤ ├─────────────────────────────────────────────────────────────────────────────────┤ 40   (1285 of 1374 — fits, 89 spare)
│  │ Parent · 21 rows · Colore × Taglia   ⌕ Find…   [Overview ▾][Customise][Reload]  │
│▥ ├──┬──┬────────────┬───┬──────┬──────┬──────┬──────┬──────┬──────┬───────────────┤ 56
│  │☐ │▸ │ SKU        │M% │Marken│Artik │Aufzä │Beschr│Gefahr│Gewebe│Ursprung       │
│  ├──┼──┼────────────┼───┼──────┼──────┼──────┼──────┼──────┼──────┼───────────────┤
│  │  identity 389 + 7 required (810) = 1199 of 1372 — all seven on screen           │ 672
│  ├─────────────────────────────────────────────────────────────────────────────────┤ 36
│  │ 21 rows · autosave ✓            Type or Enter to edit · ↓↑ · Tab → · fill · ⌘Z  │
└──┴─────────────────────────────────────────────────────────────────────────────────┘
```

### 10.5 Channel · eBay · IT · 1440×900 ⟦derived⟧ · drawer closed

```
├──┬─────────────────────────────────────────────────────────────────────────────────┤ 40
│  │ Scope [Master][Amazon][eBay 71%][Shopify][Woo][Etsy]  Sheet Images Analytics Activity Errors&Sync  [IT ▾][it ▾]│
│▤ ├─────────────────────────────────────────────────────────────────────────────────┤ 40   ◄ was 102 over 3 rows
│  │ [Preflight ★ (20)] [+ Add listing alias]        1 listing · 20 SKUs on eBay · IT │
│▥ ├──┬────────────────┬─────────┬────────┬────────┬────────┬────────┬───────────────┤ 29
│  │▾ │ ① Primary  ACTIVE                                                            │
│  │  │ [▣] …BLACK-3XL │ Nome    │ Descr  │ Name   │ Prod T │ Qty    │ Price   │ ⋯   │ 699
│  ├─────────────────────────────────────────────────────────────────────────────────┤ 36
│  │ 21 rows · autosave ✓        ⚠ 42 cells missing on eBay · IT   Type or Enter…    │
└──┴─────────────────────────────────────────────────────────────────────────────────┘
```
`Warnings (42)` has left the top-right. Its count now lives in the view control
(`Missing required · 42`) and its *statement* in the footer.

### 10.6 Tier B — 1280 container 1214 (icon tabs)

```
│ Scope [Master 71%][Amazon 71%][eBay —][Shopify][Woo][Etsy]   ▦ Sheet  ▣  ◔  ↻  ⚠   [IT ▾][it ▾] │
                                                               ▲ active keeps its text; the rest are icon + tooltip
                                                               1109 of 1214 ⟦derived⟧
```

---

## 11. WHAT EACH LANE OWES THIS SPEC

> **🔴 ONE LINE, ONE LANE (ruling #186).** Every item below has exactly one owner, and no item
> appears in two rows. This rule exists because §5.5's earlier trailing routing line let two lanes
> read the same sentence as an instruction to build: PES.4 landed a record-open affordance into
> PES.2's `MasterSheet.tsx`, importing a file that did not exist, and left tsc red on a shared file
> within the hour of the spec being approved. **A spec line naming two lanes is a claim collision
> with a delay fuse.** If you find an item here you think is yours and it is on another lane's row,
> that is a spec defect — file it to UX.1, do not build it.
>
> **🔴 AND (D9, #214): NO LANE RESTORES A LINK-OUT TO AN OLD SURFACE FOR PARITY'S SAKE.** A link to
> a legacy page is a parity *defect*, not a parity feature — "the old page did X and we link to it"
> means X is not covered. If a capability has no home in the new surfaces, file it as a **gap** and
> it gets built here; do not close the row with an anchor. §2.1b re-derives the nine that D9
> removed.

| lane | item |
|---|---|
| **PES.1** | **§2.1 FRAME bands only — product header 48/32, merged scope+tabs 40** (the family bar and the sheet toolbar are §2.1 rows too, but they render in PES.2's `MasterSheet.tsx`, so they are on PES.2's line — found by UX.1's own conformance run, #186's rule applied to #186's fix) · **§2.3 drop the AppTopBar on this route (`AppShell.tsx` route matcher — approved #182)** · §3 merged row + the three tiers · §4 collapse (arming rule, ref+class, no height animation) · §6.2 rule 6 — the readiness note band moves into the footer |
| **PES.2** | **§2.1 SHEET bands — fold the family bar (49→0) and bring the sheet toolbar to 40 (`--nds-toolbar-h` is minted; cite it)** · **§5.5 the footer hint string** · **§5.5 the identity cell's open control / `open-record` verb — SOLE owner (#186); PES.4 calls it** · §8.3 CONSUMES DS.1's new row kind (does not add it; the 32px thumb needs nothing new — `compact.thumb` is already 32) · §9.2 column ORDER · §9.3 widths · §6.1–6.2 the view control absorbing the warning chips · **§7.2 GRID.md §10's blanket body-portal claim needs qualifying — it is not true of AG's own popups** |
| **PES.3** | §9.4 the channel default view — 15664px must become a curated set, SOLE owner · **§5.5 delete the channel sheet's own double-click handler** |
| **PES.4** | §5 non-modal slide-over · §5.2 the Esc-ownership rule · §5.4 the horizontal-scroll-on-open fix — **blocked until AG.1 registers `ScrollApiModule`; do not build against a throwing call** · **§5.5 the drawer stops listening for double-click, and CALLS PES.2's `open-record` verb for any entry point of its own — it does not build one (#186)** |
| **AG.1** | §2.1a strip + married groups (CONFIRMED, theirs) · §9.2a `applyOrder: true`, whose-order-wins, "Reset columns" · §9.3a state-not-count in `LongTextCell` · §5.4 **register `ScrollApiModule`** · **§5.5 the key map + `enterNavigatesVertically: false`** · §7.1 the floating-filter popups, and the select editor that never opens |
| **DS.1** | §7 popup primitives · **§7.3 the anchoring clause — the guard asserts the OUTCOME, never portal parentage** · §6 the warning component's new home · **§8.3 the non-stacking media row in `tokens/grid.ts` — SOLE owner, by path** · **`--nds-toolbar-h: 40px` — mint it now, #182 ratified §2.1** |

## 12. 🟢 ANSWERED by the Owner (ruling #182, 2026-09-01)

All three as recommended:

1. **§2.3 — the AppTopBar is DROPPED on the studio route.** Sheet 89.4% at rest / 91.2% collapsed;
   rows 678 = 74.8%. Cost accepted: global ⌘K and the notification bell are one step back while in
   the studio.
2. **§8.3 — the 32px thumbnail on a 36px one-line row.** 18.8 rows at 906 (the figure improved from
   17.3 once the AppTopBar came out). Not the /products/next 85px row, which would have shown 8.
   **And it turned out not to be only an aesthetic choice** — §4.3: at 28px the v2 budget leaves the
   grid zero scroll range and the collapsing header could never fire. The taller row restores it.
   The Owner's two answers depend on each other.
3. **§3.3 — chips stay channel-only**, market and locale as separate switchers.

Two items were written into this spec at the hub's instruction on the same ruling: **§5.5** (the
gesture map — double-click edits everywhere, records open explicitly, and Enter's exact behaviour)
and **§7.3** (the anchoring clause, because an invariant a live complaint satisfies is an incomplete
invariant).

**Nothing in this document is open.** Blocked, not open: §5.4 waits on AG.1 registering
`ScrollApiModule`; `var(--nds-toolbar-h)` may not be written until DS.1 mints it.

## 13a. 🔴 THE COORDINATE IS SIX VARIABLES, NOT ONE — pin the list, don't rely on vigilance

I made the same class of error twice in an hour. First: comparing two reveal paths that differed in
**market**, and reporting a landed fix as broken. Then, while testing whether the contested
"scrolls into view" readings were that same confound, I compared drawer measurements that differed
in **scope** — my earlier `scrollTop 1034` was `scope=AMAZON&market=IT`; re-measured on the master
scope at the same market it is **0**, with the pane's `scrollHeight` **9,389** rather than 13,685.
Different surface, same name.

**Vigilance did not survive one hour.** So the rule is a list, and the probe carries it:

> **A studio reading is only comparable to another when all six are pinned: PRODUCT · SCOPE ·
> MARKET · LOCALE · VIEWPORT · BUILD.** Any of the six left to resolve itself is an input the
> reading silently depends on. State all six beside every number.

⟦measured, `cell=item_name`, master scope, 1728×906, same product and row⟧

| market | drawer `scrollTop` | pane `scrollHeight` | `item_name` column |
|---|---|---|---|
| DE | **0** | 9,389 | exists |
| IT | 39 | 9,485 | exists |
| ES | 23 | 9,293 | exists |
| FR | 39 | 9,389 | exists |
| **PL** | **no tall pane at all** | — | **does not exist** |

**Two things this settles, and one it does not.**

- 🔴 **PL has no `item_name` column.** FE.1's "exactly 0 on PL" is very likely the
  **column-does-not-exist** case rather than a scroll defect — the same shape AG.1 hit when an
  unpinned link resolved to PL with `maxScroll 0`. That is testable in one line and should be
  before it is filed as a scroll bug.
- 🔴 **The contested readings split by SCOPE, not by market.** Master scope gives 0–39 across four
  markets (SR.1's 11 belongs to this family); the Amazon scope gives 1034/1678. So "three modes of
  one defect" may be **one defect on one scope plus an absent column on another**.
- ⚠ **What it does not settle:** whether the field is *in view* at any of these positions. My label
  selector failed to locate the field block, so I have scroll positions and not landings. Nobody
  should close this on my numbers alone.

## 14. SR.1's SIX — rulings, with the measurement each rests on

### 14.1 🔴 ONE TOOLBAR FOR BOTH SCOPES ⟦SR.1: master chrome 42px; channel 99–111px in three ragged bands⟧

Moving Master → Amazon **loses** search, `Overview ▾`, Customise, Export, Reload, the checkbox
column, the filter row, the bulk bar and the four family verbs, and **gains** three badges,
`Preflight ★` and `Add alias`. **Six of ten operator tasks live on a channel scope**, so the scope
that lost the tools is the one most used.

> **RULED: the sheet's chrome is a property of THE SHEET, not of the scope.** One toolbar component
> serves both. Scope-specific controls (`Preflight`, `Add alias`, alias badges) are **additions to
> the shared bar, never a replacement for it** — and a control absent on a channel scope must be
> absent for a stated reason, not because a second bar was written and did not think of it.

The three ragged bands are the same finding as §1.4's 102px channel toolbar; the fix is now the
shared component rather than a re-layout. → **PES.3** consumes PES.2's toolbar; **PES.2** owns it.

### 14.2 🔴 DRAWER GROUPS: I RULED THIS ON PRINCIPLE AND SR.1'S DATA OVERTURNS THE IMPLEMENTATION

⟦SR.1, measured: 97 fields, every group expanded · 641px pane · **13,682px of content = 21.3
screens** · 291 controls · **4 field rows visible** · `&cell=item_name` leaves `scrollTop` at 11
with the field at 1,429.⟧

**My #283 ruling was "start expanded", and my reason was right: a collapsed group hides empty
required fields, and hiding the work hides the job (§9 / #173). The data shows expanded does not
achieve that.** An operator sees **4 of 97 fields** either way. Expanded does not show the record;
it shows the same 4% with 21 screens of scrolling behind it. **I optimised for a principle without
checking whether the implementation delivered it** — which is the same error as reading a disabled
control as a design fact (§2.1c), one level up.

> **RE-RULED: groups start COLLAPSED — and a collapsed group must be INFORMATIVE, not merely
> closed.** Each group header carries its own count of what needs work (`Attributes · 7 required
> missing`). **Nothing is hidden: the work is summarised at every level and one click reaches it.**
> That keeps the principle #283 was protecting and pays 21 screens less for it.
>
> **The group holding the arriving cell opens**, and arriving at a named field **scrolls it into
> view** — `scrollTop 11` with the target at 1,429 is §5.4's failure in a different surface: a deep
> link that names a target and does not take you to it.
>
> **And subtract the 97 per-field Compare icons.** Compare is a tab; duplicating it 97 times is 97
> controls doing a job one surface already has. That is most of the 291.

→ **PES.4.** #283's "never persist collapse across records" **stands** — a group an operator
collapsed on product A, silently collapsed on product B, hides work they did not choose to hide.

### 14.3 🔴 A DESTINATION WITH NO CONTROLS IS NOT A DESTINATION ⟦SR.1: `Field history` and `Compare` — one instruction, zero controls⟧

> **RULED: a tab that cannot do anything must not be a tab.** Either it carries its verb, or it
> folds into the surface that has one. An empty pane with an instruction is a promise the product
> does not keep, and it costs the operator a navigation to discover that.

Both are context surfaces: the record is already chosen, so they should populate from it. Where a
second target is genuinely needed, the pane must offer **the control that chooses it**, not a
sentence describing what the operator should have done. → **PES.4**.

### 14.4 🔴 THE STATE WORD LEADS; THE NUMBER FOLLOWS ⟦SR.1: `Master 71%` and `Amazon 71%` are the same numeral for "warnings, publishable" and "blocked"⟧

> **RULED: a chip leads with its state and carries the number second.** The number is a property;
> the state is the fact, and it is the half that differs. `Amazon · Blocked 71%`.

⚠ **And the width tension, resolved rather than left to be discovered:** chips measure ~107px and
§3.4's Tier B already fights for that row at 1280. A state word makes them wider. **If width forces
a choice, the STATE survives and the number is dropped** — never the reverse. Two chips reading the
same number for opposite facts is the defect; two chips reading `Blocked` and `Warnings` with no
number is still honest. → **PES.1** (chip), consuming `readinessMeta`'s tone and label (§6.4: never
a local default).

### 14.5 🔴 THE LOCALE SET IS A FUNCTION OF THE MARKET ⟦SR.1: 9 locales on every market — 108 combinations, Turkish on Amazon·IT⟧

> **RULED: derive the offered locales from the market.** Offering a locale a market cannot use is an
> invitation to author content nobody will ever read — the expensive kind of dead end, because the
> operator only learns it failed at publish.

**One exception that must not become a hiding place:** if a product *already holds* content in a
locale the market does not support, that content is **shown** — it exists, and §6's rules forbid
making existing data invisible — but it is not **offered** as a new choice. Existing and offerable
are different sets. → **PES.1** / **PES.5** (the market→locale map).

### 14.6 🔴 THE SHORTCUT HINT IS A TEACHING AID AND EARNS ITS PLACE ONLY UNTIL TAUGHT ⟦SR.1: six shortcuts, 491px of footer, permanently⟧

This is mine to weigh because §6.5 put the **refusal** in that slot and ruled the hint yields to it.

> **RULED: retire the hint after the operator's first successful edit (persisted per user), and keep
> `?` as the permanent way back to it.** A hint teaches a gesture learned once; 491px of footer
> forever is a high price for a lesson already delivered.

**This strengthens §6.5 rather than competing with it.** With the hint retired, the footer's width
belongs to the save state and the refusal — the honest occupants — instead of the refusal having to
displace a teaching aid. **The footer's height still never changes** (§6.5): what varies is only its
content. → **PES.2**.

## 12a. HOW TO READ THE NUMBERS IN THIS DOCUMENT

Ratified as a standing rule (#378) after a scope-limited figure was twice mistaken for a decision:

> **A qualified figure here is usually the LIMIT OF THE MEASUREMENT, not a decision.** If a number
> is stated "on master", "at 1440", "on GALE-JACKET", that is where I measured. **Treat the boundary
> as a question, not as a ruling** — ask, and I will either extend it or say why it does not
> generalise. `name = 220` was scoped to master for exactly this reason and turned out to apply
> everywhere, with a *stronger* case on the channel scope than on the one I measured.

**Swept for the rest. These are measurement-limited and should be questioned when they matter:**

| figure | measured on | what changes it |
|---|---|---|
| **§9.1's "7 required columns"** | **OUTERWEAR** | 🔴 **The required set is per PRODUCT TYPE** (ruling #173: 7 / 6 / 0 across the catalogue). A knee slider does not require `fabric_type`. **The `layout:v2` check hardcodes OUTERWEAR's seven** — it is right for this fixture and wrong for a sheet of anything else, and it will report confidently either way. |
| §3.1's chip widths (561px, 6 chips) | a product on 3 live channels | a product on more channels changes the row's fit and which tier applies |
| §14.2's drawer (97 fields, 21.3 screens) | **Amazon scope** | the master scope drawer measures 9,389px, not 13,685 — the finding holds, the figure does not transfer |
| §4.3b's whole ledger | a **21-row** family at 906 | §4's lede: the reference fixture is the marginal case for collapse arming |
| §1.3's column-visibility counts | GALE-JACKET's view | a different default view changes every count |
| ~~§2.2's `rows-area`~~ | ~~GALE-JACKET~~ | 🟢 **RETIRED: the toolbar now holds `--nds-toolbar-h` (PES.2), so the band IS constant.** Both products measure toolbar **40** and rows-area **675 (74.5%)** at 1728×906 — the first figure in this table to graduate from fixture-limited to fixture-independent, and it took a defect fix rather than a caveat |

**These are decisions and do not move with the fixture:** §2.1's band heights · §2.3's AppTopBar
removal · §3.3's channel-only chips · §5.1's non-modal slide-over · §6's warning rules · §9.2's
ordering rule · §9.6b's precedence · §9.3c's `name = 220`.

🔴 **AND THE FIRST SECOND-PRODUCT RUN FOUND A BAND THAT IS NOT CONSTANT.** The fixture guard (#383)
made it safe to point the probe at a GLOVES product, and it immediately failed `rows-area` at
**669 against the expected 674**. Isolated to one band ⟦measured, 1728×906, both products, same
coordinate⟧:

| band | GALE-JACKET (21 rows) | GLOVES (6 rows) |
|---|---|---|
| header | 48 | 48 |
| scope + tabs | 40 | 40 |
| **sheet toolbar** | **41** | **47** |
| AG header | 57 | 57 |
| footer | 36 | 36 |
| **rows area** | **674** | **669** |

**Every band is identical except the toolbar, which is 6px taller. Diagnosed, and the hub's
inference from this table was right: the 1px and the 6px are ONE mechanism.**

> **`--nds-toolbar-h` is applied as `min-height`, not `height`. The token is a FLOOR; the bar has no
> fixed height at all** — it sizes to its tallest child. ⟦measured: `minHeight: 40px`,
> `padding 6/6`, `border-bottom 1px`, `box-sizing: border-box`⟧
>
> ```
> GALE-JACKET   6 + tallest child 28 + 6 + 1 = 41
> GLOVES        6 + tallest child 34 + 6 + 1 = 47
> ```
>
> **The named child (#388's ask): the `caps` pill at 34px** — a DS `Pill` inside the DS `InfoTip`
> primitive (`h10-tipwrap` is InfoTip's wrapper class, `primitives/InfoTip.tsx:54`, `inline-flex`,
> **adds no height itself** — legacy in name only). It is an EXTRA child on GLOVES, not a taller
> rendering of a shared one: 12 children against the fixture's 11, and the only one that is not
> 28px. **So the variance is a DS inconsistency — a `Pill` is 6px taller than an `nds-btn.sm`
> beside it — not a legacy component in the DS toolbar.** ⟪I described it as a "legacy wrapper" in
> a hand-off before checking the class; the `h10-` prefix made it plausible and it was wrong. → DS.2
> owns the 6px.⟫ Ninth child, where GALE-JACKET has a
> 28px `nds-btn` in the same position.

🔴 **AND I HAVE TO WITHDRAW MY OWN EXPLANATION OF THE 41.** I recorded it as *"40 + a 1px bottom
border, correct by design"* and gave the probe a ±1 tolerance so no lane would chase it. **The
border is real — and it is not why the box is 41.** 41 is `6 + 28 + 6 + 1`, and it equals 40+1 only
by coincidence of the tallest control being 28px. **I explained a discrepancy with a mechanism I had
partially measured and never did the arithmetic for**, then built a tolerance on it — and that
tolerance is what kept the real mechanism invisible until a second product moved the tallest child.

**The general form, because it is not a CSS lesson:** a correct fact (`border-bottom: 1px`) is not
an explanation until the sum comes out. **A tolerance justified by an unverified cause hides the
cause.** ⟪and the probe's ±1 stays only until PES.2 fixes it, at which point the expectation becomes
exact⟫

**Two consequences.** §2.2's **674 is GALE-JACKET's number, not the budget's** — the band budget is
only fixture-independent if every band is, and one is not. And a bar whose height is set by a token
but determined by its contents will drift again the moment a lane adds a control to it. → **PES.2**,
as a defect rather than a caveat: the toolbar should hold `--nds-toolbar-h` regardless of what it
carries, or the token is decorative.

⚠ **The one to fix rather than flag: the probe's hardcoded required set.** It should read the
required keys from the columns contract's `requiredForProductTypes` for the product under test, not
carry OUTERWEAR's seven as a constant. Until it does, **`layout:v2` is a GALE-JACKET instrument**,
and §9.1's readings are only about this fixture. Recorded here rather than left as a surprise for
whoever first points it at another product.

## 15. OWNER DECISIONS D10–D13 (04:47) — spec amendments

### 15.1 D10 — attribute headers in ENGLISH on every scope; the channel's label in the tooltip

⟦measured earlier: on market DE the master sheet renders `Markenname *`, `Aufzählungspunkt *`,
`Gefahrgutvorschriften *` — the channel's own localised labels, as headers.⟧

> **RULED: the header carries the ENGLISH attribute name on every scope. The channel's own label
> moves to the header tooltip — and the tooltip NAMES THE CHANNEL**, because the same field has a
> different label per channel and a bare foreign string does not say whose it is. Same rule as
> §9.6's mark: an adornment names its source. → PES.5 (contract), PES.2/PES.3 (headers).

**And it removes a scale hazard nobody named:** an operator working across Amazon·DE and eBay·IT
today reads two different vocabularies for one field, so a column cannot be recognised across scopes
by sight. One vocabulary is what makes the sheet comparable at all.

### 15.2 D12 — the SKU text appears in EXACTLY ONE column; the thumbnail stays

Owner: *"There is no point having the SKU with the image… we already have a dedicated column for the
SKU."* **This corrects §8**, which put the thumbnail in the identity cell without saying what
happens to the text beside it.

> **RULED: the identity cell carries the THUMBNAIL ONLY. The SKU text lives in the dedicated `sku`
> column and nowhere else.** The `rowMediaLine` row kind survives unchanged — the Owner is removing
> a duplication, not the picture.

⚠ **Consequence to take, not to discover:** the identity column was sized for a thumbnail *plus*
text. With the text gone it needs the tree expander and a 32px thumb — **so it should shrink, and
that width returns to the required columns**, which §9.1 is still 87px short of fitting at 1280.
→ PES.2 to re-measure the identity block after the change rather than leaving it at 389.

### 15.3 D13 — a closed-list cell must LOOK like one, at rest

Owner: *"the status column… should really be a dropdown."* ⟦`status` is `kind: 'select'` on the wire
and mounts the select editor — it already **is** a dropdown, and reads as free text until you commit
to editing it.⟧ **So this is not a missing feature; it is an affordance that was never drawn**, and
the Owner's word for it is the operator's experience of it.

> **RULED: a cell whose value comes from a closed list is visually distinguishable from a free-text
> cell WITHOUT interacting — a chevron at rest or on hover — on every scope, IN THE ENGINE.**
> Per-sheet is how the two scopes diverged in the first place (§14.1). → AG.1 / PES.2 substrate.

⚠ **A cell's adornment budget is now real and I am flagging it before three lanes each add one.**
A single cell may carry §9.3a's state mark, §9.6's provenance mark, and now a chevron — at
110px (§9.3d) that is most of the cell. **If they cannot coexist legibly, bring me the measurement;
the answer is a combined adornment, never a wider column** (§9.3d's constraint, extended).

### 15.4 D11 — the channel scopes get the media tab

Owner: *"we keep the same UI for all scopes… images on the master and not on Amazon or eBay."*

> **RULED: a master-only surface is a parity DEFECT from here.** §14.1 said the sheet's chrome is a
> property of the sheet, not the scope; this extends it to the **tabs**. A tab that exists on one
> scope and not another must have a stated reason, not an implementation history. → PES.7.

---

## 15.5 RE-BASELINE after #458 (every declared column now yields a cell) — `studio-sheet.service.ts` 05:08:34, measured 06:0x

| scope | cols | content | @1728 | @1440 | uncoverable trailing 520px |
|---|---|---|---|---|---|
| master DE | **19** | 2,439 | 1.47 screens | 1.78 | `productType`, `dsa_responsible_party_address`, `gpsr_safety_attestation`, `ready:scope` |
| Amazon·IT | **17** | 2,284 | 1.38 | 1.66 | `dsa_responsible_party_address`, `gpsr_safety_attestation`, `basePrice`, `totalStock` |
| eBay·IT | **9** | **fits exactly** | 1.00 | 1.00 | @1728 `actions` · @1440 `status`, `basePrice`, `totalStock`, `actions` |

**§9.1 re-read on the current build: master is 7/7 at 1728 AND 1440**, 6/7 at 1280
(`product_description` clipped) — #398's reading survives #458, and master's default view did not
grow: still 19 columns, 2,439px. The flagged-keys half admitted nothing new there.

**🔴 A structural finding the re-baseline produced, which changes what §9.2's tail has to do.**
On eBay·IT `content === client` at **both** widths — 1,660 at 1728 and 1,372 at 1440. **The columns
flex to fill the viewport, so there is no fixed model width and no horizontal scroll at all.**
Consequences:

- **"Content width" is not a property of the sheet on a fitted scope** — it is a property of the
  viewport. Any figure of mine quoted as a channel content width is a *viewport* reading. (My own
  earlier 1,404 was one of these, taken at 1440.)
- 🔴 **The uncoverable band MOVES with the viewport.** At 1728 it holds only `actions`, which nobody
  opens a record from — §9.2's tail is satisfied by accident. **At 1440 it holds `status`,
  `basePrice` and `totalStock`, all editable.** So on a fitted sheet the tail is not a one-time
  column ordering: **narrowing the window pulls real columns into the band.** The tail must be
  stated as a property to hold at every supported width, not an order to set once.

⚠ **Discrepancy with PES.3, flagged rather than resolved:** they measured Amazon·IT at **14 columns
/ 1,934px**; I measure **17 / 2,284** at `?scope=AMAZON&market=IT&locale=it`, swept, settled, on the
build above. Same-input rule — I am not asserting mine over theirs; one of us has a different
coordinate, locale or build, and it should be reconciled before either number is used. → PES.3.

## 16. 🔴 "THOUSANDS, OR HUNDREDS OF THOUSANDS OF SKUs" — which of my numbers survive

Owner's framing, and it is a standing instruction on every measurement in this document: **say which
numbers were taken on a 21-row family and which would hold at a thousand.**

| number | row-count dependent? | at scale |
|---|---|---|
| §2's band budget · rows-area 675 | **no** | unchanged — it is chrome arithmetic |
| §9.1's column fit · §9.3's widths | **no** | unchanged |
| §14.2's drawer (97 fields) | **no** | per record, not per sheet |
| **§4.3b's whole arming ledger** | **YES** | `R = rows × 36 + 56 − H`. At 21 rows R is 81 and the family is the *marginal* case; **at 1,000 rows R is ~35,000 and collapse is always armed.** The ledger's fragility is a SMALL-family property and disappears at scale — the opposite of the usual direction, and worth knowing before someone "fixes" it |
| §5.4's reveal · §7's popovers | **no** | geometry, not volume |
| **everything about rendering cost** | **YES — and unmeasured** | 21 rows tells us nothing about 1,000. AG virtualises, but I have measured no scroll, no sort, no fill-down at volume. **Not a claim I have made; not one anyone should read into a green suite.** |

**🔴 And one invariant of mine does NOT survive scale, which is worth stating before it is hit.**
§9.1 says *identity plus every column REQUIRED for this row's product type fits at 1440*. That is
satisfiable because GALE-JACKET's family is **one product type with seven required fields**. **A
sheet of a thousand SKUs spans many product types, and the required set is their UNION** — ruling
#173 measured 7 / 6 / 0 across the catalogue, so a mixed sheet's union is larger than any single
type's and there is no width at which it fits.

> **So §9.1 needs a scale form, and I am not inventing one from a 21-row fixture.** The candidates
> are: the required set follows the row under the cursor (per-row, not per-sheet); or the sheet
> shows the union and accepts horizontal scroll for it; or a mixed sheet is a different view from a
> family sheet. **Each is a different product, so it is the Owner's call, and it needs a measurement
> on a real mixed sheet first — which nobody has taken.** Recorded as the open question rather than
> answered from the fixture that cannot see it.

## 13. CONFORMANCE STATUS — measured, not reported

`npm run layout:v2` · pinned `market=DE&locale=de` · **run 2026-09-02 ~07:5x, load 3.11**, against
`studio-sheet.service.ts` 07:19:33 — every figure carries the build and the load it was taken on
(#470, and the starvation etiquette).

**Count, in both units, because they differ and I once wrote one next to a runner printing the
other.** As of **08:2x after the inset deletion**: the suite prints **4 failing assertions across 6
measured states**, which are **2 distinct defects** — the §5.4 reveal not clearing a covered cell
(×2 widths) and §9.1 @1280 (×2 drawer states). A defect count is the useful number for a lane; an
assertion count is the honest number against the runner's own output. **Neither is wrong; quoting
one in the other's units is.**

**The §5.3 fix is the clearest case this document has of a defect that was hiding a second one.**
The inset narrowed the grid out from under the panel, so §5.4's clearance assertion measured an
overlap of 0 and could not fail; it had been passing 21× per run for exactly as long as the rejected
inset survived. Deleting the inset armed the check and it convicted immediately. **A check that
cannot fail is not a check that is passing** — and here the reason it could not fail was itself the
defect. See §13's §5.4 row.

| § | assertion | state |
|---|---|---|
| **contract (SC.1 W-1/W-2)** | every declared column yields a cell, same set and order, all four coordinates · every non-editable cell states a reason | 🟢 **96/96 · 96/96 · 97/97 · 35/35**, 21 rows each — an independent reproduction of SC.1's counts |
| **§2 — the whole band budget** | no AppTopBar · no `⋯` · header 48 · merged row 40 · toolbar **40 exactly** · AG header 57 · no group strip · family bar folded · **rows 675 (74.5%)** | 🟢 complete, fixture-independent |
| §8.3 §9 | row 36 · thumbnail 32×32 · order inverted · widths landed · ~~**7 of 7 required at 1728 and 1440, DRAWER CLOSED**~~ | 🔴 **THE 7/7 WAS TRUE OF ONE COORDINATE AND WRITTEN AS IF IT WERE TRUE OF THE SHEET.** It holds on master·DE and nowhere else: at 1440 master·IT is 6/7 (+87) and Amazon·IT 6/7 (+102) ⟦measured 2026-09-02 on `ChannelSheet.tsx` 14:23:19⟧. Nothing regressed — §9.1 had never been pointed at a second coordinate, so the row recorded the only arm that existed. See §9.1a; three coordinates now run every width, every run |
| **§9.1 coordinates** | the invariant holds at every coordinate, not just the fixture's | 🟢 **D11 MET at 1440 on all three coordinates** ⟦record run 14:55:48–14:59:11, no disturbance, no drift⟧: master·DE 7/7 (73 spare) · master·IT 7/7 (73) · Amazon·IT 7/7 (122). Nine of nine cells matched the prediction stated BEFORE #690 landed, on four independent readings. 1280 stays 6/7 on all three (+87 / +87 / +38) and is **ruled not to be D11's bar (#693)** — the residual is the required block's own 910px, no chrome term left to spend. The 1280 ordering has REVERSED since #679: the channel is now 49px ahead of master. **The runner now ASSERTS at 1440 and RECORDS the three 1280 rows as a ruled residual (#693/#708)** — printed in full every run, ratcheted so a worsening still fails. `npm run layout:v2` exits 0 for the first time |
| **W-4 — §9.1's own denominator** | the required set is derived from the contract, not trusted | 🟢 NEW 2026-09-02, and its first output is a finding: master·DE **7** ✅ · Amazon·IT **7** ✅ · Amazon·DE 7 · **eBay·IT 1** (`brand` alone). §9.1 on eBay·IT is 1-of-1 and **cannot fail** — a green that cannot go red is not evidence, so W-4 asserts only on the coordinates §9.1 measures and prints the denominator for the rest |
| **the disturbance banner itself** | a disturbed run says so on every exit path | 🔴→🟢 **IT DID NOT FIRE ON THE FAILURE PATH, which is the path that gets quoted.** `suspect()` was called on the nothing-measured and all-green exits only, so this suite's own record run printed four failures and one abstained coordinate in silence — the banner would not have fired for the incident it was written for. Also `const suspect` was scoped inside `if (measured === 0)`, so the all-green exit threw `ReferenceError`: **the success path had never run to completion.** Both fixed 2026-09-02; the nothing-measured path is proven by `LAYOUT_ROWS_MS=1`, the failure path by `LAYOUT_SELFTEST_STAMP=1` on a red run |
| §6.2 §6.3 | no warning-glyphed control above the grid | 🟢 |
| §4 §5 | scroll source · arming · slide-over **fixed, z-index 50 < 1400, reachable, not `aria-modal`** | 🟢 |
| §5.4 URL path | 6/6 cold · **write behaviour asserted, not just clearance** · reveal now scrolls a covered cell: **writes [82] @1440, [242] @1280** (was `writes []` while covered by 66 / 226) | 🟢 fixed 08:30:35 |
| **§5.4 VERB path** | the §5.5 primary gesture opens the record | 🔴 **THE DRAWER NEVER MOUNTS.** Two-arm, same record id, same build, 1728: `rec` in the URL **at load** → panel present in **8ms**; `rec` set **client-side** by right-click → "Open record" → URL updates to the same id, `[data-studio-dock]` track present, **`.nds-drawer-dock` absent after 12s**, no console error. **NOT caused by the 08:21:55 or 08:30:35 changes** — this check was already abstaining in this session's first run, against the 07:19:33 build. Cause not asserted; filed to PES.4 as a measurement |
| **§5.5 / URL state** | every URL-driven control re-renders | 🟢 **FIXED 08:48:55** (`contracts.tsx`, fresh `{}` + a `historyStateIsInternal` dev guard). Five real gestures at 1728, re-run after the 08:56:19 server restart: **Activity tab** → selected=Activity, grid unmounted · **Market → Belgium** → button "BE · Belgium", header cells **32 → 22** · **right-click → Open record** → panel mounts · **Back** → panel closed, `rec` cleared · **`<Link>`** → `/products`. **5/5.** Root cause was `app-router.js:255` early-returning on a state carrying `__NA`, so `pushState(window.history.state, …)` — the rule my own `reference_next_query_cursor` insisted on — opted the studio out of the re-render it needed |
| **§5.4 reveal — BOTH PATHS** | opening a record clears the focused cell | 🟢 **GREEN 2026-09-02 — re-measured on `StudioDock.tsx` 13:13:11 · `MasterSheet.tsx` 13:13:26 · `ChannelSheet.tsx` 13:22:40** (first met at 09:34:02; re-taken rather than carried forward, because both hosts that READ the attribute changed after that stamp — `StudioDock` itself was only a byte-identical `cp` restore, but the sheets were not). **An mtime is a claim about the FILE, not about the behaviour: it moves without a change and a change can arrive in a file you were not watching** — so re-measure rather than re-stamp. **`npm run layout:v2` now prints a `📌 BUILD STAMP` of all nine files on the path at the top of every run**, so any number quoted from it carries its own provenance. It earned itself on its first run: `grid.css` had moved to 13:30:12 six minutes after the acceptance above was taken, and nobody would have noticed. Re-taken against it — unchanged. Cause was the entrance animation: the host read `.nds-drawer-dock`'s **live** rect while `nds-slidein` ran, got the viewport edge, computed overlap 0 and correctly declined. Series at 1440, per frame from first existence: `1440, 1440, 1294, 1239, … 920` — at the edge for the first **~34ms (2 frames)**, resting at 249ms. Fixed by publishing `data-resting-left`. Acceptance, animation ON: **1440** attr "920", covered 66px → `writes [82]` · **1280** attr "760", covered 96px → `[112]` · **1728** attr "1208", covered 48px → `[64]`; URL path `[82]` / `[242]` / clear. Attribute equals the live resting rect at every width on both paths; `data-reveal-skipped` null throughout |
| **⚠️ `writes []` — the most false-negative-prone value in this suite** | | **Four false negatives in one morning, each individually reasonable.** (1) The `scrollLeft` interceptor was installed by `addInitScript` on a page created *inside* the URL-path check, so on the verb path the field was **empty by construction** — and I relayed that to another lane as excluding a hypothesis before catching it. (2)–(4) Three probe-conduct confounds that each made the rule **correctly** decline: focus left on `sku` (right 366, never covered by a panel at 920) — *in both arms*, so it read as a property of the subject; then focus corrected but the right-click aimed at the original `sku` coordinates, re-focusing it before the menu opened; and finally the right-click must land on the *currently focused* cell. **An empty write list is the easiest value in this suite to obtain spuriously, and every spurious route to it looks like correct restraint.** Never report it without stating the interceptor is installed AND the focused cell is actually covered |
| ~~§5.4 verb reveal 17/17~~ | | ⚠️ **THE 17/17 WAS STALE AND I KEPT REPORTING IT GREEN.** The check had been returning `ABSTAIN — drawer did not open, focus kept` all session while this table said 🟢 from an earlier build. **An abstain is not a pass, and a status row is a claim that needs re-measuring like any other** — this is the third time that trap has caught me in one session, and the first where I carried the stale value into a report to another lane |
| §7 | no document h-scroll · popovers **9/9 anchored, distinct panels** · `selectedInView` · right-edge select 3/3 | 🟢 — **this figure was unearned until 2026-09-02.** The earlier 9/9 was read through a panel that never closed: three triggers all measured 983–1264, so `Market` was scored against `Publish`'s panel (a false FAILURE) and `Content locale` passed only because it shares that panel's right edge (a false PASS). Now each panel is its own: Market 1013–1213 w200 against trigger 1013–1135 |
| **§5.3** | **sheet undisplaced with the drawer open** | 🟢 **FIXED 2026-09-02 08:21:55** — Δ **0** at every width (1660→1660 · 1372→1372 · 1212→1212). Was Δ520 at every width: PES.2's staged §5.4 inset (`MasterSheet.tsx:1318` `data-panel-open` + `grid.css:752` shrinking `.ag-root-wrapper` by `--nds-studio-panel-w, 520px`), deleted by PES.2 after the hub found it (#603). Drawer-open §9.1 restored with it — 1728 **7/7**, 1440 **7/7**, 1280 **6/7** — one defect, six measurements, no §9 work needed |
| **§5.4 reveal** | **the reveal must clear a cell the panel covers** | 🔴 **NEW, and the inset was hiding it.** `supplier_declared_dg_hz_regulation` **COVERED by 66px @1440, 226px @1280**, `writes []` — the rule declines to move. `bullet_point` clears at all three widths. **This check could not fail until today:** with the inset, measured panel/grid overlap was always 0, so `cellRight <= panelLeft` was trivially true — 21 green ticks that were unfailable. Overlap is now a real **519**, and the assertion convicted on its first armed run |
| **§9.1 @ CHANNEL SCOPE (Amazon·IT)** | all 7 required visible at scrollLeft 0 | 🔴 **6 of 7 at 1440 — below §9.1's own stated bar**, `product_description` clipped (1728 **7/7**; 1280 4/7, informational under §9.3b). Required set derived from the contract (`requiredBy` ∋ "Amazon · IT", all 7 also OUTERWEAR-required and `defaultVisible`) and it is the **same seven keys** as master, so the denominators compare. **Not PES.3's D18 editor change** (`ChannelSheet.tsx` 13:22:40): the two `select` columns it touched render at 130px and fit at every width, and all seven rendered widths equal the contract's declared `width`. **First measurement, not a comparison — there has never been a channel-scope §9.1 baseline**, so it is not called a regression. Master at 1440 is 7/7, so the spec currently implies a channel parity it does not have. Open: whether §9.1's fixture should carry a channel coordinate permanently — today's would not have caught this |
| §9.1 @ 1280 | all 7 required visible | ⏳ **6 of 7, both drawer states** (`product_description` clipped) — below §9.1's stated 1440 bar (§9.3b), not unfinished work. Now identical open and closed, which is itself the §5.3 fix showing |
| §5.4 trailing · §5 pad | uncoverable band · phantom column | ⚪ **NOT MEASURED** — no mechanism landed, so nothing to convict |
| §6.5 §3.6 §9.6 §15 | refusal in the footer · readiness three-state · derived marks · D10–D13 | ⏳ ruled, with their owners |

**Rows: 458 (50.6%) → 675 (74.5%).**

**What this table cannot tell you** — most of this session's findings hid in exactly these gaps.
§7's invariant is necessary and not sufficient: the `Content locale` regression passed it and every
width check, and only the *anchoring* assertion convicted it. A *not-covered* check scores the
URL-path row 6/6 where **rendered AND clear** scored it 3/6. "Clear" alone is scored identically by
a correct rule and an over-scrolling one — **only the write count separates them.** §9.1's
denominator must be the required SET, not the rendered subset. **An abstain is not a pass**, and
reading one from a failure list is how five drawer assertions went unmeasured for hours. And every
reading is one build, one pinned coordinate, one fixture — **which is the marginal case** (§4's
lede). The script's header lists the **nine** traps it has already fallen into. The last two were not wrong
numbers but wrong *conduct*: the probe clicked every button in the header to discover which opened a
panel — safe only by accident, since `PublishMenu` is inert while publish is unwired, and local dev
writes to the **production** database — and it measured popovers through a panel it had never closed.
**Ask of a probe not only what it measures but what it DOES**, and re-ask when the page grows a
control.
