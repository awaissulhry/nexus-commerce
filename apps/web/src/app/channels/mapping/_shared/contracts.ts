/**
 * PES.6 — the Global Mapping Engine's client contracts.
 *
 * These mirror `apps/api/src/services/pim/mapping/*` exactly. They are the page's own types;
 * PES.5's sheet read composes `resolveChannelField` IN-PROCESS rather than calling this page's
 * endpoint (hub ruling #15), so there is one resolver with two callers and no HTTP hop inside
 * the sheet.
 */

export type FieldPriority = 'required' | 'requiredIfRelevant' | 'bestPractice' | 'optional'
export type RuleKind = 'unmapped' | 'attribute' | 'constant' | 'expression' | 'businessRule'
export type FieldStatus = 'mapped' | 'unmapped'

export interface TransformOp {
  type: string
  [k: string]: unknown
}

export interface FieldMappingRule {
  source: string
  fallback?: string
  transforms?: TransformOp[]
  required?: boolean
  notes?: string
}

export interface CatalogueGroup {
  key: string
  label: string
  description: string | null
  order: number
}

export interface CatalogueField {
  shopifyField?: import('@nexus/shared/shopify-information').InformationField
  readOnlyReason?: string

  fieldKey: string
  sheetKey?: string
  shape?: 'scalar' | 'list' | 'measure'
  label: string
  helpText: string | null
  group: string
  groupOrder: number
  priority: FieldPriority
  prioritySource: 'amazonSchema' | 'channelSchema' | 'ruleFlag' | 'unknown'
  maxLength: number | null
  maxBytes: number | null
  options: string[] | null
  optionLabels: Record<string, string> | null
  selectionOnly: boolean
  editable: boolean
  deprecatedOptions: string[] | null
  rule: FieldMappingRule | null
  ruleKind: RuleKind
  ruleSummary: string | null
  ruleRef: string | null
  overlay: boolean
  ruleOrigin?: 'master' | 'default' | 'category' | null
  schemaKnown?: boolean
  sourceOwner?: { kind: 'listing' | 'system'; label: string; path: string } | null
  status: FieldStatus | 'owned'
}

export interface FieldCatalogue {
  mappingToken: string
  mappingVersion: number
  channel: string
  marketplace: string
  productType: string | null
  productTypes: string[]
  schema: {
    source: 'amazonCache' | 'channelSchema' | 'none'
    present: boolean
    fetchedAt: string | null
    ageDays: number | null
    version: string | null
    note: string | null
  }
  groups: CatalogueGroup[]
  fields: CatalogueField[]
  counts: {
    total: number
    mapped: number
    unmapped: number
    owned?: number
    required: number
    requiredUnmapped: number
    coveragePct: number | null
  }
  expressions: Record<string, string>
}

export interface ResolvedCell {
  rule?: FieldMappingRule | null
  ruleOrigin?: 'master' | 'default' | 'category' | null
  supplyingRule?: { id: string; name: string; version: number; href: string }
  fieldKey: string
  value: unknown
  status: FieldStatus
  provenance: string | null
  appliedTransforms: string[]
  warnings: string[]
  errors: string[]
  autoCorrected: { from: string; to: string } | null
  required: boolean
  requirementReasons?: Array<{ message: string; schemaPath: string }>
  overLimit: { chars?: number; bytes?: number } | null
}

export type CategoryResolutionSource =
  | 'categoryExact' | 'categoryWildcard' | 'ancestorExact' | 'ancestorWildcard' | 'listing'
  | 'productType' | 'none'

export interface ResolvedCategory {
  channelCategoryId: string | null
  channelCategoryPath: string | null
  browseNodeId: string | null
  source: CategoryResolutionSource
  categoryId: string | null
  categoryName: string | null
  reviewed: boolean
}

export interface ResolvedProduct {
  readiness?: { state: 'blocked' | 'locally-valid'; populated: number; total: number; invalid: number; translationPending: number; listingOwnerFields?: number; schemaValidation: 'evaluated' | 'missing' | 'unavailable'; channelValidation: 'not-checked' }
  productId: string
  sku: string
  name: string | null
  category: ResolvedCategory
  cells: Record<string, ResolvedCell>
  counts: { mapped: number; unmapped: number; errors: number; requiredMissing: number }
}

export interface ResolveBatchResult {
  channel: string
  marketplace: string
  locale: string
  catalogue: FieldCatalogue | null
  products: ResolvedProduct[]
  missingProductIds: string[]
}

export interface TemplateRow {
  channel: string
  code: string
  name: string
  currency: string
  language: string
  region: string
  isParticipating: boolean
  fieldCount: number
  /** Distinct field keys carrying a rule across the default bucket AND every category overlay. */
  mappedCount: number
  /** Just the default bucket — usually smaller, and the reason a naive count read 0. */
  defaultRuleCount: number
  overlayTypes: string[]
  expressionCount: number
  lastSyncedAt: string | null
}

export interface PreviewSku {
  channelCategoryId?: string | null
  productId: string
  sku: string
  name: string | null
  productType: string | null
  listedHere: boolean
  label: string
}

