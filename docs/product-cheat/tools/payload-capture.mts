// Step 3.2 M1 / M2 — capture the Amazon STUDIO-PUBLICATION payload for one family, LOCAL ONLY.
//
// Everything runs inside ONE database transaction that is THROWN AWAY at the end: nested writes join it
// (`inDatabaseTransaction` reuses an active context) and after-commit effects never run. Nothing is sent:
// `fetch` is stubbed to throw, Redis points at a dead port, background jobs are off. Refuses any database host but
// 127.0.0.1. Afterwards it re-reads the probed listing OUTSIDE the transaction to prove nothing persisted.
//
//   cd apps/api && npx tsx ../../docs/product-cheat/tools/payload-capture.mts --sku 1J-EYE5-Y0TW [--field <fieldKey>]
process.env.REDIS_URL = 'redis://127.0.0.1:1'
process.env.NEXUS_DISABLE_BACKGROUND_JOBS = '1'
process.env.ENABLE_QUEUE_WORKERS = '0'
const network: string[] = []
globalThis.fetch = (async (input: unknown) => { network.push(String(input)); throw new Error(`payload-capture: network refused (${String(input)})`) }) as typeof fetch

const API = '/Users/awais/nexus-commerce/apps/api/src'
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const SKU = flag('sku') ?? '1J-EYE5-Y0TW'
const FIELD = flag('field')
const CONTENT = new Set(['item_name', 'product_description', 'bullet_point', 'generic_keyword'])

await import(`${API}/env.js`)
const host = new URL(process.env.DATABASE_URL ?? 'postgres://unknown/').hostname
if (host !== '127.0.0.1') { console.error(`REFUSE: database host ${host} is not local`); process.exit(1) }

const { default: prisma } = await import(`${API}/db.js`)
const { inDatabaseTransaction } = await import(`${API}/lib/database-context.js`)
const { withWorkspace, LEGACY_WORKSPACE_ID } = await import(`${API}/lib/workspace-context.js`)
const { readPublicationFacts } = await import(`${API}/services/pim/studio-publication-plan.js`)
const { prepareAmazonPublication } = await import(`${API}/services/pim/studio-publication-amazon.js`)
const { applyProductBulkEdits } = await import(`${API}/services/products/bulk-edit.service.js`)
const { loadAmazonSpec } = await import(`${API}/services/pim/channel-specs/index.js`)
const { getStudioSheet } = await import(`${API}/services/pim/studio-sheet.service.js`)
const { attributesFromCells } = await import(`${API}/services/pim/mapping/schema-requirements.js`)

