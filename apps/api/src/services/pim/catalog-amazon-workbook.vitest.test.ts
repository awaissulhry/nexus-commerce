/**
 * CFI (R-CFI-1) — the Owner's native Amazon templates imported AS IS. One test per rule of the L2 lane
 * (`docs/channel-file-import/BUILD.md`). Fixtures are built here with JSZip (no binary files, never the
 * Owner's originals); they mirror shapes measured on the Owner's corpus on 2026-09-25.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import type { TransferRow } from '@nexus/shared/catalog-transfer'
import { detectAmazonTemplate, classifyRecordAction, legacyAttributePath, type AmazonTemplateParse } from '../amazon/template-workbook.js'
import { mapAmazonWorkbook, checkLedger, matchAmazonIdentities, amazonProductTypes, type AmazonDestination, type AmazonListingCandidate } from './catalog-amazon-workbook.js'
import { amazonSpecFromDefinition } from './channel-specs/amazon.js'
import { buildAmazonDraftFields } from '../channel-mapping/amazon-draft.js'

// ── fixtures ────────────────────────────────────────────────────────────────
const IT = 'APJ6JRA9NG5V4'
const col = (n: number): string => n > 26 ? col(Math.floor((n - 1) / 26)) + col(((n - 1) % 26) + 1) : String.fromCharCode(64 + n)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
type Cell = string | { v: string; f?: string; e?: boolean }
async function workbook(rows: Record<number, Cell[]>): Promise<Buffer> {
  const zip = new JSZip()
  const body = Object.entries(rows).map(([r, cells]) => `<row r="${r}">${cells.map((c, i) => {
    if (c === '' || c === undefined) return ''
    const ref = `${col(i + 1)}${r}`
    if (typeof c === 'string') return `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>`
    if (c.e) return `<c r="${ref}" t="e"><v>${esc(c.v)}</v></c>`
    return `<c r="${ref}"><f>${esc(c.f ?? '')}</f><v>${esc(c.v)}</v></c>`
  }).join('')}</row>`).join('')
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Modello" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
function settings(extra: Record<string, string> = {}) {
  return 'settings=' + Object.entries({ feedType: '256', primaryMarketplaceId: `amzn1.mp.o.${IT}`, contentLanguageTag: 'it_IT', attributeRow: '5', dataRow: '7', ...extra }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}
const h = (key: string, slot = 1, leaf = 'value', lang?: string) => `${key}[marketplace_id=${IT}]${lang ? `[language_tag=${lang}]` : ''}#${slot}.${leaf}`
/** A new-grammar template: keys in row 5, data from row 7; 20 filler keys keep the key row "dense". */
async function template(keys: string[], data: Cell[][], opts: { settings?: Record<string, string>; aliases?: { attribute: string; aliases: Record<string, string> }[]; row6?: Cell[] } = {}) {
  const filler = Array.from({ length: 20 }, (_, i) => `filler_${i}#1.value`)
  const s = settings({ ...(opts.aliases ? { attributeSettings: b64(opts.aliases) } : {}), ...opts.settings })
  const rows: Record<number, Cell[]> = { 1: [s], 5: [...keys, ...filler] }
  if (opts.row6) rows[6] = opts.row6
  data.forEach((cells, i) => { rows[7 + i] = cells })
  return (await detectAmazonTemplate(await workbook(rows), { strict: true }))!
}
const attr = (properties: object, max = 1) => ({ type: 'array', maxItems: max, items: { type: 'object', properties } })
const coat = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { required: ['brand'], properties: {
  item_name: attr({ value: { type: 'string' } }), bullet_point: attr({ value: { type: 'string' } }, 10), brand: attr({ value: { type: 'string' } }),
  color: attr({ value: { type: 'string', enum: ['black', 'grey'], enumNames: ['Nero', 'Grigio'] } }),
  model_name: attr({ value: { type: 'string' } }), batteries_required: attr({ value: { type: 'boolean' } }),
  item_weight: attr({ value: { type: 'number' }, unit: { type: 'string', enum: ['kilograms'] } }),
  list_price: attr({ value_with_tax: { type: 'number' } }), merchant_suggested_asin: attr({ value: { type: 'string' } }),
  closure: attr({ type: attr({ value: { type: 'string' } }) }),
  item_package_dimensions: attr(Object.fromEntries(['length', 'width', 'height'].map(d => [d, { type: 'object', properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['centimeters'] } } }]))),
  apparel_size: { type: 'array', maxItems: 1, selectors: ['marketplace_id', 'size_system'], items: { type: 'object', properties: { size_system: { type: 'string', enum: ['as3'], enumNames: ['DE/NL/SE/PL'] }, size: { type: 'string', enum: ['m'], enumNames: ['M'] } } } },
} } })
const specs = new Map([['COAT', coat]])
const base: AmazonDestination = { accountId: 'amazon-a', marketplace: 'IT', language: 'it' }
const SKU = 'contribution_sku#1.value', TYPE = 'product_type#1.value', ACTION = '::record_action'
const fields = (rows: TransferRow[], sku?: string) => Object.fromEntries(rows.filter(r => !sku || r.sku === sku).map(r => [`${r.field}${r.locale ? `@${r.locale}` : ''}${r.action === 'CLEAR' ? '!CLEAR' : ''}`, r.value]))
const clean = (parsed: AmazonTemplateParse, result: ReturnType<typeof mapAmazonWorkbook>) => expect(checkLedger(parsed, result)).toEqual({ unaccounted: [], duplicated: [], danglingRows: [] })

describe('CFI — record actions come from the template\'s own dictionary (rule 2)', () => {
  it('uses the aliases and the blank default the template declares, over any word list', async () => {
    const aliases = [{ attribute: ACTION, aliases: { 'Modifica': 'partial_update', 'Erstellen oder Ersetzen (Vollständige Aktualisierung)': 'full_update', 'Bearbeiten (Teilaktualisierung)': 'partial_update', 'Löschen': 'delete' } }]
    const parsed = await template([SKU, ACTION, TYPE], [['A', 'Modifica', 'COAT'], ['B', '', 'COAT'], ['C', 'Bearbeiten (Teilaktualisierung)', 'COAT'], ['D', 'Löschen', 'COAT']],
      { aliases, settings: { AttributeDefaultValues: b64({ '::record_action': 'partial_update' }) } })
    // "Modifica" alone reads as "replace" to the word markers; the template says partial.
    expect(parsed.rows.map(r => r.__action)).toEqual(['partial', 'partial', 'partial', 'delete'])
    expect(parsed.meta.recordActionDefault).toBe('partial_update')
  })
  it('reads the German, old flat-file and wire forms without a dictionary', () => {
    expect(classifyRecordAction('Bearbeiten (Teilaktualisierung)')).toBe('partial')
    expect(classifyRecordAction('Löschung')).toBe('delete')
    expect(classifyRecordAction('Elimina')).toBe('delete')
    expect(classifyRecordAction('PartialUpdate')).toBe('partial')
    expect(classifyRecordAction('partial_update')).toBe('partial')
    expect(classifyRecordAction('Update')).toBe('replace')
    expect(classifyRecordAction('Aggiornamento')).toBe('replace')
    expect(classifyRecordAction('Erstellen oder Ersetzen (Vollständige Aktualisierung)')).toBe('replace')
  })
})

