import type { ICellRendererParams } from 'ag-grid-community';
import { type CellProvenance, type ProvenanceLike } from './provenance';
/**
 * 🔴 Mirrored by hand and deliberately WIDER than the producer, for the reason
 * `_studio/sheet/master/types.ts` records at length: a consumer may be wider than its producer and
 * must never be narrower. Every optional here is optional because an older server omits it, and
 * absence is UNKNOWN rather than a default this file invents.
 *
 * Source of truth: `docs/vt1-contracts.md` §1 (FINAL, VT.1). Fixtures: `docs/fixtures/vt1/fixtures.ts`.
 */
export interface VariationThemeAxis {
    axisKey: string;
    familyKey: string;
    label: string;
    /** What the channel DELIVERS. This — never `label` — is what the cell prints (§1.4). */
    channelName: string;
    target: string | null;
    included: boolean;
    segment?: string;
    /** Set when this axis binds to nothing on this coordinate. Rendered in warning tone. */
    unbound?: {
        reason: string;
    } | null;
}
export interface VariationThemeCell {
    axes: VariationThemeAxis[];
    theme: {
        code: string;
        label: string;
        deprecated: boolean;
    } | null;
    source: {
        kind: 'derived' | 'rule' | 'override' | 'none';
        ruleLabel: string | null;
        category: string | null;
        /** Verbatim, server-stated (§1.1). The cell NEVER composes this. */
        label: string;
        tieBreak?: 'bare-form' | 'only-match' | 'only-live' | 'set-order' | 'kept-from-listing';
    };
    candidates: {
        kind: 'theme-enum' | 'aspects' | 'free';
        items: Array<{
            code: string;
            label: string;
            coversAll: boolean;
            drops: string[];
            deprecated: boolean;
            required?: boolean;
        }>;
        limit: number | null;
        schemaFetchedAt: string | null;
        /**
         * 🔴 FOUR-way, and `ok` is only ever sent with a NON-EMPTY list. `unavailable` = we COULD NOT LOOK;
         * `no-theme` (R-VT-7) = we looked and this Amazon product type declares no variation theme, so there is
         * nothing to offer. An empty list that reads as "none exist" is the defect all four words exist for.
         */
        state: 'ok' | 'freeform' | 'unavailable' | 'no-theme';
        unavailableReason?: string;
    } | null;
    /** MASTER ONLY, and the scope discriminator this file reads — see `isMasterProjection`. */
    masterCandidates: Array<{
        key: string;
        label: string;
        axisKey: string;
        valueCount: number;
    }> | null;
    dropped: string[];
    collisions: {
        unresolved: number;
        summary: string;
    } | null;
    locked: {
        reason: string;
        externalId: string | null;
        setChangeIs: 'relist' | 'new-parent' | 'in-place';
        orderChangeAllowed: boolean;
        /**
         * VT.2c — the axes this coordinate has ALREADY PUBLISHED, so each of them keeps its row and
         * loses only its target control, with `reason` on the element the operator hovers (spec §4.4.4).
         *
         * VT.F item A5: BOTH producers serve it now. It was optional while only the projection read did
         * (`family-projection.service.ts`, from the parent listing's `__lastPublishedAxes`), so the sheet
         * cell rendered the unlocked arm on a coordinate the dock showed as partly frozen — two answers to
         * "may I move this axis" for one live listing. `lockedAxisKeysFrom()` is now the one function both
         * call. It stays OPTIONAL in the TYPE so an older server's payload still parses, and a missing value
         * is read as `[]` at exactly one place (`axisLockReason`), never as "nothing is locked" by accident.
         */
        lockedAxisKeys?: string[];
    } | null;
    /**
     * VT.2c — the PRESENTATION order's writability on this coordinate, when the server states it.
     *
     * Separate from `locked` on purpose, because the two answer different questions and the dock
     * measured both: `locked` is "this coordinate has published", `order.writableHere` is "this
     * endpoint can write the order at all" (`docs/vp2-contracts.md` §4.1 — eBay's presentation order
     * keeps its own editor and its own CAS pair, so the projection PATCH does not touch it). An
     * unlocked coordinate can still refuse a reorder, which a lock flag alone cannot express.
     */
    order?: {
        writableHere: boolean;
        reason: string;
    };
    /**
     * VT.2c — the FAMILY axes this coordinate may still add, when the producer states them.
     *
     * `+ Add a <noun>` adds an AXIS, not a channel target: an aspect added as an axis produces an
     * `axisKey` the family does not have, and the projection PATCH would refuse it (measured by VT.4:
     * the dock's own add list is the family axes minus the mapped ones, and it is empty on every
     * coordinate of this catalogue because the server lists every family axis in `mapping`). Absent
     * on the sheet cell, whose producer does not serve it — REQUEST TO VT.1.
     */
    addableAxes?: Array<{
        axisKey: string;
        familyKey: string;
        label: string;
    }>;
    /**
     * VT.2c — the coordinate's own names, SERVER-STATED, for the sentences that name it.
     *
     * The sheet cell carries its coordinate inside `write`, and every sentence read it from there. A
     * host whose write is NOT this panel's has nowhere to put them: the Variants dock owns its own
     * `Save mapping`, so its adapter sets `write: null` on purpose — and every aria sentence then read
     * `The This coordinate specific for Color`, measured in this file's own suite before the field
     * existed. `channel` is the channel's word (`eBay`), `scope` the composed coordinate (`eBay · IT`).
     */
    coordinateNames?: {
        channel: string;
        scope: string;
    };
    write: {
        endpoint: 'variation-axes' | 'projection';
        expectedVersion: number;
        aliasKey: string;
        coordinate: {
            channel: string | null;
            market: string;
            accountId: string | null;
        };
        childIds?: string[];
    } | null;
    deliveryNote?: string;
    writable: boolean;
    writeBlockedReason: string | null;
    vocabulary: {
        axisNoun: string;
        axisNounPlural: string;
        sectionTitle: string;
    };
    separator: string;
    /**
     * EDITOR-ONLY, never on the wire: the operator pressed `Reset to rule`, so the commit is
     * `{ expectedVersion, reset: true }` ALONE (contract §3.3 — combining it with `theme` or `mapping`
     * is a `400 bad_projection_request`). It rides on the reported value because the reported value is
     * the only thing AG hands the write path, and a parallel channel for one boolean is how an
     * intent gets lost between two hosts.
     */
    resetRequested?: boolean;
    /**
     * EDITOR-ONLY, never on the wire: the cell AS THE SERVER SERVED IT, captured when the editor
     * opened.
     *
     * 🔴 It has to travel on the reported value, because by commit time the BEFORE is gone. AG's
     * `valueSetter` replaces `row.values[key]` in place (it must — `reference_ag_value_setter_must_
     * mutate_params_data`), and on the master sheet the grid row IS the object the sheet payload
     * holds, so a commit that read "the row's current value" as the baseline would compare the edited
     * cell with itself, compute `kind: 'none'`, and send nothing at all. Measured exactly that way on
     * `VX-TEST-3AX`: a witnessed reorder gesture, the editor's own footer reading `order`, Enter
     * pressed — and zero requests on the wire.
     *
     * Nothing serialises it: `variationThemeWrite` derives a BODY from these facts and never sends the
     * cell object, so the baseline cannot reach a route.
     */
    baseline?: VariationThemeCell;
}
/** The CHILD-row reason, verbatim (Appendix A · contract §1.3). */
export declare const VARIATION_THEME_CHILD_REASON = "Set on the parent";
/**
 * Is this projection the MASTER's?
 *
 * 🔴 Read from ONE wire fact rather than a per-builder flag. Contract §1.2: master serves
 * `candidates: null` with `masterCandidates` filled; every channel coordinate serves
 * `masterCandidates: null`. `write.endpoint === 'variation-axes'` is the same fact from the write
 * side and is used only as the fallback for a row that carries no candidates at all, because a
 * coordinate with no listing serves `write: null` and must not silently read as master.
 */
