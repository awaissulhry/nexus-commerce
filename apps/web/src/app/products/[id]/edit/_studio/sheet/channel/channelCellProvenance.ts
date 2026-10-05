/**
 * The channel sheet's ONE verdict about a cell (2026-10-04, channel cell marks): which mark it wears.
 *
 * The Owner's rule, the same on the Shared scope and on every channel scope: **no mark on a cell that simply follows the
 * Shared product; a small mark only where the value differs from it, or where the next action differs.** One verdict
 * feeds everything that describes a channel cell — its mark (`CascadeCell`), its tint (`master/channelColumns.tsx`),
 * the bullets mark (`slotListColumnDef`'s `provenanceOf`) and Cell details (`describeValueSource` words this member).
 * Two verdicts disagreed before: the cell drew one source and Cell details explained another.
 *
 * 🔴 Why this is the SHEET's function and not `classifyProvenance(…, 'channel')`. That classifier is right for the
 * Variants tab (`variationTheme.tsx`), which keeps it, and wrong for this sheet in three common cases (checked in the
 * API, 2026-10-04):
 *   1. every mapped cell is `derived` (`studio-sheet.service.ts`, `derived = … && !!m.rule`), so a plain "copy the
 *      Shared field" path would draw Σ on nearly every mapped cell;
 *   2. a variant's own Shared value is sent `pinned: true` (layer `variant`), so it would draw ✎;
 *   3. an old listing text (`channelSnapshot`, a following pin) classifies `inherited` — 🔗, though it differs from the
 *      Shared product on 80 of 82 eBay IT listings.
 * The generic members (refused, AI, out of date, formula) still come from `classifyProvenance`, so they cannot drift.
 *
 * Order — the fact that most changes the NEXT action wins. It is NOT restated here: the verdict lists every member whose
 * fact holds and takes the strongest by the DS's one precedence (`PROVENANCE_PRECEDENCE` / `strongestProvenance`):
 *   refused › attention › pending › aiStale › ai › outdated › formula › listingLevel › listingValue ›
 *   mappedShared › mapped › inheritedOverride › inherited › pinned › own
 *
 * `own` (no mark): a plain path that copies the Shared field (with or without a fallback or a channel adjustment that
 * says the same fact in the channel's words), the Shared value or a variant's own Shared value, a channel-only field
 * (nothing in the Shared product to follow), a translation of the Shared product, an identity field locked to the
 * Shared product, and an empty or unmapped cell.
 *
 * PURE — no React, so the node test suite reads it directly.
 */
import { classifyProvenance, provenanceTooltip, strongestProvenance, type CellProvenance } from '@/design-system/grid/renderers/provenance'
import { MATRIX_CELL_COPY } from '@/design-system/grid/renderers/matrixCells'
import { isEmptyShape } from '@/design-system/grid/renderers/shapeFormat'
import { columnRequiredByAny } from '@nexus/shared/master-sheet'
import { fallbackLanguage, languageTextName } from '../languages'
import { offerDraftCellWords, pendingPublishOf } from './offerDrafts'
import { hasValue } from './provenance'
import { resetFollowsShared } from './value-source'
import type { ChannelSheetRow, MappedCell, SheetColumn, StudioCellValue } from './types'

export interface ChannelCellVerdictOptions {
  /** The mapping RUN was product-grain (`meta.mapping.productLevelOnly`): a real transform reads `mappedShared`. */
  productLevelOnly?: boolean
  /** The server's reason this cell's formula produced nothing (the formula batch), or null. */
  refusedReason?: string | null
  /**
   * The cell is empty and already draws `⚠ required` (`channelCellDrawsRequired`). The server's "required" sentences
   * (`isRequiredSentence`) then add nothing the cell does not say — the Shared scope draws the same state with no mark.
   * Absent = false: a required error on a cell that does NOT say "required" still raises `attention`, so it is never
   * hidden.
   */
  drawsRequired?: boolean
  /**
   * The column's shape: the verdict reads "has a value" by the rule the cell draws by (`channelCellPresent`), so a list
   * of blanks never wears 🔗 or "Listing value" beside an empty cell. Absent = a scalar.
   */
  shape?: SheetColumn['shape']
  /**
   * What the value IS underneath, without the marks laid on top of it (`attention`, `pending`): inherited, pinned, … —
   * Cell details' actions (Keep as listing override, Reset) follow it, while the cell still wears the attention or
   * pending mark and Cell details still shows that sentence (2026-10-04).
   */
  underlying?: boolean
}

