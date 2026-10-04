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
/**
 * 2026-10-04 (channel cell marks) — four members for the channel scopes, each minted by ruling #16's test (the next
 * action differs), each with its own glyph:
 *
 *   🕒  pending       saved in Nexus; the channel gets it only when you publish.
 *   ⓘ   attention     the channel or the mapping disagrees with what Nexus would send (saved but not sent, a reported
 *                     FBA listing, a mapping error). Read the reason before acting.
 *   🏪  listingValue  the listing still holds its own older text, not the Shared product's. "Follow Shared" fixes it.
 *   ≋   listingLevel  one value for the whole listing (an eBay item specific on a variation row): editing it here
 *                     edits every variation.
 *
 * `classifyProvenance` does NOT produce them from the generic inputs — the Shared scope and the Variants tab keep their
 * verdicts. The product sheet's channel verdict is one sheet function that may return them; this file only describes
 * them (label, sentence, tint, precedence).
 */
import type { CellProvenance } from '@nexus/shared/cell-provenance'
export type { CellProvenance } from '@nexus/shared/cell-provenance'

/**
 * What a screen reader says for each mark, and the first words of its hover. Short, plain English. A `Record`, so a
 * member added to `CellProvenance` without a label fails the typecheck instead of reading as an empty name.
 */
const PROVENANCE_LABEL: Record<CellProvenance, string> = {
  own: '',
  outdated: 'Out of date',
  inherited: 'Inherited',
  inheritedOverride: 'Inherited via an override',
  pinned: 'Pinned',
  mapped: 'Derived by a mapping rule',
  mappedShared: 'Derived per product, shared by every alias',
  ai: 'AI-drafted',
  aiStale: 'AI-drafted, out of date',
  formula: 'Calculated by a formula',
  refused: 'The formula produced no value',
  pending: 'Waits for Publish',
  attention: 'Needs attention',
  listingValue: 'Listing value',
  listingLevel: 'One value for the whole listing',
}

/** The mark's short name — its accessible name when no source or sentence is given. Empty for `own` (no mark). */
export function provenanceLabel(provenance: CellProvenance): string {
  return PROVENANCE_LABEL[provenance] ?? ''
}

/**
 * Which member a cell wears when several facts hold at once — strongest first, by §9.6b's rule: the fact that most
 * changes the NEXT action wins. `classifyProvenance` already follows this order for the members it produces; the
 * channel sheet's verdict and a mixed slot list (bullets) pick by it.
 *
 * refused › attention › pending › aiStale › ai › outdated › formula › listingLevel › listingValue › mappedShared ›
 * mapped › inheritedOverride › inherited › pinned › own
 */
export const PROVENANCE_PRECEDENCE: readonly CellProvenance[] = [
  'refused', 'attention', 'pending', 'aiStale', 'ai', 'outdated', 'formula', 'listingLevel', 'listingValue',
  'mappedShared', 'mapped', 'inheritedOverride', 'inherited', 'pinned', 'own',
]

/** The strongest of several members by `PROVENANCE_PRECEDENCE`; `own` for none. */
export function strongestProvenance(members: Iterable<CellProvenance>): CellProvenance {
  let best = PROVENANCE_PRECEDENCE.length - 1
  for (const m of members) {
    const at = PROVENANCE_PRECEDENCE.indexOf(m)
    if (at >= 0 && at < best) best = at
  }
  return PROVENANCE_PRECEDENCE[best]
}

/**
 * The minimal cell shape the classifier needs. Both apps' fuller `SheetCellValue`
 * (`{ value, source, inheritedFrom, inherited }`) satisfies it, and so does a channel override row.
 */
export interface ProvenanceLike {
  tier?: 'pin' | 'language' | 'source' | 'computed'
  /** Resolver verdict, with the tier named for the operator rather than a storage id. */
  provenance?: { member: CellProvenance; from: string | null }
  translation?: { outdated: boolean; source?: 'manual' | 'ai' | 'translated'; reviewedAt?: string | null }
  follows?: boolean | null

