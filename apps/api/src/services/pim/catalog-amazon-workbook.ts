import { normalizeLanguage } from './content-language.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import type { TransferRow, TransferIssue, TransferMode } from '@nexus/shared/catalog-transfer'
import { detectAmazonTemplate, legacyAttributePath, DUPLICATE_MARK, type AmazonTemplateParse } from '../amazon/template-workbook.js'
import type { ChannelSpec, ChannelFieldSpec } from './channel-specs/types.js'
import { managedChannelField } from './catalog-transfer-plan.js'
import type { SourceExclusion } from './catalog-source-mapping.js'
import { checkWorkbookSize } from './catalog-source-file.js'
import { TRANSFER_MAX_FILE_BYTES, TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'
import { MARKETPLACE_ID_TO_CODE } from '../../utils/marketplace-code.js'
import { amazonChannelKey } from '@nexus/shared/channel-mapping'
import { ignoredReason, unmappedReason, type ReaderMapping } from '../channel-mapping/decisions.js'

/**
 * CFI (R-CFI-1, `docs/channel-file-import/BUILD.md`) — the Owner's native Amazon template, read AS IS.
 *
 * Every populated cell of the file ends in exactly ONE place, written where the decision is made:
 * a row (`origin: 'channel-file'`), an exclusion with a written reason, or an issue with a written
 * reason. The `ledger` records that decision per cell so `checkLedger` can prove zero silent loss.
 * Generic only: the file's keys, the template's own dictionaries and settings, and the category schema.
 */
export interface AmazonLedgerEntry {
  row: number; sku: string; header: string
  outcome: 'row' | 'excluded' | 'refused' | 'skipped-row'
  field?: string; reason?: string
}
/** CFI-4 — an identity the Owner must confirm before the row can be imported. */
export interface AmazonIdentityLink { fileSku: string; proposedSku: string; reason: string }
export interface AmazonWorkbookResult {
  rows: TransferRow[]; issues: TransferIssue[]; exclusions: SourceExclusion[]
  links: AmazonIdentityLink[]; ledger: AmazonLedgerEntry[]; warnings: string[]
  /** CHMAP — the mapping version the file was read with (`docs/studies/channel-mappings.md` §8). */
  mapping?: { setId: string; version: number; status: string; label: string; created: boolean }
}
/** How a file SKU was matched to a Nexus listing (D4): the product SKU and WHICH listing of it (alias). */
export interface AmazonIdentity { sku: string; via: 'sku' | 'seller-sku' | 'asin' | 'link'; aliasKey?: string }
/** Listing facts are keyed by product SKU (primary listing) or `sku␀aliasKey` (an alias listing). */
export const amazonListingKey = (sku: string, aliasKey = '') => aliasKey ? `${sku}\u0000${aliasKey}` : sku
/** The Nexus listing a SKU already has on this account and market. */
export interface AmazonListingFact { version: number; externalListingId: string | null; checkedAt: string | null }

export interface AmazonDestination {
  accountId: string; marketplace: string
  /** The market's primary content language in Nexus. */
  language: string
  /** Every content language the market carries in Nexus (default: `[language]`). */
  languages?: string[]
  /** The market's currency; a file price in another currency is refused. */
  currency?: string
  /** @deprecated kept for callers; read-only fields are now imported as the channel's own value. */
  existingListingSkus?: Set<string>
  identities?: Map<string, AmazonIdentity>
  proposals?: Map<string, { proposedSku: string; reason: string }>
  /** A file SKU that matched several Nexus products, or a confirmed link to an unknown SKU. */
  identityProblems?: Map<string, string>
  /** Nexus SKUs that exist. When given, SKUs outside it are NEW products (created only in create/upsert). */
  existingProducts?: Set<string>
  listings?: Map<string, AmazonListingFact>
  mode?: TransferMode | string
  familyCode?: string | null
  /** `true` confirms every delete row; a list confirms only rows whose file SKU or Nexus SKU it names. */
  confirmDeletes?: boolean | string[]
  /** Drawer: the SKUs of its one product group. */
  scopeSkus?: Set<string>
  /** Drawer: rows carry the reviewed listing version (`requireEditorVersions`). */
  withVersions?: boolean
  /** CHMAP — the mapping version's decisions. Absent = the rules alone (pure callers and old tests). */
  mapping?: ReaderMapping
}

export type Placement =
  | { kind: 'identity' } | { kind: 'type' } | { kind: 'action' } | { kind: 'relationship' }
  | { kind: 'id-type' } | { kind: 'id-value' } | { kind: 'identifier' }
  | { kind: 'price' } | { kind: 'sale'; part: 'value' | 'start' | 'end' } | { kind: 'currency' }
  | { kind: 'pricing-rule'; what: string } | { kind: 'quantity' } | { kind: 'managed' }
  | { kind: 'foreign-market'; market: string } | { kind: 'foreign-language'; language: string }
  | { kind: 'duplicate'; of: string } | { kind: 'not-in-type'; attribute: string; legacy: boolean }
  | { kind: 'unplaced'; path: string[]; legacy: boolean }
  | { kind: 'field'; field: ChannelFieldSpec; locale: string; path: string[]; slots: number[]; languageTagged: boolean }
  // CHMAP — a mapping version's decision that differs from the rule.
  | { kind: 'mapping-ignored'; reason: string } | { kind: 'mapping-unmapped'; reason: string }

const pathOf = (header: string) => header.replace(/\[[^\]]*\]/g, '').replace(/#\d+/g, '').split('.')
const slotOf = (header: string) => [...header.matchAll(/#(\d+)/g)].map(m => Number(m[1]))
const qualifier = (header: string, key: string) => new RegExp(`\\[${key}=([^\\]]+)\\]`).exec(header)?.[1]
const PRICE_ROOTS = new Set(['purchasable_offer', 'standard_price', 'sale_price'])
const QUANTITY_ROOTS = new Set(['fulfillment_availability'])
const RELATIONSHIP_ROOTS = new Set(['parentage_level', 'child_parent_sku_relationship'])
const isText = (field: ChannelFieldSpec) => (field.kind === 'text' || field.kind === 'longtext') && !field.options?.length
const excelDate = (raw: string) => /^\d{5}(\.\d+)?$/.test(raw.trim()) ? new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(raw)) * 86_400_000).toISOString().slice(0, 10) : raw.trim()
/**
 * Yes/no words by language — only for files that carry no dictionary of their own (old flat files
 * write "No"/"Sì"; current templates translate through their `attributeSettings` aliases first).
 */
const BOOLEAN_WORDS: Record<string, { yes: string[]; no: string[] }> = {
  it: { yes: ['sì', 'si', 'vero'], no: ['no', 'falso'] }, de: { yes: ['ja', 'wahr'], no: ['nein', 'falsch'] },
  fr: { yes: ['oui', 'vrai'], no: ['non', 'faux'] }, es: { yes: ['sí', 'si', 'verdadero'], no: ['no', 'falso'] },
  en: { yes: ['yes', 'y', 'true'], no: ['no', 'n', 'false'] }, nl: { yes: ['ja', 'waar'], no: ['nee', 'onwaar'] },
  pl: { yes: ['tak', 'prawda'], no: ['nie', 'fałsz'] }, sv: { yes: ['ja', 'sant'], no: ['nej', 'falskt'] },
}
function booleanOf(value: string, language: string): boolean | null {
  const v = value.trim().toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  const words = BOOLEAN_WORDS[language]
  const english = BOOLEAN_WORDS.en
  if (words?.yes.includes(v) || english.yes.includes(v)) return (words?.no.includes(v) || english.no.includes(v)) ? null : true
  if (words?.no.includes(v) || english.no.includes(v)) return false
  return null
}
/** Amazon's classic flat-file unit codes → the current schema's unit values (language-neutral). */
const LEGACY_UNITS: Record<string, string> = {
  kg: 'kilograms', gr: 'grams', g: 'grams', mg: 'milligrams', lb: 'pounds', lbs: 'pounds', oz: 'ounces',
  cm: 'centimeters', mm: 'millimeters', m: 'meters', in: 'inches', ft: 'feet', ml: 'milliliters', l: 'liters',
}
function unitOf(value: string, field: ChannelFieldSpec) {
  if (!field.unitOptions?.length || field.unitOptions.includes(value)) return value
  const mapped = LEGACY_UNITS[value.trim().toLowerCase()]
  return mapped && field.unitOptions.includes(mapped) ? mapped : value
}
const toNumber = (raw: string) => { const v = raw.trim().replace(/^(\d+),(\d+)$/, '$1.$2'); const n = Number(v); return v && Number.isFinite(n) ? n : null }

/** The file's own dictionary first, then the schema's own label for a code (`Nero` → `black`). */
function sourceValue(parsed: AmazonTemplateParse, header: string, value: string, field?: ChannelFieldSpec) {
  const aliases = parsed.valueAliases?.[header]
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, value)) return aliases[value]
  if (field?.options?.length && !field.options.includes(value) && field.optionLabels) {
    const wanted = value.trim().toLowerCase()
    const hit = Object.entries(field.optionLabels).find(([, label]) => String(label).trim().toLowerCase() === wanted)
    if (hit) return hit[0]
  }
  return value
}