class Rollback extends Error { constructor(readonly result: unknown) { super('rollback') } }
const where = (value: unknown, needle: string, path = ''): string[] => {
  if (typeof value === 'string') return value.includes(needle) ? [path] : []
  if (Array.isArray(value)) return value.flatMap((v, i) => where(v, needle, `${path}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => where(v, needle, path ? `${path}.${k}` : k))
  return []
}

const report: Record<string, unknown> = { sku: SKU, database: host }
let listingBefore: { id: string; overrideData: unknown; version: number } | null = null
try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () => inDatabaseTransaction(prisma, async () => {
    const root = await prisma.product.findFirstOrThrow({ where: { sku: SKU, deletedAt: null, parentId: null } })
    const rootListing = await prisma.channelListing.findFirstOrThrow({ where: { productId: root.id, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: { not: null } } })
    const scope = { channel: 'AMAZON', marketplace: 'IT', accountId: rootListing.channelConnectionId! }
    // PRECONDITION, inside the thrown-away transaction: the local copy of the Amazon account is `disconnected`, and the
    // builder refuses such an account before it reads any attribute. Marked connected here; rolled back with the rest.
    const account = await prisma.channelConnection.findUniqueOrThrow({ where: { id: scope.accountId } })
    report.accountPrecondition = { authStatus: account.authStatus, setTo: 'connected', rolledBack: true }
    if (account.authStatus !== 'connected') await prisma.channelConnection.update({ where: { id: scope.accountId }, data: { authStatus: 'connected' } })
    // PRECONDITION 2, same transaction: the local cached Amazon·IT schemas have EXPIRED, so the feed builder's schema hints
    // (`getFeedSchemaHints` → `getSchema`) would re-fetch from Amazon (the stubbed fetch refused it). Their `expiresAt`
    // is moved a day ahead so the builder uses the cached copy, as it does on a server with a fresh cache.
    const extended = await prisma.categorySchema.updateMany({ where: { channel: 'AMAZON', marketplace: 'IT', isActive: true }, data: { expiresAt: new Date(Date.now() + 86_400_000) } })
    report.schemaPrecondition = { expiredLocalSchemasExtended: extended.count, rolledBack: true }
    // PRECONDITION 3 (only with --fulfillment FBM|FBA), same transaction: a family member with no fulfillment method is
    // refused before its attributes are serialised. Set on the family's products that have none; rolled back.
    const fulfillment = flag('fulfillment')
    if (fulfillment) {
      const set = await prisma.product.updateMany({ where: { OR: [{ id: root.id }, { parentId: root.id }], deletedAt: null, fulfillmentMethod: null }, data: { fulfillmentMethod: fulfillment as never } })
      report.fulfillmentPrecondition = { productsSet: set.count, to: fulfillment, rolledBack: true }
    }
    const child = await prisma.product.findFirstOrThrow({ where: { parentId: root.id, deletedAt: null, channelListings: { some: { channel: 'AMAZON', marketplace: 'IT', channelConnectionId: scope.accountId, aliasKey: '' } } }, orderBy: { sku: 'asc' } })
    const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: child.id, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: scope.accountId, aliasKey: '' } })
    listingBefore = { id: listing.id, overrideData: listing.overrideData, version: listing.version }
    report.child = child.sku

    const build = async () => {
      const facts = await readPublicationFacts(root.id, scope)
      const publication = await prepareAmazonPublication(facts)
      return { facts, publication }
    }
    const before = await build()
    const catalogue = before.facts.resolved[0]?.catalogue
    const productType = before.facts.resolved[0]?.products.find((p: { productId: string }) => p.productId === child.id)?.category.channelCategoryId
    const spec = await loadAmazonSpec('IT', String(productType), scope.accountId)
    report.productType = productType
    report.issuesBefore = before.facts.issues.filter((i: { severity: string }) => i.severity === 'error').length

    // A free-text attribute the resolver owns: no other builder, no own store, not content, not an enum.
    const candidates = (catalogue?.fields ?? []).filter((f: any) => !f.sourceOwner && f.schemaKnown !== false && !f.channelStore
      && !CONTENT.has(f.fieldKey.split('.')[0]) && (f.kind === 'text' || !f.kind) && !(f.options?.length) && f.shape !== 'list'
      && spec.fields.some((s: { key: string }) => s.key === f.fieldKey))
    const field = FIELD ? candidates.find((f: any) => f.fieldKey === FIELD) : (candidates.find((f: any) => /model_name|model_number|part_number|manufacturer/.test(f.fieldKey)) ?? candidates[0])
    if (!field) throw new Error(`no free-text Amazon field found (${candidates.length} candidates)`)
    const sheetField = `attr_${field.sheetKey ?? field.fieldKey}`
    const attribute = spec.fields.find((s: { key: string }) => s.key === field.fieldKey)!.attribute
    report.field = { fieldKey: field.fieldKey, sheetField, attribute, candidates: candidates.length }

    // M2 — the SAME state as the "before" feed: the sheet's Amazon·IT values for this child against its payload message.
    // Each sheet value is serialised with the payload's own serialiser (`attributesFromCells`), then both sides are reduced
    // to their scalar leaves (without `marketplace_id` / `language_tag`, which only the envelope adds) and compared per root.
    if (argv.includes('--m2')) {
      const sheet = await getStudioSheet({ productId: root.id, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it',
        accountId: scope.accountId, includeMapping: true } as never)
      const empty = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0)
      const leaves = (v: unknown): string[] => v == null ? [] : Array.isArray(v) ? v.flatMap(leaves)
        : typeof v === 'object' ? Object.entries(v as object).filter(([k]) => k !== 'marketplace_id' && k !== 'language_tag').flatMap(([, x]) => leaves(x))
        : [String(v)]
      const rootOf = (k: string) => spec.fields.find((f: { key: string }) => f.key === k)?.attribute
      const perProduct: unknown[] = []
      const totals = { products: 0, sheetValues: 0, same: 0, differ: 0, sheetOnly: 0, payloadOnly: 0, headerProductTypeMismatch: 0 }
      const differences: unknown[] = [], sheetOnlyRoots = new Set<string>(), payloadOnlyRoots = new Set<string>()
      for (const row of sheet.rows as any[]) {
        const message = (before.publication.feed.messages as any[]).find(m => m.sku === row.sku) ?? null
        if (!message) { perProduct.push({ sku: row.sku, message: 'none' }); continue }
        const sheetValues: Record<string, unknown> = {}
        for (const f of catalogue?.fields ?? []) {
          const key = [f.sheetKey, `attr_${f.sheetKey ?? f.fieldKey}`, f.fieldKey].find((k: string | undefined) => k && row?.values?.[k] !== undefined)
          if (key && !empty(row.values[key]?.value)) sheetValues[f.fieldKey] = row.values[key].value
        }
        // `productType` selects the schema; it is the message HEADER, not an attribute.
        if (sheetValues.productType !== undefined && String(sheetValues.productType) !== String(message.productType)) totals.headerProductTypeMismatch++
        delete sheetValues.productType
        const expected = attributesFromCells(spec, sheetValues) as Record<string, unknown>
        const payload = (message.attributes ?? {}) as Record<string, unknown>
        const unserialised = Object.keys(sheetValues).filter(k => !(String(rootOf(k)) in expected))
        let same = 0, differ = 0, sheetOnly = 0, payloadOnly = 0
        for (const r of [...new Set([...Object.keys(expected), ...Object.keys(payload)])].sort()) {
          const a = leaves(expected[r]).sort(), b = leaves(payload[r]).sort()
          if (!(r in payload)) { sheetOnly++; sheetOnlyRoots.add(r) }
          else if (!(r in expected)) { payloadOnly++; payloadOnlyRoots.add(r) }
          else if (JSON.stringify(a) === JSON.stringify(b)) same++
          else { differ++; differences.push({ sku: row.sku, root: r, sheet: a.slice(0, 3), payload: b.slice(0, 3) }) }
        }
        totals.products++; totals.sheetValues += Object.keys(sheetValues).length
        totals.same += same; totals.differ += differ; totals.sheetOnly += sheetOnly; totals.payloadOnly += payloadOnly
        perProduct.push({ sku: row.sku, sheetValues: Object.keys(sheetValues).length, same, differ, sheetOnly, payloadOnly, unserialised })
      }
      const parentRow = (sheet.rows as any[]).find(r => r.id === root.id)
      const parentMessage = (before.publication.feed.messages as any[]).find(m => m.sku === parentRow?.sku)
      report.m2parent = { themeCell: parentRow?.values?.variation_theme ?? parentRow?.values?.attr_variation_theme ?? null,
        relationshipCells: Object.fromEntries(Object.entries(parentRow?.values ?? {}).filter(([k]) => /child_parent|parentage/.test(k)).map(([k, v]) => [k, (v as any)?.value])),
        payloadTheme: parentMessage?.attributes?.variation_theme ?? null, payloadParentage: parentMessage?.attributes?.parentage_level ?? null }
      report.m2 = { totals, sheetOnlyRoots: [...sheetOnlyRoots], payloadOnlyRoots: [...payloadOnlyRoots], differences: differences.slice(0, 20), perProduct }
    }

    const probe = `M1-PROBE-${Math.random().toString(36).slice(2, 10)}`
    report.probe = probe
    report.controlBefore = { inFeed: where(before.publication.feed, probe) }

    const write = await applyProductBulkEdits({ changes: [{ id: child.id, field: sheetField, value: probe, target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: scope.accountId }], expectedVersion: listing.version } as never,
      { formulaCascade: false, logger: { warn: () => undefined, error: () => undefined } })
    const stored = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
    report.write = { response: { updated: (write as any).updated, versionOf: (write as any).versionOf, currentVersion: (write as any).currentVersion },
      landedIn: where({ overrideData: stored.overrideData, platformAttributes: stored.platformAttributes }, probe) }

    const after = await build()
    const messages = after.publication.feed.messages.map((m: { sku: string }) => ({ sku: m.sku, paths: where(m, probe) })).filter((m: { paths: string[] }) => m.paths.length)
    const childMessage = after.publication.feed.messages.find((m: { sku: string }) => where(m, probe).length)
    report.after = { messagesWithProbe: messages, value: childMessage ? (childMessage as any).attributes?.[attribute] : null,
      messageCount: after.publication.feed.messages.length, operationTypes: [...new Set(after.publication.feed.messages.map((m: { operationType: string }) => m.operationType))] }
    throw new Rollback(null)
  }))
} catch (error) {
  if (!(error instanceof Rollback)) { report.error = error instanceof Error ? error.stack?.split('\n').slice(0, 14).join('\n') : String(error) }
}
// Outside the transaction: the listing must be exactly as before.
if (listingBefore) {
  const now = await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    prisma.channelListing.findUniqueOrThrow({ where: { id: (listingBefore as any).id } }))
  report.rolledBack = JSON.stringify(now.overrideData) === JSON.stringify((listingBefore as any).overrideData) && now.version === (listingBefore as any).version
}
report.networkAttempts = network
console.log(`REPORT ${JSON.stringify(report)}`)
process.exit(0)