  /**
   * PES.5's explicit verdict, and AUTHORITATIVE when present:
   * `master | variant | alias | aliasVariant | channel | linked | default`. The server knows which
   * layer supplied the value; a client re-deriving it from `source` strings is guessing at
   * something already decided.
   */
  layer?: string | null
  /** PES.5: this layer stores its own value — the ✎ glyph, stated rather than inferred. */
  pinned?: boolean
  /** PES.5: a `FieldLinkGroup` supplies this value — the 🔗 glyph. */
  linkGroupId?: string | null
  /**
   * The RESOLVER's word for the layer that won, when no explicit `layer` is given:
   * `master | masterLocale | masterColumn | variant | variantLocale | channelOverride |
   * channelExplicit | default` (`attribute-resolver.ts`'s `ValueSource`). Kept for the
   * catalogue-wide sheet read, which predates the studio contract.
   */
  source?: string | null
  /** The row this value was inherited FROM, when it was inherited. */
  inheritedFrom?: string | null
  /** The server's own verdict: this row has no value of its own. */
  inherited?: boolean
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
  refusedReason?: string | null
  /** Set by the AI enrichment lane (PES.8) on a drafted, unapproved value. */
  aiDrafted?: boolean
  /** PES.8: the cell has moved since the draft was generated — approving it overwrites an edit. */
  aiStale?: boolean
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
  mapped?: { status?: string; provenance?: string | null; derived?: boolean } | null
  /**
   * The mapping resolved at PRODUCT grain, so every alias of this product carries the same value.
   * A refinement of `mapped`, not a sibling — it only applies to a cell that was actually derived,
   * because "shared across aliases" says nothing about a cell no rule produced. It arrives from
   * `meta.mapping.productLevelOnly`, which is a fact about the RUN, not about the cell.
   */
  mappedProductLevel?: boolean
  /**
   * A stored `CellFormula` produces this cell's value (D16). Supplied by the lane from its own
   * per-family read — never inferred from the value looking like an expression, because a value
   * that merely STARTS with `=` is a string an operator is entitled to store.
   */
  formula?: boolean
}

/**
 * Classify one cell.
 *
 * Order matters: an AI draft is reported as a draft even when it is also technically the row's own
 * value, because "a machine proposed this and nobody has agreed" is the fact an operator must act
 * on. `inherited` beats `pinned` for the same reason — it is the weaker claim on the value.
 *
 * A row that carries a value from a layer BELOW the one it is displayed on (a variation showing a
 * channel override, an alias showing its own title) reads as `pinned`: the resolver named a source
 * other than the plain master, and nothing was inherited.
 */
/** Studio-contract layers that ARE the master — inheriting from one of these is a plain 🔗. */
const MASTER_LAYERS = new Set(['master', 'default'])
/** Resolver sources that ARE the master, however the master happens to store that field. */
const MASTER_SOURCES = new Set(['master', 'masterlocale', 'mastercolumn', 'default', 'schema'])
/** Resolver sources that are an explicit override of the layer above. */
const OVERRIDE_SOURCES = new Set(['channeloverride', 'channelexplicit', 'variantoverride', 'aliasoverride', 'override', 'pinned'])