describe('CFI — record actions are honoured (rule 3, Q1 a)', () => {
  const keys = [SKU, ACTION, TYPE, h('item_name', 1, 'value', 'it_IT'), h('model_name', 1, 'value', 'it_IT'), h('bullet_point', 1, 'value', 'it_IT'), h('bullet_point', 2, 'value', 'it_IT'), h('brand', 1, 'value', 'it_IT')]
  it('a FULL row clears its blank, editable, optional columns (clearIfPresent); a PARTIAL row clears nothing', async () => {
    const parsed = await template(keys, [['FULL', 'full_update', 'COAT', 'Giacca', '', '', '', ''], ['PART', 'partial_update', 'COAT', 'Giacca', '', '', '', '']])
    const result = mapAmazonWorkbook(parsed, specs, base)
    const clears = result.rows.filter(r => r.action === 'CLEAR')
    expect(clears.map(r => [r.sku, r.field, r.clearIfPresent])).toEqual([['FULL', 'model_name', true], ['FULL', 'bullet_point', true]])
    // `brand` is required: Amazon refuses a full update that blanks it, so its value stays — never cleared.
    expect(clears.some(r => r.field === 'brand')).toBe(false)
    clean(parsed, result)
  })
  it('a list field is blank only when ALL its slots are blank', async () => {
    const parsed = await template(keys, [['FULL', 'full_update', 'COAT', 'Giacca', 'Gale', '', 'Seconda', 'XAVIA']])
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(result.rows.filter(r => r.action === 'CLEAR')).toEqual([])
    expect(fields(result.rows).bullet_point).toEqual(['Seconda'])
  })
  it('a DELETE row: an issue on `presence` stating the evidence, then a presence row once confirmed', async () => {
    const parsed = await template(keys, [['DEL', 'delete', 'COAT', 'Giacca', '', '', '', '']])
    const listings = new Map([['DEL', { version: 4, externalListingId: 'B0TESTASIN', checkedAt: '2026-09-24T03:37:00.000Z' }]])
    const pending = mapAmazonWorkbook(parsed, specs, { ...base, listings })
    expect(pending.rows).toEqual([])
    expect(pending.issues).toEqual([expect.objectContaining({ field: 'presence', message: expect.stringContaining('B0TESTASIN') })])
    expect(pending.issues[0].message).toContain('2026-09-24')
    clean(parsed, pending)
    const confirmed = mapAmazonWorkbook(parsed, specs, { ...base, listings, confirmDeletes: true })
    expect(confirmed.rows).toEqual([expect.objectContaining({ entity: 'Listings', field: 'presence', action: 'SET', value: 'ENDED', origin: 'channel-file' })])
    expect(confirmed.issues).toEqual([])
    clean(parsed, confirmed)
    // No Nexus listing on this market: nothing to end, said so.
    expect(mapAmazonWorkbook(parsed, specs, { ...base, listings: new Map(), confirmDeletes: true }).exclusions[0].message).toContain('nothing to end')
  })
})

describe('CFI — OLD flat files (rule 4)', () => {
  it('reads market + language from the D1 settings cell and maps classic keys through the current schema', async () => {
    const d1 = `settings=attributeRow=3&contentLanguageTag=it_IT&dataRow=4&primaryMarketplaceId=amzn1.mp.o.${IT}&labelRow=2`
    const keys = ['feed_product_type', 'item_sku', 'update_delete', 'item_name', 'bullet_point1', 'bullet_point2', 'closure_type', 'item_weight', 'item_weight_unit_of_measure', 'standard_price', 'quantity', 'platinum_keywords1', 'color_name',
      'batteries_required', 'package_length_unit_of_measure', 'package_width', 'package_height', 'apparel_size_system',
      ...Array.from({ length: 20 }, (_, i) => `legacy_filler${i}`)]
    const buffer = await workbook({ 1: ['TemplateType=fptcustom', 'Version=2024.0630', 'TemplateSignature=Q09BVA==', d1], 2: keys.map(k => k.toUpperCase()), 3: keys,
      4: ['coat', 'OLD-1', 'PartialUpdate', 'Giacca', 'Primo', 'Secondo', 'Cerniera', '1.6', 'kilograms', '89.90', '5', 'obsolete', 'Nero', 'No', 'CM', '29', '9', 'DE / NL / SE / PL'] })
    const parsed = (await detectAmazonTemplate(buffer, { strict: true }))!
    expect(parsed.meta).toMatchObject({ grammar: 'legacy', marketplace: 'IT', contentLanguageTag: 'it_IT', productTypes: ['COAT'] })
    expect(parsed.rows[0].__action).toBe('partial')
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(fields(result.rows)).toMatchObject({ productType: 'COAT', item_name: 'Giacca', bullet_point: ['Primo', 'Secondo'], closure: 'Cerniera', item_weight: { value: 1.6, unit: 'kilograms' }, price: 89.9, color: 'black',
      batteries_required: false, item_package_dimensions__width: { value: 29, unit: 'centimeters' }, item_package_dimensions__height: { value: 9, unit: 'centimeters' } })
    expect(result.exclusions.some(e => e.field === 'quantity' && e.message.includes('file value 5'))).toBe(true)
    // An old column today's schema does not know is explained, not refused; a unit alone states nothing.
    expect(result.exclusions.find(e => e.field === 'platinum_keywords1')?.message).toContain("current COAT schema has no platinum_keywords")
    expect(result.exclusions.find(e => e.field === 'package_length_unit_of_measure')?.message).toContain('without its value')
    // The size-system LABEL (spaced differently) is the schema's own selector.
    expect(result.exclusions.find(e => e.field === 'apparel_size_system')?.message).toContain('size_system=as3')
    expect(result.warnings.join(' ')).toContain('unit CM of the other item_package_dimensions')
    expect(result.issues).toEqual([])
    clean(parsed, result)
  })
  it('an old-file key row with many current keys is still the OLD grammar (GLOBAL files carry 11 markets of offer keys)', async () => {
    const d1 = `settings=attributeRow=3&contentLanguageTag=it_IT&dataRow=4&primaryMarketplaceId=amzn1.mp.o.${IT}`
    const offers = ['A1PA6795UKMFR9', 'A13V1IB3VIYZZH', 'A1RKKUPIHCS9HS', 'A1805IZSGTT6HS', 'A2NODRKZP88ZB9', 'A1C3SOZRARQ6R3', 'AMEN7PMS3EDWL', 'A28R8C7NBKEWEA', 'A1F83G8C2ARO7P', 'A33AVAJ2PDY3EV', 'ATVPDKIKX0DER']
      .flatMap(m => [`purchasable_offer[marketplace_id=${m}]#1.our_price#1.schedule#1.value_with_tax`, `purchasable_offer[marketplace_id=${m}]#1.start_at.value`])
    const keys = ['feed_product_type', 'item_sku', 'update_delete', 'item_name', ...offers]
    const buffer = await workbook({ 1: ['TemplateType=fptcustom', 'Version=2024.0630', 'TemplateSignature=Q09BVA==', d1], 3: keys, 4: ['coat', 'GLOBAL-1', 'Update', 'Giacca', '10'] })
    const parsed = (await detectAmazonTemplate(buffer, { strict: true }))!
    expect(parsed.meta.grammar).toBe('legacy')
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(fields(result.rows)).toMatchObject({ productType: 'COAT', item_name: 'Giacca' })
    // The other markets' offers belong to those markets' files.
    expect(result.exclusions.find(e => e.field === offers[0])?.message).toContain('Amazon DE')
    clean(parsed, result)
  })
  it('translates classic ids, numbered slots and units to current attribute paths', () => {
    expect(legacyAttributePath('bullet_point3')).toBe('bullet_point#3.value')
    expect(legacyAttributePath('other_image_url_ps02')).toBe('image_locator_ps02#1.media_location')
    expect(legacyAttributePath('package_height_unit_of_measure')).toBe('item_package_dimensions#1.height#1.unit')
    expect(legacyAttributePath(h('item_name'))).toBeNull()
  })
})

