# SR.1 — Simplicity & product review of the Product Edit Studio

**Lane:** SR.1 (review-only) · **Session:** `nexus-commerce-c1 [c0cef6]` · **Date:** 2026-09-02
**Owns:** this file only. No product files, no DS files, no edits to any lane's tree.
**Mandate (hub ruling #215):** the Owner's standard — *"Everything has to be super simple and easy
to use and extremely functional and efficient."* Decision D9 is the exemplar: **a control that
exists because the old page had it, or because a lane could build it, rather than because an
operator needs it there.**

---

## §0 · How to read the numbers

Every measurement below was taken on `localhost:3000/products/cmokmy3a40078pm0p1fvnu523/edit/studio`
(GALE-JACKET, 21 rows) at a **1728×906 viewport**, read-only, between 01:20 and 02:47 on 2026-09-02.
No writes of any kind were performed on any family.

Four things about the evidence, stated up front because they change how much weight each number
carries.

**1. I report clicks, keystrokes, scrolls and guesses — not seconds.** Wall-clock through an
automation harness measures the harness, not an operator. Where time genuinely matters I report the
*server's* latency, measured directly (`curl` against `127.0.0.1:8091`), which is operator-visible
and instrument-independent.

**2. The tree moved under me all night.** Five lanes were editing. Two readings are **VOID** and do
not appear below: a 01:31 `Could not load AMAZON · IT` (the hub's 01:08 restart) and a 01:44 pass
that hit a `grid.css` build error. **Three** whole-app outages happened during the review — a CSS
comment containing `*/` inside `--nds-note-*/--nds-tonal-*`; `familySummary` referenced but undefined
at `MasterSheet.tsx:1156`; and a `viewCtx` used before its declaration that crashed the master scope
~02:20–02:37. All three were other lanes' in-flight edits, all were diagnosed and routed, and none is
a finding about the design. **Because the third overlapped my master-scope work, I re-took every
master-scope reading on the fixed build (02:44–02:47); see §5.** No number here comes from inside a
crash window.

**3. Three findings were fixed while I was writing them up** — the two-editor gap (§2.0), the row
context menu (§2.16) and the images reorder grip (§2.6). Each is marked 🟢 CLOSED and kept, because
the *shape* of the defect is what the Owner should read, not its status.

**4. Two viewports were in the brief; I measured at 1728×906.** The window manager refused a resize
to 1440×900 (`resize_window` returned success and `innerWidth` stayed 1728). Everything below is
therefore the *generous* case: at 1440 the horizontal-overflow and scroll numbers get worse, never
better. Where a number would change materially I say so.

**Where the reference products are invoked** — Linear, Notion databases, Airtable, Shopify admin,
Stripe dashboard, Rithum's listing grid — I am relying on my own knowledge of them, not on anything
fetched during this review. Stated once here rather than repeated.

---

## §1 · The ten canonical tasks

Performed as an operator who has never seen the page, starting from a cold load of the studio.
"Guesses" counts moments where the page gave me two plausible paths and no way to choose.

| # | Task | Clicks | Keys | Scrolls | Guesses | Verdict |
|---|------|--------|------|---------|---------|---------|
| 1 | Change one variation's title for Amazon · IT only | 5 | 2 | 0 | **3** | ⚠ Reachable, but the page never says whether the edit is market-local — and there are two title fields |
| 2 | Fix "missing required" on one child | 2 | — | 0 | 0 | ✅ **The best thing in the studio.** One click isolates exactly the 42 missing fields and nothing else |
| 3 | Add a market the family isn't on (Amazon · PL) | 3 | 3 | 0 | 1 | ⚠ Two clicks to *get* there, then the one control that explains what listing needs answers with a truncated sentence |
| 4 | Bulk-change every child's price by +5% | — | — | — | — | ⛔ **Not possible.** No arithmetic on a selection anywhere in the studio |
| 5 | Find why a channel row last failed to sync | 1 | — | 0 | 0 | ✅ **Exemplary.** Cause, "retrying won't help", what would help, and an honest statement of what the view cannot see |
| 6 | Restore a field to yesterday's value | 4 | 12 | 0 | **2** | ⚠ Requires typing an exact timestamp against an unbounded field; the disabled button mis-states why it is disabled |
| 7 | Reorder a child's images and set a new hero | — | — | 0 | **2** | ⛔ **No hero control exists** — 0 hero/main/primary controls among 144 buttons, re-checked 02:47. Reorder *was* undiscoverable; PES.7 shipped a grip during the review and I verified it on 24/24 tiles |
| 8 | Compare a child against its parent | 2 | — | 0 | 1 | ⚠ The drawer's "Compare" is a *different axis* (scope, not parent); parent overrides live only in the sheet's 🔗 glyph |
| 9 | Find the LIVE state of a listing | 3 | — | 0 | 1 | ⚠ Shows `ACTIVE / pushed: yes / offer: selling` with **no time reference at all**, and the ↗ ASIN is not a link |
| 10 | Switch scope and back without losing your place | 2 | — | 0 | 0 | ⛔ **Sort, selection and scroll are all destroyed.** Measured with a witness |

### Task-by-task detail worth keeping

**1 — two title fields, and no statement of blast radius.** On Amazon · IT the sheet carries both
`Name` and `Nome dell'articolo`; the drawer shows both, 920px apart in the scroll, holding the
*identical* 127-character value, both stamped `🔗 Master`. Nothing distinguishes which one Amazon
publishes. Separately: **5 of 97 drawer fields carry the sentence "Writes to the master record —
this changes every channel, not just this one."** The two title fields are not among them, so the
one question the task asks — *does this change Italy only?* — is unanswered on screen.

**2 — the standout.** `⚠ Missing required (42)` → the sheet collapses to `SKU · Master% ·
Descripción del producto · Viñeta · Readiness`, every row `⚠ required` and `Missing · 2`. 21 × 2 =
42, and the count is honest. From "42 things are wrong" to "here they are, and nothing else" in one
click. See §3.

**3 — the create path works; the explanation does not.** From master · DE: click the market
switcher, type `pol`, click `PL · Poland`, click the `Amazon` chip = **3 clicks + 3 keystrokes**, and
a full sheet renders for a family with zero PL listings, with the alias band reading the neutral
`NOT LISTED`. (PES.3 measured **2 clicks** on the same path; the difference is that they counted from
an already-active channel scope and did not count the option click. Both readings are right about
what they counted.) Then `Check before listing` returns, in full and un-clipped:
`Unknown market "AMAZON:PL". This platform has: ` — 47 characters ending in a colon and a space.

**4 — the gap is total.** Selecting rows produces a bulk bar with exactly three verbs — `Unlink from
parent`, `Move to another parent…`, `Delete variation…` — plus `Clear`. The row context menu adds
nothing arithmetic. AG's fill handle copies a value; it does not multiply. To do +5% on 20 children
an operator computes 20 numbers elsewhere and types them in.

**5 — how the rest should read.** One navigation gives: `Amazon · 50 queued writes across 1 cause ·
18 products · none need you`; the cause `NEXUS_ENABLE_AMAZON_PUBLISH=false`; and the line that makes
it actionable — *"Re-running these writes would be refused by the same gate that failed them… The
flag, not the retry, is what has to change."* Plus two footnotes that disclose the view's own blind
spots. (One blemish: the chips say `Dead (269)` / `All (269)` while the header and the cause row both
say `50`. See §2.12.)

**6 — measured to the disabled control, as the brief directs.** `History → Restore record` offers a
bare `datetime-local` with **no `min`, no `max`, and no list of moments that actually hold changes**.
With a browser-valid value entered, `Show the record then` stays disabled and its tooltip still reads
*"Pick a date and time first"* — which is false; a date and time have been picked.
*What a watched reading would take:* a signed-in session is **not** required — `Show the record then`
is a read. What is required is a value the component accepts; the fastest route is to give the field
`min`/`max` so the operator cannot enter one it silently rejects.

**7 — the affordance is absent, not just hidden.** Across the whole Images tab, **0 of 88 buttons**
mention hero, main or primary (other than `Open MAIN`, which opens the viewer). The viewer displays
`Hero: No` as a read-only fact with no control beside it. The tile itself is a `<button
aria-label="Open …">` with `cursor: zoom-in`; its wrapper has `cursor: auto`, `touch-action: auto`,
no `draggable`, no drag handle and no `aria-roledescription`. I did **not** attempt a drag: a reorder
is a real write to production data and my lane is read-only. So the honest claim is *no discoverable
affordance*, not *no drag support*.

**9 — nothing on the pane is timestamped.** `Status ACTIVE`, `Pushed to channel: yes`, `Offer:
selling`, `Price €105.00`, `Quantity (this channel) 19`, `Channel reference B0BMS6ZZ4H`. A regex for
`ago|as of|last (checked|synced|seen)|updated` over the pane's text returns **nothing**. And the
`↗ B0BMS6ZZ4H` line that reads as "open this on Amazon" is a plain `<div>` beside a text node — no
`href`, no `onclick`, no `title`, not an anchor and not a button. The ASIN is also printed twice.

**10 — measured twice, because the first run was a false pass.** Before (master · DE): `scrollTop
205`, sort `sku:descending`, `2` rows selected. After Master → Amazon → Master: `scrollTop 0`, sort
`[]`, selection `0`. My first attempt showed everything unchanged — because my clicks had *missed*
the chips and the scope never changed. I re-ran it with an `aria-checked` witness on the scope
radios. **Column state I deliberately do not claim:** removing `brand` via Customise did not survive
the round trip, but it also did not survive a plain reload, so under a session-less API I cannot
separate "the switch discarded it" from "it was never persisted".

---

## §2 · Ranked — what to remove, merge or hide

Ranked by operator impact, not by ease. Each item names the owning lane from the claims table.
**Every item here is filed with the hub as a cross-lane request; I have edited nobody's file.**

### §2.0 · Closed during the review — kept for the shape, not the status

**The same field had two different editors depending on scope.** `item_name`, 127 characters, on
`GALE-JACKET-BLACK-MEN-3XL`:

| | master · ES | Amazon · IT (before) | Amazon · IT (after) |
|---|---|---|---|
| element | `textarea` in `ag-popup-editor` | inline `input` | `textarea` in `ag-popup-editor` |
| size | 460 × 126 | **158 × 25** | 460 × 126 |
| of 127 chars visible | all | ~23 | all |

The sheet that exists to tune a market's copy had the worse editor. PES.3 fixed it (`cellEditor` was
simply unset on the channel sheet) and I re-measured on my own row: **460 × 126, all 127 characters**.
Worth keeping because the *class* is what matters — **a capability present on one scope and silently
absent on the other**, which is also §2.1.

---

### §2.1 · 🔴 The channel scope and the master scope are two different applications

**Where:** `_studio/sheet/master/MasterSheet.tsx` (PES.2) vs `_studio/sheet/channel/**` (PES.3);
shape owned by UX.1's layout-v2 spec.

**Measured today.** Switching from Master to Amazon on the same product, the operator loses:
the search box, the `Overview ▾` view menu, `Customise`, `Export`, `Reload`, the checkbox column, the
whole per-column filter row, the bulk-action bar, and the four family verbs. It gains three
right-aligned badges, a `Preflight ★ (20)` chip and `+ Add listing alias`. The chrome above the grid
is **42px on master** (one merged toolbar, after tonight's v2 landing) and **99–111px on a channel**,
in three ragged bands that do not share an alignment: badges right at y≈89, `Preflight` left at
y≈127, `+ Add listing alias` right at y≈154.

**Why it is the top item.** Six of the ten tasks either start on a channel scope or end there. An
operator who has learned the master sheet has to learn a second, poorer sheet to do the market work
that is the product's entire reason for existing — and the poorer one is where the Owner's operators
will spend most of their day.

**Simplest alternative.** One toolbar component for both scopes, with scope-specific controls taking
slots in it rather than replacing it. Airtable does exactly this: switching from Grid to Gallery
changes the *canvas*, never the toolbar — search, filter, sort, row height and share stay in the same
places. Concretely: keep search / view menu / Customise / Export / Reload always; let the channel
scope contribute `Preflight`, the three badges and `+ Add listing alias` into the same row.

**What it would break.** Nothing structural; the channel sheet has no saved views today, so `Overview
▾` would need either a channel view set or to render disabled with a reason. Export on a channel
scope needs AG.1's `exportGrid` to accept the channel column model.

**Confidence: high.** Both layouts measured on the same build, minutes apart.

---

### §2.2 · 🔴 The record drawer opens 97 fields at once, all groups expanded

**Where:** `_studio/drawer/**` — **PES.4**. (FE.1 owns the render-cost half and has filed it;
this is the product half, which they deliberately left to this lane.)

**Measured.** The Record pane is **641px tall with 13,682px of content — 21.3 screens.** Seven
groups, all `aria-expanded="true"` on open: Identity 7 · **Attributes 61** · Identifiers 6 · Pricing
7 · Inventory 4 · Physical 6 · Amazon 6 = **97 fields**. Each field carries a provenance chip, a
`Field history` button and a `Compare across scopes` button: **291 controls in a 520px-wide panel,
of which 4 field rows are visible at a time.** (FE.1 independently counted 96/192; the one-field
difference is the read-only SKU row. Neither number changes the conclusion.)

And the deep link does not help: opening a record from a cell puts `&cell=item_name` in the URL, and
the pane sits at `scrollTop: 11`. The field the operator clicked is at offset **1,429px** — four
screens down, never revealed.

**Simplest alternative.** Two changes, both subtractive:
1. **Open with every group collapsed except the one containing the cell the operator came from**,
   and scroll to that field. Notion's page-properties panel and Stripe's object drawer both open
   *at* the thing you clicked, not at the top of everything.
2. **Drop the per-field `Compare across scopes` icon** — 97 controls gone. Compare needs a field
   selected, and when you arrive from a cell the field *is* selected; the tab can compare that one.
   Keep the per-field `⟲ Field history`: it is the only route into history that works (§2.5).

**What it would break.** An operator who today scrolls to browse all attributes would need one extra
click per group. That is the trade, and it is worth it at 21.3 screens.

**Confidence: high.**

---

### §2.3 · 🔴 Nothing an operator sets survives a scope switch

**Where:** the remount is **PES.1**'s (the studio page re-executes on every URL-state change); the
state that should survive it is **PES.2**'s.

**Measured with a witness** (§1, task 10): sort, row selection and scroll position are all reset.
Column state could not be separated from "never persisted" under a session-less API and is **not**
claimed.

**Why it matters more than it looks.** The studio's whole model is "compare the same rows across
scopes". An operator who sorts by stock, scrolls to the row they care about, flips to Amazon to check
it and flips back lands at the top of an unsorted sheet, every time.

**Simplest alternative.** Sort and scroll are already URL-expressible — the frame writes `scope`,
`market`, `locale`, `tab`, `chip` and `rec` to the URL. Adding `sort` puts sort in the same
mechanism, survives reload and back/forward for free, and needs no new store. Selection is the
harder one and is also the least missed; Linear drops selection on view change too.

**What it would break.** Nothing. It is additive to a mechanism that already exists.

**Confidence: high** for sort/selection/scroll; **not assessed** for columns.

---

### §2.4 · 🔴 Customise: 98 checkboxes, 13.3 screens, no search — in the market's language

**Where:** the shared DS preferences modal — **DS.2** (with DS.1 as DS component owner). Not
studio-local: the same modal serves six pages.

**Measured.** The left column list holds **98 checkboxes** in a **258px viewport with 3,436px of
content = 13.3 screens**, with **no search input** (`searchInputs: 0`) and no type-ahead. The right
"In view" list is 1.4 screens. And the attribute the operator is hunting is labelled in the *market's*
language: `Aufzählungspunkt` on DE, `Viñeta` on ES.

This is the Owner's "complicated to make changes" complaint, measured.

**Simplest alternative.** A search box at the top of the left list. This is an addition, and I said
the brief is subtraction — so, precisely: it removes 13.3 screens of scrolling and the requirement
that an English-speaking operator know the German word for "bullet point". Airtable, Notion and
Linear all put a search field at the top of their field/column pickers, for exactly this reason.
Pair it with §4.1 (English labels on master) and the problem mostly disappears.

**What it would break.** Nothing. Additive, inside one shared component.

**Confidence: high.**

---

### §2.5 · Two of the drawer's four tabs are empty destinations

**Where:** `_studio/drawer/**` — **PES.4**.

**Measured.** `History → Field history` renders one sentence and no controls: *"Pick a field — the ⟲
beside any attribute on the Record tab — to see what has happened to it."* `Compare` renders
*"Pick a field on the Record tab to compare it across scopes."* and **zero buttons**
(`btns: 0`, pane `scrollHeight === clientHeight`).

So two of four top-level tabs are destinations whose only content is an instruction to go to a
different tab — and the icon they point at is the real entry point.

**Simplest alternative.** `History` shows the **record's** change log (every field, newest first) —
which is what an operator means by "history", and which the audit rows already exist to answer;
the field ⟲ then filters it. `Compare` stops being a tab and becomes what the field icon opens.
Net: one tab removed, one tab filled, no new concepts. Stripe's object view does exactly this — a
single Events/Logs tab for the object, filterable to one field.

**What it would break.** The field ⟲ / compare icons need a target to open into; if Compare stops
being a tab, it becomes a section within History or a popover. PES.4's call.

**Related, unconfirmed:** I observed once that clicking a field's `Compare across scopes` icon
switched to the Compare tab **without carrying the field** (the pane still said "Pick a field"). The
build was rebuilt under me before I could reproduce it, so **I do not file this as confirmed** — it
needs one re-run on a stable build.

**Confidence: high** for the empty tabs; **unconfirmed** for the icon-carries-nothing observation.

---

### §2.6 · The Images tab has no hero control and no visible way to reorder

**Where:** `_studio/images/**` — **PES.7**.

**🟢 THE REORDER HALF IS CLOSED — PES.7 shipped a grip and I verified it on the current build.**
`span.tileGrip`, 20×20, `cursor: grab`, present on **24 of 24 tiles**, titled *"Drag to reorder — or
select it and use ← Move / Move →"* — which names the keyboard route too. Re-measured 02:47.

**⚠ Correction to my own evidence, per hub ruling #334.** My first pass cited "no `draggable`
attribute" as part of the case. That was worthless: PES.7's drag is pointer-based, so `draggable`
was never the mechanism and its absence proved nothing either way. The conclusion was right for a
different reason — the *operator* evidence, which stands: nothing on screen said the tiles could be
dragged, and the tile's own cursor was `zoom-in`. **Nobody reading this later should take "no
`draggable`" as "no drag".** (My re-check nearly repeated the error in reverse: a probe for
`[class*=grip]` returned `false` because the class is `tileGrip`, capital G. Testing for the
*mechanism* — `cursor: grab` anywhere on the page — found all 24. Guessing a name produces a false
negative; asking what the browser computed does not.)

**🔴 THE HERO HALF STANDS.** Re-measured on the same build: **144 buttons on the tab, and the only
matches for hero/main/primary are "Skip to main content" and "Open MAIN".** The viewer still shows
`Hero: No` as a read-only fact with no control beside it.

**Simplest alternative.** One control on the tile's hover state — `Set as main` — beside the grip
that now exists. Shopify's product-media grid puts both in the same place: drag to reorder, and the
first tile is labelled as the one customers see first.

**What it would break.** Nothing. `Hero` is already a modelled fact — it is displayed and not
settable.

**Confidence: high.** Hero controls absent from the DOM, measured twice on two builds. I never
tested whether dragging *works*, because that is a write — and I did not need to: PES.7 owns that
and has confirmed it.

---

### §2.7 · The readiness numbers look like one idea and are four

**Where:** vocabulary **PES.5**; scope chip **PES.1**; row column and `Readiness` cell **PES.2**.

**Measured on one screen at a time:**
- Scope chips read `Master 71%` and `Amazon 71%` — the *same number*. Their accessible names say
  different things: Master is *"Warnings · 71%. Publishable, with fields this channel may reject"*;
  Amazon is *"Blocked · 71%. Required fields are missing or invalid — this scope cannot publish."*
  The number is the part that is identical; the state is the part that matters, and the state is the
  part only a screen-reader user gets.
- The per-row `Master` column reads `22%` on DE and `23%` on PL for the same rows.
- On master · PL every row's `Readiness` cell reads **`Ready`** while the `Master` scope chip reads
  **`—`**. These are two deliberate vocabularies (hub ruling #3) — but on screen, together, they say
  "unknown" and "ready" about the same thing.

**Simplest alternative.** Lead the chip with the **state word**, not the percentage — `Master ·
Warnings`, `Amazon · Blocked` — and put the number second or in the tooltip. Two chips that differ
in meaning should differ in what they display. Stripe does this everywhere: the badge says
`Succeeded` / `Requires action`, never `71%`.

**What it would break.** Nothing; it is a label change. The two-vocabulary rule stays intact — this
makes the *difference* visible instead of hiding it behind identical numerals.

**Confidence: high** on the readings; **medium** on the remedy, since PES.5 owns what the percentage
means and may have a better second line.

---

### §2.8 · The Listings pane cannot say how old its truth is, and its one link is not a link

**Where:** `_studio/drawer/**` — **PES.4** (pane), with the listing shape from **PES.5**.

**Measured** (§1, task 9): no time reference anywhere in the pane; `↗ B0BMS6ZZ4H` is a `<div>` with
an SVG beside a bare text node — no `href`, no handler; and the ASIN is printed twice, once as
`Channel reference` in the fact list and once under the glyph.

**Simplest alternative.** Delete the duplicated ASIN block and make the remaining `Channel reference`
value the link (one control replaces two), and add one line — `as of <timestamp>` — beside the status
facts. If we do not know when the listing was last read, say `never checked` rather than printing
`selling` with no date. Shopify's channel panel shows `Published · synced 2 minutes ago`; the second
half is the half that lets an operator act.

**What it would break.** Nothing, if the read timestamp exists. If it does not, that is the finding
and the pane should say so rather than implying freshness.

**Confidence: high** on the measurements; the timestamp's availability is PES.5's to confirm.

---

### §2.9 · "Restore record" asks for a timestamp it will not accept, and mis-states why

**Where:** `_studio/drawer/**` — **PES.4**.

**Measured.** The `datetime-local` input has **empty `min` and empty `max`**. With a value the
browser reports as *valid* (`validity.valid === true`), `Show the record then` remains disabled and
its tooltip still reads **"Pick a date and time first"** — a disabled control giving the wrong
reason, which is the exact family the programme's own honesty rule names.

**Simplest alternative.** Replace the free timestamp with **the list of moments that actually have
recorded changes** — the audit rows already exist; the Errors and Activity surfaces read them. The
operator picks a version instead of guessing a time, and the "some fields cannot be recovered"
caveat (which is good, and stays — see §3) attaches to a specific version rather than to the whole
idea. Notion and Google Docs both do this; nobody types a timestamp into a version history.
Failing that: set `min` to the record's creation and `max` to now, and make the tooltip name the
actual reason.

**What it would break.** Nothing. It narrows an unbounded input to the values that can succeed.

**Confidence: high.**

---

### §2.10 · The one control that explains "what would it take to list here" returns half a sentence

**Where:** the message is server-side (**PES.5**); the surface is **PES.3**'s channel scope.

**Measured, in full and un-clipped** (`scrollWidth === clientWidth`, 47 characters):

> `Unknown market "AMAZON:PL". This platform has: `

It promises a list and ends. This is the answer to the second half of task 3 — the replacement for
the removed "List on Amazon · market" wizard — so it is the sentence that has to carry D9's weight.

**Simplest alternative.** Either finish the sentence (name the markets this platform *does* have), or
replace it with what the operator can act on: *"Amazon is not set up for PL. Nothing would publish
here until a mapping exists for PL · OUTERWEAR."* The eBay chip's tooltip already says something of
exactly that shape and says it well — copy that sentence's structure.

**What it would break.** Nothing.

**Confidence: high.**

---

### §2.11 · On an unlisted market, the page says both "Not listed" and "1 listing"

**Where:** `_studio/sheet/channel/**` — **PES.3**.

**Measured** on Amazon · PL, three strings inside one 99px band:
`Not listed` · `This row has no listing on this channel` · `1 listing · 20 SKUs on Amazon · PL`.

The first two are right. The third contradicts them roughly 200px away.

**Simplest alternative.** The summary should be derived from the same read as the band, not
computed separately — or suppressed entirely when the coordinate has no listing, since `Not listed`
already said it. One statement, not two.

**Confidence: high.**

---

### §2.12 · Errors & Sync: three counts of the same thing that do not agree

**Where:** `_studio/channel-ops/**` / Errors & Sync — **PES.3**.

**Measured** on Amazon · IT: chips read `Dead (269)` and `All (269)`; the header reads `50 queued
writes across 1 cause · 18 products`; the single cause row reads `50 writes · 18 products`. An
operator cannot reconcile 269 with 50, and the footnote that explains the view's coverage explains a
*different* thing (which rows can appear at all).

Also on that surface: `since 09/06/2026` in an English UI is ambiguous — read as MM/DD it is a
future date. Use `9 Jun 2026`.

**Simplest alternative.** One count, or two counts whose labels say why they differ. If 269 is
"dead rows for this channel" and 50 is "dead rows for this product", the chips should say so.

**Confidence: high** on the readings; the cause of the discrepancy is PES.3's to determine.

---

### §2.13 · The content locale is a second axis that is almost always noise

**Where:** `_studio/StudioBar.tsx` — **PES.1**.

**Measured.** The locale switcher offers **9 locales on every market** — 12 markets × 9 locales = 108
combinations, of which a handful are real. On Amazon · IT it offers Turkish. And the auto-link is
inconsistent: selecting IT set locale to Italian, while selecting **PL left the locale on German**,
producing `PL · Poland` + `German (de)` with nothing on screen flagging it.

**Simplest alternative.** Derive the locale from the market and show it as text, not a control —
surfacing a picker only for the markets that genuinely have more than one selling language (Amazon
BE is the real case: nl and fr). That removes a control from the primary bar for eleven of twelve
markets and removes the possibility of a nonsense coordinate.

**What it would break.** Any workflow that deliberately edits one market's copy in another language.
I have not found one; if the Owner has, this item is void.

**Confidence: medium** — the measurement is certain, the judgement about BE-style markets is mine.

---

### §2.14 · The drawer shows the same title twice and says nothing about which one publishes

**Where:** `_studio/drawer/**` (**PES.4**) over the field set from **PES.5**.

**Measured** (§1, task 1): `Name` at scroll offset 506 and `Nome dell'articolo *` at 1,429 — same
127-character value, same `🔗 Master` chip, neither carrying the "writes to the master record" line
that 5 other fields carry.

**Simplest alternative.** On a channel scope, show the channel's field and reference the platform
field beneath it (*"from Name on the master record"*), rather than presenting two peers. And extend
the blast-radius sentence to every field that has one — its absence currently reads as "this one is
safe", which is a guess the operator should not have to make.

**Confidence: high** on the duplication; **medium** on whether the two fields genuinely write to
different places, which PES.5 owns and which I could not test without a write.

---

### §2.15 · Two error surfaces; one of them leaves the operator with no move

**Where:** frame-level — **PES.1**.

**Measured, both on screen tonight.** A failed scope read renders `Could not load AMAZON · IT` /
`Failed to fetch` as plain text with **no retry control** — the operator's only recourse is a browser
reload. A component crash renders the error boundary: the actual error name plus a **`Try again`**
button.

**Simplest alternative.** One surface, shaped like the boundary: what failed, in the operator's
terms, and a button that retries. Merge, not add — this removes a second error idiom.

**Confidence: high.** Both surfaces observed directly; the "Failed to fetch" one appeared during a
server restart, so its *trigger* was environmental — its *shape* is the finding.

---

### §2.16 · The row context menu carries six items nobody chose

**Where:** `design-system/grid/**` under PES.2's claim — **AG.1** owns the grid's menu wiring.

**Measured**, master row menu, 10 items: `Open record`, `Unlink from parent`, `Move to another
parent…`, `Delete variation…` (the studio's four), then `Cut ⌃X`, `Copy ⌃C`, `Copy with Headers`,
`Copy with Group Headers`, `Paste ⌃V`, `Export ›` (AG Grid's defaults).

`Copy with Group Headers` offers to copy group headers on a sheet that displays no column groups.
`Export ›` duplicates the toolbar's `Export` button, with a different affordance and a different
scope.

**🟢 CLOSED — verified on screen at 02:46.** The menu now carries **8** items: `Open record`,
`Unlink from parent`, `Move to another parent…`, `Delete variation…`, `Cut`, `Copy`, `Copy with
Headers`, `Paste`. `Copy with Group Headers` and `Export ›` are both gone — exactly the two named
here, and the two an operator would otherwise have had to try in order to learn they were pointless.

**Confidence: high**, and no longer open.

---

### §2.17 · `Pause offer` and `Activate offer` are both offered on an active row

**Where:** `_studio/sheet/channel/**` / the action registry — **PES.3**.

**Measured**, row menu on an `ACTIVE` Amazon · IT row: both `Pause offer on Amazon · IT` and
`Activate offer on Amazon · IT` are listed. One of them is always a no-op, and the operator has to
know the row's state to know which.

**Simplest alternative.** One item whose label follows the state. Two verbs → one.

**Confidence: high.** (Both were disabled under local dev with a correct reason — see §3 — so this
is about the menu's shape, not its gating.)

---

### §2.18 · A permanent six-item keyboard tutorial in the footer

**Where:** `design-system/grid/**` footstrip — **PES.2**.

**Measured.** `Enter to edit · Enter again to save · ↓↑ to move · Tab → · drag the corner to fill ·
⌘Z` — 491px, rendered on every sheet, forever. `Tab →` names a key and not an outcome; `⌘Z` has no
verb at all.

**Simplest alternative.** Keep the row count. Move the shortcuts behind the conventional `?` overlay,
or show the strip until the operator's first successful edit and then retire it. Linear, Notion and
Airtable all teach shortcuts through `?`; none of them spends permanent chrome on it.

**What it would break.** Discoverability for a first-time operator — which is why "until the first
edit" is the safer half of the alternative.

**Confidence: medium.** The measurement is certain; whether the Owner wants the reminder permanent is
a preference, and `feedback_keep_placeholder_controls` suggests caution about removing visible aids.

---

## §3 · Already simple — do not touch

Labelled **watched** (I performed the interaction and saw it behave) or **read** (I only inspected
it), per hub ruling #294.

1. **The `Missing required (42)` chip.** — **watched.** One click; the sheet becomes exactly the two
   deficient columns across 21 rows, `Missing · 2` each, 21 × 2 = 42. Nothing else changes. This is
   the single best interaction in the studio and the pattern the other chips should follow.
2. **The Errors & Sync cause view.** — **watched.** Groups 50 writes under one cause, states that
   retrying is refused by the same gate, names the flag that would change it, and discloses that 86%
   of queue rows can never appear here so an empty list means nothing. Do not "tidy" those footnotes.
3. **Disabled write verbs that name the permission and the reason.** — **watched.** Every gated verb
   carries *"Not signed in to the API — this needs products.edit…"* on the control itself. Seven
   controls in the landing chrome are disabled and every one of them explains itself.
4. **The scope chips' accessible names.** — **watched** (read via the a11y tree, and I operated the
   chips). *"eBay — Not set up. No mapping rules configured for eBay · IT and OUTERWEAR — nothing
   would publish here"* is the best sentence in the product. §2.7 asks for it to be *visible*, not
   for it to change.
5. **The `Overview ▾` view menu.** — **watched.** Eight curated views (Overview, Content, Specs,
   Logistics, Pricing, Identifiers, Localisation · DE, Everything else) plus `Save current as new
   view…`. This is what keeps the 98-column Customise dialog rare; §2.4 is about the fallback, not
   about this.
6. **The error boundary's shape.** — **watched**, twice, involuntarily. It names the real error and
   offers `Try again`. §2.15 asks the *other* error surface to look like this one.
7. **The master long-text popup editor.** — **watched.** 460 × 126, full value, clamped inside the
   viewport (`right: 1728` against `innerWidth: 1728`). It is now the channel editor too.
8. **`Restore record`'s honesty note.** — **watched.** *"Values are reconstructed from what was
   recorded about the changes since — not from a stored copy, so some fields cannot be recovered."*
   §2.9 changes the input, never this sentence.
9. **The drawer footer.** — **watched.** *"5 of 7 required fields filled · 22% complete · autosaves
   per field"* — a denominator, a percentage and the save model in nine words.
10. **The field-level blast-radius sentence.** — **watched.** *"Writes to the master record — this
    changes every channel, not just this one."* The sentence is right; §2.14 is about the 92 fields
    that lack it.
11. **The images viewer's `USED ON CHANNELS` back-references.** — **watched.** `AMAZON · PT03 ·
    Nero`, `AMAZON · ES · PT03 · Nero` — coordinate-level, which is what makes a delete decision
    safe.
12. **The v2 merged toolbar that landed tonight.** — **watched**, measured before and after: master
    chrome **91px → 42px**, and the grid viewport now holds 20 rows at 36px. Whatever budget pressure
    comes next, this is the win to defend.
13. **`NOT LISTED` on an unlisted coordinate.** — **watched** on Amazon · PL. Neutral, accurate, and
    not the false `DRAFT` it used to read.

---

## §4 · Questions only the Owner can answer

**4.1 · Should the master sheet's column headers be in English?**
On the **Master** scope — which the product itself calls "the stored truth" — the columns are Amazon
attribute names localized to whichever market is selected: `Markenname / Artikelname /
Aufzählungspunkt` on DE, `Marca / Nombre del producto / Viñeta` on ES. Measured on two markets, same
scope. The standing rule is that UI copy is English. My recommendation, which matches the hub's:
**English on master, the market's language on a channel scope** — an operator preparing an Italian
listing benefits from seeing Amazon's Italian label; an operator maintaining the master record does
not. This also removes most of the pain in §2.4.

**4.2 · Does the placeholder-control rule extend to the studio's primary action?**
`Publish ▾` is the most prominent control in the header, and **every item in its menu is disabled**,
by construction rather than by session — the menu's own footer says publishing is not wired to it.
The standing rule is to keep placeholder controls, and the menu is scrupulously honest about it. The
question is whether that rule was meant to cover the one button the header exists to offer, or
whether `Publish ▾` should be hidden until it can send something.

**4.3 · Is bulk arithmetic on a selection in scope for the studio?**
Task 4 (+5% on every child) cannot be done here at all. The three bulk verbs are structural
(unlink / move / delete). Should the studio grow "apply a formula to the selected cells" — the
Airtable/Excel model the sheet metaphor already promises — or does price maths stay on the pricing
page, in which case the sheet should say so rather than leaving the operator to discover the absence?

**4.4 · Where should an operator land?**
`/products/<id>/edit` still serves the **old** page — with the `Datasheet · Amazon File · eBay File ·
Recover · List on Channel` link-outs D9 removed from the studio. The studio is at
`/products/<id>/edit/studio`. I assume this is a deliberate pre-cutover state, but it means the D9
decision is currently reversed for anyone who navigates normally.

**4.5 · Is the content locale a control the operator needs?**
See §2.13 — nine locales on every market, and a PL market currently pairs with a German locale
without complaint. Is there a real workflow that edits one market's copy in another market's
language, outside genuinely multilingual markets like Amazon BE?

**4.6 · Should a percentage appear on a chip at all?**
`Master 71%` and `Amazon 71%` are the same number meaning "publishable with warnings" and "blocked".
The state is what an operator acts on. Is the number worth the space it takes and the confusion it
causes, or should the chip say the state and keep the number for the tooltip?

---

## §5 · What I did not verify, and why

- **No write was performed anywhere**, so every task involving a mutation (1, 2, 4, 6, 7) is measured
  *to the disabled control*, as the brief directs. §1 says per task what a watched reading would need.
- **Image reorder-by-drag was not attempted** — it is a real write to production data.
- **Column-preference persistence** could not be separated from "never saved" under a session-less
  API (§1, task 10).
- **The compare-icon-carries-no-field observation** (§2.5) was seen once and could not be reproduced
  before the build changed under me. It is recorded as unconfirmed, not filed.
- **1440×900 was not measured** — the window manager refused the resize. All numbers are the 1728×906
  case, which is the generous one.
- **Three whole-app outages** (a `grid.css` comment containing `*/`; an undefined `familySummary`;
  and a `viewCtx` used before its declaration, reported by the hub as crashing the master scope
  ~02:20–02:37) were other lanes' in-flight edits, diagnosed and routed, and are not findings about
  the design.
- **The third of those overlapped my master-scope readings, so I re-took them all on the fixed build
  (02:44–02:47) rather than reason about whether they were affected.** Reproduced unchanged: chrome
  **42px**, **24** chrome controls of which **7** disabled with the same names, the views menu's
  **9** entries, the Images tab's **0** hero controls. Two things had genuinely moved and are marked
  closed above, not void: the row context menu (§2.16, 10 → 8) and the images grip (§2.6). Nothing
  in this document rests on a reading taken inside the crash window.