export function classifyProvenance(cell: ProvenanceLike | null | undefined, layer: 'master' | 'variant' | 'channel' = 'master'): CellProvenance {
  if (!cell) return 'own'
  /**
   * 🔴 `refused` OUTRANKS EVERYTHING, including `ai` — and it is the only member that exists because
   * a cell was asserting something FALSE (#780).
   *
   * A formula whose result the server refused stores its expression and writes no value. Before this
   * member existed the cell classified as `formula` and drew `ƒ · "Calculated by a formula on this
   * cell"` over a value the formula had not calculated — the refusal reason rendered nowhere at
   * rest, so the only person who ever saw it was whoever caused it, in that instant.
   *
   * Precedence by §9.6b's rule — which fact most changes the next action — puts it top. Every other
   * member describes where a value CAME FROM; this one says the cell is not what its own mark
   * claims. An unapproved AI draft asks for a decision; a refusal says the sheet is currently
   * lying, and that outranks a decision.
   */
  if (cell.refusedReason != null && cell.refusedReason !== '') return 'refused'
  const member = cell.provenance?.member
  if (member === 'refused') return 'refused'
  if (cell.aiDrafted) return cell.aiStale ? 'aiStale' : 'ai'
  if (cell.translation && (cell.translation.source === 'ai' || cell.translation.source === 'translated') && !cell.translation.reviewedAt) return cell.translation.outdated ? 'aiStale' : 'ai'
  if (member === 'ai' || member === 'aiStale') return member
  if (cell.translation?.outdated || member === 'outdated') return 'outdated'
  /**
   * §9.6, and the ORDER is the ruling (#355). `ai` > `mappedShared` > `mapped` > the chain below.
   *
   * 🔴 **Precedence is by which fact most changes the NEXT ACTION, not by which claim is weakest.**
   * That correction matters more than the placement: `ai` does not win for being a weak claim, it
   * wins because "a machine proposed this and nobody has agreed" demands a decision.
   *
   * `mapped` outranks `inherited` because it is the mark that **redirects the operator to a
   * different surface**: an inherited cell is edited HERE and editing pins it, but a mapped value
   * is computed at read time and stored nowhere, so the click that changes it is the RULE, not the
   * cell. Drawing it 🔗 would promise that reset returns the master's value — and what is on screen
   * was never the master's value, only a function of it. That is `inheritedOverride`'s defect shape
   * (#16): a mark that misdescribes what the next click does.
   *
   * `mappedShared` outranks `mapped` because **editing one row changes N**.
   *
   * The chain that fed the rule is NOT lost — it goes in the tooltip, which is the right home for a
   * secondary fact. §9.6b: *a combination earns its own member only when it changes where the next
   * click lands*, so "mapped-from-inherited" and "mapped-from-pinned" share `mapped` rather than
   * multiplying the vocabulary by layers × sources.
   */
  /**
   * 🔴 `formula` sits directly below `ai` and ABOVE the derived pair, on §9.6b's rule that
   * precedence follows which fact most changes the next action.
   *
   * Above `mapped`: both are computed, but they are edited in different PLACES. A mapped value sends
   * the operator to the rule; a formula is edited here, in this cell. A cell that is both — a
   * mapping rule that matched AND a formula stored on the cell — must read as the one the operator
   * can act on, which is the formula.
   *
   * Below `ai`: an unapproved draft still demands a decision first, and a formula is not a claim
   * awaiting agreement.
   */
  if (cell.formula || member === 'formula') return 'formula'
  // A resolver result can be an explicit listing override, with no rule applied.
  const derived = cell.mapped?.status === 'mapped' && (cell.mapped.derived ?? cell.mapped.provenance !== 'override')
  if (derived && cell.mappedProductLevel) return 'mappedShared'
  if (derived) return 'mapped'
  if (member) return member === 'pinned' && cell.follows ? 'inherited' : member
  /**
   * 🔴 `inheritedFrom` alone is NOT evidence of inheritance.
   *
   * The resolver sets it to the id of the entity the value came from — and for a PARENT's own
   * value that is the parent itself. Reading it as inheritance drew every master attribute on the
   * parent row as "🔗 inherited from GALE-JACKET", i.e. inherited from itself. Caught on screen on
   * real data, not in a test: 21 of 21 rows wore the glyph when only the 20 children should have.
   *
   * So the server's explicit `inherited` verdict wins whenever it is present, and `inheritedFrom`
   * is only consulted when nobody stated one. A wrong 🔗 is worse than a missing one — it tells
   * the operator their edit will pin a value that is already this row's own.
   */
  const isInherited =
    typeof cell.inherited === 'boolean' ? cell.inherited : cell.inheritedFrom != null && cell.inheritedFrom !== ''

  // ── PES.5's studio contract states the answer; take it. ──────────────────────────────────
  if (cell.layer != null && cell.layer !== '') {
    const explicit = cell.layer.toLowerCase()
    if (explicit === 'linked' || (cell.linkGroupId != null && cell.linkGroupId !== '')) return 'inherited'
    // Inherited, but from WHERE? A layer that is itself an override resets somewhere other than
    // the master, so it is a different state and not a different tooltip (ruling #16).
    if (isInherited) return MASTER_LAYERS.has(explicit) ? 'inherited' : 'inheritedOverride'
    if (cell.pinned) return 'pinned'
    // On a channel sheet the master is the layer ABOVE, so a value stored on a more specific layer
    // is a pin even when the server did not set `pinned` (it sets it for the six flagged fields).
    if (layer !== 'master' && explicit !== 'master' && explicit !== 'default') return 'pinned'
    return 'own'
  }

  // ── Otherwise infer from the resolver's own `source`. ────────────────────────────────────
  const source = (cell.source ?? '').toLowerCase()
  if (isInherited) return !source || MASTER_SOURCES.has(source) ? 'inherited' : 'inheritedOverride'
  if (cell.pinned) return 'pinned'
  if (!source) return 'own'
  if (OVERRIDE_SOURCES.has(source)) return 'pinned'
  // 🔴 `masterLocale` and `masterColumn` ARE the master — the master simply stores that field in a
  // locale slot or a legacy column. Treating any non-`master` string as a pin marked most content
  // cells on a channel sheet ✎ "pinned away from the master" when they were the master's own.
  if (layer !== 'master' && !MASTER_SOURCES.has(source)) return 'pinned'
  return 'own'
}