/** Layers whose `pinned` is NOT a listing pin: the variant's own Shared value (the server sends it `pinned: true`). */
const SHARED_PIN_LAYERS: ReadonlySet<string> = new Set(['variant'])
/** Listing layers a value inherited from is itself an override of the Shared product (ruling #16). */
const OVERRIDE_LAYERS: ReadonlySet<string> = new Set(['alias', 'aliasVariant', 'channel'])

/**
 * The server's sentences that say ONLY "the channel requires a value here and there is none" — mirrored from the API's
 * own templates, and pinned to that source text by `requiredSentences.vitest.test.ts` (a reworded server sentence fails
 * that test, not the sheet):
 *
 *   `resolve-batch.service.ts`     Field '<label>' is required.
 *   `schema-requirements.ts`       Required by the category's condition for this product: <label>.      (Amazon)
 *                                  Required by the category schema: <label>.  ·  …: the <attribute> attribute.  (Etsy)
 *
 * 🔴 Words, because the wire has no per-sentence fact: `mapped.errors` is plain text, and the rule behind each sentence
 * (`findings` in the resolver) never leaves the API. The structured fact that DOES travel — `mapped.requiredByRule`, the
 * resolver's "this cell is required" — decides whether an empty cell draws `⚠ required` (`channelCellDrawsRequired`);
 * these words only decide which of its sentences that text already says. Not "required" here: an alternative ("The
 * category requires an allowed alternative; this option needs …"), an attribute that lacks a part ("… the <attribute>
 * attribute needs <part>."), a translation the field waits for, a mapping error — each asks for a different action.
 */
export const REQUIRED_SENTENCE = {
  /** `resolve-batch.service.ts` — a field the channel (or a mapping rule's flag) requires, with no value. */
  field: /^Field '.+' is required\.$/,
  /** `schema-requirements.ts` `reason` — the category's JSON schema, conditionally or always. */
  schemaPrefixes: ["Required by the category's condition for this product: ", 'Required by the category schema: '] as const,
  /** `schema-requirements.ts` — an attribute that exists but lacks a part (a selector, a unit): not this cell's value. */
  lacksPart: / attribute needs /,
}

/** A server error that only says a required value is missing (see `REQUIRED_SENTENCE`). */
export function isRequiredSentence(error: string): boolean {
  if (REQUIRED_SENTENCE.field.test(error)) return true
  return REQUIRED_SENTENCE.schemaPrefixes.some(prefix => error.startsWith(prefix)) && !REQUIRED_SENTENCE.lacksPart.test(error)
}

/** The cell's server errors that only say a required value is missing. */
export const requiredErrorsOf = (cell: StudioCellValue | undefined): string[] => (cell?.mapped?.errors ?? []).filter(isRequiredSentence)

/** A value this listing stores for itself — the server's pin on any layer except the variant's own Shared value. */
function isListingPin(cell: StudioCellValue): boolean {
  return cell.pinned === true && cell.inherited !== true && !SHARED_PIN_LAYERS.has(cell.layer)
}

/**
 * A channel-only field: no rule maps it from the Shared product (`mapped.sourceOwner`: policies, condition, listing
 * settings, an item specific with no Shared source; on Shopify the server's `channelOnly` — every value Nexus holds there
 * arrives `mapped: null`, so the mapping cannot say it). The server sends its stored listing value `pinned: true` with
 * `mapped.provenance: 'override'` (the wire fixture in `packages/shared/sheet-cell-wire.vitest.test.ts`) — but there is
 * nothing in the Shared product for it to follow, so ✎ "Pinned" would misdescribe it: no mark.
 *
 * Checked 2026-10-04 (`resolve-batch.service.ts`): a channel-only value is read from the row's OWN listing only — a
 * variation does not inherit its listing band's value, so a variation's own value overrides no band value and its reset
 * goes to empty, never to a band value. The one exception, an eBay item specific held once per listing, arrives with
 * `mapped.listingLevel` and wears `listingLevel` (it outranks this).
 */