export interface CategoryMappingRow {
  categoryId: string
  categoryName: string
  categoryPath: string
  depth: number
  parentId: string | null
  productCount: number
  mapping: {
    id: string
    marketplace: string
    channelCategoryId: string
    channelCategoryPath: string | null
    browseNodeId: string | null
    confidence: string
    reviewedAt: string | null
    notes: string | null
  } | null
  inheritedFrom: { categoryId: string; categoryName: string; channelCategoryId: string; reviewed?: boolean } | null
}

export interface ExpressionRow {
  name: string
  expr: string
  /** null = the stored formula does not parse. An empty list means "depends on nothing", which
   *  is a different and legitimate answer — see `parseError`. */
  dependencies: { attributes: string[]; rules: string[] } | null
  parseError: { message: string; pos: number } | null
  usedBy: Array<{ productType: string | null; fieldKey: string; via: 'ref' | 'call' }>
}

export interface ExprFunctionDoc {
  name: string
  signature: string
  group: 'Logic' | 'Text' | 'Number' | 'Pricing' | 'Rules'
  summary: string
}

// ── Display vocabulary ─────────────────────────────────────────────
// ONE table. Every surface that shows a priority or a rule kind reads it from here, so the
// grid, the drawer and the rail cannot drift into three spellings of the same word.

export const PRIORITY_META: Record<FieldPriority, { label: string; tone: 'danger' | 'warning' | 'info' | 'neutral'; order: number }> = {
  required:           { label: 'Required',            tone: 'danger',  order: 0 },
  requiredIfRelevant: { label: 'Required if relevant', tone: 'warning', order: 1 },
  bestPractice:       { label: 'Best practice',        tone: 'info',    order: 2 },
  optional:           { label: 'Optional',             tone: 'neutral', order: 3 },
}

export const RULE_KIND_META: Record<RuleKind, { glyph: string; label: string; hint: string }> = {
  unmapped:     { glyph: '',  label: 'Not mapped',    hint: 'Nothing feeds this channel field yet.' },
  attribute:    { glyph: '🏷', label: 'Attribute',     hint: 'Reads one attribute from your data.' },
  constant:     { glyph: '❝', label: 'Fixed value',   hint: 'The same value for every product.' },
  expression:   { glyph: '𝑓', label: 'Formula',       hint: 'Computed by a formula over your attributes.' },
  businessRule: { glyph: '✦', label: 'Business rule', hint: 'Runs a saved, reusable business rule.' },
}

/** Why a preview cell is empty. An empty cell has several causes and must name its own. */
export function emptyReason(cell: ResolvedCell | undefined): string {
  if (!cell) return 'Not resolved — pick a preview SKU to see this field’s value.'
  if (cell.provenance === 'override') return 'This listing has an explicit blank override. Follow Master in the product editor to restore inheritance.'
  if (cell.status === 'unmapped') return 'No rule or listing value supplies this field.'
  if (cell.errors.length > 0) return cell.errors[0]
  if (cell.warnings.length > 0) return cell.warnings[0]
  return 'The rule resolved to an empty value for this product.'
}

// ── Auto-map (6.24) + clone (6.26) ─────────────────────────────────

export type SuggestConfidence = 'high' | 'medium'

export interface MappingSuggestion {
  fieldKey: string
  label: string | null
  suggestedSource: string
  confidence: SuggestConfidence
  reason: string
  required?: boolean
  /** Set by the client when the suggestion came from the AI pass rather than the heuristic. */
  fromAI?: boolean
}

export interface SuggestResult {
  channel: string
  code: string
  productType: string | null
  suggestions: MappingSuggestion[]
  unmappedTotal: number
}

export interface AiSuggestResult {
  suggestions: MappingSuggestion[]
  /** False when the AI never ran — `reason` then says why (kill-switch, no provider, nothing
   *  left for it to do, or the call failed). The UI prints that sentence rather than an
   *  empty list, so "no suggestions" is never mistaken for "AI found nothing". */
  aiUsed: boolean
  reason?: string
  scanned: number
}

export interface CloneResult {
  results: Array<{ channel: string; code: string; cloned: number; skipped: number; error?: string }>
}

/** Product-local automatic inheritance is returned by the resolver, never guessed from labels. */
export function fieldWithPreviewRule(field: CatalogueField, cell?: ResolvedCell): CatalogueField {
  if (field.rule || !cell?.rule || cell.ruleOrigin !== 'master') return field
  return { ...field, rule: cell.rule, ruleOrigin: 'master', ruleKind: 'attribute',
    ruleSummary: cell.rule.source, status: 'mapped' }
}

export function mappingOriginLabel(field: CatalogueField): string {
  return field.ruleOrigin === 'master' ? 'Follows Master' : field.ruleOrigin === 'category' ? 'Category rule'
    : field.ruleOrigin === 'default' ? 'Market rule' : field.status === 'mapped' ? 'Mapped' : 'Unmapped'
}

export function isCategoryField(fieldKey: string, channel?: string): boolean {
  if (channel === 'SHOPIFY') return false
  return fieldKey === 'productType' || fieldKey === 'categoryId'
}

