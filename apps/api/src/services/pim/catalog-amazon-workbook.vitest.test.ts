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
    expect(result.exclusions.map(e => e.message).join(' ')).toMatch(/Automated pricing rules.*file value 60/)
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
    const parsed = await template(keys, [['85-A8DQ-UNYF', 'partial_update', 'COAT', 'Giacca', 'ASIN', 'B0BSXLDDSL'], ['MISANO-S', 'partial_update', 'COAT', 'Giacca', 'ASIN', 'B0BSXLDDSL']])
    const result = mapAmazonWorkbook(parsed, specs, { ...base, identities: new Map([['85-A8DQ-UNYF', { sku: 'MISANO-S', via: 'asin' as const }], ['MISANO-S', { sku: 'MISANO-S', via: 'sku' as const }]]) })
    expect(result.rows).toEqual([])
    expect(result.issues.map(i => i.message)).toEqual(Array(2).fill(expect.stringContaining('two seller SKUs (85-A8DQ-UNYF, MISANO-S; ASIN B0BSXLDDSL)')))
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
