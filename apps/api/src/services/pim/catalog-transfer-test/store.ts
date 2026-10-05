/** Isolated Prisma-shaped test store. No env loading, network, or working-catalog connection. */
type Row = Record<string, any>
const clone = <T>(v: T): T => structuredClone(v)
const eq = (a: any, b: any) => a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : a === b
export function importTestStore(options: { recordQueries?: boolean } = {}) {
  const data: Record<string, Map<string, Row>> = Object.fromEntries(['product', 'channelListing', 'channelConnection', 'productFamily', 'category', 'categorySchema', 'categoryChannelMapping', 'marketplace', 'productListingAlias', 'productCategory', 'bulkOperation', 'importJob', 'importJobRow', 'scheduledImport', 'auditLog', 'ebayDescriptionTheme', 'cellFormula', 'fieldValueMap', 'sizeScaleMap', 'fieldLinkGroup',
    // LX.F R-LX-13 — the three stores LX added. Without them an apply failed with
    // "Cannot read properties of undefined (reading 'create')" and the job read
    // PARTIAL, with the real cause invisible in the outcome rows.
    'productTranslation', 'channelListingTranslation', 'readinessIndex', 'outboundSyncQueue',
    // P1.3 — every queue row is now created through `createOutboundRow`, whose BP.S3
    // preflight asks the grant table whether the seller account is SHARED with a second
    // business. Without the store an apply failed with "Cannot read properties of
    // undefined (reading 'findMany')" and the job read PARTIAL. Empty = nothing shared
    // here, which is this fixture's world: one business, two of its own accounts.
    'channelAccountGrant',
    // CFI (R-CFI-1) — the price door's audit + timeline, the channel's last read, and the offer SKUs a listing carries.
    'channelListingOverride', 'priceChangeEvent', 'channelDrift', 'offer'].map(k => [k, new Map()]))
  /** CFI — which raw-SQL columns this fixture database carries (sale window, PR presence), and every raw statement run. */
  // The sale window lives in raw columns Prisma never returns (`sale-window.ts`), so it is kept APART from the listing row:
  // a listing snapshot must not see it, exactly as against PostgreSQL.
  const raw = { saleWindowColumns: true, presenceColumns: true, statements: [] as { sql: string; values: unknown[] }[], saleWindows: new Map<string, { start: string | null; end: string | null }>() }
  const queries: { model: string; method: string; args: Row; returned: number }[] = []
  const failures = new Map<string, Error>()
  let sequence = 0, undo: (() => void)[] | null = null
  let queryCount = 0
  const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true
    if (key === 'OR') return expected.some((w: Row) => matches(row, w))
    if (key === 'AND') return expected.every((w: Row) => matches(row, w))
    if (key.startsWith('workspace_')) return matches(row, expected)
    if (key === 'channel_code') return matches(row, expected)
    // LX.F2 R-LX-21 — a COMPOUND UNIQUE arrives as ONE key whose value names the real
    // columns. Two were special-cased by name above and the third threw: measured,
    // `content-write.ts`'s closing
    // `channelListingTranslation.findUniqueOrThrow({ where: { channelListingId_language: … } })`
    // answered `Not found` for a row it had created five lines earlier, and the transfer job
    // read PARTIAL with "Not found" as its only word. The rule is now DERIVED instead of
    // listed (`reference_a_list_of_members_is_a_set_claim`): a key the row does not carry,
    // whose value is a plain object naming only keys the row DOES carry, is a compound unique.
    if (!(key in row) && expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)
      && Object.keys(expected).length > 0 && Object.keys(expected).every(k => k in row)) return matches(row, expected)
    if (key === 'children') return [...data.product.values()].some(p => p.parentId === row.id && matches(p, expected.some))
    if (key === 'parent') return !!data.product.get(row.parentId) && matches(data.product.get(row.parentId)!, expected)
    if (key === 'product') return !!data.product.get(row.productId) && matches(data.product.get(row.productId)!, expected)
    const value = row[key]
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
      if ('path' in expected) return eq(expected.path.reduce((v: any, k: string) => v?.[k], value), expected.equals)
      return Object.entries(expected).every(([op, v]) => op === 'in' ? (v as any[]).some(x => eq(value, x)) : op === 'not' ? !eq(value, v) : op === 'gt' ? value > (v as any) : op === 'gte' ? value >= (v as any) : op === 'lt' ? value < (v as any) : op === 'lte' ? value <= (v as any) : eq(value?.[op], v))
    }
    return eq(value, expected)
  })
  const changed = (model: string, id: string) => {
    const old = data[model].get(id)
    if (undo) undo.push(() => { if (old) data[model].set(id, old); else data[model].delete(id) })
  }
  /** LX.F2 — the one place that answers a `translations` include, for either owner. */
  const translationsOf = (model: string, row: Row): Row[] =>
    model === 'channelListing' ? [...data.channelListingTranslation.values()].filter(t => t.channelListingId === row.id).map(clone)
    : model === 'product' ? [...data.productTranslation.values()].filter(t => t.productId === row.id).map(clone)
    : clone(row.translations ?? [])
  const db: Row = {}
  for (const model of Object.keys(data)) {
    const result = (row: Row | undefined, args: Row = {}) => {
      if (!row) return null
      const out = clone(row)
      if (args.select?.product) {
        const parent = row.productId ? data.product.get(row.productId) : undefined
        // The fields a nested product select names (the price door reads sku, basePrice, minPrice and maxPrice); a select
        // without a field list keeps the old answer, the parent id.
        const fields = args.select.product?.select ? Object.keys(args.select.product.select) : ['parentId']
        out.product = row.productId ? Object.fromEntries(fields.map((f) => [f, parent?.[f] ?? null])) : null
      }
      // LX.F R-LX-13 — a selected TO-MANY relation is always an array in Prisma's
      // answer, never undefined. LX reads `translations` on products and listings
      // (`catalog-product-transfer.ts:36,41`), and this store returned `undefined`
      // for any row whose fixture predates the relation, which read as
      // "Cannot read properties of undefined (reading 'map')" — a 400 on export.
      // LX.F2 R-LX-21 — and it must be the REAL relation, not the row's own field. This
      // returned `row.translations ?? []`, which no writer ever sets, so `translations` was
      // permanently `[]`: `content-write.ts`'s `prior = listing.translations.find(...)` never
      // found the pin row the SAME-LANGUAGE CASCADE had just created, took its `create`
      // branch, and left **two `ChannelListingTranslation` rows for one
      // `(channelListingId, language)`** — a pair the production unique index makes
      // impossible, so the harness was hiding the update path instead of exercising it
      // (measured: `fixture-6 {follows:['title']}` and `fixture-130 {name:'HTTP title'}`, both
      // `p0-account-a`/`it`, in one apply).
      if (args.select?.translations || args.include?.translations) out.translations = translationsOf(model, row)
      // LX's same-language cascade loads each listing WITH its product and that
      // product's translations (`master-content.service.ts:116`), a nested include
      // this store did not answer — `listing.product.sku` then threw.
      if (args.include?.product) {
        const owner = row.productId ? data.product.get(row.productId) : undefined
        out.product = owner ? { ...clone(owner), translations: translationsOf('product', owner) } : null
      }
      if (args.include?.parent) out.parent = row.parentId ? clone(data.product.get(row.parentId) ?? null) : null
      if (args.include?._count) out._count = { children: [...data.product.values()].filter(p => p.parentId === row.id).length }
      if (args.select) return Object.fromEntries(Object.keys(args.select).map(k => [k, out[k]]))
      return out
    }
    const find = (args: Row = {}) => {
      let rows = [...data[model].values()].filter(r => matches(r, args.where))
      const order = args.orderBy ? Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy] : []
      rows.sort((a, b) => { for (const entry of order) { const [key, dir] = Object.entries(entry)[0]; if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * (dir === 'desc' ? -1 : 1) } return 0 })
      return rows.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take)
    }
    const call = (method: string, args: Row, returned: number) => { queryCount++; if (options.recordQueries !== false) queries.push({ model, method, args: clone(args), returned }) }
    db[model] = {
      async findMany(args: Row = {}) { const rows = find(args); call('findMany', args, rows.length); return rows.map(r => result(r, args)) },
      async findFirst(args: Row = {}) { const rows = find(args); call('findFirst', args, rows.length ? 1 : 0); return result(rows[0], args) },
      async findUnique(args: Row) { const rows = find(args); call('findUnique', args, rows.length ? 1 : 0); return result(rows[0], args) },
      async findUniqueOrThrow(args: Row) { const r = await db[model].findUnique(args); if (!r) throw new Error('Not found'); return r },
      async count(args: Row = {}) { const n = find(args).length; call('count', args, n); return n },
      async create(args: Row) {
        const id = args.data.id ?? `fixture-${++sequence}`
        if (data[model].has(id)) throw new Error('Duplicate ID')
        const defaults = model === 'importJob' ? { successRows: 0, failedRows: 0, skippedRows: 0 } : model === 'importJobRow' ? { status: 'PENDING', errorMessage: null } : model === 'product' ? { version: 0, deletedAt: null, parentId: null, familyId: null, categories: [], categoryAttributes: {}, localizedContent: {}, isParent: false } : model === 'channelListing' ? { version: 0, aliasKey: '', aliasId: null, overrideData: {}, platformAttributes: {} } : model === 'scheduledImport' ? { runCount: 0, nextRunAt: null, cronExpression: null, scheduledFor: null, timezone: 'Europe/Rome' } : {}
        const row = { ...defaults, id, createdAt: new Date(), updatedAt: new Date(), ...clone(args.data) }
        changed(model, id); data[model].set(id, row); call('create', args, 1); return result(row, args)
      },
      async createMany(args: Row) { for (const row of args.data) await db[model].create({ data: row }); return { count: args.data.length } },
      async updateMany(args: Row) {
        const rows = find({ where: args.where })
        for (const row of rows) {
          const failure = failures.get(`${model}:${row.id}`)
          if (failure) { failures.delete(`${model}:${row.id}`); throw failure }
          const next = clone(row)
          for (const [k, v] of Object.entries(args.data)) next[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] ?? 0) + Number(v.increment) : clone(v)
          if (['product', 'channelListing', 'scheduledImport', 'importJob'].includes(model) && !args.data.updatedAt) next.updatedAt = new Date(Math.max(Date.now(), new Date(row.updatedAt).getTime() + 1))
          changed(model, row.id); data[model].set(row.id, next)
        }
        call('updateMany', args, rows.length); return { count: rows.length }
      },
      async update(args: Row) { const r = find({ where: args.where })[0]; if (!r) throw new Error('Not found'); await db[model].updateMany(args); return result(data[model].get(r.id), args) },
      async deleteMany(args: Row) { const rows = find(args); for (const r of rows) { changed(model, r.id); data[model].delete(r.id) } return { count: rows.length } },
    }
  }
  // CFI — the narrow raw SQL of `sale-window.ts` and `recordChannelDeletion`, answered from the same rows.
  db.$queryRawUnsafe = async (sql: string, ...values: unknown[]) => {
    raw.statements.push({ sql, values })
    if (sql.includes('information_schema.columns') && sql.includes('salePriceStart')) return [{ n: raw.saleWindowColumns ? 2 : 0 }]
    if (sql.includes('information_schema.columns') && sql.includes('presenceIntent')) return [{ n: raw.presenceColumns ? 3 : 0 }]
    if (sql.includes('to_char("salePriceStart"')) return (values[0] as string[]).flatMap(id => data.channelListing.has(id) ? [{ id, start: raw.saleWindows.get(id)?.start ?? null, end: raw.saleWindows.get(id)?.end ?? null }] : [])
    throw new Error(`Unsupported fixture raw query: ${sql}`)
  }
  // The price door reads its product's master price, floor and ceiling FOR SHARE before it writes (channel-price-write).
  db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    raw.statements.push({ sql, values })
    if (sql.includes('FROM "Product" WHERE id =') && sql.includes('FOR SHARE')) {
      const p = data.product.get(values[0] as string)
      return p ? [{ basePrice: p.basePrice ?? null, minPrice: p.minPrice ?? null, maxPrice: p.maxPrice ?? null }] : []
    }
    // S9 — a new product's SKU is checked against the channel SKUs other products' listings hold (`channelSkuHoldings`):
    // the alias-SKU column is there, and these fixtures hold no listing under another product's channel SKU.
    if (sql.includes('information_schema.columns') && sql.includes('ProductListingAlias')) return [{ alias_sku: true }]
    if (sql.includes('FROM unnest(') && sql.includes('"ChannelListing" cl')) return []
    throw new Error(`Unsupported fixture raw query: ${sql}`)
  }
  db.$executeRawUnsafe = async (sql: string, ...values: unknown[]) => {
    raw.statements.push({ sql, values })
    const row = data.channelListing.get(values[0] as string)
    if (!row) return 0
    if (sql.includes('"salePriceStart" = $2')) {
      const previous = raw.saleWindows.get(row.id)
      if (undo) undo.push(() => { if (previous) raw.saleWindows.set(row.id, previous); else raw.saleWindows.delete(row.id) })
      raw.saleWindows.set(row.id, { start: values[1] as string | null, end: values[2] as string | null })
      return 1
    }
    changed('channelListing', row.id)
    if (sql.includes('"presenceIntent" = \'ENDED\'')) data.channelListing.set(row.id, { ...row, presenceIntent: 'ENDED', presenceIntentBy: values[1], presenceIntentReason: values[2], channelFact: 'ABSENT', channelFactVia: 'channel-file-import', endedBy: values[1], endedReason: 'channel-file-delete' })
    else throw new Error(`Unsupported fixture raw statement: ${sql}`)
    return 1
  }
  let tail = Promise.resolve()
  db.$transaction = async (fn: (tx: Row) => Promise<any>) => {
    const previous = tail
    let release!: () => void; tail = new Promise<void>(resolve => { release = resolve })
    await previous
    const journal: (() => void)[] = []; undo = journal
    try { return await fn(db) } catch (e) { for (const restore of journal.reverse()) restore(); throw e } finally { undo = null; release() }
  }
  const seed = (count = 1) => {
    for (const model of Object.values(data)) model.clear(); queries.length = 0; queryCount = 0
    data.productFamily.set('f1', { id: 'f1', code: 'coats', label: 'Coats' })
    for (const a of ['account-a', 'account-b']) data.channelConnection.set(a, { id: a, channelType: 'AMAZON', marketplace: null, displayName: a, isActive: true })
    for (const market of ['IT', 'FR']) data.marketplace.set(market, { id: market, channel: 'AMAZON', code: market, name: market, languages: [market === 'IT' ? 'it' : 'fr'], isActive: true })
    for (let i = 0; i < count; i++) {
      const id = `p${i}`, sku = String(i).padStart(6, '0')
      data.product.set(id, { id, sku, name: `Original ${i}`, description: null, familyId: 'f1', parentId: i % 20 ? `p${i - i % 20}` : null, isParent: i % 20 === 0, version: 3, basePrice: 25, totalStock: 17, categories: [], categoryAttributes: {}, localizedContent: {}, deletedAt: null, updatedAt: new Date('2026-01-01') })
      for (const [a, market] of [['account-a', 'IT'], ['account-b', 'FR']]) {
        const listingId = `${id}-${a}`
        data.channelListing.set(listingId, { id: listingId, productId: id, channel: 'AMAZON', marketplace: market, channelConnectionId: a, aliasKey: '', version: 8, updatedAt: new Date('2026-01-01'), platformAttributes: { productType: 'COAT' }, followMasterTitle: true, title: 'Sync snapshot', titleOverride: null, overrideData: { material: 'Protected cotton' } })
      }
    }
  }
  return { db, data, queries, failures, seed, raw, get queryCount() { return queryCount } }
}
export const fixtureColumns = ['name', 'description', 'basePrice', 'totalStock'].map(key => ({ key, writeField: key, label: key, group: 'Shared', kind: ['basePrice', 'totalStock'].includes(key) ? 'number' : 'text', storage: 'column', scope: 'global', shape: 'scalar', requiredBy: [], editable: true, defaultVisible: true }))
export const fixtureFields = [
  { fieldKey: 'item_name', sheetKey: 'name', label: 'Title', kind: 'text', shape: 'scalar', editable: true, maxLength: 100, channelStore: { kind: 'listingColumn', column: 'title', followFlag: 'followMasterTitle' } },
  { fieldKey: 'material', sheetKey: 'material', label: 'Material', kind: 'text', shape: 'scalar', editable: true },
]