/**
 * The sentence a cell's tooltip carries for its provenance. One wording, so the sheet, the drawer
 * and the channel scopes cannot describe the same cell three ways. It is also the mark's own text — its hover and its
 * accessible name (`ProvenanceMark`, 2026-10-04) — so `from` means ONE thing everywhere: the layer or source the value
 * follows, came from, or no longer follows ("GALE-JACKET", "the Shared product", "the Primary listing", "the Italian
 * text"), never the row's own SKU and never where a pin is stored.
 *
 * Punctuation rule (2026-10-04): no sentence ENDS with a full stop — the hover, the accessible name and the
 * mark-plus-source text all read as one line. A sentence may hold a full stop inside (outdated, aiStale, a formula
 * named by `from`). A `from` that IS the server's sentence (refused, pending, attention) is returned verbatim, with
 * whatever punctuation the server wrote.
 *
 * `by` (`mapped`, `mappedShared` only, 2026-10-04): the rule that derives the value when it has a name of its own — "the
 * reusable rule “Apparel brand”" — so the sentence names its author and its source apart ("Derived by the reusable rule
 * “Apparel brand” from the Shared product"). Absent = "a mapping rule"; every other member ignores it.
 */
export function provenanceTooltip(provenance: CellProvenance, from?: string | null, by?: string | null): string {
  switch (provenance) {
    case 'inherited':
      return from
        ? `Inherited from ${from} — edit to give this row its own value`
        : 'Inherited from the parent — edit to give this row its own value'
    case 'inheritedOverride':
      // "the Shared product", never "the master": the UI renamed Master → Shared (PR #250).
      return from
        ? `Inherited from ${from}, which itself overrides the Shared product — resetting returns it to ${from}, not to the Shared product`
        : 'Inherited from a layer that itself overrides the Shared product — resetting returns it there, not to the Shared product'
    case 'pinned':
      return from ? `Pinned on this row — it no longer follows ${from}` : 'Pinned on this row — it no longer follows the layer above'
    case 'mapped':
      // §9.6 requires the mark to NAME ITS SOURCE — and to say where the value is actually decided,
      // because this cell is not the place.
      return `Derived by ${by || 'a mapping rule'}${from ? ` from ${from}` : ''}`
    case 'mappedShared':
      // The scope statement is the whole point: without it, N identical rows assert N independent
      // resolutions when there was one.
      return `Derived per product${by ? ` by ${by}` : ''}${from ? ` from ${from}` : ''} — every alias of this product shares this value, so editing one changes all of them`
    case 'refused':
      /**
       * 🔴 THE SERVER'S OWN REASON AND NOTHING ELSE (#780). No prefix, no "the formula was
       * refused:", no restatement of the field name. The server already writes a whole sentence
       * naming the value, the field and the allowed options; wrapping it would produce two voices in
       * one tooltip and, where the server names the field, two labels for one column.
       *
       * The fallback is deliberately thin. It fires only when a cell is classified `refused` with
       * no reason text, which the classifier makes impossible — it is here so a future caller that
       * sets the member some other way cannot render an empty tooltip.
       */
      return from ?? 'This formula produced no value'
    case 'formula':
      // Names WHERE the next click lands, like every other member's wording.
      return from
        ? `Calculated by a formula on this cell — ${from}. Edit the cell to change the formula`
        : 'Calculated by a formula on this cell — edit the cell to change the formula'
    case 'outdated':
      return `Out of date — ${from ?? 'the source'} changed after this translation was written. Compare with the source; translate again or mark reviewed`
    case 'ai':
      return 'Drafted by AI and not yet approved — review before it counts as confirmed'
    case 'aiStale':
      /* With a source (a machine translation of an older source text — the sheets pass "the source text"): approving it
         overwrites nothing, so the sentence says what to do instead. Without one (an AI draft of this cell, PES.8): the
         cell moved since the draft, and approving the draft would overwrite that edit. */
      return from
        ? `Drafted by AI from an older value — ${from} has changed since. Compare with it before approving`
        : 'Drafted by AI from an older value — this cell has changed since. Approving this overwrites that change'
    /*
     * `pending` and `attention` work like `refused`: `from` is the SERVER'S sentence and is returned verbatim — no
     * prefix, no restatement. The fallbacks fire only for a caller that sets the member without a sentence.
     */
    case 'pending':
      return from ?? 'Saved in Nexus — the channel gets this value when you publish'
    case 'attention':
      return from ?? 'Needs attention — this value may not reach the channel as shown'
    case 'listingValue':
      // `from` is not used: the sentence is about the listing's own text, whichever layer named it. The typographic ’, as
      // the sheet's Cell details writes the same sentence.
      return 'This listing still holds its own text, not the Shared product’s — the next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now'
    case 'listingLevel':
      return `One value for the whole listing${from ? `, from ${from}` : ''} — setting or clearing it here sets it for every variation`
    default:
      return ''
  }
}

