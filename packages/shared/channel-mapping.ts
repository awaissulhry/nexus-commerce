/**
 * CHMAP (`docs/studies/channel-mappings.md` §8) — channel mappings as versioned data.
 *
 * One MAPPING SET = one channel file FORM (an Amazon template for its product types, or our eBay workbook)
 * for one marketplace, in one VERSION. Every channel column of the form has one FIELD row with the decision
 * for it. Import, export and push read the same set; an ACTIVE set never changes (an edit makes a new DRAFT).
 * This module is the contract the API and the web share. Pure: no I/O.
 */

export const MAPPING_CHANNELS = ['AMAZON', 'EBAY'] as const
export type MappingChannel = (typeof MAPPING_CHANNELS)[number]

/** The shapes of channel file Nexus reads and writes. */
export const MAPPING_FORM_KINDS = ['AMAZON_TEMPLATE', 'AMAZON_FLAT_FILE', 'EBAY_WORKBOOK'] as const
export type MappingFormKind = (typeof MAPPING_FORM_KINDS)[number]

export const MAPPING_SET_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const
export type MappingSetStatus = (typeof MAPPING_SET_STATUSES)[number]

/**
 * `mapped`   — the column carries a Nexus value (both ways unless `direction` says otherwise).
 * `ignored`  — deliberately not read or written; `reason` says why.
 * `managed`  — another Nexus workflow owns it (prices, stock, parentage, identity); `reason` names it.
 * `unmapped` — nobody decided yet. A file whose FILLED column is unmapped is not imported, and a set with
 *              a REQUIRED unmapped column cannot be activated.
 */
export const MAPPING_FIELD_STATES = ['mapped', 'ignored', 'managed', 'unmapped'] as const
export type MappingFieldState = (typeof MAPPING_FIELD_STATES)[number]

export const MAPPING_DIRECTIONS = ['in', 'out', 'both'] as const
export type MappingDirection = (typeof MAPPING_DIRECTIONS)[number]

/** Where a mapped column lands in Nexus. */
export const MAPPING_TARGET_KINDS = [
  'identity', // the row's SKU
  'productType', // Amazon product type / eBay category
  'recordAction', // Amazon `::record_action`, eBay `Action`
  'channelField', // a field of the channel spec (`item_name`, `color`, `title`, `bestOfferFloor` …)
  'itemSpecific', // an eBay item specific outside the category schema (`itemSpecifics.<name>`)
  'selector', // a schema selector the channel writer supplies (`apparel_size.size_system`)
  'price', 'sale', 'currency', // the price door (record-only on import)
  'quantity', 'relationship', 'identifier', // other workflows own these
  'image', // eBay Image 1..n (one ordered list)
  'none',
] as const
export type MappingTargetKind = (typeof MAPPING_TARGET_KINDS)[number]

/** The channel schema's requirement level (never invented — the channel spec derives it). */
export type MappingRequirement = 'required' | 'requiredIfRelevant' | 'bestPractice' | 'optional'

/**
 * The closed list of value transforms. Each is code written once; a field row picks it by name.
 * `dictionary` = the template's own label ↔ code list; `list` = one ordered list slot (`#2`) or a joined text;
 * `measure` = the value or the unit half of a measurement.
 */
export type MappingTransform =
  | { op: 'copy' }
  | { op: 'dictionary' }
  | { op: 'list'; slot?: number; join?: string }
  | { op: 'measure'; part: 'value' | 'unit' }
  | { op: 'number' }
  | { op: 'boolean' }
  | { op: 'date' }
  | { op: 'constant'; value: string }

export interface MappingFieldRow {
  id?: string
  /** Amazon: the key without its marketplace qualifier; eBay: the column name without its marks. */
  channelKey: string
  /** The verbatim header in the file. */
  columnKey: string | null
  label: string | null
  aliases: string[]
  /** The form's product types this decision applies to; empty = all of them. */
  productTypes: string[]
  requirement: MappingRequirement | null
  templateRequirement: string | null
  targetKind: MappingTargetKind
  targetKey: string | null
  transform: MappingTransform[]
  direction: MappingDirection
  state: MappingFieldState
  reason: string | null
  decidedBy: 'rule' | 'owner'
  sortOrder: number
}

export interface MappingLayout { sheet: string; labelRow: number | null; keyRow: number; dataRow: number | null }

/** What identifies a form, read from a file. */
export interface MappingForm {
  channel: MappingChannel
  marketplace: string
  formKind: MappingFormKind
  formKey: string
  templateIdentifier: string | null
  templateVersion: string | null
  language: string | null
  layout: MappingLayout | null
  /** sha256 of the ordered channel keys. */
  keyFingerprint: string
}