describe('CFI — formulas and Excel errors (rule 5)', () => {
  it('imports the value Excel saved for a formula, flags it, and refuses an error cell alone', async () => {
    const parsed = await template([SKU, ACTION, TYPE, h('list_price', 1, 'value_with_tax'), h('model_name', 1, 'value', 'it_IT')],
      [['F1', 'partial_update', 'COAT', { v: '109.9', f: 'B7*1.22' }, { v: '#N/A', e: true }]])
    expect(parsed.meta.formulaCells).toEqual({ 7: [h('list_price', 1, 'value_with_tax')] })
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(fields(result.rows).list_price).toBe(109.9)
    expect(result.warnings.join(' ')).toContain('computed by Excel formulas')
    expect(result.ledger.find(e => e.header === h('list_price', 1, 'value_with_tax'))?.reason).toContain('formula')
    expect(result.issues.map(i => i.message)).toEqual([expect.stringContaining('#N/A')])
    clean(parsed, result)
  })
})

describe('CFI — languages per column, never the whole file (rule 6)', () => {
  const keys = [SKU, ACTION, TYPE, h('item_name', 1, 'value', 'it_IT'), h('item_name', 1, 'value', 'en_GB'), h('color', 1, 'value', 'en_GB')]
  it('a text column in a language the market does not carry is refused alone; its choices still import', async () => {
    const parsed = await template(keys, [['L1', 'partial_update', 'COAT', 'Giacca', 'Jacket', 'Grigio']])
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(fields(result.rows)).toMatchObject({ item_name: 'Giacca', color: 'grey' })
    expect(result.issues.map(i => i.field)).toEqual([h('item_name', 1, 'value', 'en_GB')])
    clean(parsed, result)
  })
  it('stored in its own language when the market carries it', async () => {
    const parsed = await template(keys, [['L1', 'partial_update', 'COAT', 'Giacca', 'Jacket', 'Grigio']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, languages: ['it', 'en'] })
    expect(fields(result.rows)).toMatchObject({ 'item_name@it': 'Giacca', 'item_name@en': 'Jacket' })
    expect(result.issues).toEqual([])
  })
  it('a file in a language the market lacks is NOT refused whole', async () => {
    const parsed = await template([SKU, ACTION, TYPE, h('item_name', 1, 'value', 'en_GB'), h('color', 1, 'value', 'en_GB')], [['E1', 'partial_update', 'COAT', 'Jacket', 'Grigio']], { settings: { contentLanguageTag: 'en_GB' } })
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(fields(result.rows).color).toBe('grey')
    expect(result.warnings.join(' ')).toContain('does not carry')
  })
})

describe('CFI — Amazon\'s example row (rule 7)', () => {
  it('skips the row above the template\'s first data row, with a reason, and accounts for it', async () => {
    const parsed = await template([SKU, ACTION, TYPE, h('brand', 1, 'value', 'it_IT')], [['REAL', 'partial_update', 'COAT', 'XAVIA']], { row6: ['ABC123', '(Standard) Crea o sostituisci', 'ACCESSORIO', 'Sony'] })
    expect(parsed.rows.map(r => r[SKU])).toEqual(['REAL'])
    expect(parsed.meta.skippedRows?.[0]).toMatchObject({ row: 6, cells: { [SKU]: 'ABC123' } })
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(result.exclusions[0].message).toContain("first data row")
    expect(result.ledger.filter(e => e.outcome === 'skipped-row')).toHaveLength(4)
    clean(parsed, result)
  })
})