/**
 * `cellClassRules` for provenance. Pair with `ProvenanceMark` in the renderer: the class carries
 * the tint, the mark carries the meaning.
 */
export function provenanceClassRules<T>(read: (data: T, colId: string) => CellProvenance) {
  const of = (p: { data?: T; colDef: { colId?: string; field?: string } }): CellProvenance =>
    p.data ? read(p.data, p.colDef.colId ?? p.colDef.field ?? '') : 'own'
  type P = { data?: T; colDef: { colId?: string; field?: string } }
  return {
    'nds-cell-is-inherited': (p: P) => of(p) === 'inherited' || of(p) === 'inheritedOverride',
    'nds-cell-is-inherited-override': (p: P) => of(p) === 'inheritedOverride',
    'nds-cell-is-pinned': (p: P) => of(p) === 'pinned',
    'nds-cell-is-mapped': (p: P) => of(p) === 'mapped' || of(p) === 'mappedShared',
    'nds-cell-is-mapped-shared': (p: P) => of(p) === 'mappedShared',
    // Class names as PES.8 requested them, so the AI lane's own CSS expectations hold.
    'nds-cell-is-outdated': (p: P) => of(p) === 'outdated',
    'nds-cell-is-formula': (p: P) => of(p) === 'formula',
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
    'nds-cell-is-formula-refused': (p: P) => of(p) === 'refused',
    'nds-cell-is-ai-draft': (p: P) => of(p) === 'ai' || of(p) === 'aiStale',
    'nds-cell-is-ai-draft-stale': (p: P) => of(p) === 'aiStale',
    /*
     * 2026-10-04 (channel cell marks). Every name is new — none of these may share a key with `roundTripClassRules` or
     * `sheetClassRules` (`classRuleKeys.vitest.test.ts`).
     *
     * 🔴 `awaiting-publish`, NEVER `nds-cell-is-pending`: the save tracker owns that class (a save in flight, a warning
     * wash, `grid.css`). A value waiting for Publish is SAVED — painting it like an unsaved edit would be false. It gets
     * no tint at all: the mark carries it, and the row's Status cell already says the row waits for Publish.
     */
    'nds-cell-is-awaiting-publish': (p: P) => of(p) === 'pending',
    /* The warning wash `outdated` wears: the next action is the same family — read why before you act. */
    'nds-cell-is-attention': (p: P) => of(p) === 'attention',
    /* The pinned wash: like a pin it differs from the Shared product, and "Follow Shared" returns it there. */
    'nds-cell-is-listing-value': (p: P) => of(p) === 'listingValue',
    /* No tint, like `mappedShared` (its sibling: a claim about SCOPE — editing one row changes all of them). */
    'nds-cell-is-listing-level': (p: P) => of(p) === 'listingLevel',
  }
}

