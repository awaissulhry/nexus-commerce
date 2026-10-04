import { amazonChannelKey, type MappingFieldRow, type MappingRequirement, type MappingTransform } from '@nexus/shared/channel-mapping'
import type { AmazonTemplateParse } from '../amazon/template-workbook.js'
import { offerDraftReason, placeHeader, type AmazonDestination, type Placement } from '../pim/catalog-amazon-workbook.js'
import { rootOfLeaf } from '../amazon/offer-fields.js'
import type { ChannelSpec } from '../pim/channel-specs/types.js'

/**
 * CHMAP — the RULE decisions for every column of an Amazon template, as mapping rows (a DRAFT). The rules are the
 * reader's own (`placeHeader`), run once per product type of the form; the Owner's decisions from an earlier
 * version are laid over them by the store (`carryOwnerDecisions`). Pure.
 */

export interface AmazonDraftContext {
  marketplace: string
  primaryLanguage: string
  marketLanguages: string[]
  /** The form's product types (the template signature). */
  productTypes: string[]
}

type Row = Omit<MappingFieldRow, 'id'>
const REQUIREMENT_RANK: Record<MappingRequirement, number> = { required: 4, requiredIfRelevant: 3, bestPractice: 2, optional: 1 }
const EMPTY_SPEC = (category: string, marketplace: string): ChannelSpec => ({ channel: 'AMAZON', marketplace, category, fields: [], groups: [], fetchedAt: null, schemaVersion: null, coverage: {}, unrecognised: [], absent: true })

/** How strongly a placement maps the column: the best one across the form's product types becomes the row. */
function rank(p: Placement): number {
  switch (p.kind) {
    case 'field': return 7
    case 'identity': case 'type': case 'action': case 'price': case 'sale': case 'currency': case 'id-type': case 'id-value': return 6
    case 'unplaced': return 5 // a validated selector, decided below; otherwise the column is unmapped
    case 'relationship': case 'quantity': case 'managed': case 'pricing-rule': case 'offer-draft': case 'identifier': return 4
    case 'duplicate': case 'foreign-market': case 'foreign-language': return 3
    case 'not-in-type': return 2
  }
}

const samePlacement = (a: Placement, b: Placement) => a.kind === b.kind && (a.kind !== 'field' || b.kind !== 'field' || a.field.key === b.field.key)

/** A schema selector the channel writer supplies (`apparel_size.size_system`), validated against the schema. */
function isSelector(p: Placement, spec: ChannelSpec) {
  if (p.kind !== 'unplaced') return false
  const selector = p.path[p.path.length - 1]
  const rootSchema = (spec.validationSchema?.properties as Record<string, any> | undefined)?.[p.path[0]]
  return !!rootSchema?.selectors?.includes(selector)
}

/**
 * The dictionary step, as this file uses it: labels or Amazon's own codes, and which label for a code the dictionary
 * names twice. Learned from the filled cells, so writing back reproduces the Owner's own spelling.
 */
export function dictionaryTransform(parsed: AmazonTemplateParse, header: string): Extract<MappingTransform, { op: 'dictionary' }> | null {
  const aliases = parsed.valueAliases?.[header] ?? {}
  if (!Object.keys(aliases).length) return null
  const used = [...new Set(parsed.rows.map(r => (r[header] ?? '').trim()).filter(Boolean))]
  const codes = new Set(Object.values(aliases))
  const writesCodes = used.length > 0 && used.every(v => !Object.prototype.hasOwnProperty.call(aliases, v) && codes.has(v))
  const labelsOf = new Map<string, string[]>()
  for (const [label, code] of Object.entries(aliases)) labelsOf.set(code, [...(labelsOf.get(code) ?? []), label])
  const prefer: Record<string, string> = {}
  for (const v of used) if (Object.prototype.hasOwnProperty.call(aliases, v) && (labelsOf.get(aliases[v])?.length ?? 0) > 1 && labelsOf.get(aliases[v])![0] !== v) prefer[aliases[v]] = v
  return { op: 'dictionary', ...(writesCodes ? { write: 'code' as const } : {}), ...(Object.keys(prefer).length ? { prefer } : {}) }
}

function fieldTransform(parsed: AmazonTemplateParse, header: string, p: Extract<Placement, { kind: 'field' }>): MappingTransform[] {
  const out: MappingTransform[] = []
  const dictionary = dictionaryTransform(parsed, header)
  if (dictionary) out.push(dictionary)
  if (p.field.shape === 'list') out.push({ op: 'list', slot: p.slots[0] ?? 1 })
  if (p.field.shape === 'measure') out.push({ op: 'measure', part: p.path.at(-1) === 'unit' ? 'unit' : 'value' })
  if (p.field.kind === 'number' && !(p.field.shape === 'measure' && p.path.at(-1) === 'unit')) out.push({ op: 'number' })
  if (p.field.kind === 'boolean') out.push({ op: 'boolean' })
  if (p.field.kind === 'date') out.push({ op: 'date' })
  return out.length ? out : [{ op: 'copy' }]
}

