/**
 * CHMAP M2 — an Amazon template's mapping version: the rules' draft, the reader following it, and the Owner's
 * decisions winning over the rules. Fixtures are built with JSZip (never the Owner's files; the repo is public).
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { activationBlocker, amazonChannelKey, diffMappingFields, mappingCounts, type MappingFieldRow } from '@nexus/shared/channel-mapping'
import { detectAmazonTemplate } from '../amazon/template-workbook.js'
import { mapAmazonWorkbook, type AmazonDestination } from '../pim/catalog-amazon-workbook.js'
import { amazonSpecFromDefinition } from '../pim/channel-specs/amazon.js'
import { buildAmazonDraftFields } from './amazon-draft.js'
import { readerMapping } from './decisions.js'
import { amazonFormOf } from './form.js'
import { carryOwnerDecisions } from './store.js'

const IT = 'APJ6JRA9NG5V4'
const col = (n: number): string => n > 26 ? col(Math.floor((n - 1) / 26)) + col(((n - 1) % 26) + 1) : String.fromCharCode(64 + n)
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
async function workbook(rows: Record<number, string[]>): Promise<Buffer> {
  const zip = new JSZip()
  const body = Object.entries(rows).map(([r, cells]) => `<row r="${r}">${cells.map((c, i) => c ? `<c r="${col(i + 1)}${r}" t="inlineStr"><is><t>${esc(c)}</t></is></c>` : '').join('')}</row>`).join('')
  zip.file('xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Modello" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}
const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64')
const settings = (extra: Record<string, string> = {}) => 'settings=' + Object.entries({ feedType: '256', primaryMarketplaceId: `amzn1.mp.o.${IT}`, contentLanguageTag: 'it_IT', attributeRow: '5', dataRow: '7',
  templateIdentifier: 'tmpl-it-1', Version: '2026.0713', TemplateSignature: b64('COAT,PANTS'), ...extra }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
const h = (key: string, slot = 1, leaf = 'value', lang?: string) => `${key}[marketplace_id=${IT}]${lang ? `[language_tag=${lang}]` : ''}#${slot}.${leaf}`
const SKU = 'contribution_sku#1.value', TYPE = 'product_type#1.value', ACTION = '::record_action'
async function template(keys: string[], data: string[][], extra: Record<string, string> = {}) {
  const filler = Array.from({ length: 20 }, (_, i) => `filler_${i}#1.value`)
  const rows: Record<number, string[]> = { 1: [settings(extra)], 5: [...keys, ...filler] }
  data.forEach((cells, i) => { rows[7 + i] = cells })
  return (await detectAmazonTemplate(await workbook(rows), { strict: true }))!
}
const attr = (properties: object, max = 1) => ({ type: 'array', maxItems: max, items: { type: 'object', properties } })
const coat = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'COAT', schemaDefinition: { required: ['brand', 'item_name'], properties: {
  item_name: attr({ value: { type: 'string' } }), brand: attr({ value: { type: 'string' } }), model_name: attr({ value: { type: 'string' } }),
  team_name: attr({ value: { type: 'string' } }), style: attr({ value: { type: 'string' } }),
  color: attr({ value: { type: 'string', enum: ['black'], enumNames: ['Nero'] } }),
  apparel_size: { type: 'array', maxItems: 1, selectors: ['marketplace_id', 'size_system'], items: { type: 'object', properties: { size_system: { type: 'string', enum: ['as6'], enumNames: ['IT'] }, size: { type: 'string', enum: ['m'], enumNames: ['M'] } } } },
} } })
const pants = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'PANTS', schemaDefinition: { required: ['brand'], properties: {
  item_name: attr({ value: { type: 'string' } }), brand: attr({ value: { type: 'string' } }), rise: attr({ style: attr({ value: { type: 'string' } }) }),
} } })
const specs = new Map([['COAT', coat], ['PANTS', pants]])
const ctx = { marketplace: 'IT', primaryLanguage: 'it', marketLanguages: ['it'], productTypes: ['COAT', 'PANTS'] }
const destination: AmazonDestination = { accountId: 'amazon-a', marketplace: 'IT', language: 'it' }
const keys = [SKU, TYPE, ACTION, h('item_name', 1, 'value', 'it_IT'), h('brand', 1, 'value', 'it_IT'), h('team_name', 1, 'value', 'it_IT'), h('color'), h('rise', 1, 'style#1.value'),
  h('apparel_size', 1, 'size_system'), h('mystery'), `purchasable_offer[marketplace_id=${IT}][audience=ALL]#1.our_price#1.schedule#1.value_with_tax`]
const row = ['GALE-JACKET-BLACK-MEN-M', 'COAT', '', 'Giacca', 'XAVIA', 'Giacca', 'Nero', '', 'IT', '', '99']
const withIds = (rows: ReturnType<typeof buildAmazonDraftFields>): MappingFieldRow[] => rows.map((r, i) => ({ ...r, id: `f${i}` }))
const byKey = (rows: readonly MappingFieldRow[], key: string) => rows.find(r => r.channelKey === amazonChannelKey(key))!

describe('CHMAP — an Amazon template becomes a mapping version', () => {
  it('reads the template identity: id, version, and the product types it was made for', async () => {
    const parsed = await template(keys, [row])
    expect(parsed.meta.templateVersion).toBe('2026.0713')
    expect(parsed.meta.templateProductTypes).toEqual(['COAT', 'PANTS'])
    const form = amazonFormOf(parsed, 'IT')
    expect(form).toMatchObject({ channel: 'AMAZON', marketplace: 'IT', formKind: 'AMAZON_TEMPLATE', formKey: 'COAT+PANTS', templateIdentifier: 'tmpl-it-1', templateVersion: '2026.0713', language: 'it_IT' })
    // The same columns give the same fingerprint; one more column gives another.
    expect(amazonFormOf(await template(keys, []), 'IT').keyFingerprint).toBe(form.keyFingerprint)
    expect(amazonFormOf(await template([...keys, h('style')], []), 'IT').keyFingerprint).not.toBe(form.keyFingerprint)
  })

  it('decides every column by the rules, per product type, with the channel requirement', async () => {
    const rows = withIds(buildAmazonDraftFields(await template(keys, [row]), specs, ctx))
    expect(rows).toHaveLength(keys.length + 20)
    expect(byKey(rows, SKU)).toMatchObject({ targetKind: 'identity', state: 'mapped', requirement: 'required' })
    expect(byKey(rows, h('item_name', 1, 'value', 'it_IT'))).toMatchObject({ targetKind: 'channelField', targetKey: 'item_name', state: 'mapped', requirement: 'required', productTypes: [] })
    // color is a COAT attribute only: mapped for COAT, restricted to it.
    expect(byKey(rows, h('color'))).toMatchObject({ targetKind: 'channelField', targetKey: 'color', state: 'mapped', productTypes: ['COAT'], transform: [{ op: 'copy' }] })
    expect(byKey(rows, h('rise', 1, 'style#1.value'))).toMatchObject({ state: 'mapped', productTypes: ['PANTS'] })
    expect(byKey(rows, h('apparel_size', 1, 'size_system'))).toMatchObject({ targetKind: 'selector', state: 'mapped' })
    expect(byKey(rows, h('mystery'))).toMatchObject({ targetKind: 'none', state: 'ignored' })
    expect(byKey(rows, keys[10])).toMatchObject({ targetKind: 'price', state: 'mapped' })
    expect(mappingCounts(rows).requiredUnmapped).toBe(0)
  })

  it('a column the rules cannot place is UNMAPPED, and blocks activation only when the channel requires it', () => {
    const rows: MappingFieldRow[] = [
      { channelKey: 'a', columnKey: 'a', label: null, aliases: [], productTypes: [], requirement: 'required', templateRequirement: null, targetKind: 'none', targetKey: null, transform: [], direction: 'both', state: 'unmapped', reason: null, decidedBy: 'rule', sortOrder: 0 },
      { channelKey: 'b', columnKey: 'b', label: null, aliases: [], productTypes: [], requirement: 'optional', templateRequirement: null, targetKind: 'none', targetKey: null, transform: [], direction: 'both', state: 'unmapped', reason: null, decidedBy: 'rule', sortOrder: 1 },
    ]
    expect(activationBlocker(rows)).toMatch(/^1 required column is not mapped \(a\)/)
    expect(activationBlocker([{ ...rows[0], state: 'ignored' }, rows[1]])).toMatch(/1 required column/)
    expect(activationBlocker([{ ...rows[0], state: 'mapped' }, rows[1]])).toBeNull()
    expect(mappingCounts(rows)).toMatchObject({ unmapped: 2, requiredUnmapped: 1 })
  })

  it('the reader gives the SAME result with the rules’ own version as with the rules alone', async () => {
    const parsed = await template(keys, [row, ['GALE-JACKET', 'COAT', '', 'Giacca parent', 'XAVIA', '', '', '', '', '', '']])
    const rows = withIds(buildAmazonDraftFields(parsed, specs, ctx))
    const plain = mapAmazonWorkbook(parsed, specs, destination)
    const mapped = mapAmazonWorkbook(parsed, specs, { ...destination, mapping: readerMapping({ id: 's', version: 1, status: 'DRAFT' }, 'Amazon IT · COAT+PANTS · v1 (draft)', rows) })
    expect(mapped.rows).toEqual(plain.rows)
    expect(mapped.ledger).toEqual(plain.ledger)
    expect(mapped.issues).toEqual(plain.issues)
  })

  it('the Owner’s decisions win: ignore a column, map a column to another field, leave one unmapped', async () => {
    const parsed = await template(keys, [row])
    const rules = withIds(buildAmazonDraftFields(parsed, specs, ctx))
    const plain = mapAmazonWorkbook(parsed, specs, destination)
    expect(plain.rows.find(r => r.field === 'team_name')?.value).toBe('Giacca')
    const decided = rules.map(r =>
      r.channelKey === amazonChannelKey(h('team_name', 1, 'value', 'it_IT')) ? { ...r, state: 'ignored' as const, decidedBy: 'owner' as const, reason: 'Amazon workaround for the piece of a set' }
      : r.channelKey === amazonChannelKey(h('mystery')) ? { ...r, state: 'mapped' as const, targetKind: 'channelField' as const, targetKey: 'style', decidedBy: 'owner' as const }
      : r.channelKey === amazonChannelKey(h('brand', 1, 'value', 'it_IT')) ? { ...r, state: 'unmapped' as const, decidedBy: 'owner' as const, reason: 'check the registered brand first' }
      : r)
    const withMystery = await template(keys, [[...row.slice(0, 9), 'Da moto', '99']])
    const out = mapAmazonWorkbook(withMystery, specs, { ...destination, mapping: readerMapping({ id: 's', version: 2, status: 'DRAFT' }, 'Amazon IT · COAT+PANTS · v2 (draft)', decided) })
    expect(out.rows.find(r => r.field === 'team_name')).toBeUndefined()
    expect(out.exclusions.find(e => e.field === h('team_name', 1, 'value', 'it_IT'))?.message).toContain('Ignored by Amazon IT · COAT+PANTS · v2 (draft): Amazon workaround for the piece of a set')
    expect(out.rows.find(r => r.field === 'style')?.value).toBe('Da moto')
    expect(out.issues.find(i => i.field === h('brand', 1, 'value', 'it_IT'))?.message).toContain('is not mapped in Amazon IT · COAT+PANTS · v2 (draft) (check the registered brand first)')
    // Every other decision is unchanged: the same item_name, color and price rows as the rules alone.
    for (const field of ['item_name', 'color', 'price']) expect(out.rows.filter(r => r.field === field)).toEqual(plain.rows.filter(r => r.field === field))
  })

  it('a column the version does not know is refused, never guessed', async () => {
    const parsed = await template([...keys, h('style')], [[...row, 'Militare']])
    const rows = withIds(buildAmazonDraftFields(await template(keys, [row]), specs, ctx))
    const out = mapAmazonWorkbook(parsed, specs, { ...destination, mapping: readerMapping({ id: 's', version: 1, status: 'ACTIVE' }, 'v1', rows) })
    expect(out.issues.find(i => i.field === h('style'))?.message).toContain('the column is not in this version')
    expect(out.rows.find(r => r.field === 'style')).toBeUndefined()
  })

  it('carries the Owner’s decisions to a new version and to another market’s template', () => {
    const rule = (key: string): Omit<MappingFieldRow, 'id'> => ({ channelKey: key, columnKey: key, label: null, aliases: [], productTypes: [], requirement: null, templateRequirement: null, targetKind: 'channelField', targetKey: 'team_name', transform: [{ op: 'copy' }], direction: 'both', state: 'mapped', reason: null, decidedBy: 'rule', sortOrder: 0 })
    const earlier: MappingFieldRow[] = [{ ...rule('team_name[language_tag=it_IT]#1.value'), state: 'ignored', decidedBy: 'owner', reason: 'workaround', id: 'x' }]
    const de = carryOwnerDecisions([rule('team_name[language_tag=de_DE]#1.value'), rule('brand#1.value')], earlier, { from: 'it_IT', to: 'de_DE' })
    expect(de[0]).toMatchObject({ state: 'ignored', decidedBy: 'owner', reason: 'workaround' })
    expect(de[1]).toMatchObject({ state: 'mapped', decidedBy: 'rule' })
    // The SKU / product type / action rows keep their meaning whatever an old version says.
    const locked = carryOwnerDecisions([{ ...rule(SKU), targetKind: 'identity' }], [{ ...rule(SKU), targetKind: 'identity', state: 'ignored', decidedBy: 'owner', id: 'y' }], { from: 'it_IT', to: 'it_IT' })
    expect(locked[0].state).toBe('mapped')
  })

  it('diffs two versions column by column', () => {
    const a: MappingFieldRow = { channelKey: 'k', columnKey: 'k', label: null, aliases: [], productTypes: [], requirement: 'optional', templateRequirement: null, targetKind: 'channelField', targetKey: 'x', transform: [], direction: 'both', state: 'mapped', reason: null, decidedBy: 'rule', sortOrder: 0 }
    const diff = diffMappingFields([a, { ...a, channelKey: 'gone' }], [{ ...a, requirement: 'required', state: 'ignored' }, { ...a, channelKey: 'new' }])
    expect(diff.added).toEqual(['new'])
    expect(diff.removed).toEqual(['gone'])
    expect(diff.requirementChanged).toEqual([{ channelKey: 'k', from: 'optional', to: 'required' }])
    expect(diff.decisionChanged[0].to.state).toBe('ignored')
  })

  it('reads the version of an OLD flat file from its own row-1 cell', async () => {
    const legacy = (await detectAmazonTemplate(await workbook({
      1: ['TemplateType=fptcustom', 'Version=2024.0630', `TemplateSignature=${b64('COAT')}`, settings({ attributeRow: '3', dataRow: '4', Version: '', TemplateSignature: '' })],
      3: ['item_sku', 'feed_product_type', 'item_name', 'brand_name', ...Array.from({ length: 20 }, (_, i) => `filler_${i}`)],
      4: ['S1', 'coat', 'Giacca', 'XAVIA'],
    }), { strict: true }))!
    expect(legacy.meta.grammar).toBe('legacy')
    expect(legacy.meta.templateVersion).toBe('2024.0630')
    expect(amazonFormOf(legacy, 'IT')).toMatchObject({ formKind: 'AMAZON_FLAT_FILE', formKey: 'COAT', templateVersion: '2024.0630' })
  })
})
