/**
 * PES.8 — the channel's own rules, as the prompt and the validator both see them.
 *
 * There is exactly ONE source for what a cell may contain: `SheetColumn`, from
 * `sheet-columns.service.ts`, which derives its caps from the cached Amazon
 * product-type definition (`schema-caps.ts`) and the eBay aspect table. That is
 * the same object the sheet validates a typed cell against, so an AI draft is
 * held to the same rule as an operator's keystroke — no second opinion, no
 * drift.
 *
 * 🔴 What the existing generator gets wrong, and why this file exists:
 * `listing-content.service.ts` hardcodes "HARD MAX 200 characters" into the
 * title prompt for every channel, market and product type, and never looks at
 * `maxUtf8ByteLength` at all. Amazon enforces BYTES. An Italian title of 198
 * characters with a dozen accented vowels is over 200 bytes and gets refused at
 * publish having passed every check we made. Both caps travel here.
 */
import type { SheetColumn } from '../../pim/sheet-columns.service.js'

export interface CellConstraint {
  /** Bare master key (no `attr_` prefix) — how the sheet names the column. */
  columnKey: string
  /** What `PATCH /api/products/bulk` expects in `changes[].field`. */
  writeField: string
  label: string
  kind: SheetColumn['kind']
  /** Tightest CHARACTER cap across the coordinates in play. */
  maxLength?: number
  /** Tightest UTF-8 BYTE cap. Amazon enforces this one. */
  maxBytes?: number
  /** Which coordinate set the tightest cap — shown in the review drawer. */
  capFrom?: string
  /** Closed list, when the channel publishes one. */
  options?: string[]
  /** `strict` = off-list warns (never blocks); `open` = anything goes. */
  mode?: 'strict' | 'open'
  /** Coordinates that require a value here. */
  requiredBy: string[]
  /** Still offered by the channel but marked deprecated — warn, never block. */
  deprecatedOptions?: string[]
  helpText?: string
}

/**
 * Fields an enrichment pass must never propose, whatever the operator selects.
 *
 * Measured on the real IT catalogue: a master-scope run on one XAVIA product
 * put 60 columns in scope, and among them were `merchant_suggested_asin`,
 * `product_tax_code`, `gpsr_safety_attestation`, `country_of_origin`,
 * `supplier_declared_dg_hz_regulation` and `ghs_chemical_h_code`.
 *
 * Those are not copy. They are claims of record — an identifier that addresses
 * a real listing, a tax classification a filing depends on, a safety
 * attestation a regulator reads, a date, an origin a customs declaration
 * carries. A language model has no way to know any of them, and the review
 * flow is not a sufficient guard: a plausible-looking value in a tinted cell
 * invites an approving click, and a wrong one here is a compliance problem
 * rather than a bad sentence. Telling the model not to invent them (the prompt
 * does) is weaker than never asking.
 *
 * Matching is on the normalised key, so `attr_` prefixes and casing do not
 * open a hole.
 */
const NEVER_DRAFT_EXACT = new Set([
  'countryoforigin',
  'country_of_origin',
  'producttaxcode',
  'product_tax_code',
  'merchantsuggestedasin',
  'merchant_suggested_asin',
  'externallyassignedproductidentifier',
  'gtin',
  'upc',
  'ean',
  'isbn',
  'asin',
  'hscode',
  'hs_code',
])

/** Substrings that mark a claim of record rather than a description. */
const NEVER_DRAFT_PATTERNS = [
  'attestation',
  'responsible_party',
  'browse_node',
  'batter',
  'certificat',
  'compliance',
  'complian',
  'regulation',
  'regulatory',
  'hazmat',
  'dangerous_goods',
  'dg_hz',
  'ghs_',
  'medical_device',
  'safety_data',
  'declaration',
  'notified_body',
  'tax_code',
  'date',
  'identifier',
  'exemption',
  '_url',
  'warranty_period',
  'battery',
]

function normaliseKey(key: string): string {
  return key.replace(/^attr_/, '').toLowerCase()
}

/** True when this column carries a claim of record and must never be drafted. */
export function isNeverDraft(key: string): boolean {
  const k = normaliseKey(key)
  if (NEVER_DRAFT_EXACT.has(k)) return true
  return NEVER_DRAFT_PATTERNS.some((p) => k.includes(p))
}

/**
 * What a run drafts when the operator names no columns.
 *
 * The deny-list above is a backstop, not a posture. Enumerating everything
 * dangerous in a 47-column Amazon manifest is a game you lose once and lose
 * silently: the same dry run that surfaced the tax code and the safety
 * attestation also surfaced `dsa_responsible_party_address`,
 * `recommended_browse_nodes`, `merchant_shipping_group`, `skip_offer` and
 * `parentage_level` — a legal address, an identifier, and three pieces of
 * operational configuration, none of which anybody wants a model writing.
 *
 * So the default is an ALLOW-list of things that are unambiguously descriptive
 * copy. Widening past it is possible and takes an explicit `columns` list —
 * a deliberate act by an operator who can see what they asked for. The
 * deny-list still applies on top, so widening cannot reach a claim of record.
 */