export interface MappingSetSummary extends MappingForm {
  id: string
  version: number
  status: MappingSetStatus
  basedOnId: string | null
  source: 'FILE' | 'COPY' | 'EDIT'
  notes: string | null
  createdAt: string
  activatedAt: string | null
  retiredAt: string | null
  counts: MappingCounts
}

export interface MappingCounts {
  fields: number
  mapped: number
  ignored: number
  managed: number
  unmapped: number
  /** Required by the channel and not mapped (unmapped, or ignored while required). */
  requiredUnmapped: number
  /** Conditionally required and unmapped. */
  conditionalUnmapped: number
}

export interface MappingSetDetail extends MappingSetSummary { fields: MappingFieldRow[] }

/** What changed between two versions of a form, column by column. */
export interface MappingDiff {
  added: string[]
  removed: string[]
  requirementChanged: { channelKey: string; from: MappingRequirement | null; to: MappingRequirement | null }[]
  decisionChanged: { channelKey: string; from: Pick<MappingFieldRow, 'state' | 'targetKind' | 'targetKey'>; to: Pick<MappingFieldRow, 'state' | 'targetKind' | 'targetKey'> }[]
}

const isRequired = (f: Pick<MappingFieldRow, 'requirement'>) => f.requirement === 'required'
const isOpen = (f: Pick<MappingFieldRow, 'state'>) => f.state === 'unmapped'

/** The counters the screen shows on top of a set. A REQUIRED column counts as unmapped when it is unmapped OR ignored. */
export function mappingCounts(fields: readonly Pick<MappingFieldRow, 'state' | 'requirement'>[]): MappingCounts {
  const counts: MappingCounts = { fields: fields.length, mapped: 0, ignored: 0, managed: 0, unmapped: 0, requiredUnmapped: 0, conditionalUnmapped: 0 }
  for (const f of fields) {
    counts[f.state]++
    if (isRequired(f) && (isOpen(f) || f.state === 'ignored')) counts.requiredUnmapped++
    else if (f.requirement === 'requiredIfRelevant' && isOpen(f)) counts.conditionalUnmapped++
  }
  return counts
}

/** Why a set cannot be activated, or `null` when it can. */
export function activationBlocker(fields: readonly Pick<MappingFieldRow, 'state' | 'requirement' | 'channelKey'>[]): string | null {
  const blocking = fields.filter(f => isRequired(f) && (isOpen(f) || f.state === 'ignored'))
  if (!blocking.length) return null
  const names = blocking.slice(0, 5).map(f => f.channelKey).join(', ')
  return `${blocking.length} required column${blocking.length === 1 ? ' is' : 's are'} not mapped (${names}${blocking.length > 5 ? ', …' : ''}). Map ${blocking.length === 1 ? 'it' : 'them'} before activating.`
}

/** Column-by-column difference between an older and a newer version. */
export function diffMappingFields(older: readonly MappingFieldRow[], newer: readonly MappingFieldRow[]): MappingDiff {
  const before = new Map(older.map(f => [f.channelKey, f])), after = new Map(newer.map(f => [f.channelKey, f]))
  const diff: MappingDiff = { added: [], removed: [], requirementChanged: [], decisionChanged: [] }
  for (const [key, f] of after) {
    const old = before.get(key)
    if (!old) { diff.added.push(key); continue }
    if (old.requirement !== f.requirement) diff.requirementChanged.push({ channelKey: key, from: old.requirement, to: f.requirement })
    if (old.state !== f.state || old.targetKind !== f.targetKind || old.targetKey !== f.targetKey) {
      diff.decisionChanged.push({ channelKey: key, from: { state: old.state, targetKind: old.targetKind, targetKey: old.targetKey }, to: { state: f.state, targetKind: f.targetKind, targetKey: f.targetKey } })
    }
  }
  for (const key of before.keys()) if (!after.has(key)) diff.removed.push(key)
  return diff
}

/** Amazon: the column key without its marketplace qualifier (the same field in every market's template). */
export function amazonChannelKey(header: string): string {
  return header.replace(/\[marketplace_id=[^\]]*\]/g, '')
}

/** eBay: the column name without the export's marks (`*` required, `○` recommended, `↕` variation, `⚠` ghost). */
export function ebayColumnName(header: string): string {
  return header.replace(/\s*[○↕⚠*]+/gu, '').trim()
}
