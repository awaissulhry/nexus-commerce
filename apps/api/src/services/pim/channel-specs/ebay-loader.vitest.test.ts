import { beforeEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ categorySchema: { findMany: vi.fn() }, channelSchema: { findMany: vi.fn() } }))
vi.mock('../../../db.js', () => ({ default: db }))
import { loadEbaySpec } from './index.js'
beforeEach(() => { vi.clearAllMocks(); db.channelSchema.findMany.mockResolvedValue([{ fieldKey: 'aspect_Foreign', label: 'Foreign', required: true }]) })
it('never borrows marketplace-wide aspects for an uncached category', async () => {
  db.categorySchema.findMany.mockResolvedValue([])
  const spec = await loadEbaySpec('IT', ['123'])
  expect(spec.absent).toBe(true)
  expect(spec.fields.some(f => f.attribute === 'aspect_Foreign')).toBe(false)
  expect(spec.fields.find(f => f.key === 'categoryId')?.requirement).toBe('required')
})
it('selects the latest exact leaf instead of an older English-rich row', async () => {
  db.categorySchema.findMany.mockResolvedValue([{ fetchedAt: new Date(), schemaVersion: 'v2', schemaDefinition: { aspects: [] } }])
  const spec = await loadEbaySpec('EBAY_IT', ['123'])
  expect(db.categorySchema.findMany.mock.calls[0][0]).toMatchObject({ where: { productType: '123', marketplace: { in: ['IT', 'EBAY_IT'] } }, orderBy: [{ fetchedAt: 'desc' }, { id: 'asc' }] })
  expect(spec.schemaVersion).toBe('v2')
})
it('requires separate contracts for different categories', async () => {
  await expect(loadEbaySpec('IT', ['123', '456'])).rejects.toThrow('separately')
  expect(db.categorySchema.findMany).not.toHaveBeenCalled()
})

// P1 (report 3 I-3.5) — on 177101 the newest cached row is the thin one the old flat-file GET writes (no cardinality), so
// "Chiusura" was offered as a list while eBay says SINGLE. The shape comes from the newest FULL row of the same category.
const thin = { fetchedAt: new Date('2026-09-14'), schemaVersion: 'live', schemaDefinition: { aspects: [
  { id: 'aspect_Chiusura', kind: 'enum', label: 'Closure / Fastening (Chiusura)', englishName: 'Closure / Fastening', localizedName: 'Chiusura', options: ['Cerniera', 'Bottoni', 'Velcro'], enumMode: 'open' },
  { id: 'aspect_Caratteristiche', kind: 'enum', label: 'Caratteristiche', options: ['Ventilato'], enumMode: 'open' },
] } }
const rich = { fetchedAt: new Date('2026-09-10'), schemaVersion: 'hash', schemaDefinition: { aspects: [
  { id: 'aspect_Closure / Fastening', kind: 'enum', label: 'Chiusura', englishName: 'Closure / Fastening', localizedName: 'Chiusura', options: ['Cerniera'], cardinality: 'SINGLE', dataType: 'STRING' },
  { id: 'aspect_Features', kind: 'enum', label: 'Caratteristiche', englishName: 'Features', localizedName: 'Caratteristiche', options: ['Ventilato'], cardinality: 'MULTI' },
] } }
it('takes single or multiple values from the newest full row when the newest row is thin; the options stay the newest', async () => {
  db.channelSchema.findMany.mockResolvedValue([{ fieldKey: 'aspect_Closure / Fastening', label: 'Closure', required: false, notes: 'multi-value' }])
  db.categorySchema.findMany.mockResolvedValue([thin, rich])
  const spec = await loadEbaySpec('IT', ['177101'])
  const closure = spec.fields.find(f => f.label === 'Chiusura')!
  expect(closure).toMatchObject({ shape: 'scalar', cardinality: { min: 1, max: 1 }, options: ['Cerniera', 'Bottoni', 'Velcro'] })
  expect(spec.fields.find(f => f.label === 'Caratteristiche')).toMatchObject({ shape: 'list', cardinality: { min: 1, max: null } })
  expect(spec.fetchedAt).toEqual(thin.fetchedAt)
})
// W3-5 — the thin row never carries eBay's "required from" date; the newest full row's date still reaches the column.
it('a thin newest row does not hide the date from which eBay plans to require an aspect', async () => {
  db.channelSchema.findMany.mockResolvedValue([])
  const dated = { ...rich, schemaDefinition: { aspects: [{ ...rich.schemaDefinition.aspects[0], expectedRequiredByDate: '2027-01-15T00:00:00.000Z' }, rich.schemaDefinition.aspects[1]] } }
  db.categorySchema.findMany.mockResolvedValue([thin, dated])
  const spec = await loadEbaySpec('IT', ['177101'])
  expect(spec.fields.find(f => f.label === 'Chiusura')).toMatchObject({ requirement: 'bestPractice', helpText: 'eBay plans to require this item specific from about 15 January 2027.' })
  expect(spec.fields.find(f => f.label === 'Caratteristiche')).toMatchObject({ requirement: 'optional' })
})
it('control: with no full row, the thin row keeps the old fallback (the marketplace notes)', async () => {
  db.channelSchema.findMany.mockResolvedValue([{ fieldKey: 'aspect_Closure / Fastening', label: 'Closure', required: false, notes: 'multi-value' }])
  db.categorySchema.findMany.mockResolvedValue([thin])
  expect((await loadEbaySpec('IT', ['177101'])).fields.find(f => f.label === 'Chiusura')).toMatchObject({ shape: 'list' })
})
// P1 (report 3 I-3.9) — eBay refuses one value over 65 characters (21919308); the cache states no cap, the column does.
it('every aspect column carries eBay\'s 65-character per-value limit, a tighter cached one wins', async () => {
  db.categorySchema.findMany.mockResolvedValue([{ fetchedAt: new Date(), schemaVersion: 'v', schemaDefinition: { aspects: [
    { id: 'aspect_Marca', kind: 'text', label: 'Marca (Brand)' }, { id: 'aspect_Codice', kind: 'text', label: 'Codice (Code)', maxLength: 30 },
  ] } }])
  const spec = await loadEbaySpec('IT', ['1'])
  expect(spec.fields.find(f => f.label === 'Marca')?.maxLength).toBe(65)
  expect(spec.fields.find(f => f.label === 'Codice')?.maxLength).toBe(30)
  expect(spec.fields.find(f => f.key === 'title')?.maxLength).toBe(80)
})