describe('CFI — identity and new products (rule 8, D4)', () => {
  const keys = [SKU, ACTION, TYPE, h('item_name', 1, 'value', 'it_IT'), 'child_parent_sku_relationship[marketplace_id=' + IT + ']#1.parent_sku']
  it('a seller-SKU match imports onto the Nexus SKU and remembers the channel SKU', async () => {
    const parsed = await template(keys, [['AMZ-CHILD', 'partial_update', 'COAT', 'Giacca', '']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, identities: new Map([['AMZ-CHILD', { sku: 'NEXUS-CHILD', via: 'seller-sku' }]]) })
    expect(result.rows.every(r => r.sku === 'NEXUS-CHILD' && r.fileSku === 'AMZ-CHILD')).toBe(true)
    expect(result.rows).toContainEqual(expect.objectContaining({ entity: 'Listings', field: 'sellerSku', value: 'AMZ-CHILD' }))
    clean(parsed, result)
  })
  it('a parent proposal is returned and its row waits for confirmation', async () => {
    const parsed = await template(keys, [['MOSS-JACKET', 'partial_update', 'COAT', 'Giacca', '']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, proposals: new Map([['MOSS-JACKET', { proposedSku: 'IT-MOSS-JACKET', reason: '2 of its 2 children in this file belong to IT-MOSS-JACKET in Nexus' }]]) })
    expect(result.links).toEqual([{ fileSku: 'MOSS-JACKET', proposedSku: 'IT-MOSS-JACKET', reason: expect.stringContaining('children') }])
    expect(result.rows).toEqual([])
    expect(result.issues[0].message).toContain('IT-MOSS-JACKET')
    clean(parsed, result)
  })
  it('a SKU twice in one file is refused, naming both rows', async () => {
    const parsed = await template(keys, [['TWICE', 'partial_update', 'COAT', 'A', ''], ['TWICE', 'partial_update', 'COAT', 'B', '']])
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(result.rows).toEqual([])
    expect(result.issues[0].message).toContain('rows 7 and 8')
    clean(parsed, result)
  })
  it('a NEW product gets a Shared name only from a primary-language file', async () => {
    const it = await template(keys, [['NEW-IT', 'full_update', 'COAT', 'Giacca nuova', 'PARENT']])
    const created = mapAmazonWorkbook(it, specs, { ...base, existingProducts: new Set(['PARENT']), mode: 'upsert', familyCode: 'jackets' })
    expect(created.rows.filter(r => r.entity === 'Products').map(r => [r.field, r.locale, r.value])).toEqual([['family', '', 'jackets'], ['name', '', 'Giacca nuova'], ['name', 'it', 'Giacca nuova'], ['parentSku', '', 'PARENT']])
    const de = await template([SKU, ACTION, TYPE, `item_name[marketplace_id=A1PA6795UKMFR9][language_tag=de_DE]#1.value`], [['NEW-DE', 'full_update', 'COAT', 'Neue Jacke']], { settings: { primaryMarketplaceId: 'amzn1.mp.o.A1PA6795UKMFR9', contentLanguageTag: 'de_DE' } })
    const refused = mapAmazonWorkbook(de, specs, { ...base, marketplace: 'DE', language: 'de', existingProducts: new Set(), mode: 'upsert', familyCode: 'jackets' })
    expect(refused.rows).toEqual([])
    expect(refused.issues[0].message).toContain('Italian name')
    clean(de, refused)
  })
})

describe('CFI — prices (rule 9, Q2 a)', () => {
  const offer = (leaf: string) => `purchasable_offer[marketplace_id=${IT}][audience=ALL]#1.${leaf}`
  it('selling price and sale window become price/sale rows; RRP a listing value; rules and stock stay out', async () => {
    const parsed = await template([SKU, ACTION, TYPE, offer('our_price#1.schedule#1.value_with_tax'), offer('discounted_price#1.schedule#1.value_with_tax'), offer('discounted_price#1.schedule#1.start_at'), offer('discounted_price#1.schedule#1.end_at'),
      offer('minimum_seller_allowed_price#1.schedule#1.value_with_tax'), h('list_price', 1, 'value_with_tax'), 'fulfillment_availability#1.quantity'],
      [['P1', 'partial_update', 'COAT', '99', '79.9', '46023', '2026-10-31', '60', '129', '7']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, currency: 'EUR' })
    expect(fields(result.rows)).toMatchObject({ price: 99, sale: { value: 79.9, start: '2026-01-01', end: '2026-10-31' }, list_price: 129 })
    // B3 (2026-10-05) — an offer setting is named as one, not as an automated pricing rule.
    expect(result.exclusions.map(e => e.message).join(' ')).toMatch(/Minimum seller price: an Amazon offer setting, not read from a file \(file value 60\)/)
    expect(result.exclusions.map(e => e.message).join(' ')).toMatch(/Stock is not imported.*file value 7/)
    clean(parsed, result)
  })
  it('a sale value without both dates is refused, not guessed', async () => {
    const parsed = await template([SKU, ACTION, TYPE, offer('discounted_price#1.schedule#1.value_with_tax')], [['P2', 'partial_update', 'COAT', '79.9']])
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(result.rows.some(r => r.field === 'sale')).toBe(false)
    expect(result.issues[0].message).toContain('start date and end date')
  })
})

describe('CFI — read-only, not-in-type and origin (rules 10–12)', () => {
  it('imports a read-only field as the channel\'s own value, explains attributes the product type lacks, and marks every row', async () => {
    const pants = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'PANTS', schemaDefinition: { properties: { item_name: attr({ value: { type: 'string' } }), brand: attr({ value: { type: 'string' } }) } } })
    pants.fields.find(f => f.key === 'brand')!.editable = false
    const parsed = await template([SKU, ACTION, TYPE, h('brand', 1, 'value', 'it_IT'), h('batteries_required')], [['PT1', 'partial_update', 'PANTS', 'XAVIA', 'false']])
    const result = mapAmazonWorkbook(parsed, new Map([['PANTS', pants]]), base)
    expect(fields(result.rows).brand).toBe('XAVIA')
    expect(result.exclusions.find(e => e.field === h('batteries_required'))?.message).toContain('Not an attribute of Amazon PANTS')
    expect(result.issues).toEqual([])
    expect(result.rows.every(r => r.origin === 'channel-file')).toBe(true)
    clean(parsed, result)
  })
  it('the drawer scope excludes SKUs outside its product and rows carry the listing version', async () => {
    const parsed = await template([SKU, ACTION, TYPE, h('item_name', 1, 'value', 'it_IT')], [['IN', 'partial_update', 'COAT', 'A'], ['OUT', 'partial_update', 'COAT', 'B']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, scopeSkus: new Set(['IN']), withVersions: true, listings: new Map([['IN', { version: 9, externalListingId: null, checkedAt: null }]]) })
    expect(result.rows.every(r => r.sku === 'IN' && r.version === 9)).toBe(true)
    const outside = result.exclusions.filter(e => e.message.includes('Outside this product'))
    expect(outside.length).toBe(4)
    expect(outside.every(e => e.sku === 'OUT')).toBe(true)
    clean(parsed, result)
  })
})

