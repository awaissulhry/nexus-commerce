// PCO §6.2 — how much of an Amazon studio-publication payload is UNCHANGED after one field changes on one product. LOCAL ONLY.
// A trimmed copy of docs/product-cheat/tools/payload-capture.mts (same preconditions, same rollback) plus sizes and a diff.
//
// Everything runs inside ONE database transaction that is THROWN AWAY at the end. Nothing is sent: `fetch` is stubbed to
// throw, Redis points at a dead port, background jobs are off. Refuses any database host but 127.0.0.1. Afterwards it
// re-reads the probed listing OUTSIDE the transaction to prove nothing persisted.
//
//   cd apps/api && npx tsx ../../docs/publish-changes-only/tools/payload-diff.mts --sku xavia-knee-slider --fulfillment FBM [--field part_number]
//
// PREDICTIONS (written 2026-09-25 before the first run, family xavia-knee-slider, Amazon·IT, field part_number):
//  D1 before: 9 messages (the whole family), all PARTIAL_UPDATE, each carrying its full attribute set (≥ 10 roots per child).
//  D2 after the one-field change on one child: still 9 messages; exactly 1 message differs, in exactly 1 attribute root.
//  D3 a change-only payload (changed roots of changed messages only) is < 10 % of the whole feed's bytes.
process.env.REDIS_URL = 'redis://127.0.0.1:1'
process.env.NEXUS_DISABLE_BACKGROUND_JOBS = '1'
process.env.ENABLE_QUEUE_WORKERS = '0'
const network: string[] = []
globalThis.fetch = (async (input: unknown) => { network.push(String(input)); throw new Error(`payload-diff: network refused (${String(input)})`) }) as typeof fetch

const API = '/Users/awais/nexus-commerce/apps/api/src'
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const SKU = flag('sku') ?? 'xavia-knee-slider'
const FIELD = flag('field') ?? 'part_number'
const MARKET = (flag('market') ?? 'IT').toUpperCase()

await import(`${API}/env.js`)
const host = new URL(process.env.DATABASE_URL ?? 'postgres://unknown/').hostname
if (host !== '127.0.0.1') { console.error(`REFUSE: database host ${host} is not local`); process.exit(1) }

const { default: prisma } = await import(`${API}/db.js`)
const { inDatabaseTransaction } = await import(`${API}/lib/database-context.js`)
const { withWorkspace, LEGACY_WORKSPACE_ID } = await import(`${API}/lib/workspace-context.js`)
const { readPublicationFacts } = await import(`${API}/services/pim/studio-publication-plan.js`)
const { prepareAmazonPublication } = await import(`${API}/services/pim/studio-publication-amazon.js`)
const { prepareAmazonChanges, compileAmazonChanges } = await import(`${API}/services/pim/studio-publication-amazon-changes.js`)
const { publicationChangeId } = await import(`${API}/services/pim/studio-publication-changes.js`)
const { AmazonSpApiClient } = await import(`${API}/clients/amazon-sp-api.client.js`)
const { applyProductBulkEdits } = await import(`${API}/services/products/bulk-edit.service.js`)

