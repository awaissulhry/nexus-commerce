# One Cell Editor Shell — design for approval

**Status:** hub order #776(3), written by `nexus-commerce-b0`. **Design only. Nothing built.**
The hub asked to see this before any code, and the Owner sees it.

---

## 1. Why one shell, in one paragraph

Today the sheet has **five editors and three behaviours**: `agTextCellEditor` and
`agNumberCellEditor` inline, `agLargeTextCellEditor` and the DS `SelectPanelEditor` and
`FormulaCellEditor` as popups. Every property that ought to be a property of *editing* — where the
box sits, how wide it is, what the origin cell does, which keys commit — is currently a property of
*whichever editor happened to open*. That is why this month produced a fill handle that swallowed
double-clicks, a long-text box displaced 202 px from its own cell, a formula box displaced 79 px, a
select whose origin cell went blank, and a locked cell that refused in silence on one scope and
explained itself on the other. **Each was fixed separately. None of them could have been fixed
once**, because there was no "once" to fix them in.

The shell is that "once": one component that owns anchoring, sizing, the origin-cell treatment and
the keyboard model, hosting a small body per column kind.

## 2. What it is

```
┌─ EditorShell (design-system/grid/editors/EditorShell.tsx) ──────────────┐
│  owns:  anchor (top-left pinned to the cell)                            │
│         size   (editorBox: clamp(cellW, contentW, min(cap, roomRight))) │
│         origin (outline on the cell; value hidden only for `over`)      │
│         keys   (Enter/Tab/Esc/typing/F2 — Excel's model, one place)     │
│         commit (one path to the writer; untouched ⇒ never writes)       │
│                                                                         │
│  hosts one body, chosen by column kind:                                 │
│    text     → <TextBody>      (inline-feel, single line)                │
│    number   → <NumberBody>    (numeric input, digit-guarded)            │
│    longtext → <LongTextBody>  (textarea + the cap counter)              │
│    select   → <SelectBody>    (the DS ListboxPanel, unchanged)          │
│    yes/no   → <SelectBody>    (a two-option select — see §6)            │
│    formula  → <FormulaBody>   (field + completions + preview)           │
└─────────────────────────────────────────────────────────────────────────┘
```

The shell is **one AG cell editor** registered once. `cellEditorSelector` stops choosing between
five components and instead chooses a *body*. `cellEditorPopup` stops being a per-column decision:
the shell is always a popup, and "inline" becomes a **presentation** of the shell that is exactly
the cell's box, not a different mechanism.

🔴 **That last sentence is the whole design.** Inline-vs-popup is currently an AG mechanism switch
with different anchoring, different key ownership and different origin-cell behaviour. Making it a
size instead means a text cell and a formula cell differ only in how big the box is and what is
inside it — which is precisely the Owner's *"one consistent rule per column kind, not per mood"*.

## 3. What it fixes that today's code cannot

| today | with the shell |
|---|---|
| `cellEditorPopup` per column; AG owns Enter/Tab/Esc differently for popup vs inline | one popup, one key model, asserted once |
| `isCancelAfterEnd` exists on the formula editor only | one commit path; untouched never writes, for every kind |
| the blanking rule keys on `:not(.nds-cell-is-select)` — a **proxy** for "is this popup `under`" | the shell knows its own placement; no proxy |
| refusal wording wired per sheet (master first, channel three weeks later, caught by the gate) | the shell refuses, so both scopes get it the day it lands |
| a new kind means a new editor and five new places to remember | a new kind is a body |

## 4. The keyboard model, stated once

Measured today and unchanged by this design — the shell's job is to make it *uniform*, not to
change it (see `2026-09-03-cell-editing-contract.md`):

`Enter` commits and moves down · `Tab` commits and moves right, opening the next cell ·
`Esc` cancels and never writes · typing replaces · `F2` edits in place · click-away commits.

🔴 One deliberate change is proposed, and it is the only behavioural change in this document:
**typing a non-numeric character on a number cell currently opens an EMPTY editor** (measured:
`basePrice` showed `0`, `Q` gave `""`), so committing from there clears the value. The shell's
`NumberBody` would reject the keystroke and keep the value, as Excel does. Flagged separately in the
contract because it is a change, not a port.

## 5. Migration — four steps, each shippable and gated

1. **Shell + `TextBody` + `NumberBody`.** Replaces the two inline editors. The contract gate's
   `text` and `number` rows must stay green through the swap; the geometry block must stay flush.
2. **`LongTextBody`.** Replaces `agLargeTextCellEditor` and retires the `--nds-editor-w/h` CSS
   custom-property channel, which exists only because AG's stock editor takes `rows`/`cols` and not
   pixels. This is where the shell pays for itself.
3. **`SelectBody`.** Wraps the existing `SelectPanelEditor` body unchanged; the shell takes over its
   anchoring and origin-cell handling, which removes the `nds-cell-is-select` proxy.
4. **`FormulaBody`.** Last, because it is the richest and the only one with a completions layer.

Each step lands with the contract gate green on both scopes; a step that reddens a row does not
land. **No step changes what the sheet does** except §4's number-key rule.

## 6. What I would not do, and why — the parts worth arguing about

- **I would not fold yes/no into a checkbox.** It is a two-option select on this system (0 boolean
  columns of 96 on the wire) and a checkbox cannot express "not set".
- **I would not make the shell a modal.** Pencil & Paper's data-table analysis is blunt that modals
  take the operator *"away from the context of the table"*, and the whole point of a sheet is the
  neighbouring rows.
- **I would not build this before the Customise-reload defect is settled.** See §7.
- **The shell does not replace the Phase 2 cell/formula bar** the hub has parked. They compose: the
  bar is a second, always-present host for the same bodies. If the bar is approved first, the shell
  gets cheaper, not redundant — which is an argument for deciding the bar first.

## 7. 🔴 The reason I would not start yet

Measured today on a fresh context with an 8 s settle: **a column ticked in Customise does not
survive a reload**, on master *and* on Amazon·IT, including `handmade_classification` — the exact
column ruling #774 used when it closed the Owner's item 44. Attribution is not established and it is
not this lane's change.

Rebuilding every editor on a sheet whose column set does not survive a reload means every
verification of the rebuild inherits that instability, and a rebuild is the worst possible time to
be unsure whether a column's absence is your fault. **Settle that first; then step 1 is a day.**

## 8. What the hub is being asked to decide

1. Build the shell, or wait for the Phase 2 bar decision first?
2. Is §4's number-keystroke change approved as part of it, or does it ship separately now?
3. Does step 1 start before or after the Customise-reload defect is attributed and fixed?
