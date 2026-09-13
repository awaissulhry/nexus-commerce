/**
 * GDS / PES.2 — cell PROVENANCE: where the value in this cell actually came from.
 *
 * The Product Edit Studio's whole claim is that one grid can show a master value, a variation's own
 * value, a channel override and an AI draft without the operator having to remember which surface
 * they are on. That only works if every cell says, on its own, which layer it is reading — so this
 * is a mark, in the cell, next to the value:
 *
 *   🔗  inherited   the parent's value; this row has none of its own. Edit to pin.
 *   ✎   pinned      this row overrides the layer above it.
 *   ✦   AI-drafted  proposed, not confirmed. Tinted until a human approves it.
 *   (none)          the row's own, plainly stored value — the common case, and it gets no ink.
 *
 * **A glyph, never a colour alone.** The tint is an aid; a operator with any colour-vision
 * difference reads the icon and the tooltip. Same rule the tag identity work landed on.
 *
 * PURE — no React, no lucide, so the node-environment vitest suite can test it. The MARK itself
 * (the icon) is `provenanceMark.tsx` beside this file; splitting them is the DS's own convention
 * (`format.ts` pure + tested, `cells.tsx` React), and it is what lets these rules be tested at all.
 *
 * The classifier lives here rather than in a page because PES.2 (master), PES.3
 * (channel aliases) and PES.4 (the record drawer) must all reach the same verdict about the same
 * cell — a drawer that says "inherited" over a cell drawn "pinned" is worse than either alone.
 */
/**
 * Where a cell's value came from, in the order the resolver layers them.
 *
 * `aiStale` is PES.8's request and it earns its own state: a draft generated against a value the
 * operator has since edited. Approving it would overwrite that edit, so it must NOT look like a
 * clean draft — same reason a refused save stays red instead of fading.
 *
 * `inheritedOverride` is PES.3's, ratified as hub ruling #16, and it earns its own state for a
 * sharper reason: **it resets to a different place.** A variant row inheriting from its ALIAS looks
 * identical to one inheriting from the master, but the alias is itself an override — so "reset this
 * cell" returns it to the alias's value, not the master's, and an operator who read the plain 🔗
 * has been told the wrong thing about what their next click does. Layout §1 draws the alias level
 * with its own glyph, so a tooltip-only distinction is below the bar.
 */
/**
 * `mapped` / `mappedShared` are §9.6, ruled by UX.1 (hub #351/#355). A value derived by the mapping
 * engine is a **mark in the cell**, never a column of its own: a column duplicates the value and
 * spends the width §9.1 is already fighting for.
 *
 * 🔴 `mappedShared` is `productLevelOnly` — the resolver is keyed by PRODUCT, so every alias row of
 * one product shows the SAME derived value. It earns its own member rather than a tooltip variant
 * because **editing one alias row changes all of them**, and the operator must see that before
 * acting. It is a claim about SCOPE, where `mapped` is a claim about ORIGIN.
 */
/**
 * `formula` is D16's, ruled at #763, and it earns its own member by §9.6b's own test — **it changes
 * where the next click lands**. A formula cell is not edited by typing a value over it: opening it
 * opens the FORMULA, and the value on screen is the engine's output for this row. Drawn as `pinned`
 * it would promise that typing replaces the value, when typing replaces the RULE; drawn as `mapped`
 * it would send the operator to a mapping rule that does not exist, because a cell formula lives on
 * this cell and nowhere else.
 *
 * It is also the member that makes the value on screen honest. Until it existed the sheet showed a
 * formula's OUTPUT with no mark at all — indistinguishable from a typed value — while the cell that
 * had just been committed showed the formula TEXT as though that were the value.
 */
import type { CellProvenance } from '@nexus/shared/cell-provenance';
export type { CellProvenance } from '@nexus/shared/cell-provenance';
/**
 * The minimal cell shape the classifier needs. Both apps' fuller `SheetCellValue`
 * (`{ value, source, inheritedFrom, inherited }`) satisfies it, and so does a channel override row.
 */