export declare function isMasterProjection(cell: VariationThemeCell): boolean;
export type VariationThemeState = 'child' | 'unset' | 'delivered';
/**
 * Which of the design §3.4 states this cell is in.
 *
 * `unset` covers BOTH empty sentences — master's `Set axes…` and Amazon's `Choose a theme` — because
 * they are one state wearing two server-stated labels, not two states. What separates them on
 * screen is the TONE (`variationThemeUnsetTone`), and that follows a fact, not a guess.
 */
export declare function variationThemeState(cell: VariationThemeCell | null | undefined): VariationThemeState;
/**
 * `warning` or `muted` for the `unset` state.
 *
 * Design §3.4 / canvas artboard 5: master's `Set axes…` is muted while the family is empty and turns
 * `⚠ required` **once the family has children** — the children are the reason the structure matters.
 * `write.childIds` is where the wire states them (contract §1.2 relays them because the
 * `variation-axes` validator requires them back), so the tone follows a measured count and not an
 * assumption. On a channel coordinate `Choose a theme` is always a warning: readiness raises
 * `theme-unset` as an ERROR there (contract §4), so a muted cell would understate a blocking fact.
 */
export declare function variationThemeUnsetTone(cell: VariationThemeCell): 'warning' | 'muted';
/**
 * Copy, export and filter text — contract §1.4, stated there so both hosts agree.
 *
 * INCLUDED axes only, `channelName` (never `label`), joined with the coordinate's own separator:
 * `Color · Size` on master and eBay, `Farbe / Größe` on Amazon·DE. A child row is the em dash the
 * grid uses everywhere else; a family with no axes is `''`, because the cell is showing a SENTENCE
 * (`source.label`) at that point and exporting that sentence as a value would put prose in a CSV
 * column of names.
 */