// ── VT.3 — the Variations group (design §3.7 · VX §11.1) ───────────
// The rule block that VX M2 stores at `MarketplaceSchemaMapping.variations` (channel wide) and
// `byProductType[<category>].variations` (per channel category). These types mirror the wire shape
// requested from VT.1 in `docs/pes-claims.md` (`GET`/`PUT /pim/channel-mapping/:channel/:code/
// variations[/:categoryId]`). EVERY count on the group comes from here — the page computes none of
// them, because a number the page adds up is a number the wire and the screen can disagree about.

export type VariationRuleSource = 'rule' | 'derived' | 'none'
export type CollisionResolverKind = 'split' | 'fold' | 'exclude'
export type ListingSplitMode = 'one' | 'per-axis'

export interface VariationRuleAxis {
  axisKey: string
  /** English label — Nexus vocabulary, what the operator already knows. */
  label: string
  /** What the channel DELIVERS: Amazon's bound-attribute title, the eBay site aspect, the Shopify option. */
  channelName: string
  /** Amazon: the theme segment's attribute. eBay: the aspect. Shopify/Etsy: the option. */
  target: string | null
  included: boolean
}

export interface VariationThemeOption {
  code: string
  label: string
  /** True when every one of the family's axes survives this choice. */
  coversAll: boolean
  /** axisKeys this choice DROPS. Empty when `coversAll`. */
  drops: string[]
  deprecated: boolean
}

export interface VariationValueMapCount {
  axisKey: string
  label: string
  mapped: number
  unreviewed: number
}

/**
 * The Variations group's whole wire payload for one channel × market × category.
 *
 * `source` is the SERVER's answer, never inferred from `rule === null` on the page: "no rule, the
 * derived theme applies" and "no rule and nothing derives either" are different sentences and the
 * group prints different copy for them.
 */
export interface VariationRuleView {
  channel: string
  market: string
  /** null = the channel-wide rule (no category selected). */
  categoryId: string | null
  /** What the Rule line names: the Amazon product type, the eBay category, the Shopify product type. */
  categoryLabel: string
  source: VariationRuleSource
  /** Non-null only when `source === 'rule'`. Never composed by the page. */
  ruleLabel: string | null
  /**
   * design §3.7's one addition: with no rule, the derivation for this category's most common axis
   * set — "colour × size → COLOR/SIZE on 9 of 9 families".
   */
  derivation: {
    axisSummary: string
    themeCode: string | null
    themeLabel: string | null
    families: number
    familiesTotal: number
  } | null
  counts: {
    follow: number
    override: number
    collide: number
    /** The blast radius the save simulation answers with: families that WOULD gain a collision. */
    wouldCollide: number
    total: number
  }
  /** Amazon only (the product type's own enum). `null` on every other channel. */
  theme: { code: string | null; label: string | null; options: VariationThemeOption[] } | null
  axes: VariationRuleAxis[]
  /** axisKeys not delivered here, named — never silent (VX §6). */
  dropped: string[]
  collisions: {
    resolver: CollisionResolverKind
    foldInto: string | null
    foldSeparator: string
    resolvers: Array<{ kind: CollisionResolverKind; available: boolean; reason: string | null }>
  }
  split: { mode: ListingSplitMode; axisKey: string | null; available: boolean; reason: string | null }
  valueMaps: VariationValueMapCount[]
  /** Server-stated sentence — who names an axis on each channel (VX §7). */
  axisNamesSentence: string
  previewSkus: PreviewSku[]
  /** Non-null = this rule cannot be saved; the sentence says why. The controls stay, the save does not. */
  writeBlockedReason: string | null
  /** CAS token for the PUT, the same vocabulary the field rules use. */
  expectedToken: string
  /**
   * R-VT-2 (a), served by VT.1b: stored keys the read did NOT recognise, named. `[]` on this
   * catalogue today. The group prints them, because the whole point of R-VT-2 is that an
   * unrecognised key must be VISIBLE rather than silently costing the marketplace its rule set.
   */
  mappingWarnings?: string[]
  /**
   * The channel's own noun for the section title. VT.1b serves `{ sectionTitle }` alone; the two
   * noun fields the CELL contract also carries are optional here because this surface never reads
   * them — requiring them would have made the live payload fail to type on arrival.
   */
  vocabulary?: { sectionTitle: string; axisNoun?: string; axisNounPlural?: string }
}

/** The body the group PUTs. `dryRun: true` is the blast-radius simulation that runs before a commit. */
export interface VariationRuleWrite {
  expectedToken: string
  dryRun: boolean
  rule: {
    theme: string | null
    axes: Array<{ axisKey: string; target: string | null; order: number; included: boolean }>
    collisions: { resolver: CollisionResolverKind; foldInto: string | null; foldSeparator: string }
    split: { mode: ListingSplitMode; axisKey: string | null }
  } | null
}

/** What a `dryRun` PUT answers with. `jobId` is present only on the committing call. */
export interface VariationRuleSimulation {
  follow: number
  wouldCollide: number
  jobId?: string
}