const isChannelOnly = (cell: StudioCellValue) => !!cell.mapped?.sourceOwner || cell.channelOnly === true

/**
 * Transforms that ADD or REWRITE content (lead's decision, 2026-10-04): when one RAN (`appliedTransforms` lists the
 * transforms that ran, by type), the value differs from the Shared product — Σ. An expression is a rule too.
 * Vocabulary and format conversions (`valueMap`, `sizeScale`, `unit`, `numberFormat`, `titleCase` / `lowerCase` /
 * `upperCase`, `truncate`, `channelLimit`) say the same fact in the channel's words: no mark, and Cell details lists
 * them as "Channel adjustments".
 */
export const CONTENT_TRANSFORMS: ReadonlySet<string> = new Set(['template', 'prepend', 'append', 'replace', 'expr'])

/** The content-changing transforms that ran on this cell, in the order they ran. */
export const contentTransformsOf = (mapped: MappedCell | null | undefined): string[] =>
  (mapped?.appliedTransforms ?? []).filter(transform => CONTENT_TRANSFORMS.has(transform))

/**
 * A REAL transform: the value is decided by a rule, not copied from a Shared field. A plain `sourcePath` copy is not
 * one, even with a fallback or a channel adjustment; a content-changing transform that ran is. An override, a link, an
 * identity lock or a rule that produced nothing is never "derived".
 */
function isRealTransform(mapped: MappedCell): boolean {
  if (mapped.status !== 'mapped' || mapped.sourceOwner) return false
  if (mapped.provenance === 'override' || mapped.provenance === 'linked' || mapped.provenance === 'locked' || mapped.provenance === 'missing') return false
  if (mapped.supplyingRule || mapped.usesExpression || mapped.provenance === 'default') return true
  if (contentTransformsOf(mapped).length > 0) return true
  /* A rule with no plain source path (a constant). `derived` says a RULE produced the result at all: a content value
     with no rule (`derived: false`) has no source path either, and it follows the Shared text. */
  const plainPath = !!mapped.sourcePath?.trim() || (mapped.legacySource === 'fallback' && !!mapped.fallbackPath?.trim())
  return (mapped.derived ?? true) && !plainPath
}

/** The mapping errors that raise `attention`: all of them, less the required sentence a `⚠ required` cell already says. */
function attentionErrors(cell: StudioCellValue, drawsRequired: boolean): string[] {
  const errors = cell.mapped?.errors ?? []
  return drawsRequired ? errors.filter(error => !isRequiredSentence(error)) : errors
}

/** Why a cell needs attention, in the verdict's order — the one reading the mark, its sentence and Cell details share. */
export type AttentionCause = 'notSent' | 'reported' | 'mapping' | 'divergence'

export function attentionCause(cell: StudioCellValue | undefined, drawsRequired = false): AttentionCause | null {
  if (!cell) return null
  // A saved offer change Publish will NOT send (a restock date that has passed).
  if (pendingPublishOf(cell)?.sent === false) return 'notSent'
  // Amazon's last report says FBA while Nexus sends FBM (D9 = A).
  if (cell.fulfilmentReported) return 'reported'
  // A blocking mapping or validation error: the value would not ship as shown (the old red "!" pill).
  if (attentionErrors(cell, drawsRequired).length > 0) return 'mapping'
  // The cell shows one value and another one publishes (a Shopify sharing conflict, a master-column twin).
  if (cell.divergence) return 'divergence'
  return null
}

/**
 * A mapping error's words: "Mapping error" or "Field validation", and the errors that raised `attention`, in the server's
 * order — less the "required" sentences a `⚠ required` cell already says (`drawsRequired`), so the mark names the cause
 * it is drawn for. Cell details' notes still list every server sentence.
 */
export function mappingErrorWords(cell: StudioCellValue | undefined, drawsRequired = false): { label: string; description: string } | null {
  const mapped = cell?.mapped
  if (!mapped || !cell) return null
  const errors = attentionErrors(cell, drawsRequired)
  if (errors.length === 0) return null
  return { label: (mapped.mappingErrors ?? mapped.errors).length ? 'Mapping error' : 'Field validation', description: errors.join(' · ') }
}