export declare function variationThemeText(cell: VariationThemeCell | null | undefined): string;
/**
 * The wire's `source.kind` as the facts `classifyProvenance()` reads — NOT a provenance member.
 *
 * 🔴 This function exists so that there is no second classifier. It answers in the DS's own
 * vocabulary (`layer`, `inherited`, `pinned`) and hands the verdict to the one classifier the
 * master sheet, the channel sheet and the drawer already share (ruling #11).
 *
 * | scope   | `source.kind`        | facts                                  | member      |
 * |---------|----------------------|----------------------------------------|-------------|
 * | master  | any                  | `layer: 'master'`, nothing inherited   | `own`       |
 * | channel | `derived` \| `rule`  | `layer: 'master'`, `inherited: true`   | `inherited` |
 * | channel | `override`           | `layer: 'channel'`, `pinned: true`     | `pinned`    |
 * | channel | `none`               | `layer: 'master'`, nothing inherited   | `own`       |
 *
 * **`rule` draws 🔗 and not Σ, and that is the canvas's word, not an oversight.** Σ (`mapped`) is the
 * DS member for "computed by a rule", and its whole justification is that the next click lands on a
 * different surface. Here it does not: design §3.4 and canvas artboard 5 both draw the link glyph
 * for `derived` AND for `rule` ("Same mark; tooltip 'Follows rule Apparel default'"), because the
 * editor this cell opens can override the rule ON THIS COORDINATE — the click lands here either
 * way. The rule is named in the tooltip, which §9.6b calls the right home for a secondary fact.
 * Recorded as `ASSUMED:` in the ledger with the doc lines that decide it.
 */
export declare function variationThemeProvenance(cell: VariationThemeCell): ProvenanceLike;
/** The member, through the ONE classifier. Exported so the gate and the tests read what the cell reads. */
export declare function variationThemeProvenanceMember(cell: VariationThemeCell): CellProvenance;
/**
 * The cell's ONE tooltip. Every line is server-stated; the order is what most changes the next action.
 *
 * Amazon·DE reads `COLOR/SIZE` then `Derived from the family axes` — design §3.4's own example. The
 * enum CODE leads because it is the fact the printed label cannot carry (two enum spellings share
 * one label on this product type — `COLOR/SIZE` and `COLOR_NAME/SIZE_NAME` are both `Farbe / Größe`,
 * measured by VT.0), so a tooltip without it cannot tell an operator which theme is live.
 */
export declare function variationThemeTooltip(cell: VariationThemeCell | null | undefined): string;
export interface VariationThemeValueParams {
    /** Set by the host when the row is a CHILD, so the `—` carries its reason without a value. */
    childReason?: string;
}
/**
 * The cell. `.nds-cell-value` + `.nds-cell-value-text` are the ENGINE's own wrappers (grid.css:843)
 * — the same two master's `withMark` uses — so the mark sits on the value's line and the names
 * truncate before anything trailing moves (#707's measured defect). The trailing pieces are
 * SIBLINGS of the text for exactly that reason.
 */
export declare const VariationThemeValue: import("react").NamedExoticComponent<ICellRendererParams<any, any, any> & VariationThemeValueParams>;
