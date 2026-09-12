/** Disposable Prisma-shaped fixture. No real database, credentials or marketplace writes. */
import { channelsHash } from './channels.js'
const stamp = new Date('2026-09-06T12:00:00Z')
type Row = Record<string, any>
const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, value]) => {
  if (value instanceof Date) return new Date(row[key]).getTime() === value.getTime()
  if (value && typeof value === 'object') {
    if ('in' in value) return value.in.includes(row[key])
    if ('contains' in value) return String(row[key]).toLowerCase().includes(value.contains.toLowerCase())
    if ('array_contains' in value) return value.array_contains.every((v: Row) => row[key].some((r: Row) => matches(r, v)))
  }
  return row[key] === value
})
export function productPresetTestStore() {
  const children = (prefix: string) => [{ id: `${prefix}-s`, sku: `${prefix}-S`, variantAttributes: { size: 'S', color: 'Black' }, basePrice: 25, totalStock: 17 }]
  const data: Record<string, Row[]> = {
    product: ['p1', 'p2'].map(id => ({ id, name: id === 'p1' ? 'Alpine jacket family' : 'Coastal jacket family', sku: id === 'p1' ? 'ALPINE' : 'COASTAL', isParent: true, parentId: null, deletedAt: null, updatedAt: stamp, children: children(id) })),
    channelConnection: ['account-a', 'account-b'].map((id, i) => ({ id, displayName: i ? 'Second store' : 'Main store', channelType: 'AMAZON', isActive: true, isPrimary: !i, updatedAt: stamp })),
    channelListing: [], listingWizard: [],
    wizardTemplate: [{ id: 'outerwear', name: 'Outerwear defaults', description: 'Size variation defaults for Italy and France', channels: [{ platform: 'AMAZON', marketplace: 'IT' }, { platform: 'AMAZON', marketplace: 'FR' }], defaults: { skuStrategy: { childSku: 'per-marketplace' }, variations: { commonTheme: 'SIZE_NAME', themeByChannel: { 'AMAZON:FR': 'COLOR_NAME' }, includedSkus: ['FOREIGN-S'] }, pricing: { basePrice: 999 } }, builtIn: false, categoryHint: 'Jackets', usageCount: 0, lastUsedAt: null, createdAt: stamp, updatedAt: stamp }],
    categorySchema: [{ id: 'schema-it', channel: 'AMAZON', marketplace: 'IT', productType: 'JACKET', isActive: true, variationThemes: ['SIZE_NAME', 'COLOR_NAME'], fetchedAt: stamp }, { id: 'schema-fr', channel: 'AMAZON', marketplace: 'FR', productType: 'JACKET', isActive: true, variationThemes: ['COLOR_NAME'], fetchedAt: stamp }],
  }
  for (const productId of ['p1', 'p2']) for (const accountId of ['account-a', 'account-b']) for (const market of ['IT', 'FR']) for (const aliasKey of ['', 'alias-one']) data.channelListing.push({ id: `${productId}:${accountId}:${market}:${aliasKey || 'primary'}`, productId, channel: 'AMAZON', marketplace: market, channelConnectionId: accountId, aliasKey, aliasId: aliasKey || null, title: `${productId} ${market} listing`, listingStatus: 'ACTIVE', isPublished: true, offerActive: true, platformAttributes: { productType: 'JACKET' }, price: 25, quantity: 17, version: 3, updatedAt: stamp })
  const db: Row = {}
  const writes: string[] = []
  for (const model of Object.keys(data)) {
    db[model] = {
      findUnique: async ({ where }: Row) => structuredClone(data[model]!.find(row => matches(row, where)) ?? null),
      findUniqueOrThrow: async ({ where }: Row) => { const row = data[model]!.find(row => matches(row, where)); if (!row) throw new Error('not found'); return structuredClone(row) },
      findFirst: async ({ where }: Row) => structuredClone(data[model]!.find(row => matches(row, where)) ?? null),
      findMany: async ({ where, take, skip = 0 }: Row = {}) => structuredClone(data[model]!.filter(row => matches(row, where)).slice(skip, take === undefined ? undefined : skip + take)),
      count: async ({ where }: Row = {}) => data[model]!.filter(row => matches(row, where)).length,
      create: async ({ data: values }: Row) => {
        if (model === 'listingWizard' && data[model]!.some(r => r.productId === values.productId && r.channelsHash === values.channelsHash && r.status === values.status)) throw { code: 'P2002' }
        const row = { id: `draft-${data[model]!.length + 1}`, version: 1, createdAt: new Date(), updatedAt: new Date(), submissions: [], ...structuredClone(values) }
        data[model]!.push(row); writes.push(model); return structuredClone(row)
      },
      updateMany: async ({ where, data: values }: Row) => {
        let count = 0
        for (const row of data[model]!.filter(row => matches(row, where))) {
          Object.assign(row, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : structuredClone(v)])))
          if (!('updatedAt' in values)) row.updatedAt = new Date()
          writes.push(model); count++
        }
        return { count }
      },
      update: async ({ where, data: values }: Row) => {
        const found = data[model]!.find(row => matches(row, where)); if (!found) throw { code: 'P2025' }
        await db[model].updateMany({ where, data: values }); return structuredClone(found)
      },
    }
  }
  db.$transaction = async (fn: (tx: Row) => unknown) => {
    const before = structuredClone(data), writeCount = writes.length
    try { return await fn(db) } catch (error) { Object.assign(data, before); writes.length = writeCount; throw error }
  }
  const scope = { productId: 'p1', channel: 'AMAZON' as const, accountId: 'account-a', market: 'IT', listingId: 'p1:account-a:IT:primary', aliasKey: '' }
  const addDraft = (state: Row = {}, override: Row = {}) => {
    const channels = [{ platform: 'AMAZON', marketplace: 'IT' }]
    const draft = { id: 'existing', productId: 'p1', channels, channelsHash: channelsHash(channels), status: 'DRAFT', version: 2, currentStep: 5, state, channelStates: { 'AMAZON:IT': { productType: { productType: 'JACKET' }, attributes: { fabric: 'Wool' } } }, updatedAt: stamp, createdAt: stamp, expiresAt: new Date('2099-01-01'), ...override }
    data.listingWizard.push(draft); return draft
  }
  return { db, data, writes, scope, addDraft }
}
