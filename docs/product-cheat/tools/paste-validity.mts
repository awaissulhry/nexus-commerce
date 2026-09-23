// Step 3.6 — does the SERVER refuse a pasted value over a cap or off a closed list? LOCAL ONLY, rolled back, no network.
//   cd apps/api && npx tsx ../../docs/product-cheat/tools/paste-validity.mts [--sku xavia-knee-slider]
process.env.REDIS_URL = 'redis://127.0.0.1:1'
process.env.NEXUS_DISABLE_BACKGROUND_JOBS = '1'
process.env.ENABLE_QUEUE_WORKERS = '0'
const network: string[] = []
globalThis.fetch = (async (input: unknown) => { network.push(String(input)); throw new Error(`paste-validity: network refused (${String(input)})`) }) as typeof fetch
const API = '/Users/awais/nexus-commerce/apps/api/src'
const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const SKU = flag('sku') ?? 'xavia-knee-slider'
await import(`${API}/env.js`)
const host = new URL(process.env.DATABASE_URL ?? 'postgres://unknown/').hostname
if (host !== '127.0.0.1') { console.error(`REFUSE: database host ${host} is not local`); process.exit(1) }
const { default: prisma } = await import(`${API}/db.js`)
const { inDatabaseTransaction } = await import(`${API}/lib/database-context.js`)
const { withWorkspace, LEGACY_WORKSPACE_ID } = await import(`${API}/lib/workspace-context.js`)
const { applyProductBulkEdits } = await import(`${API}/services/products/bulk-edit.service.js`)
const { resolveBatch } = await import(`${API}/services/pim/mapping/resolve-batch.service.js`)

class Rollback extends Error {}
const report: Record<string, unknown> = { sku: SKU, database: host }
let listingId = '', before = ''
try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () => inDatabaseTransaction(prisma, async () => {
    const root = await prisma.product.findFirstOrThrow({ where: { sku: SKU, deletedAt: null, parentId: null } })
    const child = await prisma.product.findFirstOrThrow({ where: { parentId: root.id, deletedAt: null }, orderBy: { sku: 'asc' } })
    const listing = await prisma.channelListing.findFirstOrThrow({ where: { productId: child.id, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', channelConnectionId: { not: null } } })
    listingId = listing.id; before = JSON.stringify(listing.overrideData)
    const resolved = await resolveBatch({ channel: 'AMAZON', marketplace: 'IT', channelConnectionId: listing.channelConnectionId!, aliasKey: '', productIds: [child.id], includeCatalogue: true })
    const fields = (resolved.catalogue?.fields ?? []).filter((f: any) => !f.sourceOwner && !f.channelStore && f.schemaKnown !== false && f.shape !== 'list')
    const capped = fields.find((f: any) => f.maxLength && !(f.options?.length))
    const closed = fields.find((f: any) => f.options?.length && f.kind !== 'boolean')
    report.fields = { capped: capped && { key: capped.fieldKey, maxLength: capped.maxLength }, closed: closed && { key: closed.fieldKey, options: closed.options.length } }
    const ctx = { formulaCascade: false, logger: { warn: () => undefined, error: () => undefined } }
    const write = async (changes: Array<{ field: string; value: unknown }>) => {
      const fresh = await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })
      try {
        const r: any = await applyProductBulkEdits({ changes: changes.map(c => ({ id: child.id, target: 'channel', ...c })),
          marketplaceContexts: [{ channel: 'AMAZON', marketplace: 'IT', accountId: listing.channelConnectionId }], expectedVersion: fresh.version } as never, ctx)
        return { success: r.success ?? true, updated: r.updated, errors: r.errors }
      } catch (error: any) { return { threw: error?.statusCode ?? String(error), details: error?.details ?? error?.message } }
    }
    const stored = async (key: string) => ((await prisma.channelListing.findUniqueOrThrow({ where: { id: listing.id } })).overrideData as any)?.[key]
    const over = 'X'.repeat((capped?.maxLength ?? 100) + 1)
    report.a_overCap = capped ? { result: await write([{ field: `attr_${capped.sheetKey ?? capped.fieldKey}`, value: over }]), stored: (await stored(capped.sheetKey ?? capped.fieldKey)) === over } : 'no capped field'
    report.b_offList = closed ? { result: await write([{ field: `attr_${closed.sheetKey ?? closed.fieldKey}`, value: 'NOT-ON-THE-LIST-3.6' }]), stored: (await stored(closed.sheetKey ?? closed.fieldKey)) === 'NOT-ON-THE-LIST-3.6' } : 'no closed field'
    const valid = 'VALID-3.6-CONTROL'
    report.c_valid = capped ? { result: await write([{ field: `attr_${capped.sheetKey ?? capped.fieldKey}`, value: valid }]), stored: (await stored(capped.sheetKey ?? capped.fieldKey)) === valid } : 'no capped field'
    const valid2 = 'VALID-3.6-MIXED'
    report.d_mixed = capped && closed ? { result: await write([{ field: `attr_${capped.sheetKey ?? capped.fieldKey}`, value: valid2 }, { field: `attr_${closed.sheetKey ?? closed.fieldKey}`, value: 'NOT-ON-THE-LIST-3.6' }]),
      validStored: (await stored(capped.sheetKey ?? capped.fieldKey)) === valid2 } : 'n/a'
    throw new Rollback()
  }))
} catch (error) { if (!(error instanceof Rollback)) report.error = error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : String(error) }
if (listingId) report.rolledBack = JSON.stringify((await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, () => prisma.channelListing.findUniqueOrThrow({ where: { id: listingId } }))).overrideData) === before
report.networkAttempts = network
console.log(`REPORT ${JSON.stringify(report)}`)
process.exit(0)