/** The ONE channel verdict. See the header for the order and what reads `own`. */
export function channelCellProvenance(cell: StudioCellValue | undefined, options: ChannelCellVerdictOptions = {}): CellProvenance {
  if (!cell) return 'own'
  const holds: CellProvenance[] = []
  // The generic members, from the DS classifier — mapping facts are this function's, so they are not passed on.
  const generic = classifyProvenance({ ...cell, mapped: null, refusedReason: options.refusedReason ?? null }, 'channel')
  if (generic === 'refused' || generic === 'ai' || generic === 'aiStale' || generic === 'outdated' || generic === 'formula') holds.push(generic)

  // attention — the channel or the mapping disagrees with what Nexus would send.
  if (!options.underlying && attentionCause(cell, options.drawsRequired)) holds.push('attention')
  // pending — saved in Nexus, reaches the channel on Publish (an Amazon offer change) or on Review synchronization (a
  // Shopify edit Shopify does not have yet: the server's `unsentDraft`). `nexusDraft` without `pinned` is a reset draft,
  // which is unsent by construction (`nexusDraft` = pending edit || saved pin, and a saved pin is always pinned).
  if (!options.underlying && (pendingPublishOf(cell) || cell.unsentDraft === true || (cell.nexusDraft && !cell.pinned))) holds.push('pending')

  const mapped = cell.mapped
  if (mapped?.listingLevel?.variation) holds.push('listingLevel')
  const present = channelCellPresent({ shape: options.shape }, cell.value)
  const listingPin = isListingPin(cell)
  /* A typed edit pins the cell before the server answers (`optimisticCell`) and keeps its old `source` / `mapped`: a
     listing pin therefore rules out what those still say. The server never sends a listing pin together with either. */
  if (cell.source === 'channelSnapshot' && present && !listingPin) holds.push('listingValue')
  if (mapped && !listingPin && isRealTransform(mapped)) holds.push(options.productLevelOnly ? 'mappedShared' : 'mapped')
  if (present && cell.inherited === true && OVERRIDE_LAYERS.has(cell.layer)) holds.push('inheritedOverride')
  if (present && !listingPin && (cell.layer === 'linked' || !!cell.linkGroupId || mapped?.provenance === 'linked' || fallbackLanguage(cell) !== null)) holds.push('inherited')
  /* A pin, a listing override or a saved Shopify value — except on a channel-only field, which has nothing to follow: a
     Shopify value the Shared product supplies nothing for resets to Shopify's own value (an unsent edit of it is still
     `pending`, above). */
  if (!isChannelOnly(cell) && (listingPin || mapped?.provenance === 'override' || cell.nexusDraft)) holds.push('pinned')
  return strongestProvenance(holds)
}

/** Present by the column's shape — the rule `CascadeCell` draws the value by. */
export function channelCellPresent(column: Pick<SheetColumn, 'shape'>, value: unknown): boolean {
  return column.shape === 'list' || column.shape === 'measure' ? !isEmptyShape(column.shape, value) : hasValue(value)
}

/**
 * The cell is empty and draws `⚠ required`, with no mark for its "required" sentences — as the Shared scope draws an
 * empty required field. Required by any of:
 *   · the SHARED rule master applies (`columnRequiredByAny`: the column applies to this row and a channel requires it);
 *   · the resolver's own verdict for this cell (`mapped.requiredByRule`): a category condition or the category schema
 *     (Amazon's "Required by the category's condition for this product: External Product ID") — the column's
 *     `requiredBy` cannot know a requirement that depends on the product's other values;
 *   · a server sentence that says so (`requiredErrorsOf`) — Etsy's "Required by the category schema: the taxonomy_id
 *     attribute" arrives with `requiredByRule: false`.
 * Measured 2026-10-04 on GALE-JACKET: 341 of Amazon IT's 366 `attention` marks and Etsy's 105 were empty cells whose
 * only error was one of these sentences, while the Shared scope draws the same state as the text "⚠ required".
 * Cell details keeps the server's whole sentence.
 */