/** Where one file column goes, decided once per product type. CHMAP: also the RULE a mapping draft records. */
export function placeHeader(parsed: AmazonTemplateParse, header: string, spec: ChannelSpec, destination: AmazonDestination, primaryLanguage: string, marketLanguages: string[]): Placement {
  if (header.includes(DUPLICATE_MARK)) return { kind: 'duplicate', of: header.slice(0, header.indexOf(DUPLICATE_MARK)) }
  const legacy = parsed.meta.grammar === 'legacy' ? legacyAttributePath(header) : null
  const key = legacy ?? header
  const path = pathOf(key), root = path[0]
  if (key === 'contribution_sku#1.value' || header === 'item_sku' || root === 'contribution_sku') return { kind: 'identity' }
  if (key === 'product_type#1.value' || root === 'product_type') return { kind: 'type' }
  if (key === '::record_action') return { kind: 'action' }
  if (key === 'amzn1.volt.ca.product_id_type') return { kind: 'id-type' }
  if (key === 'amzn1.volt.ca.product_id_value') return { kind: 'id-value' }
  if (key.startsWith('amzn1.volt.ca.')) return { kind: 'identifier' }
  const market = qualifier(key, 'marketplace_id')
  if (market && parsed.meta.primaryMarketplaceId && market !== parsed.meta.primaryMarketplaceId) return { kind: 'foreign-market', market: MARKETPLACE_ID_TO_CODE[market] ?? market }
  if (RELATIONSHIP_ROOTS.has(root)) return { kind: 'relationship' }
  if (QUANTITY_ROOTS.has(root)) return { kind: 'quantity' }
  if (PRICE_ROOTS.has(root)) {
    const audience = qualifier(key, 'audience')
    if (audience && audience !== 'ALL') return { kind: 'pricing-rule', what: `the ${audience} audience price` }
    if (path.at(-1) === 'currency') return { kind: 'currency' }
    if (root === 'purchasable_offer' && path[1] === 'our_price') return { kind: 'price' }
    if (root === 'purchasable_offer' && path[1] === 'discounted_price') return { kind: 'sale', part: path.at(-1) === 'start_at' ? 'start' : path.at(-1) === 'end_at' ? 'end' : 'value' }
    if (root === 'purchasable_offer' && ['start_at', 'end_at'].includes(path[1])) return { kind: 'pricing-rule', what: 'the offer start/end date' }
    if (root === 'purchasable_offer' && path[1]) return { kind: 'pricing-rule', what: path[1].replace(/_/g, ' ') }
    return { kind: 'managed' }
  }
  const rootSchema = (spec.validationSchema?.properties as Record<string, any> | undefined)?.[root]
  const fields = spec.fields.filter(f => f.attribute === root)
  if (!fields.length && !rootSchema) return { kind: 'not-in-type', attribute: root, legacy: !!legacy }
  const candidates = fields.filter(f => {
    const base = [f.attribute, ...f.path]
    return path.join('.') === base.join('.') || path.join('.') === [...base, 'value'].join('.') || f.shape === 'measure' && path.join('.') === [...base, 'unit'].join('.')
  })
  if (candidates.length !== 1) return { kind: 'unplaced', path, legacy: !!legacy }
  const field = candidates[0]
  // `list_price` (RRP) is a saved listing fact, not a selling price (studio-publication-amazon.ts:134).
  if (field.attribute !== 'list_price' && managedChannelField({ fieldKey: field.key, channelStore: field.channelStore })) return { kind: 'managed' }
  return fieldPlacement(parsed, key, field, path, primaryLanguage, marketLanguages)
}

/** A column that carries `field`: its language decides the locale it is stored under (or refuses it). */
function fieldPlacement(parsed: AmazonTemplateParse, key: string, field: ChannelFieldSpec, path: string[], primaryLanguage: string, marketLanguages: string[]): Placement {
  // An untagged text column is written in the file's own content language, not automatically the market's.
  const language = qualifier(key, 'language_tag') ?? parsed.meta.contentLanguageTag
  let locale = ''
  if (language) {
    const lang = normalizeLanguage(language)
    if (lang !== primaryLanguage) {
      if (isText(field)) {
        if (!marketLanguages.includes(lang)) return { kind: 'foreign-language', language: lang }
        locale = lang
      }
      // A choice/number/boolean tagged with another language is the same wire value in every language.
    } else if (isText(field) && marketLanguages.length > 1) locale = lang
  }
  return { kind: 'field', field, locale, path, slots: slotOf(key), languageTagged: !!qualifier(key, 'language_tag') }
}

/**
 * CHMAP — the mapping version decides. Rule-made rows follow the rule (they were written by it); the Owner's
 * decisions win over it: an ignored column is excluded with the Owner's reason, an unmapped one is refused, and a
 * column the Owner mapped to another field of the product type is read into that field.
 */
function decidePlacement(rule: Placement, parsed: AmazonTemplateParse, header: string, spec: ChannelSpec, mapping: ReaderMapping | undefined, primaryLanguage: string, marketLanguages: string[]): Placement {
  if (!mapping) return rule
  const decision = mapping.byKey.get(amazonChannelKey(header))
  if (!decision) return { kind: 'mapping-unmapped', reason: unmappedReason(mapping, header, 'the column is not in this version') }
  if (decision.state === 'unmapped') return rule.kind === 'unplaced' || decision.decidedBy === 'owner' ? { kind: 'mapping-unmapped', reason: unmappedReason(mapping, header, decision.reason) } : rule
  if (decision.decidedBy !== 'owner') return rule
  if (decision.state === 'ignored' || decision.state === 'managed') return { kind: 'mapping-ignored', reason: ignoredReason(mapping, decision.reason) }
  if (decision.targetKind === 'channelField' && decision.targetKey && !(rule.kind === 'field' && rule.field.key === decision.targetKey)) {
    const field = spec.fields.find(f => f.key === decision.targetKey)
    if (!field) return { kind: 'not-in-type', attribute: decision.targetKey, legacy: false }
    const key = parsed.meta.grammar === 'legacy' ? legacyAttributePath(header) ?? header : header
    return fieldPlacement(parsed, key, field, pathOf(key), primaryLanguage, marketLanguages)
  }
  return rule
}

/**
 * Pure: the file + the category schemas + what Nexus holds (resolved on the host) → rows, exclusions,
 * issues, identity proposals and the per-cell ledger.
 */