describe('CFI — the ledger proves every populated cell was decided once (CFI-9)', () => {
  it('flags an unaccounted cell, a duplicate entry and a row entry with no row', async () => {
    const parsed = await template([SKU, ACTION, TYPE, h('item_name', 1, 'value', 'it_IT')], [['LG', 'partial_update', 'COAT', 'Giacca']])
    const result = mapAmazonWorkbook(parsed, specs, base)
    clean(parsed, result)
    const [first, ...rest] = result.ledger
    expect(checkLedger(parsed, { rows: result.rows, ledger: rest }).unaccounted).toEqual([{ row: first.row, header: first.header }])
    expect(checkLedger(parsed, { rows: result.rows, ledger: [...result.ledger, first] }).duplicated).toHaveLength(1)
    const itemName = result.ledger.find(e => e.field === 'item_name')!
    expect(checkLedger(parsed, { rows: result.rows.filter(r => r.field !== 'item_name'), ledger: result.ledger }).danglingRows).toEqual([{ row: itemName.row, header: itemName.header }])
  })
})

describe('CFI review fixes (2026-09-25)', () => {
  const keys = [SKU, ACTION, TYPE, h('item_name', 1, 'value', 'it_IT'), 'amzn1.volt.ca.product_id_type', 'amzn1.volt.ca.product_id_value']
  const cand = (over: Partial<AmazonListingCandidate>): AmazonListingCandidate => ({ sku: 'P', aliasKey: '', accountId: 'amazon-a', sellerSkus: [], asin: 'B0ASIN0001', ...over })
  it('1 — identity: only THIS account\'s listings, the matched alias travels, several listings are refused by name', () => {
    const other = matchAmazonIdentities({ fileSkus: ['P-FBA'], exactSkus: new Set(), asinOf: new Map(), accountId: 'amazon-a', candidates: [cand({ accountId: 'amazon-b', sellerSkus: ['P-FBA'] })] })
    expect(other.identities.size).toBe(0)
    const alias = matchAmazonIdentities({ fileSkus: ['P-FBA'], exactSkus: new Set(), asinOf: new Map([['P-FBA', 'B0ASIN0001']]), accountId: 'amazon-a',
      candidates: [cand({}), cand({ aliasKey: 'alias-fba-1', sellerSkus: ['P-FBA'] })] })
    // The seller-SKU identity decides before the ASIN, which both listings share.
    expect(alias.identities.get('P-FBA')).toEqual({ sku: 'P', via: 'seller-sku', aliasKey: 'alias-fba-1' })
    const two = matchAmazonIdentities({ fileSkus: ['X'], exactSkus: new Set(), asinOf: new Map([['X', 'B0ASIN0001']]), accountId: 'amazon-a', candidates: [cand({}), cand({ aliasKey: 'al-000002' })] })
    expect(two.problems.get('X')).toMatch(/several Nexus listings \(P \(primary listing\); P \(listing alias 000002\)\)/)
  })
  it('1 — rows target the matched alias listing; a confirmed delete ends THAT listing and names the file SKU', async () => {
    const parsed = await template(keys, [['P-FBA', 'delete', 'COAT', '', 'ASIN', 'B0ASIN0001']])
    const destination = { ...base, identities: new Map([['P-FBA', { sku: 'P', via: 'seller-sku' as const, aliasKey: 'alias-fba-1' }]]),
      listings: new Map([['P', { version: 1, externalListingId: 'B0ASIN0001', checkedAt: null }], ['P\u0000alias-fba-1', { version: 7, externalListingId: 'B0ASIN0001', checkedAt: null }]]), confirmDeletes: true, withVersions: true }
    const result = mapAmazonWorkbook(parsed, specs, destination)
    expect(result.rows).toEqual([expect.objectContaining({ field: 'presence', sku: 'P', aliasKey: 'alias-fba-1', fileSku: 'P-FBA', version: 7 })])
    clean(parsed, result)
    const same = await template(keys, [['P', 'delete', 'COAT', '', '', '']])
    expect(mapAmazonWorkbook(same, specs, { ...destination, identities: new Map() }).rows[0]).toMatchObject({ aliasKey: '', fileSku: 'P' })
  })
  it('1 — a delete matched only by ASIN is another offer: Nexus\'s listing is not ended', async () => {
    const parsed = await template(keys, [['OTHER-OFFER', 'delete', 'COAT', '', 'ASIN', 'B0ASIN0001']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, identities: new Map([['OTHER-OFFER', { sku: 'P', via: 'asin' as const }]]), listings: new Map([['P', { version: 1, externalListingId: 'B0ASIN0001', checkedAt: null }]]), confirmDeletes: true })
    expect(result.rows).toEqual([])
    expect(result.exclusions[0].message).toContain('different offer on the same ASIN')
    clean(parsed, result)
  })
  it('2 — two file SKUs on one Nexus listing: every row of both refused, no rows, one clear sentence', async () => {
    const parsed = await template(keys, [['85-A8DQ-UNYF', 'partial_update', 'COAT', 'Giacca', 'ASIN', 'B0FXC60C5F'], ['MISANO-S', 'partial_update', 'COAT', 'Giacca', 'ASIN', 'B0FXC60C5F']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, identities: new Map([['85-A8DQ-UNYF', { sku: 'MISANO-S', via: 'asin' as const }], ['MISANO-S', { sku: 'MISANO-S', via: 'sku' as const }]]) })
    expect(result.rows).toEqual([])
    expect(result.issues.map(i => i.message)).toEqual(Array(2).fill(expect.stringContaining('two seller SKUs (85-A8DQ-UNYF, MISANO-S; ASIN B0FXC60C5F)')))
    expect(result.ledger.every(e => e.outcome === 'refused')).toBe(true)
    clean(parsed, result)
  })
  it('3 — confirmDeletes as a list confirms only the rows it names (file SKU or Nexus SKU)', async () => {
    const parsed = await template(keys, [['D1', 'delete', 'COAT', '', '', ''], ['D2', 'delete', 'COAT', '', '', ''], ['F3', 'delete', 'COAT', '', '', '']])
    const listings = new Map(['D1', 'D2', 'N3'].map(k => [k, { version: 1, externalListingId: null, checkedAt: null }]))
    const identities = new Map([['F3', { sku: 'N3', via: 'seller-sku' as const }]])
    // A confirmation names the FILE's SKU only: ticking the Nexus SKU N3 does not confirm file row F3.
    const result = mapAmazonWorkbook(parsed, specs, { ...base, listings, identities, confirmDeletes: ['D1', 'N3'] })
    expect(result.rows.map(r => r.sku)).toEqual(['D1'])
    expect(result.issues.map(i => [i.sku, i.field])).toEqual([['D2', 'presence'], ['N3', 'presence']])
    expect(result.issues[1]).toMatchObject({ fileSku: 'F3', channel: 'AMAZON', marketplace: 'IT', accountId: 'amazon-a' })
    expect(mapAmazonWorkbook(parsed, specs, { ...base, listings, identities, confirmDeletes: ['F3'] }).rows.map(r => r.sku)).toEqual(['N3'])
  })
  it('3 — one tick on "P" never ends the alias listing "P-FBA" of the same product', async () => {
    const parsed = await template(keys, [['P', 'delete', 'COAT', '', '', ''], ['P-FBA', 'delete', 'COAT', '', '', '']])
    const listings = new Map([['P', { version: 1, externalListingId: null, checkedAt: null }], ['P\u0000alias-fba-1', { version: 2, externalListingId: null, checkedAt: null }]])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, listings, identities: new Map([['P-FBA', { sku: 'P', via: 'seller-sku' as const, aliasKey: 'alias-fba-1' }]]), confirmDeletes: ['P'] })
    expect(result.rows.map(r => [r.sku, r.aliasKey])).toEqual([['P', '']])
    expect(result.issues).toEqual([expect.objectContaining({ field: 'presence', fileSku: 'P-FBA', aliasKey: 'alias-fba-1' })])
  })
  it('b — an ASIN-only match imports the content but does not record the other offer\'s SKU as this listing\'s', async () => {
    const parsed = await template(keys, [['OTHER-OFFER', 'partial_update', 'COAT', 'Giacca', 'ASIN', 'B0ASIN0001']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, identities: new Map([['OTHER-OFFER', { sku: 'P', via: 'asin' as const }]]) })
    expect(fields(result.rows)).toMatchObject({ item_name: 'Giacca', merchant_suggested_asin: 'B0ASIN0001' })
    expect(result.rows.some(r => r.field === 'sellerSku')).toBe(false)
    expect(result.warnings.join(' ')).toContain('Matched by ASIN; the file\'s seller SKU OTHER-OFFER is another offer')
    clean(parsed, result)
  })
  it('c — the Shared name uses the title\'s EFFECTIVE language (untagged-by-locale text on a German market is German)', async () => {
    const DE = 'A1PA6795UKMFR9'
    const parsed = await template([SKU, ACTION, TYPE, `item_name[marketplace_id=${DE}][language_tag=de_DE]#1.value`], [['NEW-X', 'full_update', 'COAT', 'Deutsche Jacke']],
      { settings: { primaryMarketplaceId: `amzn1.mp.o.${DE}`, contentLanguageTag: 'it_IT' } })
    const result = mapAmazonWorkbook(parsed, specs, { ...base, marketplace: 'DE', language: 'de', existingProducts: new Set(), mode: 'upsert', familyCode: 'jackets' })
    expect(result.rows.filter(r => r.entity === 'Products')).toEqual([])
    expect(result.issues.map(i => i.message).join(' ')).toContain('needs a verified name')
  })
  it('4 — untagged (old flat-file) text is in the file\'s language: refused per column, or stored in that language', async () => {
    const d1 = (lang: string) => `settings=attributeRow=3&contentLanguageTag=${lang}&dataRow=4&primaryMarketplaceId=amzn1.mp.o.${IT}`
    const keys3 = ['feed_product_type', 'item_sku', 'update_delete', 'item_name', 'color_name', ...Array.from({ length: 20 }, (_, i) => `legacy_filler${i}`)]
    const parsed = (await detectAmazonTemplate(await workbook({ 1: ['TemplateType=fptcustom', 'Version=1', 'TemplateSignature=Q09BVA==', d1('en_GB')], 3: keys3, 4: ['coat', 'EN-1', 'PartialUpdate', 'Jacket', 'Grigio'] }), { strict: true }))!
    const refused = mapAmazonWorkbook(parsed, specs, base)
    expect(refused.rows.some(r => r.field === 'item_name')).toBe(false)
    expect(refused.issues.map(i => i.field)).toEqual(['item_name'])
    expect(fields(refused.rows).color).toBe('grey')
    const stored = mapAmazonWorkbook(parsed, specs, { ...base, languages: ['it', 'en'] })
    expect(fields(stored.rows)['item_name@en']).toBe('Jacket')
    clean(parsed, refused)
  })
  it('5 — a new product\'s Shared name comes from the primary-language title, never another language\'s row', async () => {
    const parsed = await template([SKU, ACTION, TYPE, h('item_name', 1, 'value', 'en_GB'), h('item_name', 1, 'value', 'it_IT')], [['NEW', 'full_update', 'COAT', 'English jacket', 'Giacca italiana']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, languages: ['it', 'en'], existingProducts: new Set(), mode: 'upsert', familyCode: 'jackets' })
    expect(result.rows.filter(r => r.entity === 'Products' && r.field === 'name').map(r => r.value)).toEqual(['Giacca italiana', 'Giacca italiana'])
  })
  it('6 — schemas load under the template\'s own translation of a localized product type', async () => {
    const parsed = await template(keys, [['T1', 'partial_update', 'Cappotto', 'Giacca', '', '']], { aliases: [{ attribute: TYPE, aliases: { Cappotto: 'COAT' } }] })
    expect(parsed.meta.productTypes).toEqual(['CAPPOTTO'])
    expect(amazonProductTypes(parsed)).toContain('COAT')
    expect(fields(mapAmazonWorkbook(parsed, specs, base).rows).productType).toBe('COAT')
  })
})