class Rollback extends Error { constructor() { super('rollback') } }
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))
const shape = (feed: any) => {
  const messages = (feed.messages as any[]).map(m => ({ sku: m.sku, op: m.operationType, roots: Object.keys(m.attributes ?? m.patches ?? {}).length, bytes: bytes(m) }))
  return { messageCount: messages.length, operationTypes: [...new Set(messages.map(m => m.op))], feedBytes: bytes(feed),
    rootsPerMessage: { min: Math.min(...messages.map(m => m.roots)), max: Math.max(...messages.map(m => m.roots)), total: messages.reduce((n, m) => n + m.roots, 0) },
    messages }
}
const report: Record<string, unknown> = { sku: SKU, market: MARKET, field: FIELD, database: host }
let listingBefore: { id: string; overrideData: unknown; version: number } | null = null
try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () => inDatabaseTransaction(prisma, async () => {
    const root = await prisma.product.findFirstOrThrow({ where: { sku: SKU, deletedAt: null, parentId: null } })
    const rootListing = await prisma.channelListing.findFirstOrThrow({ where: { productId: root.id, channel: 'AMAZON', marketplace: MARKET, channelConnectionId: { not: null } } })
    const scope = { channel: 'AMAZON', marketplace: MARKET, accountId: rootListing.channelConnectionId! }
    // Preconditions copied from payload-capture.mts, same thrown-away transaction: the local account row is marked
    // connected, the expired local schemas are extended a day, and (with --fulfillment) products without a method get one.
    const account = await prisma.channelConnection.findUniqueOrThrow({ where: { id: scope.accountId } })
    if (account.authStatus !== 'connected') await prisma.channelConnection.update({ where: { id: scope.accountId }, data: { authStatus: 'connected' } })
    await prisma.categorySchema.updateMany({ where: { channel: 'AMAZON', marketplace: MARKET, isActive: true }, data: { expiresAt: new Date(Date.now() + 86_400_000) } })
    const fulfillment = flag('fulfillment')
    if (fulfillment) await prisma.product.updateMany({ where: { OR: [{ id: root.id }, { parentId: root.id }], deletedAt: null, fulfillmentMethod: null }, data: { fulfillmentMethod: fulfillment as never } })

    const child = await prisma.product.findFirstOrThrow({ where: { parentId: root.id, deletedAt: null, channelListings: { some: { channel: 'AMAZON', marketplace: MARKET, channelConnectionId: scope.accountId, aliasKey: '' } } }, orderBy: { sku: 'asc' } })
    const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: child.id, channel: 'AMAZON', marketplace: MARKET, channelConnectionId: scope.accountId, aliasKey: '' } })
    listingBefore = { id: listing.id, overrideData: listing.overrideData, version: listing.version }
    report.child = child.sku

    const build = async () => prepareAmazonPublication(await readPublicationFacts(root.id, scope))
    const before = await build()
    report.before = shape(before.feed)
    // PCO-4 measurement uses the exact before values as accepted-history/live-read fixtures.
    // Network stays refused. This proves compiler sparsity, not provider acceptance.
    const baseline = new Map(before.products.flatMap((p, index) => Object.entries(before.feed.messages[index].attributes ?? {})
      .map(([field, value]) => [publicationChangeId(p.productId, field), { state: 'value', value }] as const)))
    AmazonSpApiClient.prototype.getListingsItem = async ({ sku }: { sku: string }) => {
      const message = before.feed.messages.find((message: any) => message.sku === sku)
      if (!message) throw new Error('Unexpected fixture SKU')
      return { success: true, sku, rawResponse: { sku, attributes: message.attributes ?? {}, summaries: [{ marketplaceId: before.marketplaceId, productType: message.productType }] } } as any
    }

    const probe = `PCO-PROBE-${Math.random().toString(36).slice(2, 10)}`
    const write = await applyProductBulkEdits({ changes: [{ id: child.id, field: `attr_${FIELD}`, value: probe, target: 'channel' }],
      marketplaceContexts: [{ channel: 'AMAZON', marketplace: MARKET, accountId: scope.accountId }], expectedVersion: listing.version } as never,
      { formulaCascade: false, logger: { warn: () => undefined, error: () => undefined } })
    report.write = { updated: (write as any).updated, probe }

    const after = await build()
    report.after = shape(after.feed)
    const plan = await prepareAmazonChanges(await readPublicationFacts(root.id, scope), after, baseline as any)
    // The original part_number probe adds a field absent from the old request, so it has no accepted
    // field record. Its first send correctly needs an explicit choice instead of an automatic tick.
    const choices = plan.changes.filter((change: any) => change.productId === child.id && change.field === FIELD)
    report.reviewedChoices = choices
    const selectedIds = choices.filter((change: any) => change.selectable).map((change: any) => change.id)
    const sparse = compileAmazonChanges(plan, selectedIds)
    report.compiled = { fixture: 'before payload as accepted baseline and channel read', messages: sparse.feed.messages,
      products: sparse.products, fieldWrites: sparse.fieldWrites, feedBytes: bytes(sparse.feed),
      unchangedProductsSkipped: before.products.length - sparse.products.length }
    if (sparse.feed.messages.length !== 1 || sparse.feed.messages[0].patches?.length !== 1
      || sparse.feed.messages[0].patches[0].path !== `/attributes/${FIELD}`) throw new Error('The real compiler did not produce exactly one changed child/root.')
    // The diff: per message (by sku), the attribute roots whose JSON changed, appeared or disappeared.
    const bySku = new Map((before.feed.messages as any[]).map(m => [m.sku, m]))
    const changed: Array<{ sku: string; roots: string[]; changeOnlyBytes: number }> = []
    for (const m of after.feed.messages as any[]) {
      const b = bySku.get(m.sku)
      const A = m.attributes ?? m.patches ?? {}, B = b?.attributes ?? b?.patches ?? {}
      const roots = [...new Set([...Object.keys(A), ...Object.keys(B)])].filter(k => JSON.stringify(A[k]) !== JSON.stringify(B[k]))
      if (!b) changed.push({ sku: m.sku, roots: ['(new message)'], changeOnlyBytes: bytes(m) })
      else if (roots.length) changed.push({ sku: m.sku, roots, changeOnlyBytes: bytes({ ...m, attributes: Object.fromEntries(roots.map(k => [k, A[k] ?? null])) }) })
    }
    const changeOnlyBytes = changed.reduce((n, c) => n + c.changeOnlyBytes, 0)
    report.diff = { changedMessages: changed.length, changed, changeOnlyBytes, wholeFeedBytes: (report.after as any).feedBytes,
      changeOnlyShare: Number((changeOnlyBytes / (report.after as any).feedBytes).toFixed(4)),
      unchangedMessagesResent: (report.after as any).messageCount - changed.length }
    throw new Rollback()
  }))
} catch (error) {
  if (!(error instanceof Rollback)) report.error = error instanceof Error ? error.stack?.split('\n').slice(0, 14).join('\n') : String(error)
}
if (listingBefore) {
  const now = await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () =>
    prisma.channelListing.findUniqueOrThrow({ where: { id: (listingBefore as any).id } }))
  report.rolledBack = JSON.stringify(now.overrideData) === JSON.stringify((listingBefore as any).overrideData) && now.version === (listingBefore as any).version
}
report.networkAttempts = network
console.log(`REPORT ${JSON.stringify(report)}`)
process.exit(0)