/** One placement → the decision it records. */
function decisionOf(parsed: AmazonTemplateParse, header: string, p: Placement, spec: ChannelSpec, ctx: AmazonDraftContext, typesWhereNotInType: string[]):
  Pick<Row, 'targetKind' | 'targetKey' | 'state' | 'reason' | 'transform' | 'direction' | 'requirement'> {
  const base = { targetKey: null as string | null, reason: null as string | null, transform: [{ op: 'copy' }] as MappingTransform[], direction: 'both' as const, requirement: null as MappingRequirement | null }
  const learned = dictionaryTransform(parsed, header)
  const dictionary: MappingTransform[] = learned ? [learned] : [{ op: 'copy' }]
  switch (p.kind) {
    case 'identity': return { ...base, targetKind: 'identity', state: 'mapped', requirement: 'required' }
    case 'type': return { ...base, targetKind: 'productType', state: 'mapped', transform: dictionary, requirement: 'required' }
    case 'action': return { ...base, targetKind: 'recordAction', state: 'mapped', transform: dictionary, reason: 'Full update: a blank cell clears the market value. Partial update: a blank keeps it. Delete: the listing is marked ended in Nexus.' }
    case 'id-type': return { ...base, targetKind: 'identifier', targetKey: 'product_id_type', state: 'mapped', transform: dictionary }
    case 'id-value': return { ...base, targetKind: 'identifier', targetKey: 'product_id_value', state: 'mapped' }
    case 'identifier': return { ...base, targetKind: 'identifier', state: 'managed', reason: 'Amazon catalog identifier/reference. A declared ASIN is imported as Merchant Suggested ASIN; confirmed remote links are reconciled from Amazon.' }
    case 'price': return { ...base, targetKind: 'price', targetKey: 'price', state: 'mapped', transform: [{ op: 'number' }], reason: 'Through the one price door, record-only on import (nothing is sent back).' }
    case 'sale': return { ...base, targetKind: 'sale', targetKey: p.part, state: 'mapped', transform: [{ op: p.part === 'value' ? 'number' : 'date' }], reason: 'Through the one price door, record-only on import (nothing is sent back).' }
    case 'currency': return { ...base, targetKind: 'currency', state: 'mapped', reason: 'Must equal the market currency.' }
    case 'pricing-rule': return { ...base, targetKind: 'price', state: 'managed', reason: `Automated pricing rules stay in the pricing workspace (${p.what}).` }
    case 'quantity': return { ...base, targetKind: 'quantity', state: 'managed', reason: 'Stock is not imported: EU merchant quantity is one number for all EU markets, and FBA stock is Amazon’s.' }
    // The same state and target as before (a fulfilment leaf was `quantity`, an offer leaf `price`): only the words are honest
    // now, so a version made earlier is not reported as stale.
    case 'offer-draft': return { ...base, targetKind: rootOfLeaf(p.leaf) === 'fulfillment_availability' ? 'quantity' : 'price', state: 'managed', reason: offerDraftReason(p.leaf) }
    case 'relationship': return { ...base, targetKind: 'relationship', state: 'managed', reason: 'Amazon variation relationship: shared parentage is managed on the Products sheet.' }
    case 'managed': return { ...base, targetKind: 'none', state: 'managed', reason: 'Managed commercial field: use the dedicated pricing or inventory workflow.' }
    case 'foreign-market': return { ...base, targetKind: 'none', state: 'ignored', reason: `This column is for Amazon ${p.market}; it is read with the ${p.market} file.` }
    case 'foreign-language': return { ...base, targetKind: 'none', state: 'ignored', reason: `Text in ${p.language}, which Amazon ${ctx.marketplace} does not carry in Nexus (${ctx.marketLanguages.join(', ')}).` }
    case 'duplicate': return { ...base, targetKind: 'none', state: 'ignored', reason: `A second column for ${amazonChannelKey(p.of)}: the same value is kept once; a different value is refused.` }
    case 'not-in-type': return { ...base, targetKind: 'none', state: 'ignored', reason: `Not an attribute of Amazon ${typesWhereNotInType.join(' or ') || ctx.productTypes.join(' or ')} (${ctx.marketplace}): Amazon keeps no ${p.attribute} for ${typesWhereNotInType.length > 1 ? 'these product types' : 'this product type'}.` }
    case 'unplaced':
      if (isSelector(p, spec)) return { ...base, targetKind: 'selector', targetKey: p.path.join('.'), state: 'mapped', transform: dictionary, reason: 'A validated schema selector: the channel writer supplies it.' }
      return { ...base, targetKind: 'none', state: 'unmapped', reason: p.legacy ? 'This old flat-file column has no unambiguous attribute in Amazon’s current schema.' : 'This column has no unambiguous field in the current Amazon schema.' }
    case 'field': return { ...base, targetKind: 'channelField', targetKey: p.field.key, state: 'mapped', transform: fieldTransform(parsed, header, p), requirement: p.field.requirement }
  }
}