// ── Amazon file import (PR 2, 2026-10-05): honest offer words, document and product ID types, list columns ──────────
/** A schema cached before 2026-09-27 has the selectors but not their `key__selector` leaves (the golden fixtures' shape). */
const withoutLeaves = <T extends { fields: { key: string }[] }>(spec: T): T => ({ ...spec, fields: spec.fields.filter(f => !/^(compliance_media|externally_assigned_product_identifier)__/.test(f.key)) })
describe('Amazon file import — offer and fulfilment columns stay out, in honest words (B3)', () => {
  const offer = (leaf: string) => `purchasable_offer[marketplace_id=${IT}][audience=ALL]#1.${leaf}`
  const keys = [SKU, ACTION, TYPE, 'fulfillment_availability#1.lead_time_to_ship_max_days', 'fulfillment_availability#1.restock_date', 'fulfillment_availability#1.is_inventory_available',
    offer('minimum_seller_allowed_price#1.schedule#1.value_with_tax'), offer('maximum_seller_allowed_price#1.schedule#1.value_with_tax'), offer('start_at.value'), offer('end_at.value'),
    offer('automated_pricing_merchandising_rule_plan#1.merchandising_rule.rule_id'), 'fulfillment_availability#1.quantity', 'fulfillment_availability#1.fulfillment_channel_code']
  it('names each offer setting and where it is changed; quantity and the fulfilment method stay managed; nothing becomes a row', async () => {
    const parsed = await template(keys, [['O1', 'partial_update', 'COAT', '3', '2026-11-01', 'No', '60', '150', '2026-10-01', '2026-12-31', 'rule-1', '7', 'DEFAULT']])
    const result = mapAmazonWorkbook(parsed, specs, base)
    const reason = (header: string) => result.exclusions.find(e => e.field === header)?.message ?? ''
    for (const [header, label] of [[keys[3], 'Handling time'], [keys[4], 'Restock date'], [keys[5], 'Always available'], [keys[6], 'Minimum seller price'], [keys[7], 'Maximum seller price'],
      [keys[8], 'Offer start date'], [keys[9], 'Offer end date'], [keys[10], 'Automate Pricing rule']]) {
      expect(reason(header)).toContain(`${label}: an Amazon offer setting, not read from a file`)
      expect(reason(header)).toContain("Change it in the sheet's Amazon columns; it is sent when you publish.")
    }
    expect(reason(keys[3])).toContain('(file value 3)')
    // FBA quantity and the fulfilment method are untouchable: still the stock sentence, never an offer setting.
    expect(reason(keys[11])).toMatch(/^Modello: Stock is not imported/)
    expect(reason(keys[12])).toMatch(/^Modello: Stock is not imported/)
    expect(result.rows.map(r => r.field)).toEqual(['productType'])
    expect(result.issues).toEqual([])
    clean(parsed, result)
  })
  it('the mapping version records the same decision as before (managed, same target), only the words change', async () => {
    const parsed = await template(keys, [['O1', 'partial_update', 'COAT', '3', '', '', '', '', '', '', '', '', '']])
    const rows = buildAmazonDraftFields(parsed, specs, { marketplace: 'IT', primaryLanguage: 'it', marketLanguages: ['it'], productTypes: ['COAT'] })
    const row = (key: string) => rows.find(r => r.columnKey === key)!
    expect(row(keys[3])).toMatchObject({ state: 'managed', targetKind: 'quantity', reason: expect.stringContaining('Handling time: an Amazon offer setting') })
    expect(row(keys[6])).toMatchObject({ state: 'managed', targetKind: 'price', reason: expect.stringContaining('Minimum seller price: an Amazon offer setting') })
    expect(row(keys[11])).toMatchObject({ state: 'managed', targetKind: 'quantity', reason: expect.stringContaining('Stock is not imported') })
  })
})