export function channelCellDrawsRequired(column: SheetColumn, row: ChannelSheetRow, cell: StudioCellValue | undefined): boolean {
  if (channelCellPresent(column, cell?.value)) return false
  return columnRequiredByAny(column, row) || cell?.mapped?.requiredByRule === true || requiredErrorsOf(cell).length > 0
}

export interface ChannelCellFromContext {
  refusedReason?: string | null
  /** The row, for naming the listing a value comes from. */
  row?: Pick<ChannelSheetRow, 'aliasPosition' | 'sku' | 'rowKind'>
  /**
   * The row's listing alias label, when the server reported one — or a function that reads it. A function is read only
   * for a member that names the listing (a cell with no mark never looks it up: it is a search over the aliases).
   */
  aliasLabel?: string | null | (() => string | null)
  drawsRequired?: boolean
  now?: number
}

/**
 * Words for a Shopify edit Shopify does not have yet — the mark's sentence and Cell details' description. Review and
 * synchronize… (the sheet's menu) sends it; Publish does not update a product already on Shopify (D5).
 */
export const SHOPIFY_DRAFT_WORDS = 'Saved in Nexus — not sent to Shopify yet. Use Review and synchronize… to send it'

/**
 * A Shopify cell that follows the Shared product on a product Shopify already holds while Shopify keeps another value
 * (the API's `liveSharedDivergence`): nothing publishes the value shown, so its divergence is not "publishes another
 * value" (D5). A saved draft against a sharing rule is pinned, so it is never this. The pop-up's banner and Cell details
 * read this one rule.
 */
export const shopifyKeepsOwnValue = (cell: Pick<StudioCellValue, 'divergence' | 'shopifyWrite' | 'pinned' | 'inherited'> | undefined): boolean =>
  !!cell?.divergence && !!cell.shopifyWrite && cell.pinned === false && cell.inherited === true

/** The sentence an `attention` cell carries — the server's or the sheet's own words, verbatim. */
export function attentionSentence(cell: StudioCellValue, drawsRequired = false, now?: number): string | null {
  switch (attentionCause(cell, drawsRequired)) {
    case 'notSent': return offerDraftCellWords(pendingPublishOf(cell)!, now).description
    case 'reported': return MATRIX_CELL_COPY.reported(cell.fulfilmentReported!)
    case 'mapping': {
      const words = mappingErrorWords(cell, drawsRequired)!
      return `${words.label}: ${words.description}`
    }
    case 'divergence': return cell.divergence!.note
    default: return null
  }
}

/**
 * A listing as a sentence names it: "the Primary listing", "the Main listing", "listing alias 2" — never a bare label
 * ("Primary") and never the alias GLYPH (★, ①): it is the mark's accessible name too, and a screen reader would say
 * "black star". A label that already says "listing" is not said twice ("the Bundle listing").
 */
export function listingName(label: string | null | undefined, position: number): string {
  const name = label?.trim()
  if (!name) return position === 0 ? 'the Main listing' : `listing alias ${position}`
  const listed = /\blisting$/i.test(name) ? name : `${name} listing`
  return /^the\s/i.test(listed) ? listed : `the ${listed}`
}

/**
 * The mark's `from` for a member — the one thing the mark is given, as the Shared scope gives it (`withMark`). The mark
 * reads ONE sentence, `provenanceTooltip(member, from)`, and `from` means the same thing on every scope: the layer or
 * source the value follows, came from, or no longer follows — never where a pin is stored, never the row's own SKU.
 *
 *   pinned             the Shared product ("Pinned on this row — it no longer follows the Shared product"). Every
 *                      channel cell resolves from its OWN row's listing (`attribute-resolver.ts` applies only the row's
 *                      `channelListing`; a variation never reads its listing band's value), so a pin — on a listing row
 *                      or a variation row — resets to the Shared value (`describeCascade`: "reset it to this variant's
 *                      Shared value"). A pin over a mapping with no plain Shared source resets to "the configured mapping
 *                      or default" (`resetSourceLabel`): no source is named, and the sentence says "the layer above".
 *   inheritedOverride  the listing the value is inherited from, where a reset lands ("the Primary listing")
 *   inherited          "a linked field", or the language a fallback shows ("the Italian text")
 *   mapped             the source a real transform reads ("the Shared product", "the channel default"); a reusable rule
 *                      that supplies the value is the sentence's `by` (`channelCellBy`), not its source
 *   listingLevel       the SKU whose value the listing holds — unless it is this row's own
 *   listingValue       nothing (the DS sentence names no listing)
 *   ai · aiStale       "the source text" for a machine translation ("Translated by machine and not reviewed yet"; of an
 *                      older source, the text changed, not the cell) — the Shared scope passes the same
 *   refused · pending · attention   the server's sentence, verbatim
 *   outdated · formula   nothing (the Shared scope names none either)
 */