export function mapAmazonWorkbook(parsed: AmazonTemplateParse, specs: Map<string, ChannelSpec>, destination: AmazonDestination): AmazonWorkbookResult {
  if (!destination.accountId) throw new Error('Select the Amazon account that owns these listings')
  if (!parsed.meta.marketplace && !destination.marketplace) throw new Error('This Amazon workbook has no reliable marketplace/language metadata. Use column mapping with an explicit destination.')
  if (parsed.meta.marketplace && parsed.meta.marketplace !== destination.marketplace) throw new Error(`This workbook belongs to Amazon ${parsed.meta.marketplace}, not ${destination.marketplace}`)
  const primaryLanguage = normalizeLanguage(destination.language)
  const marketLanguages = [...new Set([primaryLanguage, ...(destination.languages ?? []).map(normalizeLanguage)])]
  const fileLanguage = parsed.meta.contentLanguageTag ? normalizeLanguage(parsed.meta.contentLanguageTag) : primaryLanguage
  const out: AmazonWorkbookResult = { rows: [], issues: [], exclusions: [], links: [], ledger: [], warnings: [] }
  const sheet = parsed.meta.sheet
  if (!parsed.meta.contentLanguageTag) out.warnings.push(`${sheet}: the file does not state its language; its text is read as ${primaryLanguage}, the language of Amazon ${destination.marketplace} in Nexus.`)
  if (!marketLanguages.includes(fileLanguage)) out.warnings.push(`${sheet}: the file is written in ${fileLanguage}, which Amazon ${destination.marketplace} does not carry in Nexus (${marketLanguages.join(', ')}). Its ${fileLanguage} text is refused; its choices, numbers and codes are imported.`)

  const skuHeader = parsed.headers.find(h => placeRoot(parsed, h) === 'identity')
  const typeHeader = parsed.headers.find(h => placeRoot(parsed, h) === 'type')
  const actionHeader = parsed.headers.find(h => placeRoot(parsed, h) === 'action')
  const parentHeader = parsed.headers.find(h => { const p = pathOf(parsed.meta.grammar === 'legacy' ? legacyAttributePath(h) ?? h : h); return p[0] === 'child_parent_sku_relationship' && p.at(-1) === 'parent_sku' })
  const idTypeHeader = parsed.headers.find(h => placeRoot(parsed, h) === 'id-type')
  if (!skuHeader || !typeHeader) throw new Error('Amazon SKU and product-type columns are required')
  const placements = new Map<string, Map<string, Placement>>()
  const placementFor = (category: string, spec: ChannelSpec, header: string) => {
    let byHeader = placements.get(category)
    if (!byHeader) placements.set(category, byHeader = new Map())
    if (!byHeader.has(header)) byHeader.set(header, decidePlacement(placeHeader(parsed, header, spec, destination, primaryLanguage, marketLanguages), parsed, header, spec, destination.mapping, primaryLanguage, marketLanguages))
    return byHeader.get(header)!
  }
  const fileSkuRows = new Map<string, number[]>()
  for (const [index, record] of parsed.rows.entries()) {
    const sku = (record[skuHeader] ?? '').trim()
    if (sku) fileSkuRows.set(sku, [...(fileSkuRows.get(sku) ?? []), parsed.rowNumbers?.[index] ?? index])
  }
  // Two DIFFERENT file SKUs that resolve to the SAME Nexus listing (Amazon lists one product under two
  // seller SKUs, e.g. an Amazon-made SKU and ours on one ASIN): Nexus holds one listing per product per
  // market, so neither row can be imported until the file keeps one.
  const idTypeCol = parsed.headers.find(h => placeRoot(parsed, h) === 'id-type')
  const idValueCol = parsed.headers.find(h => (parsed.meta.grammar === 'legacy' ? legacyAttributePath(h) ?? h : h) === 'amzn1.volt.ca.product_id_value')
  const asinOfRow = (record: Record<string, string>) => idTypeCol && idValueCol && sourceValue(parsed, idTypeCol, (record[idTypeCol] ?? '').trim()).trim().toLowerCase() === 'asin' ? (record[idValueCol] ?? '').trim() : ''
  const byTarget = new Map<string, { fileSkus: Set<string>; asins: Set<string> }>()
  for (const record of parsed.rows) {
    const fileSku = (record[skuHeader] ?? '').trim()
    if (!fileSku || destination.proposals?.has(fileSku) || destination.identityProblems?.has(fileSku)) continue
    const id = destination.identities?.get(fileSku)
    const key = amazonListingKey(id?.sku ?? fileSku, id?.aliasKey)
    const entry = byTarget.get(key) ?? { fileSkus: new Set(), asins: new Set() }
    entry.fileSkus.add(fileSku)
    if (asinOfRow(record)) entry.asins.add(asinOfRow(record))
    byTarget.set(key, entry)
  }
  const collisions = new Map<string, string>()
  for (const { fileSkus, asins } of byTarget.values()) if (fileSkus.size > 1) {
    const sentence = `Amazon lists this product under two seller SKUs (${[...fileSkus].join(', ')}${asins.size ? `; ASIN ${[...asins].join(', ')}` : ''}). Nexus holds one listing per product per market — keep one row.`
    for (const fileSku of fileSkus) collisions.set(fileSku, sentence)
  }
  const proposed = new Set<string>()
  const formulaCount = { n: 0, headers: new Set<string>() }

  // Evidence rows Amazon put above the data (its example row): accounted for, never imported.
  for (const skipped of parsed.meta.skippedRows ?? []) {
    const populated = Object.entries(skipped.cells).filter(([, v]) => (v ?? '').trim())
    for (const [header] of populated) out.ledger.push({ row: skipped.row, sku: '', header, outcome: 'skipped-row', reason: skipped.reason })
    if (populated.length) out.exclusions.push({ row: skipped.row, sku: skipped.cells[skuHeader] ?? '', field: skuHeader, message: `${sheet}: ${skipped.reason}. Not imported.` })
  }
  for (const orphan of parsed.meta.orphanCells ?? []) {
    out.ledger.push({ row: orphan.row, sku: '', header: `@${orphan.column}`, outcome: 'refused', reason: 'no attribute key above this column' })
    out.issues.push({ row: orphan.row, sku: '', field: `@${orphan.column}`, message: `${sheet}: column ${orphan.column} holds a value but has no attribute key in row ${parsed.meta.attrRow}` })
  }

  for (const [index, record] of parsed.rows.entries()) {
    const row = parsed.rowNumbers?.[index] ?? (parsed.meta.dataStartRow ?? 2) + index
    const fileSku = (record[skuHeader] ?? '').trim()
    let sku = fileSku
    const populated = parsed.headers.filter(h => (record[h] ?? '').trim() !== '')
    const logged = new Set<string>()
    const log = (header: string, outcome: AmazonLedgerEntry['outcome'], extra: { field?: string; reason?: string } = {}) => {
      if (logged.has(header)) return
      logged.add(header)
      const formula = parsed.meta.formulaCells?.[row]?.includes(header)
      if (formula && outcome === 'row') { formulaCount.n++; formulaCount.headers.add(header) }
      out.ledger.push({ row, sku, header, outcome, ...extra, ...(formula ? { reason: [extra.reason, 'value computed by a formula in the file'].filter(Boolean).join('; ') } : {}) })
    }
    const issue = (field: string, message: string) => out.issues.push({ row, sku, field, message: `${sheet}: ${message}` })
    const exclude = (field: string, message: string) => out.exclusions.push({ row, sku, field, message: `${sheet}: ${message}` })
    const refuseRest = (reason: string) => { for (const h of populated) log(h, 'refused', { reason }) }
    const excludeRest = (reason: string) => { for (const h of populated) if (!logged.has(h)) { exclude(h, reason); log(h, 'excluded', { reason }) } }

    if (!fileSku) { issue(skuHeader, 'SKU is required'); refuseRest('the row has no SKU'); continue }
    const repeats = fileSkuRows.get(fileSku) ?? []
    if (repeats.length > 1) { issue(skuHeader, `SKU ${fileSku} appears in rows ${repeats.join(' and ')}. Keep one row per SKU.`); refuseRest('the SKU appears in more than one row'); continue }
    const action = record.__action
    if (!['replace', 'partial', 'delete'].includes(action)) {
      issue(actionHeader ?? '::record_action', `The listing action "${actionHeader ? record[actionHeader] : ''}" is not one this template defines`)
      refuseRest('unknown listing action'); continue
    }
    const problem = destination.identityProblems?.get(fileSku)
    if (problem) { issue(skuHeader, problem); refuseRest('identity not resolved'); continue }
    const proposal = destination.proposals?.get(fileSku)
    if (proposal) {
      if (!proposed.has(fileSku)) { proposed.add(fileSku); out.links.push({ fileSku, proposedSku: proposal.proposedSku, reason: proposal.reason }) }
      issue(skuHeader, `Link Amazon ${destination.marketplace} SKU ${fileSku} to Nexus ${proposal.proposedSku}? ${proposal.reason}. Confirm the link to import this row.`)
      refuseRest('waiting for the Owner to confirm the identity link'); continue
    }
    const collision = collisions.get(fileSku)
    if (collision) { issue(skuHeader, collision); refuseRest('two file SKUs for one Nexus listing'); continue }
    const identity = destination.identities?.get(fileSku)
    sku = identity?.sku ?? fileSku
    const aliasKey = identity?.aliasKey ?? ''
    if (destination.scopeSkus && !destination.scopeSkus.has(sku)) { excludeRest('Outside this product; use Catalog import'); continue }
    const listing = destination.listings?.get(amazonListingKey(sku, aliasKey))

    if (action === 'delete') {
      const deleteHeader = actionHeader ?? skuHeader
      if (!listing) { excludeRest(`Delete row: Nexus has no listing for ${sku} on Amazon ${destination.marketplace}; nothing to end.`); continue }
      // Matched only by ASIN: the file deletes ANOTHER seller SKU's offer on that product. Deleting one
      // offer never removes another, so Nexus's listing (a different seller SKU) is not ended.
      if (identity?.via === 'asin') { excludeRest(`Delete row: Amazon seller SKU ${fileSku} is a different offer on the same ASIN as Nexus's ${sku}${listing.externalListingId ? ` (${listing.externalListingId})` : ''}; Nexus's listing is not ended.`); continue }
      const confirm = destination.confirmDeletes
      // A confirmation names the FILE's own SKU for this row: one tick on "P" must never also end "P-FBA".
      if (confirm === true || Array.isArray(confirm) && confirm.includes(fileSku)) {
        out.rows.push({ row, sku, entity: 'Listings', channel: 'AMAZON', accountId: destination.accountId, marketplace: destination.marketplace, aliasKey, locale: '', field: 'presence', action: 'SET', value: 'ENDED', origin: 'channel-file', fileSku, ...(destination.withVersions ? { version: listing.version } : {}) })
        log(deleteHeader, 'row', { field: 'presence' })
      } else {
        const evidence = [listing.externalListingId && `it has ASIN ${listing.externalListingId}`, listing.checkedAt && `Amazon was last read for it on ${listing.checkedAt.slice(0, 10)}`].filter(Boolean).join('; ')
        // The job's delete summary shows (and the web confirms by) these coordinates.
        const pendingDelete = { row, sku, field: 'presence', fileSku, channel: 'AMAZON', marketplace: destination.marketplace, accountId: destination.accountId, ...(aliasKey ? { aliasKey } : {}),
          message: `${sheet}: this row DELETES ${sku}${fileSku !== sku ? ` (Amazon seller SKU ${fileSku})` : ''} on Amazon ${destination.marketplace}${evidence ? ` (${evidence})` : ''}. The file can be older than the channel. Confirm deletions to mark the listing ended in Nexus; nothing is sent to Amazon.` }
        out.issues.push(pendingDelete)
        log(deleteHeader, 'refused', { reason: 'delete not confirmed' })
      }
      excludeRest('Delete row: only the deletion itself is imported')
      continue
    }

    const category = sourceValue(parsed, typeHeader, (record[typeHeader] ?? '').trim()).trim().toUpperCase()
    if (!category) { issue(typeHeader, 'The product type is empty on this row'); refuseRest('no product type'); continue }
    const spec = specs.get(category)
    if (!spec || spec.absent) { issue(typeHeader, `Refresh the ${destination.marketplace} / ${category} category schema first`); refuseRest('no category schema'); continue }
    const isNew = !!destination.existingProducts && !destination.existingProducts.has(sku)
    if (isNew) {
      const creating = destination.mode === 'create' || destination.mode === 'upsert'
      if (!creating) { issue(skuHeader, `${sku} is not in Nexus. Choose "Create or update" to add it.`); refuseRest('new product in update mode'); continue }
      if (!destination.familyCode) { issue(skuHeader, 'Select a product family before creating new products from an Amazon workbook'); refuseRest('new product without a family'); continue }
      if (fileLanguage !== normalizeLanguage(PRIMARY_CONTENT_LOCALE)) {
        issue(skuHeader, `${sku} is new, and its name in this file is ${fileLanguage}. A new product needs an ${normalizeLanguage(PRIMARY_CONTENT_LOCALE) === 'it' ? 'Italian' : PRIMARY_CONTENT_LOCALE} name: import the ${normalizeLanguage(PRIMARY_CONTENT_LOCALE).toUpperCase()} file first, or create the product in Nexus.`)
        refuseRest('new product needs a primary-language name'); continue
      }
    }
    const identityFields = { row, sku, channel: 'AMAZON', accountId: destination.accountId, marketplace: destination.marketplace, aliasKey, locale: '', action: 'SET' as const, origin: 'channel-file' as const,
      ...(sku !== fileSku ? { fileSku } : {}), ...(destination.withVersions && listing ? { version: listing.version } : {}) }
    const identityRow = { ...identityFields, entity: 'Overrides' as const }
    out.rows.push({ ...identityFields, entity: 'Listings', field: 'productType', value: category })
    log(typeHeader, 'row', { field: 'productType' })
    if (sku !== fileSku && identity?.via === 'asin') {
      // Same ASIN, different seller SKU: another offer on this product. Its content describes the product,
      // but its SKU is not this listing's SKU.
      const reason = `Matched by ASIN; the file's seller SKU ${fileSku} is another offer and is not recorded as this listing's SKU`
      out.warnings.push(`${sheet} row ${row}: ${reason} (Nexus ${sku}).`)
      log(skuHeader, 'excluded', { reason })
    } else if (sku !== fileSku) {
      out.rows.push({ ...identityFields, entity: 'Listings', field: 'sellerSku', value: fileSku })
      log(skuHeader, 'row', { field: 'sellerSku' })
    } else log(skuHeader, 'excluded', { reason: 'row identity (SKU)' })

    const identifierType = idTypeHeader ? sourceValue(parsed, idTypeHeader, record[idTypeHeader] ?? '').trim().toLowerCase() : ''
    const grouped = new Map<string, { field: ChannelFieldSpec; locale: string; values: { header: string; path: string[]; value: string; slots: number[] }[] }>()
    const sale: { value?: string; start?: string; end?: string; headers: string[] } = { headers: [] }
    let priceCell: { header: string; raw: string } | undefined, currencyCell: { header: string; raw: string } | undefined
    for (const header of populated) {
      if (logged.has(header)) continue
      const raw = record[header].trim()
      if (parsed.meta.errorCells?.[row]?.includes(header)) { issue(header, `The file holds an Excel error value (${raw}) here`); log(header, 'refused', { reason: 'Excel error value' }); continue }
      const place = placementFor(category, spec, header)
      switch (place.kind) {
        case 'action': { const reason = `Record action honoured (${action === 'replace' ? 'full update: blank cells clear the market value' : 'partial update: blank cells keep Nexus values'}); nothing is sent to Amazon.`; exclude(header, reason); log(header, 'excluded', { reason }); continue }
        case 'identity': case 'type': log(header, 'excluded', { reason: 'row identity' }); continue
        case 'duplicate': {
          if (raw === (record[place.of] ?? '').trim()) { const reason = `Same value as the first ${place.of} column`; exclude(header, reason); log(header, 'excluded', { reason }) }
          else { issue(header, `This attribute has two columns in the file with different values ("${record[place.of] ?? ''}" and "${raw}")`); log(header, 'refused', { reason: 'duplicate column disagrees' }) }
          continue
        }
        case 'relationship': { const reason = 'Amazon variation relationship retained as source evidence; shared parentSku is managed on the Products sheet.'; exclude(header, reason); log(header, 'excluded', { reason }); continue }
        case 'id-type': { const reason = 'Identifier type, read together with the identifier value'; log(header, 'excluded', { reason }); continue }
        case 'id-value': {
          if (identifierType === 'asin') {
            if (!/^[A-Z0-9]{10}$/.test(raw) || !spec.fields.some(f => f.key === 'merchant_suggested_asin')) { issue(header, 'The declared ASIN needs a valid ten-character value and a Merchant Suggested ASIN schema field'); log(header, 'refused', { reason: 'invalid ASIN' }) }
            else { out.rows.push({ ...identityRow, field: 'merchant_suggested_asin', value: raw }); log(header, 'row', { field: 'merchant_suggested_asin' }) }
          } else if (['ean', 'upc', 'gtin', 'isbn', 'jan'].includes(identifierType) && spec.fields.some(f => f.key === 'externally_assigned_product_identifier')) {
            out.rows.push({ ...identityRow, field: 'externally_assigned_product_identifier', value: raw }); log(header, 'row', { field: 'externally_assigned_product_identifier' })
          } else { const reason = `Amazon catalog identifier (${identifierType || 'no type'}: ${raw}); this ${category} schema has no field for it.`; exclude(header, reason); log(header, 'excluded', { reason }) }
          continue
        }
        case 'identifier': { const reason = 'Amazon catalog identifier/reference. A declared ASIN is imported as Merchant Suggested ASIN; confirmed remote links are reconciled from Amazon.'; exclude(header, reason); log(header, 'excluded', { reason }); continue }
        case 'price': priceCell = { header, raw }; continue
        case 'currency': currencyCell = { header, raw }; continue
        case 'sale': sale[place.part] = raw; sale.headers.push(header); continue
        case 'pricing-rule': { const reason = `Automated pricing rules stay in the pricing workspace (${place.what}; file value ${raw}).`; exclude(header, reason); log(header, 'excluded', { reason }); continue }
        case 'quantity': { const reason = `Stock is not imported: EU merchant quantity is one number for all EU markets, and FBA stock is Amazon's (file value ${raw}).`; exclude(header, reason); log(header, 'excluded', { reason }); continue }
        case 'managed': { const reason = `Managed commercial field: use the dedicated pricing or inventory workflow (file value ${raw}).`; exclude(header, reason); log(header, 'excluded', { reason }); continue }
        case 'foreign-market': { const reason = `This column is for Amazon ${place.market}; import it with the ${place.market} file.`; exclude(header, reason); log(header, 'excluded', { reason }); continue }
        case 'foreign-language': { issue(header, `This text is in ${place.language}, which Amazon ${destination.marketplace} does not carry in Nexus (${marketLanguages.join(', ')})`); log(header, 'refused', { reason: 'language not carried by the market' }); continue }
        case 'mapping-ignored': { exclude(header, place.reason); log(header, 'excluded', { reason: place.reason }); continue }
        case 'mapping-unmapped': { issue(header, place.reason); log(header, 'refused', { reason: place.reason }); continue }
        case 'not-in-type': {
          const reason = place.legacy
            ? `Old flat-file column ${header}: Amazon's current ${category} schema has no ${place.attribute} (${destination.marketplace}), so neither Amazon's current listing nor Nexus keeps it (file value ${raw}).`
            : `Not an attribute of Amazon ${category} (${destination.marketplace}): Amazon keeps no ${place.attribute} for this product type (file value ${raw}).`
          exclude(header, reason); log(header, 'excluded', { reason })
          continue
        }
        case 'unplaced': {
          // Selector-only leaves are generated by the same current schema used for publishing.
          const selector = place.path[place.path.length - 1]
          const rootSchema = (spec.validationSchema?.properties as Record<string, any> | undefined)?.[place.path[0]]
          const selectorSchema = rootSchema?.items?.properties?.[selector]
          let value = sourceValue(parsed, header, raw)
          // A file without a dictionary writes the selector's LABEL (size system "IT" = `as6`).
          if (Array.isArray(selectorSchema?.enumNames) && !selectorSchema.enum?.includes(value)) {
            const squash = (v: unknown) => String(v).replace(/\s+/g, '').toLowerCase()
            const at = selectorSchema.enumNames.findIndex((n: unknown) => squash(n) === squash(value))
            if (at >= 0) value = selectorSchema.enum[at]
          }
          if (rootSchema?.selectors?.includes(selector) && (selectorSchema?.enum?.includes(value) || selectorSchema?.const === value)) {
            const reason = `Validated schema selector ${selector}=${value}; the channel writer supplies it.`
            exclude(header, reason); log(header, 'excluded', { reason })
          } else if (place.legacy) { issue(header, `This old flat-file column (${header}) has no unambiguous attribute in Amazon's current ${category} schema`); log(header, 'refused', { reason: 'old column without a unique attribute' }) }
          else { issue(header, 'This populated attribute has no unambiguous destination in the current schema'); log(header, 'refused', { reason: 'no unambiguous schema field' }) }
          continue
        }
        case 'field': {
          const key = `${place.field.key}\u0000${place.locale}`
          const group = grouped.get(key) ?? { field: place.field, locale: place.locale, values: [] }
          // One language-neutral value per field: the market's own language column wins over the same
          // choice tagged with another language, whatever the column order.
          const tagOf = (h: string) => normalizeLanguage(qualifier(parsed.meta.grammar === 'legacy' ? legacyAttributePath(h) ?? h : h, 'language_tag') ?? primaryLanguage)
          const reason = `Same attribute in another language; Nexus keeps one value for ${place.field.key}`
          if (!place.locale && group.values.some(v => tagOf(v.header) !== tagOf(header))) {
            if (tagOf(header) !== primaryLanguage) { exclude(header, reason); log(header, 'excluded', { reason }); continue }
            for (const other of group.values.filter(v => tagOf(v.header) !== primaryLanguage)) { exclude(other.header, reason); log(other.header, 'excluded', { reason }) }
            group.values = group.values.filter(v => tagOf(v.header) === primaryLanguage)
          }
          group.values.push({ header, path: place.path, value: sourceValue(parsed, header, raw, place.field), slots: place.slots })
          grouped.set(key, group)
          continue
        }
      }
    }
    // Prices (Q2 a): the selling price and the sale window go through the one price door, record-only.
    const currencyOk = !currencyCell || !destination.currency || currencyCell.raw.toUpperCase() === destination.currency.toUpperCase()
    if (currencyCell) {
      if (currencyOk) { const reason = `Currency of this row's prices (${currencyCell.raw})`; log(currencyCell.header, 'excluded', { reason }) }
      else { issue(currencyCell.header, `The file's prices are in ${currencyCell.raw}; Amazon ${destination.marketplace} sells in ${destination.currency}`); log(currencyCell.header, 'refused', { reason: 'currency differs from the market' }) }
    }
    if (priceCell) {
      const value = toNumber(priceCell.raw)
      if (!currencyOk) log(priceCell.header, 'refused', { reason: 'currency differs from the market' })
      else if (value === null || value < 0) { issue(priceCell.header, 'Enter the price as a number'); log(priceCell.header, 'refused', { reason: 'price is not a number' }) }
      else { out.rows.push({ ...identityRow, field: 'price', value }); log(priceCell.header, 'row', { field: 'price' }) }
    }
    if (sale.headers.length) {
      const value = sale.value !== undefined ? toNumber(sale.value) : null
      if (!currencyOk) for (const h of sale.headers) log(h, 'refused', { reason: 'currency differs from the market' })
      else if (sale.value === undefined || value === null || !sale.start || !sale.end) {
        issue(sale.headers[0], 'A sale price needs its value, start date and end date together')
        for (const h of sale.headers) log(h, 'refused', { reason: 'incomplete sale window' })
      } else {
        out.rows.push({ ...identityRow, field: 'sale', value: { value, start: excelDate(sale.start), end: excelDate(sale.end) } })
        for (const h of sale.headers) log(h, 'row', { field: 'sale' })
      }
    }
    // A dimension with a value but no unit takes the ONE unit its sibling dimensions give in this row
    // (old flat files fill `package_length_unit_of_measure` only); said in the ledger and a warning.
    const siblingUnits = new Map<string, Set<string>>()
    for (const { field, values } of grouped.values()) if (field.shape === 'measure') for (const v of values) if (v.path.at(-1) === 'unit') siblingUnits.set(field.attribute, (siblingUnits.get(field.attribute) ?? new Set()).add(v.value))
    for (const { field, locale, values } of grouped.values()) {
      values.sort((a, b) => { for (let i = 0; i < Math.max(a.slots.length, b.slots.length); i++) { const d = (a.slots[i] ?? 1) - (b.slots[i] ?? 1); if (d) return d } return 0 })
      const typed = (value: string): unknown => {
        if (field.kind === 'number') { const number = toNumber(value); if (number === null) throw new Error('Enter a finite number, using a decimal point'); return number }
        if (field.kind === 'boolean') { const b = booleanOf(value, fileLanguage); if (b === null) throw new Error('No unambiguous boolean translation exists'); return b }
        if (field.kind === 'date') return excelDate(value)
        return value
      }
      try {
        let value: unknown
        if (field.shape === 'measure') {
          const measures = values.filter(v => v.path.at(-1) !== 'unit'), units = values.filter(v => v.path.at(-1) === 'unit')
          if (!measures.length && units.length === 1) {
            // Old flat files fill the unit column on every row, value or not: a unit alone states nothing.
            const reason = `A unit (${units[0].value}) without its value states no measurement`
            exclude(units[0].header, reason); log(units[0].header, 'excluded', { reason }); continue
          }
          const shared = siblingUnits.get(field.attribute)
          if (measures.length === 1 && !units.length && shared?.size === 1) {
            const unit = [...shared][0]
            value = { value: typed(measures[0].value), unit: unitOf(unit, field) }
            out.rows.push({ ...identityRow, locale, field: field.key, value })
            log(measures[0].header, 'row', { field: field.key, reason: `unit ${unit} taken from the other ${field.attribute} dimensions in this row` })
            out.warnings.push(`${sheet} row ${row}: ${field.key} has no unit of its own; the unit ${unit} of the other ${field.attribute} dimensions was used.`)
            continue
          }
          if (measures.length !== 1 || units.length !== 1 || JSON.stringify(measures[0].slots) !== JSON.stringify(units[0].slots)) throw new Error('A measure needs exactly one value and its matching unit')
          value = { value: typed(measures[0].value), unit: unitOf(units[0].value, field) }
        } else if (field.shape === 'list') value = values.map(v => typed(v.value))
        else { if (values.length !== 1) throw new Error('Multiple values target a scalar attribute'); value = typed(values[0].value) }
        out.rows.push({ ...identityRow, locale, field: field.key, value })
        for (const v of values) log(v.header, 'row', { field: field.key })
      } catch (e) {
        out.issues.push({ row, sku, field: field.key, message: e instanceof Error ? e.message : String(e) })
        for (const v of values) log(v.header, 'refused', { reason: e instanceof Error ? e.message : String(e) })
      }
    }
    // Q1 a — a FULL update: a blank cell in a column the file carries clears the market value (D3).
    if (action === 'replace') {
      const blanks = new Map<string, { field: ChannelFieldSpec; locale: string; headers: string[]; filled: boolean }>()
      for (const header of parsed.headers) {
        const place = placementFor(category, spec, header)
        if (place.kind !== 'field') continue
        const key = `${place.field.key}\u0000${place.locale}`
        const entry = blanks.get(key) ?? { field: place.field, locale: place.locale, headers: [], filled: false }
        entry.headers.push(header)
        if ((record[header] ?? '').trim()) entry.filled = true
        blanks.set(key, entry)
      }
      for (const { field, locale, headers, filled } of blanks.values()) {
        // Amazon refuses a full update that blanks a required attribute (its value stays), and a
        // read-only one cannot change on a live listing: neither is cleared.
        if (filled || field.requirement === 'required' || !field.editable || grouped.has(`${field.key}\u0000${locale}`)) continue
        out.rows.push({ ...identityRow, locale, field: field.key, action: 'CLEAR', clearIfPresent: true })
        out.ledger.push({ row, sku, header: headers[0], outcome: 'row', field: field.key, reason: 'full-update blank' })
      }
    }
    // A NEW product (create/upsert with a family, primary-language file — checked above).
    if (isNew) {
      const base = { row, sku, entity: 'Products' as const, channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', action: 'SET' as const, origin: 'channel-file' as const }
      const primary = normalizeLanguage(PRIMARY_CONTENT_LOCALE)
      // The EFFECTIVE language of the title: its own locale, or the market's primary language when it has none.
      const title = out.rows.find(r => r.sku === sku && r.row === row && r.field === 'item_name' && r.action === 'SET' && (r.locale ? normalizeLanguage(r.locale) : primaryLanguage) === primary)
      if (!title) { issue('item_name', 'A new product needs a verified name in the Amazon workbook') }
      else {
        out.rows.push({ ...base, field: 'family', value: destination.familyCode }, { ...base, field: 'name', value: title.value }, { ...base, locale: normalizeLanguage(PRIMARY_CONTENT_LOCALE), field: 'name', value: title.value })
        const fileParent = parentHeader ? (record[parentHeader] ?? '').trim() : ''
        if (fileParent) out.rows.push({ ...base, field: 'parentSku', value: destination.identities?.get(fileParent)?.sku ?? fileParent })
      }
    }
    if (out.rows.length + out.issues.length + out.exclusions.length > TRANSFER_MAX_ROWS) throw new Error('Amazon workbook exceeds 50,000 attribute outcomes')
  }
  if (formulaCount.n) out.warnings.push(`${sheet}: ${formulaCount.n} value(s) were computed by Excel formulas in the file (${[...formulaCount.headers].slice(0, 5).join(', ')}); the results Excel saved were imported.`)
  return out
}

/** The kind of a column that does not depend on the product type (identity, type, action, identifiers). */
function placeRoot(parsed: AmazonTemplateParse, header: string): Placement['kind'] | null {
  const key = parsed.meta.grammar === 'legacy' ? legacyAttributePath(header) ?? header : header
  const root = pathOf(key)[0]
  if (root === 'contribution_sku') return 'identity'
  if (root === 'product_type') return 'type'
  if (key === '::record_action') return 'action'
  if (key === 'amzn1.volt.ca.product_id_type') return 'id-type'
  return null
}

/**
 * CFI-9 — independent zero-loss check. Lists every populated cell of the parse (the same test the
 * reader uses) and compares it with the ledger: every cell exactly once, and every `row` entry backed
 * by an emitted row for that SKU and field. Full-update blank clears come from EMPTY cells and are not
 * required, but each must still be backed by a row.
 */
export function checkLedger(parsed: AmazonTemplateParse, result: Pick<AmazonWorkbookResult, 'rows' | 'ledger'>) {
  const cellKey = (row: number, header: string) => `${row}\u0000${header}`
  const populated = new Map<string, { row: number; header: string }>()
  for (const [index, record] of parsed.rows.entries()) {
    const row = parsed.rowNumbers?.[index] ?? (parsed.meta.dataStartRow ?? 2) + index
    for (const header of parsed.headers) if ((record[header] ?? '').trim() !== '') populated.set(cellKey(row, header), { row, header })
  }
  for (const skipped of parsed.meta.skippedRows ?? []) for (const [header, v] of Object.entries(skipped.cells)) if ((v ?? '').trim()) populated.set(cellKey(skipped.row, header), { row: skipped.row, header })
  for (const orphan of parsed.meta.orphanCells ?? []) populated.set(cellKey(orphan.row, `@${orphan.column}`), { row: orphan.row, header: `@${orphan.column}` })
  const seen = new Map<string, number>()
  const danglingRows: { row: number; header: string }[] = []
  for (const entry of result.ledger) {
    if (entry.outcome === 'row' && !result.rows.some(r => r.sku === entry.sku && r.field === entry.field && r.row === entry.row)) danglingRows.push({ row: entry.row, header: entry.header })
    if (entry.reason === 'full-update blank') continue
    const key = cellKey(entry.row, entry.header)
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return {
    unaccounted: [...populated.entries()].filter(([key]) => !seen.has(key)).map(([, cell]) => cell),
    duplicated: [...seen.entries()].filter(([, n]) => n > 1).map(([key]) => { const [row, header] = key.split('\u0000'); return { row: Number(row), header } }),
    danglingRows,
  }
}

/** An Amazon listing Nexus holds that could be the file row's listing (fetched on the host). */
export interface AmazonListingCandidate { sku: string; aliasKey: string; accountId: string | null; sellerSkus: string[]; asin: string | null }

/**
 * CFI-4 (D4) — pure identity match. Only listings of THIS seller account count (another account's
 * listing with the same seller SKU or ASIN is another business's offer). Seller-SKU identities are
 * decisive before the ASIN; a file SKU that matches more than one listing is refused, naming them.
 * The matched listing's alias travels with the identity, so rows target that exact listing.
 */
export function matchAmazonIdentities(input: { fileSkus: string[]; exactSkus: Set<string>; asinOf: Map<string, string>; candidates: AmazonListingCandidate[]; accountId: string }) {
  const identities = new Map<string, AmazonIdentity>(), problems = new Map<string, string>()
  const mine = input.candidates.filter(c => c.accountId === input.accountId)
  const name = (c: AmazonListingCandidate) => c.aliasKey ? `${c.sku} (listing alias ${c.aliasKey.slice(-6)})` : `${c.sku} (primary listing)`
  for (const fileSku of input.fileSkus) {
    if (input.exactSkus.has(fileSku)) { identities.set(fileSku, { sku: fileSku, via: 'sku' }); continue }
    const asin = input.asinOf.get(fileSku)
    const tiers: ['seller-sku' | 'asin', AmazonListingCandidate[]][] = [['seller-sku', mine.filter(c => c.sellerSkus.includes(fileSku))], ['asin', asin ? mine.filter(c => c.asin === asin) : []]]
    for (const [via, found] of tiers) {
      const distinct = [...new Map(found.map(c => [amazonListingKey(c.sku, c.aliasKey), c])).values()]
      if (!distinct.length) continue
      if (distinct.length === 1) identities.set(fileSku, { sku: distinct[0].sku, via, ...(distinct[0].aliasKey ? { aliasKey: distinct[0].aliasKey } : {}) })
      else problems.set(fileSku, `Amazon SKU ${fileSku} matches several Nexus listings (${distinct.map(name).join('; ')}). Reconcile the listing identities first.`)
      break
    }
  }
  return { identities, problems }
}

/** CFI (7a) — the product types to load schemas for: the raw values AND the template's own translations of them. */
export function amazonProductTypes(parsed: AmazonTemplateParse): string[] {
  const typeHeader = parsed.headers.find(h => placeRoot(parsed, h) === 'type')
  const types = new Set(parsed.meta.productTypes)
  if (typeHeader) for (const r of parsed.rows) { const raw = (r[typeHeader] ?? '').trim(); if (raw) types.add(sourceValue(parsed, typeHeader, raw).trim().toUpperCase()) }
  return [...types].filter(Boolean).sort()
}

export interface AmazonResolveOptions {
  accountId?: string; marketplace?: string; familyId?: string; mode: TransferMode | string
  links?: Record<string, string>; confirmDeletes?: boolean | string[]; productId?: string
}

/** Everything the host must read from the database, then the pure mapping. */
export async function resolveAmazonCatalogWorkbook(parsed: AmazonTemplateParse, opts: AmazonResolveOptions): Promise<AmazonWorkbookResult> {
  const { default: prisma } = await import('../../db.js')
  const marketplace = (opts.marketplace ?? parsed.meta.marketplace ?? '').toUpperCase()
  if (!marketplace) throw new Error('This Amazon workbook has no reliable marketplace/language metadata. Use column mapping with an explicit destination.')
  if (parsed.meta.marketplace && parsed.meta.marketplace !== marketplace) throw new Error(`This workbook belongs to Amazon ${parsed.meta.marketplace}, not ${marketplace}`)
  const market = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: marketplace, isActive: true }, select: { language: true, languages: true, currency: true } })
  if (!market?.language) throw new Error('Configure the Amazon marketplace language first')
  let accountId = opts.accountId
  if (!accountId) {
    const { listActiveConnections } = await import('../connection-resolver.service.js')
    const accounts = (await listActiveConnections('AMAZON')).filter(a => !a.marketplace || ['GLOBAL', marketplace].includes(a.marketplace))
    if (accounts.length !== 1) return refuseEverything(parsed, 'accountId', accounts.length ? `Choose the Amazon account: ${accounts.length} accounts sell on Amazon ${marketplace}` : `Choose the Amazon account: no active Amazon account sells on ${marketplace}`)
    accountId = accounts[0].id
  }
  const { loadAmazonSpec } = await import('./channel-specs/index.js')
  const specs = new Map<string, ChannelSpec>()
  // CHMAP — also the template's own product types, so its mapping version can decide every column it carries.
  for (const category of new Set([...amazonProductTypes(parsed), ...(parsed.meta.templateProductTypes ?? [])])) {
    try { specs.set(category, await loadAmazonSpec(marketplace, category, accountId)) }
    catch { /* an unavailable schema refuses that product type's rows with "Refresh the … schema" */ }
  }

  // D4 — identity: exact SKU → the listing identities the studio publisher reads → ASIN → (parents) a proposal.
  const skuHeader = parsed.headers.find(h => placeRoot(parsed, h) === 'identity')
  const idTypeHeader = parsed.headers.find(h => placeRoot(parsed, h) === 'id-type')
  const idValueHeader = parsed.headers.find(h => (parsed.meta.grammar === 'legacy' ? legacyAttributePath(h) ?? h : h) === 'amzn1.volt.ca.product_id_value')
  const parentHeader = parsed.headers.find(h => { const p = pathOf(parsed.meta.grammar === 'legacy' ? legacyAttributePath(h) ?? h : h); return p[0] === 'child_parent_sku_relationship' && p.at(-1) === 'parent_sku' })
  const rowSku = (r: Record<string, string>) => (skuHeader ? r[skuHeader] ?? '' : '').trim()
  const fileParent = (r: Record<string, string>) => (parentHeader ? r[parentHeader] ?? '' : '').trim()
  const fileSkus = [...new Set([...parsed.rows.map(rowSku), ...parsed.rows.map(fileParent)].filter(Boolean))]
  const exact = await prisma.product.findMany({ where: { sku: { in: fileSkus }, deletedAt: null }, select: { id: true, sku: true, parentId: true } })
  const bySku = new Map(exact.map(p => [p.sku, p]))
  const unresolved = fileSkus.filter(s => !bySku.has(s))
  const asinOf = new Map<string, string>()
  if (idTypeHeader && idValueHeader) for (const r of parsed.rows) {
    const type = sourceValue(parsed, idTypeHeader, r[idTypeHeader] ?? '').trim().toLowerCase(), value = (r[idValueHeader] ?? '').trim()
    if (type === 'asin' && /^[A-Z0-9]{10}$/.test(value) && rowSku(r) && !bySku.has(rowSku(r))) asinOf.set(rowSku(r), value)
  }
  // Every Amazon listing on this market that names an unresolved file SKU (seller-SKU identities) or
  // carries its ASIN. The ACCOUNT filter is applied in `matchAmazonIdentities` (pure, tested).
  const candidates: AmazonListingCandidate[] = []
  const select = { id: true, aliasKey: true, channelConnectionId: true, externalListingId: true, platformAttributes: true, flatFileSnapshot: true, offers: { select: { sku: true } }, product: { select: { sku: true } } } as const
  const seenListings = new Set<string>()
  const collect = (listings: { id: string; aliasKey: string; channelConnectionId: string | null; externalListingId: string | null; platformAttributes: unknown; flatFileSnapshot: unknown; offers: { sku: string }[]; product: { sku: string } }[]) => {
    for (const l of listings) {
      if (seenListings.has(l.id)) continue
      seenListings.add(l.id)
      const pa = (l.platformAttributes ?? {}) as Record<string, unknown>, ff = (l.flatFileSnapshot ?? {}) as Record<string, unknown>
      const sellerSkus = [...new Set([pa.sellerSku, pa.seller_sku, pa.sku, pa.item_sku, ff.item_sku, ...l.offers.map(o => o.sku)].filter((v): v is string => typeof v === 'string' && !!v.trim()))]
      candidates.push({ sku: l.product.sku, aliasKey: l.aliasKey, accountId: l.channelConnectionId, sellerSkus, asin: l.externalListingId })
    }
  }
  for (let i = 0; i < unresolved.length; i += 50) {
    const chunk = unresolved.slice(i, i + 50)
    collect(await prisma.channelListing.findMany({
      where: { channel: 'AMAZON', marketplace, OR: chunk.flatMap(s => [
        { platformAttributes: { path: ['sellerSku'], equals: s } }, { platformAttributes: { path: ['seller_sku'], equals: s } },
        { platformAttributes: { path: ['sku'], equals: s } }, { platformAttributes: { path: ['item_sku'], equals: s } },
        { flatFileSnapshot: { path: ['item_sku'], equals: s } }, { offers: { some: { sku: s } } },
      ]) }, select,
    }))
  }
  if (asinOf.size) collect(await prisma.channelListing.findMany({ where: { channel: 'AMAZON', marketplace, externalListingId: { in: [...new Set(asinOf.values())] } }, select }))
  const matched = matchAmazonIdentities({ fileSkus, exactSkus: new Set(bySku.keys()), asinOf, candidates, accountId })
  const identities = matched.identities, identityProblems = matched.problems
  for (const [fileSku, nexusSku] of Object.entries(opts.links ?? {})) {
    const target = bySku.get(nexusSku) ?? await prisma.product.findFirst({ where: { sku: nexusSku, deletedAt: null }, select: { id: true, sku: true, parentId: true } })
    if (!target) { identityProblems.set(fileSku, `The confirmed link names ${nexusSku}, which is not a Nexus product`); continue }
    bySku.set(target.sku, target); identities.set(fileSku, { sku: target.sku, via: 'link' }); identityProblems.delete(fileSku)
  }
  // Parent proposals: every resolved child of an unresolved file parent belongs to ONE Nexus parent.
  const resolvedSkus = [...new Set([...identities.values()].map(i => i.sku))]
  const missingProducts = resolvedSkus.filter(s => !bySku.has(s))
  if (missingProducts.length) for (const p of await prisma.product.findMany({ where: { sku: { in: missingProducts }, deletedAt: null }, select: { id: true, sku: true, parentId: true } })) bySku.set(p.sku, p)
  const parentIds = [...new Set([...bySku.values()].map(p => p.parentId).filter((id): id is string => !!id))]
  const parentsById = new Map((parentIds.length ? await prisma.product.findMany({ where: { id: { in: parentIds } }, select: { id: true, sku: true } }) : []).map(p => [p.id, p.sku]))
  const proposals = new Map<string, { proposedSku: string; reason: string }>()
  for (const parentSku of new Set(parsed.rows.map(fileParent).filter(Boolean))) {
    if (identities.has(parentSku) || identityProblems.has(parentSku)) continue
    const children = parsed.rows.filter(r => fileParent(r) === parentSku).map(rowSku).filter(Boolean)
    const nexusParents = new Set(children.map(c => identities.get(c)?.sku).map(s => s && bySku.get(s)?.parentId).map(id => id && parentsById.get(id)).filter((s): s is string => !!s))
    const resolvedChildren = children.filter(c => identities.has(c))
    if (nexusParents.size === 1 && resolvedChildren.length) {
      const proposedSku = [...nexusParents][0]
      proposals.set(parentSku, { proposedSku, reason: `${resolvedChildren.length} of its ${children.length} children in this file belong to ${proposedSku} in Nexus` })
    }
  }
  // The listings the resolved SKUs already have on this account and market (+ the channel's last read).
  const nexusSkus = [...new Set(parsed.rows.map(rowSku).filter(Boolean).map(s => identities.get(s)?.sku ?? s))]
  const listings = await prisma.channelListing.findMany({ where: { channel: 'AMAZON', marketplace, channelConnectionId: accountId, product: { sku: { in: nexusSkus } } }, select: { id: true, aliasKey: true, version: true, externalListingId: true, product: { select: { sku: true } } } })
  const drift = listings.length ? await prisma.channelDrift.findMany({ where: { channelListingId: { in: listings.map(l => l.id) } }, select: { channelListingId: true, lastCheckedAt: true } }) : []
  const checkedAt = new Map(drift.map(d => [d.channelListingId, d.lastCheckedAt]))
  const listingFacts = new Map(listings.map(l => [amazonListingKey(l.product.sku, l.aliasKey), { version: l.version, externalListingId: l.externalListingId, checkedAt: checkedAt.get(l.id)?.toISOString() ?? null }]))
  const family = opts.familyId ? await prisma.productFamily.findUnique({ where: { id: opts.familyId }, select: { code: true } }) : null
  let scopeSkus: Set<string> | undefined
  if (opts.productId) {
    const anchor = await prisma.product.findFirst({ where: { id: opts.productId, deletedAt: null }, select: { id: true, parentId: true } })
    if (!anchor) throw new Error('This product is unavailable')
    const rootId = anchor.parentId ?? anchor.id
    scopeSkus = new Set((await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: rootId }, { parentId: rootId }] }, select: { sku: true } })).map(p => p.sku))
  }
  const { marketLanguages } = await import('./market-languages.js')
  const languages = marketLanguages('AMAZON', marketplace, [{ channel: 'AMAZON', code: marketplace, language: market.language, languages: market.languages ?? [] }])
  const primaryLanguage = normalizeLanguage(languages[0] ?? market.language)
  // CHMAP M2 — the mapping version decides each column; the file is read with it and the use is recorded.
  const { amazonImportMapping } = await import('../channel-mapping/amazon-import.js')
  const { recordUse } = await import('../channel-mapping/store.js')
  let chmap: Awaited<ReturnType<typeof amazonImportMapping>> | null = null
  let mappingProblem = ''
  try { chmap = await amazonImportMapping(parsed, specs, { marketplace, primaryLanguage, marketLanguages: [...new Set([primaryLanguage, ...languages.map(normalizeLanguage)])] }) }
  catch (error) { mappingProblem = error instanceof Error ? error.message : String(error) }
  const result = mapAmazonWorkbook(parsed, specs, {
    accountId, marketplace, language: languages[0] ?? market.language, languages, currency: market.currency ?? undefined,
    identities, proposals, identityProblems, existingProducts: new Set(bySku.keys()), listings: listingFacts,
    mode: opts.mode, familyCode: family?.code ?? null, confirmDeletes: opts.confirmDeletes === true || Array.isArray(opts.confirmDeletes) ? opts.confirmDeletes : false, scopeSkus, withVersions: !!opts.productId,
    ...(chmap ? { mapping: chmap.mapping } : {}),
  })
  if (chmap) {
    result.mapping = chmap.info
    result.warnings.unshift(`Read with the mapping ${chmap.info.label}.`, ...chmap.warnings)
    await recordUse(chmap.info.setId, 'IMPORT', parsed.meta.sheet, { rows: result.rows.length, excluded: result.exclusions.length, refused: result.issues.length, templateVersion: parsed.meta.templateVersion ?? null })
  } else result.warnings.unshift(`The mapping versions could not be read (${mappingProblem}); this file was read with the built-in rules only, and no Owner decision was applied.`)
  return result
}