const DEFAULT_DRAFT_KEYS = new Set([
  // Master content.
  'name',
  'description',
  'bulletpoints',
  'keywords',
  // Channel CONTENT — the write fields `PATCH /api/products/bulk` accepts per channel.
  //
  // 🔴 Their absence made every channel-scope run return "No draftable columns in this scope",
  // for any channel and any market, since this lane was built. The master scope worked, so the
  // feature looked fine; the tests that covered `draftableConstraints` passed explicit column
  // lists, which bypasses this default set entirely. Found via BE.1's #298 question about
  // `includeEmptyChannels` — that flag was a real gap too, but it was not the cause of the zero.
  //
  // `*_variationTheme` is deliberately NOT here: a variation theme is listing STRUCTURE, not copy,
  // and belongs with the never-draft claims of record.
  'amazon_title',
  'amazon_description',
  'ebay_title',
  'ebay_description',
  // Channel content, by the schema's own names.
  'item_name',
  'product_description',
  'bullet_point',
  'generic_keyword',
  'title_differentiation',
  // Descriptive attributes: what the thing is like, readable off the product.
  'color',
  'colour',
  'material',
  'fabric_type',
  'outer_material',
  'lining_description',
  'pattern',
  'style',
  'style_name',
  'care_instructions',
  'water_resistance_level',
  'age_range_description',
  'target_gender',
  'department_name',
  'season',
  'fit_type',
  'closure_type',
  'sleeve_type',
  'neck_style',
  'collar_style',
  'special_feature',
  'item_type_name',
])

/** True when this column is in the default (no-selection) draft set. */
export function isDefaultDraftKey(key: string): boolean {
  return DEFAULT_DRAFT_KEYS.has(normaliseKey(key))
}

/**
 * Narrow a column set to the cells we are willing to draft.
 *
 * Excluded, deliberately:
 *  - `editable: false` — Amazon refuses the change on an existing listing, so a
 *    draft there is a proposal the operator could never apply.
 *  - `boolean` / `date` / `number` kinds — an inferred measurement or date is
 *    the class of value `master-ai-fill` already refuses to invent, and a
 *    wrong one reads as fact. Text, long text and closed lists only.
 *  - anything `isNeverDraft` names — claims of record (identifiers, tax codes,
 *    regulatory attestations, origin, dates). Excluded even when the caller
 *    asks for them by name.
 *  - with no `only` list, anything outside `DEFAULT_DRAFT_KEYS`. The default
 *    run is narrow and descriptive; widening is an explicit act.
 */
export function draftableConstraints(columns: SheetColumn[], only?: string[]): CellConstraint[] {
  const wanted = only && only.length > 0 ? new Set(only) : null
  const out: CellConstraint[] = []
  for (const c of columns) {
    if (!c.editable) continue
    if (c.kind !== 'text' && c.kind !== 'longtext' && c.kind !== 'select') continue
    // Unconditional, and above the operator's own selection: naming one of
    // these explicitly is a mistake we decline rather than honour.
    if (isNeverDraft(c.key) || isNeverDraft(c.writeField)) continue
    if (wanted) {
      if (!wanted.has(c.key) && !wanted.has(c.writeField)) continue
    } else if (!isDefaultDraftKey(c.key) && !isDefaultDraftKey(c.writeField)) {
      continue
    }
    out.push({
      columnKey: c.key,
      writeField: c.writeField,
      label: c.label,
      kind: c.kind,
      maxLength: c.maxLength,
      maxBytes: c.maxBytes,
      capFrom: c.capFrom,
      options: c.options,
      mode: c.mode,
      requiredBy: c.requiredBy,
      deprecatedOptions: c.deprecatedOptions,
      helpText: c.helpText,
    })
  }
  return out
}

/**
 * The constraint as one line of prompt text. Both caps are stated when they
 * differ, because "200 characters" and "200 bytes" are different instructions
 * the moment the copy is not ASCII — which, for an IT/DE/FR catalogue, is
 * always.
 */
export function constraintLine(c: CellConstraint): string {
  const bits: string[] = [`${c.columnKey} — ${c.label}`]
  if (c.kind === 'longtext') bits.push('(long text)')
  const caps: string[] = []
  if (c.maxLength != null) caps.push(`max ${c.maxLength} characters`)
  if (c.maxBytes != null) caps.push(`max ${c.maxBytes} UTF-8 bytes (accented letters cost 2+)`)
  if (caps.length > 0) bits.push(`[${caps.join(', ')}]`)
  if (c.options && c.options.length > 0) {
    const live = c.deprecatedOptions && c.deprecatedOptions.length > 0
      ? c.options.filter((o) => !c.deprecatedOptions!.includes(o))
      : c.options
    const shown = live.slice(0, 40)
    bits.push(
      c.mode === 'open'
        ? `(suggested values: ${shown.join(' | ')})`
        : `(choose EXACTLY ONE of: ${shown.join(' | ')}${live.length > shown.length ? ` | …${live.length - shown.length} more` : ''})`,
    )
  }
  if (c.requiredBy.length > 0) bits.push(`— required by ${c.requiredBy.join(', ')}`)
  if (c.helpText) bits.push(`— ${c.helpText.slice(0, 160)}`)
  return `- ${bits.join(' ')}`
}