export function channelCellFrom(cell: StudioCellValue | undefined, member: CellProvenance, context: ChannelCellFromContext = {}): string | null {
  if (!cell || member === 'own') return null
  const listing = () => {
    if (!context.row) return null
    const label = typeof context.aliasLabel === 'function' ? context.aliasLabel() : context.aliasLabel
    return listingName(label, context.row.aliasPosition)
  }
  switch (member) {
    case 'refused':
      return context.refusedReason ?? cell.provenance?.from ?? null
    case 'attention':
      return attentionSentence(cell, context.drawsRequired, context.now)
    case 'pending': {
      const waiting = pendingPublishOf(cell)
      return waiting ? offerDraftCellWords(waiting, context.now).description : SHOPIFY_DRAFT_WORDS
    }
    case 'listingLevel': {
      // The listing's SKU — unless it is this row's own (the first variation that holds the value): that names nothing.
      const sku = cell.mapped?.listingLevel?.sku ?? null
      return sku && sku !== context.row?.sku ? sku : null
    }
    case 'listingValue':
      // The DS sentence names no listing: nothing to look up (the alias label is a search over the aliases).
      return null
    case 'mapped':
    case 'mappedShared': {
      // The source the rule reads; a reusable rule is named as the rule (`channelCellBy`), not as the source.
      const mapped = cell.mapped
      if (mapped?.provenance === 'default' && !mapped.supplyingRule) return 'the channel default'
      return mapped?.sourcePath?.trim() ? 'the Shared product' : null
    }
    case 'inheritedOverride':
      // The listing the variation inherits from — where a reset lands.
      return listing()
    case 'inherited': {
      const language = fallbackLanguage(cell)
      return language ? languageTextName(language) : 'a linked field'
    }
    case 'pinned':
      // What the pin no longer follows: where its reset returns it (`resetSourceLabel`'s rule, `resetFollowsShared`).
      return !cell.mapped || resetFollowsShared(cell) ? 'the Shared product' : null
    case 'ai':
    case 'aiStale':
      // A machine translation: it came from the source text — of an older version, for `aiStale` (as on Shared).
      return cell.translation ? 'the source text' : null
    default:
      // outdated, formula: the shared sentence needs no name (the Shared scope passes none either).
      return null
  }
}

/**
 * The rule a `mapped` / `mappedShared` mark names as its author, when it is a reusable one — the sentence's `by`
 * (`provenanceTooltip(member, from, by)`): "Derived by the reusable rule “Apparel brand” from the Shared product".
 * Null for every other member and for a cell's own mapping ("Derived by a mapping rule …").
 */
export function channelCellBy(cell: StudioCellValue | undefined, member: CellProvenance): string | null {
  if (member !== 'mapped' && member !== 'mappedShared') return null
  const rule = cell?.mapped?.supplyingRule
  return rule ? `the reusable rule “${rule.name}”` : null
}

/**
 * The mark's text for a channel cell, as `MarkedValue`, the bullets cell (`markOf`) and the theme cell take it: `from`,
 * and — only when a reusable rule authors the value — the whole sentence as `tooltip`, which is still
 * `provenanceTooltip`'s (the mark's `from` alone cannot carry the rule's name).
 */
export function channelCellMark(cell: StudioCellValue | undefined, member: CellProvenance, context: ChannelCellFromContext = {}): { from: string | null; tooltip?: string } {
  const from = channelCellFrom(cell, member, context)
  const by = channelCellBy(cell, member)
  return by ? { from, tooltip: provenanceTooltip(member, from, by) } : { from }
}