describe('Amazon file import — compliance documents keep their type and language (B5)', () => {
  const doc = (type: string) => `compliance_media[marketplace_id=${IT}][content_language=it_IT][content_type=${type}]#1.source_location`
  const media = { type: 'array', maxItems: 1, selectors: ['marketplace_id', 'content_type', 'content_language'], items: { type: 'object', properties: {
    marketplace_id: { type: 'string' }, content_type: { type: 'string', enum: ['user_manual', 'safety_information'] }, content_language: { type: 'string', enum: ['it_IT', 'de_DE'] }, source_location: { type: 'string' } } } }
  const withLeaves = new Map([['COAT', amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: { item_name: attr({ value: { type: 'string' } }), compliance_media: media } } })]])
  const keys = [SKU, ACTION, TYPE, doc('user_manual'), doc('safety_information')]
  it('stores the document with the type and language its column names', async () => {
    expect(withLeaves.get('COAT')!.fields.map(f => [f.key, f.shape])).toEqual(expect.arrayContaining([['compliance_media', 'scalar'], ['compliance_media__content_type', 'scalar'], ['compliance_media__content_language', 'scalar']]))
    const parsed = await template(keys, [['D1', 'partial_update', 'COAT', '', 'https://example.test/safety.pdf']])
    const result = mapAmazonWorkbook(parsed, withLeaves, base)
    expect(fields(result.rows)).toMatchObject({ compliance_media: 'https://example.test/safety.pdf', compliance_media__content_type: 'safety_information', compliance_media__content_language: 'it_IT' })
    expect(result.issues).toEqual([])
    clean(parsed, result)
  })
  it('two documents on one row are refused, naming both types', async () => {
    const parsed = await template(keys, [['D2', 'partial_update', 'COAT', 'https://example.test/manual.pdf', 'https://example.test/safety.pdf']])
    const result = mapAmazonWorkbook(parsed, withLeaves, base)
    expect(result.rows.some(r => r.field.startsWith('compliance_media'))).toBe(false)
    expect(result.issues.map(i => i.message)).toEqual(['This row fills 2 compliance_media documents (user manual and safety information). Nexus keeps one document per listing: keep one of them in the file.'])
    expect(result.ledger.filter(e => e.header.startsWith('compliance_media')).map(e => e.outcome)).toEqual(['refused', 'refused'])
    clean(parsed, result)
  })
  it('a full-update row with no document clears the document with its type and language', async () => {
    const parsed = await template(keys, [['D3', 'full_update', 'COAT', '', '']])
    const result = mapAmazonWorkbook(parsed, withLeaves, base)
    expect(result.rows.filter(r => r.action === 'CLEAR').map(r => [r.field, r.clearIfPresent]).sort()).toEqual([['compliance_media', true], ['compliance_media__content_language', true], ['compliance_media__content_type', true]])
    clean(parsed, result)
  })
  it('a cached schema without the selector leaves keeps the document alone, as before', async () => {
    // A schema cached before the selector leaves were authored (2026-09-27): the golden fixtures' own shape.
    const without = new Map([['COAT', withoutLeaves(amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: { compliance_media: media } } }))]])
    expect(without.get('COAT')!.fields.some(f => f.key === 'compliance_media__content_type')).toBe(false)
    const parsed = await template(keys, [['D4', 'partial_update', 'COAT', 'https://example.test/manual.pdf', '']])
    const result = mapAmazonWorkbook(parsed, without, base)
    expect(result.rows.filter(r => r.entity === 'Overrides').map(r => [r.field, r.value])).toEqual([['compliance_media', 'https://example.test/manual.pdf']])
    clean(parsed, result)
  })
})