/** The rule decision for every column of the file, in column order. */
export function buildAmazonDraftFields(parsed: AmazonTemplateParse, specs: Map<string, ChannelSpec>, ctx: AmazonDraftContext): Row[] {
  const types = ctx.productTypes.length ? ctx.productTypes : ['UNKNOWN']
  const destination: AmazonDestination = { accountId: 'draft', marketplace: ctx.marketplace, language: ctx.primaryLanguage, languages: ctx.marketLanguages }
  const rows: Row[] = []
  const seen = new Set<string>()
  for (const [index, header] of parsed.headers.entries()) {
    const channelKey = amazonChannelKey(header)
    if (seen.has(channelKey)) continue
    seen.add(channelKey)
    const perType = types.map(type => {
      const spec = specs.get(type)
      const usable = spec && !spec.absent ? spec : EMPTY_SPEC(type, ctx.marketplace)
      return { type, spec: usable, absent: !spec || spec.absent, placement: placeHeader(parsed, header, usable, destination, ctx.primaryLanguage, ctx.marketLanguages) }
    })
    const best = perType.reduce((a, b) => rank(b.placement) > rank(a.placement) ? b : a)
    const agreeing = perType.filter(t => samePlacement(t.placement, best.placement)).map(t => t.type)
    const notInType = perType.filter(t => t.placement.kind === 'not-in-type').map(t => t.type)
    const decision = decisionOf(parsed, header, best.placement, best.spec, ctx, notInType)
    // A field with no schema behind it cannot be decided: say which schema to refresh.
    const missingSchema = perType.filter(t => t.absent).map(t => t.type)
    if (missingSchema.length === perType.length && decision.state !== 'mapped' && ['not-in-type', 'unplaced'].includes(best.placement.kind)) {
      Object.assign(decision, { state: 'unmapped', targetKind: 'none', targetKey: null, reason: `No cached Amazon ${ctx.marketplace} schema for ${missingSchema.join(', ')}: refresh it, then this column can be decided.` })
    }
    if (best.placement.kind === 'field') {
      const levels = perType.map(t => t.placement.kind === 'field' ? t.placement.field.requirement : null).filter((r): r is MappingRequirement => !!r)
      decision.requirement = levels.reduce<MappingRequirement | null>((a, b) => !a || REQUIREMENT_RANK[b] > REQUIREMENT_RANK[a] ? b : a, null)
    }
    rows.push({
      channelKey, columnKey: header, label: parsed.labels?.[header] ?? null, aliases: [],
      productTypes: agreeing.length === types.length ? [] : agreeing,
      templateRequirement: null, decidedBy: 'rule', sortOrder: index,
      ...decision,
    })
  }
  return oneColumnWritesBack(parsed, rows)
}

/**
 * Several columns can carry ONE Nexus value: `compliance_media` has a column per document type
 * (`[content_type=user_manual]`, `…=safety_information`, …) and Nexus keeps one link. All of them are read on import;
 * only one is written back — the one this file fills most (else the first). The others become `in` with the reason,
 * and the Owner can move the choice on the mapping screen.
 */
function oneColumnWritesBack(parsed: AmazonTemplateParse, rows: Row[]): Row[] {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    if (row.state !== 'mapped' || row.targetKind !== 'channelField' || !row.targetKey || row.transform.some(t => t.op === 'list' || t.op === 'measure')) continue
    const language = /\[language_tag=([^\]]+)\]/.exec(row.columnKey ?? '')?.[1] ?? ''
    const key = `${row.targetKey}\u0000${language}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const filled = (header: string) => parsed.rows.filter(r => (r[header] ?? '').trim() !== '').length
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const primary = group.reduce((a, b) => filled(b.columnKey!) > filled(a.columnKey!) ? b : a)
    for (const row of group) if (row !== primary) {
      row.direction = 'in'
      row.reason = `Nexus keeps one value for ${row.targetKey}: every column is read, and it is written back into ${primary.label ?? primary.channelKey}.`
    }
  }
  return rows
}

