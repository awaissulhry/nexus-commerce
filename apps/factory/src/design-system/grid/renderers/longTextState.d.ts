/**
 * GDS — what a long-text cell's length MEANS, as a state rather than a number (spec §9.3a).
 *
 * ## Why this is a state and not a counter
 *
 * `LongTextCell` used to render "127/200" beside one line of text. At 160px the text already
 * truncates to `XAVIA G…`; at the 110px §9.3 gives these columns the counter would be most of the
 * cell, so the width saving would be spent on the least useful half of its content. The cell's job
 * in a sheet is *empty / fine / nearly out of room / already refused* — the exact figures belong in
 * the tooltip, where they cost nothing.
 *
 * ## Why it is a separate `.ts` with NO imports
 *
 * `apps/web`'s vitest runs in a node environment and cannot render a component, so a rule living
 * inside `cells.tsx` can only be asserted, never tested. `provenance.ts`, `readiness.ts` and
 * `mediaCell.ts` already split this way — the vocabulary in a `.ts`, the rendering in the `.tsx`.
 * 🔴 Nothing on this module's import path may be a `.tsx`, which is why the params type lives HERE
 * and `cells.tsx` re-exports it, rather than the other way round.
 *
 * ## The five states, and why `unchecked` is not `filled`
 *
 * UX.1 ruled four marks (`empty · filled · near · over`) with three conditions, and their second
 * one produces the fifth: *where no cap is known there is no `near` and no `over`, and the cell must
 * not imply a cap exists.* A cell can be **unchecked** rather than **within cap** — the `caps` pill
 * exists precisely because a product type can have no cached schema. Measured on GALE-JACKET,
 * **60 of 96 columns carry no cap at all**, so this is the majority case, not an edge. Collapsing
 * `unchecked` into `filled` would assert compliance from missing information.
 *
 * 🔴 **`unchecked` means "no cap known HERE", never "no cap exists"** (UX.1's amendment). Some of
 * those 60 are not uncapped, they are UNDELIVERED: `product_description` carries `maxBytes: 20000`
 * on the wire and it reached the cell as a unit flag with the cap itself dropped — *a cap that was
 * never passed is not an absent cap*. So nothing here — the name, the tooltip, the label, or any
 * test — may assert that the FIELD has no limit. When the wire half lands, those cells move to
 * `filled`/`near`/`over` without this model having claimed anything it must then retract.
 *
 * The sheet-level fact has its own home: the `caps` notice, which says the schema was never cached.
 * The MARK answers "what about this cell"; the NOTICE answers "did we know at all".
 */
/** How much room is left before the mark warns. */
export declare const NEAR_RATIO = 0.8;
export type LongTextState = 'empty' | 'unchecked' | 'filled' | 'near' | 'over';
/** The caps as the wire states them. Both may be present, in different units. */
export interface LongTextCaps {
    /** Character cap. */
    maxLength?: number | null;
    /** Byte cap — Amazon counts UTF-8 bytes on some fields. */
    maxBytes?: number | null;
    /** Which channel imposes the tightest cap, e.g. `"Amazon · DE"`. UX.1's condition 1: a mark names its source. */
    capFrom?: string | null;
    /** Shown when the cell is empty and the field is required. */
    required?: boolean;
}
export interface LongTextReading {
    state: LongTextState;
    /** The value's length in the BINDING cap's unit; `null` when nothing caps it. */
    length: number | null;
    cap: number | null;
    unit: 'characters' | 'bytes' | null;
    capFrom: string | null;
    /** Everything the mark does not say, for the cell's tooltip. */
    title: string;
}
/**
 * 🔴 The VERDICT is not computed here. `evaluateLengthCaps` (PES.2, `editors/sheet.ts`) is the one
 * implementation — which caps apply, which one binds, and whether the value is over — and
 * `lengthValidation` calls the same function. That is the whole point: the mark an operator sees and
 * the refusal they eventually get cannot reach different answers about one cell. This module owns
 * only the MAPPING to five states and the wording.
 *
 * ⚠ `../editors/sheet` keeps this module's node-testability: its sole import is `import type` from
 * `ag-grid-community`, erased at runtime. A VALUE import there would drag AG's runtime into every
 * node test that reaches this file — there is a note on that file saying so, and it needs to stay.
 */
export declare function longTextState(value: unknown, caps?: LongTextCaps): LongTextReading;
/**
 * What the mark says out loud. Separate from the tooltip because a screen reader should get the
 * STATE without the arithmetic, and because a mark whose only distinction is colour is unreadable
 * to a large minority of operators (UX.1's condition 3 — the glyph carries it, the tone reinforces).
 */
export declare function longTextMarkLabel(r: LongTextReading): string;