describe('Amazon file import — the product ID keeps its type, checked against the schema (B7)', () => {
  const ID_TYPE = 'amzn1.volt.ca.product_id_type', ID_VALUE = 'amzn1.volt.ca.product_id_value'
  const identifier = { type: 'array', maxItems: 1, selectors: ['marketplace_id', 'type'], items: { type: 'object', properties: {
    marketplace_id: { type: 'string' }, type: { type: 'string', enum: ['ean', 'gtin', 'minsan_code', 'upc'], enumNames: ['EAN', 'GTIN', 'MINSAN', 'UPC'] }, value: { type: 'string' } } } }
  const spec = (leaf: boolean) => {
    const built = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { properties: {
      item_name: attr({ value: { type: 'string' } }), merchant_suggested_asin: attr({ value: { type: 'string' } }), supplier_declared_has_product_identifier_exemption: attr({ value: { type: 'boolean' } }),
      externally_assigned_product_identifier: identifier } } })
    expect(built.fields.find(f => f.key === 'externally_assigned_product_identifier__type')?.options).toEqual(['ean', 'gtin', 'minsan_code', 'upc'])
    return new Map([['COAT', leaf ? built : withoutLeaves(built)]])
  }
  const keys = [SKU, ACTION, TYPE, ID_TYPE, ID_VALUE]
  it('stores the type beside the value; MINSAN is accepted because this schema offers it (label or the template\'s own code)', async () => {
    const parsed = await template(keys, [['E1', 'partial_update', 'COAT', 'EAN', '8000000000001'], ['M1', 'partial_update', 'COAT', 'MINSAN', '012345678'], ['M2', 'partial_update', 'COAT', 'Codice MINSAN', '012345679']],
      { aliases: [{ attribute: ID_TYPE, aliases: { 'Codice MINSAN': 'minsan_code', EAN: 'ean' } }] })
    const result = mapAmazonWorkbook(parsed, spec(true), base)
    expect(fields(result.rows, 'E1')).toMatchObject({ externally_assigned_product_identifier: '8000000000001', externally_assigned_product_identifier__type: 'ean' })
    expect(fields(result.rows, 'M1')).toMatchObject({ externally_assigned_product_identifier: '012345678', externally_assigned_product_identifier__type: 'minsan_code' })
    expect(fields(result.rows, 'M2')).toMatchObject({ externally_assigned_product_identifier: '012345679', externally_assigned_product_identifier__type: 'minsan_code' })
    expect(result.ledger.filter(e => e.header === ID_TYPE).map(e => [e.outcome, e.field])).toEqual(Array(3).fill(['row', 'externally_assigned_product_identifier__type']))
    expect(result.issues).toEqual([])
    clean(parsed, result)
  })
  it('a type the schema does not offer is refused with its list, never guessed; ASIN and the GTIN exemption read as before', async () => {
    const parsed = await template(keys, [['I1', 'partial_update', 'COAT', 'ISBN', '9780000000002'], ['A1', 'partial_update', 'COAT', 'ASIN', 'B0TESTASIN'], ['X1', 'partial_update', 'COAT', 'exempt', '']])
    const result = mapAmazonWorkbook(parsed, spec(true), base)
    expect(result.rows.some(r => r.sku === 'I1' && r.field.startsWith('externally_assigned'))).toBe(false)
    expect(result.issues.map(i => [i.sku, i.message])).toEqual([['I1', 'Modello: The product ID type "ISBN" is not one Amazon IT accepts for COAT (EAN, GTIN, MINSAN, UPC). Correct the type in the file.']])
    expect(result.ledger.filter(e => e.sku === 'I1' && [ID_TYPE, ID_VALUE].includes(e.header)).map(e => e.outcome)).toEqual(['refused', 'refused'])
    expect(fields(result.rows, 'A1')).toMatchObject({ merchant_suggested_asin: 'B0TESTASIN' })
    expect(fields(result.rows, 'X1')).toMatchObject({ supplier_declared_has_product_identifier_exemption: true })
    expect(result.rows.some(r => (r.sku === 'A1' || r.sku === 'X1') && r.field === 'externally_assigned_product_identifier__type')).toBe(false)
    clean(parsed, result)
  })
  it('a cached schema without the type leaf still checks the type against its own list and stores the value alone', async () => {
    const parsed = await template(keys, [['U1', 'partial_update', 'COAT', 'UPC', '012345678905'], ['J1', 'partial_update', 'COAT', 'JAN', '4900000000001']])
    const result = mapAmazonWorkbook(parsed, spec(false), base)
    expect(result.rows.filter(r => r.sku === 'U1' && r.entity === 'Overrides').map(r => [r.field, r.value])).toEqual([['externally_assigned_product_identifier', '012345678905']])
    expect(result.issues.map(i => i.sku)).toEqual(['J1'])
    clean(parsed, result)
  })
})

describe('Amazon file import — a list row says how many template columns it had (B4)', () => {
  it('bullet_point with three columns, two filled: the row carries listSlots 3; a scalar carries none', async () => {
    const parsed = await template([SKU, ACTION, TYPE, h('item_name', 1, 'value', 'it_IT'), h('bullet_point', 1, 'value', 'it_IT'), h('bullet_point', 2, 'value', 'it_IT'), h('bullet_point', 3, 'value', 'it_IT')],
      [['B1', 'partial_update', 'COAT', 'Giacca', 'Uno', '', 'Tre']])
    const result = mapAmazonWorkbook(parsed, specs, base)
    expect(result.rows.find(r => r.field === 'bullet_point')).toMatchObject({ value: ['Uno', 'Tre'], listSlots: 3 })
    expect(result.rows.find(r => r.field === 'item_name')).not.toHaveProperty('listSlots')
    clean(parsed, result)
  })
})