/** A whole-file stop that still accounts for every cell (the ledger stays complete). */
function refuseEverything(parsed: AmazonTemplateParse, field: string, message: string): AmazonWorkbookResult {
  const out: AmazonWorkbookResult = { rows: [], issues: [{ row: 0, sku: '', field, message }], exclusions: [], links: [], ledger: [], warnings: [] }
  for (const [index, record] of parsed.rows.entries()) {
    const row = parsed.rowNumbers?.[index] ?? (parsed.meta.dataStartRow ?? 2) + index
    for (const header of parsed.headers) if ((record[header] ?? '').trim() !== '') out.ledger.push({ row, sku: '', header, outcome: 'refused', reason: message })
  }
  for (const skipped of parsed.meta.skippedRows ?? []) for (const [header, v] of Object.entries(skipped.cells)) if ((v ?? '').trim()) out.ledger.push({ row: skipped.row, sku: '', header, outcome: 'skipped-row', reason: skipped.reason })
  for (const orphan of parsed.meta.orphanCells ?? []) out.ledger.push({ row: orphan.row, sku: '', header: `@${orphan.column}`, outcome: 'refused', reason: message })
  return out
}

/** Thin wrapper kept for the catalog page route and existing tests: detect, then resolve. */
export async function readAmazonCatalogWorkbook(buffer: Buffer, accountId: string, marketplace: string, options: { familyId?: string; mode?: string; links?: Record<string, string>; confirmDeletes?: boolean | string[]; productId?: string } = {}) {
  if (!buffer.length || buffer.length > TRANSFER_MAX_FILE_BYTES) throw new Error('Choose a non-empty Amazon workbook up to 10 MB')
  await checkWorkbookSize(buffer)
  const parsed = await detectAmazonTemplate(buffer, { strict: true })
  if (!parsed) throw new Error('No Amazon template was detected. Use an Amazon-downloaded XLSX/XLSM workbook.')
  return resolveAmazonCatalogWorkbook(parsed, { accountId: accountId || undefined, marketplace: marketplace || undefined, familyId: options.familyId, mode: options.mode ?? 'update', links: options.links, confirmDeletes: options.confirmDeletes, productId: options.productId })
}