/**
 * The words a `from` falls back to when the server named no source — never a storage id, and never "master"
 * (the UI calls it the Shared product since PR #250). An unknown layer names nothing rather than leaking its id.
 */
const LAYER_WORDS: Record<string, string> = {
  master: 'the Shared product',
  default: 'the default',
  variant: 'the variation',
  alias: 'the listing',
  aliasvariant: 'this variation\'s listing',
  channel: 'the listing',
  linked: 'a linked field',
}

/** Members whose `from` is the SERVER'S sentence, shown verbatim — never a layer name standing in for one. */
const SENTENCE_MEMBERS: ReadonlySet<CellProvenance> = new Set<CellProvenance>(['refused', 'pending', 'attention'])

/** One source sentence for cells, tooltips and compare on both sheet hosts. */
export function describeCellSource(
  cell: ProvenanceLike | null | undefined,
  options: { layer?: 'master' | 'variant' | 'channel'; from?: string | null; refusedReason?: string | null } = {},
): { member: CellProvenance; from: string | null; tooltip: string } {
  const member = classifyProvenance({ ...cell, refusedReason: options.refusedReason ?? cell?.refusedReason }, options.layer)
  /* refused, pending, attention: `from` is the server's sentence (provenanceTooltip returns it verbatim), so a layer
     fallback would become the whole hover text. No sentence → null → the member's own default sentence. */
  const from = member === 'refused' ? options.refusedReason ?? cell?.refusedReason ?? cell?.provenance?.from ?? null
    : SENTENCE_MEMBERS.has(member) ? cell?.provenance?.from ?? null
    : cell?.provenance?.from ?? options.from ?? (cell?.layer ? LAYER_WORDS[cell.layer.toLowerCase()] ?? null : null)
  const tooltip = member === 'pinned' && cell?.tier === 'pin'
    ? `Pinned at ${from ?? 'this listing'} — changes to the shared language text do not replace this value`
    : provenanceTooltip(member, from)
  return { member, from, tooltip }
}