export interface ProvenanceLike {
    tier?: 'pin' | 'language' | 'source' | 'computed';
    /** Resolver verdict, with the tier named for the operator rather than a storage id. */
    provenance?: {
        member: CellProvenance;
        from: string | null;
    };
    translation?: {
        outdated: boolean;
        source?: 'manual' | 'ai' | 'translated';
        reviewedAt?: string | null;
    };
    follows?: boolean | null;
    /**
     * PES.5's explicit verdict, and AUTHORITATIVE when present:
     * `master | variant | alias | aliasVariant | channel | linked | default`. The server knows which
     * layer supplied the value; a client re-deriving it from `source` strings is guessing at
     * something already decided.
     */
    layer?: string | null;
    /** PES.5: this layer stores its own value — the ✎ glyph, stated rather than inferred. */
    pinned?: boolean;
    /** PES.5: a `FieldLinkGroup` supplies this value — the 🔗 glyph. */
    linkGroupId?: string | null;
    /**
     * The RESOLVER's word for the layer that won, when no explicit `layer` is given:
     * `master | masterLocale | masterColumn | variant | variantLocale | channelOverride |
     * channelExplicit | default` (`attribute-resolver.ts`'s `ValueSource`). Kept for the
     * catalogue-wide sheet read, which predates the studio contract.
     */
    source?: string | null;
    /** The row this value was inherited FROM, when it was inherited. */
    inheritedFrom?: string | null;
    /** The server's own verdict: this row has no value of its own. */
    inherited?: boolean;
    /**
     * #780 — the SERVER'S OWN reason this cell's formula produced nothing, or null/absent when it
     * produced something. `CellFormula.lastError` on the wire.
     *
     * 🔴 There is no `refused` boolean anywhere in the system and this is deliberately not one.
     * Measured 2026-09-04: the `CellFormula` model carries `id product productId scope channel
     * marketplace locale fieldKey expr dependsOn market lastError evaluatedAt version updatedBy
     * createdAt updatedAt` — no `refused` column. The `refused` flag that reads like one lives on the
     * recalc RESULT, not on the row, so a client rendering "the row's refused flag" would render a
     * field that does not exist. A stored expression plus a non-null `lastError` IS the refusal, and
     * it is already on the wire.
     */
    refusedReason?: string | null;
    /** Set by the AI enrichment lane (PES.8) on a drafted, unapproved value. */
    aiDrafted?: boolean;
    /** PES.8: the cell has moved since the draft was generated — approving it overwrites an edit. */
    aiStale?: boolean;
    /**
     * PES.6's resolver's verdict for this cell — the contract's own `MappedCell | null`, read
     * structurally so the channel's `StudioCellValue` satisfies this interface unchanged.
     *
     * 🔴 Presence is NOT derivation. `status: 'unmapped'` means the engine RAN and produced nothing,
     * which is not a derived value and must not wear the mark — marking it would tell an operator a
     * rule decides this cell when no rule matched it. I first modelled this as `mapped?: boolean`
     * and the compiler refused it against the real contract, which is the only reason the distinction
     * got made at all.
     */
    mapped?: {
        status?: string;
        provenance?: string | null;
        derived?: boolean;
    } | null;
    /**
     * The mapping resolved at PRODUCT grain, so every alias of this product carries the same value.
     * A refinement of `mapped`, not a sibling — it only applies to a cell that was actually derived,
     * because "shared across aliases" says nothing about a cell no rule produced. It arrives from
     * `meta.mapping.productLevelOnly`, which is a fact about the RUN, not about the cell.
     */
    mappedProductLevel?: boolean;
    /**
     * A stored `CellFormula` produces this cell's value (D16). Supplied by the lane from its own
     * per-family read — never inferred from the value looking like an expression, because a value
     * that merely STARTS with `=` is a string an operator is entitled to store.
     */
    formula?: boolean;
}
export declare function classifyProvenance(cell: ProvenanceLike | null | undefined, layer?: 'master' | 'variant' | 'channel'): CellProvenance;
/**
 * The sentence a cell's tooltip carries for its provenance. One wording, so the sheet, the drawer
 * and the channel scopes cannot describe the same cell three ways.
 */
export declare function provenanceTooltip(provenance: CellProvenance, from?: string | null): string;
/**
 * `cellClassRules` for provenance. Pair with `ProvenanceMark` in the renderer: the class carries
 * the tint, the mark carries the meaning.
 */
export declare function provenanceClassRules<T>(read: (data: T, colId: string) => CellProvenance): {
    'nds-cell-is-inherited': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    'nds-cell-is-inherited-override': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    'nds-cell-is-pinned': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    'nds-cell-is-mapped': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    'nds-cell-is-mapped-shared': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    'nds-cell-is-outdated': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    'nds-cell-is-formula': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    /**
     * 🔴 `nds-cell-is-FORMULA-refused`, NOT `nds-cell-is-refused` — and the name is the whole fix.
     *
     * `roundTripClassRules` has owned `nds-cell-is-refused` since long before this member existed,
     * where it means THIS CELL'S SAVE WAS REJECTED. I reused the name for a refused FORMULA, which
     * is a different fact about a different mechanism, and on master the sheet spreads
     * `...prov, ...rt` — so the round-trip rule, correctly returning false for a cell with no
     * rejected save, silently overrode this one. Both spreads were right; the collision was mine.
     * It cost a long hunt because every part in isolation was correct: the reader returned the
     * reason, `provOf` returned 'refused', and calling this very function by hand returned true —
     * while the class never appeared, because a later spread had the same key.
     * Two mechanisms must not share a class name, whatever the CSS happens to look like today.
     */
    'nds-cell-is-formula-refused': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    'nds-cell-is-ai-draft': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
    'nds-cell-is-ai-draft-stale': (p: {
        data?: T;
        colDef: {
            colId?: string;
            field?: string;
        };
    }) => boolean;
};
/** One source sentence for cells, tooltips and compare on both sheet hosts. */
export declare function describeCellSource(cell: ProvenanceLike | null | undefined, options?: {
    layer?: 'master' | 'variant' | 'channel';
    from?: string | null;
    refusedReason?: string | null;
}): {
    member: CellProvenance;
    from: string | null;
    tooltip: string;
};
