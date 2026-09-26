/** PE P3.8 — ONE eBay Inventory-model listing: append a hidden HTML comment to the group description through the real
 *  change-only sender (studio-publication-ebay-inventory.ts), read back the group AND the listing buyers see, restore the exact
 *  original group, read back, re-read 60 s later. No offer, price, stock, publish or delete call.
 *
 *    npx tsx docs/publish-everywhere/tools/ebay-inventory-proof.mts --prepare [--family=normal-knee-slider] [--market=IT]
 *    npx tsx docs/publish-everywhere/tools/ebay-inventory-proof.mts --execute-approved --proposal <file> --digest <sha256>
 *
 *  Prepare = BEGIN READ ONLY discovery + live reads (may refresh an OAuth token / write gateway call logs). Execution needs the
 *  Owner's word for THIS digest. Journals carry reason `publish-proof` (never a normal accepted baseline). Unknown = stop, no
 *  blind retry. Since 2026-09-26 channel logins are KMS-sealed: run it on the production server (`railway ssh`, no .env).
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
const SERVER = process.env.RAILWAY_ENVIRONMENT_NAME === 'production' && !existsSync(join(ROOT, '.env'))
const WORKSPACE = 'nexus_legacy_workspace', TTL_MS = 2 * 60 * 60_000, DELAY_MS = 60_000
const args = process.argv.slice(2), arg = (key: string) => args.find(a => a.startsWith(`--${key}=`))?.split('=')[1] ?? (args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : undefined)
const prepare = args.includes('--prepare'), execute = args.includes('--execute-approved')
const FAMILY = arg('family') ?? 'normal-knee-slider', MARKET = (arg('market') ?? 'IT').toUpperCase()
if (!prepare && !execute) { console.log('Prepare: --prepare [--family=SKU] [--market=IT]; after the Owner approves: --execute-approved --proposal FILE --digest SHA256'); process.exit(0) }
if (prepare && execute) throw new Error('Choose preparation or an approved execution, never both.')

const canonical = (value: unknown) => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const { parse } = await import('dotenv')
const env = SERVER ? process.env as Record<string, string> : parse(readFileSync(join(ROOT, '.env'), 'utf8'))
const target = new URL(env.DATABASE_URL)
if (!/neon\.tech$/.test(target.hostname) || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [k, v] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|EBAY_|AWS_|REDIS_)/.test(k)) process.env[k] = v
Object.assign(process.env, { NEXUS_WORKSPACES_ENABLED: '1', NEXUS_DATABASE_POOL_MAX: '2', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: '0',
  NEXUS_EBAY_REAL_API: 'true', EBAY_SANDBOX: 'false', NEXUS_ENABLE_EBAY_PUBLISH: 'false', NEXUS_ENABLE_AMAZON_PUBLISH: 'false', NEXUS_ENABLE_SHOPIFY_PUBLISH: 'false', NEXUS_ENABLE_ETSY_PUBLISH: 'false' })
const safety = setTimeout(() => { console.error(JSON.stringify({ error: 'Deadline reached: outcome UNKNOWN. Do not resend; read the listing and the run file.' })); process.exit(2) }, 20 * 60_000)
safety.unref()

async function discover() {
  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: env.DATABASE_URL, statement_timeout: 15_000 })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    if ((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Error('Discovery is not read only.')
    await db.query("SELECT set_config('nexus.workspace_id', $1, true)", [WORKSPACE])
    const rows = (await db.query(`SELECT p.id, p.sku, p."parentId", l.id AS "listingId", l."externalListingId" AS item, l."channelConnectionId" AS account, l."aliasKey",
        l."listingStatus", l."syncPaused", coalesce(l."platformAttributes" ? '__offerIds', false) AS marked
      FROM "Product" f JOIN "Product" p ON (p.id=f.id OR p."parentId"=f.id) AND p."deletedAt" IS NULL
      JOIN "ChannelListing" l ON l."productId"=p.id AND l.channel='EBAY' AND l.marketplace=$3 AND l."aliasKey"=''
      WHERE f.sku=$2 AND f."parentId" IS NULL AND f."deletedAt" IS NULL AND f."workspaceId"=$1`, [WORKSPACE, FAMILY, MARKET])).rows
    const parent = rows.find(r => !r.parentId), children = rows.filter(r => r.parentId)
    const items = new Set(rows.map(r => r.item)), accounts = new Set(rows.map(r => r.account))
    if (!parent || !children.length || items.size !== 1 || !parent.item || accounts.size !== 1) throw new Error('Expected one primary eBay item for this family, one account, parent + children.')
    if (!children.every(c => c.marked) || rows.some(r => r.syncPaused || r.listingStatus !== 'ACTIVE')) throw new Error('Every child must be Inventory-marked and every listing active and unpaused.')
    return { parent: { productId: parent.id, sku: parent.sku, listingId: parent.listingId }, children: children.map(c => ({ productId: c.id, sku: c.sku })).sort((a, b) => a.sku.localeCompare(b.sku)),
      itemId: parent.item as string, accountId: parent.account as string }
  } finally { await db.query('ROLLBACK').catch(() => {}); await db.end() }
}

const { withWorkspace } = await import(join(ROOT, 'apps/api/src/lib/workspace-context.js'))
await import(join(ROOT, 'apps/api/src/services/cx/connectors/index.js'))
const { default: prisma } = await import(join(ROOT, 'apps/api/src/db.js'))
const { readEbayInventoryListing } = await import(join(ROOT, 'apps/api/src/services/live-read/ebay-inventory.js'))
const { ebayInventoryReads, sendEbayInventoryGroup } = await import(join(ROOT, 'apps/api/src/services/pim/studio-publication-ebay-inventory.js'))
const { ebayXmlText } = await import(join(ROOT, 'apps/api/src/services/channel-drift/ebay-content-compare.js'))
const RECORDS = join(ROOT, 'docs/publish-changes-only/records')
let exitCode = 0
try {
  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const found = await discover()
    const destination = { productId: found.parent.productId, channel: 'EBAY' as const, marketplace: MARKET, accountId: found.accountId, aliasKey: '',
      expectedSkus: found.children.map(c => c.sku), itemId: found.itemId, parentSku: found.parent.sku }
    const reads = ebayInventoryReads(found.accountId, MARKET, found.itemId)
    const read = async () => {
      const live = await readEbayInventoryListing(destination, reads)
      if (!live.raw.group || !live.revision || live.raw.groupKey !== found.parent.sku) throw new Error(`The live group could not be read exactly: ${JSON.stringify(live.errors)}`)
      if (live.variations?.variants.some(v => v.state !== 'live')) throw new Error('The live group and Nexus disagree on the variants; this proof needs an exact match.')
      return live
    }
    if (prepare) {
      const before = await read(), group = before.raw.group as Record<string, unknown>
      const description = String(group.description ?? '')
      if (!description.trim()) throw new Error('The live group has no description to extend.')
      const comment = `<!-- nexuspe${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${randomUUID().replace(/-/g, '')} -->`
      const proposal = { kind: 'pe-ebay-inventory-proof', version: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
        database: { host: target.hostname, name: target.pathname }, destination, found, groupKey: found.parent.sku, beforeRevision: before.revision,
        originalGroup: group, temporaryGroup: { ...group, description: description + comment }, comment,
        listingTitle: ebayXmlText((before.raw.item as any)?.Title), readSideEffects: 'Reads only; OAuth refresh and gateway call logs possible.' }
      const path = join(RECORDS, `pe-ebay-inventory-proof-${proposal.createdAt.replace(/[:.]/g, '-')}.json`), checksum = digest(proposal)
      writeFileSync(path, JSON.stringify({ proposal, digest: checksum }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      console.log(JSON.stringify({ proposalPath: path, digest: checksum, family: FAMILY, market: MARKET, variants: found.children.length, groupKey: proposal.groupKey,
        change: 'group description + one hidden HTML comment (not shown to buyers)', comment, originalDescription: { bytes: Buffer.byteLength(description), sha256: sha(description) },
        temporaryDescription: { bytes: Buffer.byteLength(description + comment), sha256: sha(description + comment) }, untouched: 'title, pictures, aspects, variants, variesBy, offers, price, stock',
        expiresAt: proposal.expiresAt, next: 'The Owner approves this exact digest; then --execute-approved.' }, null, 2))
      return
    }
    const proposalPath = resolve(arg('proposal') ?? ''), stored = JSON.parse(readFileSync(proposalPath, 'utf8')), proposal = stored.proposal
    if (!proposalPath.startsWith(RECORDS) || stored.digest !== arg('digest') || digest(proposal) !== stored.digest || proposal.kind !== 'pe-ebay-inventory-proof') throw new Error('Proposal/digest mismatch.')
    if (Date.parse(proposal.expiresAt) <= Date.now()) throw new Error('Proposal expired; prepare and review a fresh one.')
    if (canonical(proposal.found) !== canonical(found) || proposal.database.host !== target.hostname) throw new Error('The listing coordinate changed since preparation. Nothing was sent.')
    const runPath = proposalPath.replace(/\.json$/, '.run.json')
    if (existsSync(runPath)) throw new Error('This proposal was already started. Reconcile it; never rerun blindly.')
    const run: any = { proposalPath, digest: stored.digest, startedAt: new Date().toISOString(), events: [] }
    const checkpoint = (event: string, details: unknown = {}) => { run.events.push({ at: new Date().toISOString(), event, details }); writeFileSync(runPath, JSON.stringify(run, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ event, details })) }
    checkpoint('started')
    const before = await read()
    if (before.revision !== proposal.beforeRevision || canonical(before.raw.group) !== canonical(proposal.originalGroup)) throw new Error('The live group changed since preparation. Nothing was sent.')
    Object.assign(process.env, { NEXUS_ENABLE_EBAY_PUBLISH: 'true', EBAY_PUBLISH_MODE: 'live' })
    const { recordPublicationRequests, settlePublicationRecords } = await import(join(ROOT, 'apps/api/src/services/pim/studio-publication-records.js'))
    const owner = { productId: found.parent.productId, sku: found.parent.sku }
    async function step(phase: 'temporary' | 'restore', group: Record<string, unknown>, expectedRevision: string) {
      const operationId = `pe-ebay-inventory-${stored.digest.slice(0, 24)}-${phase}`
      const context = { reviewId: operationId, userId: null, channel: 'EBAY', marketplace: MARKET, accountId: found.accountId, aliasKey: '' }
      const receipt = await sendEbayInventoryGroup({ destination, groupKey: proposal.groupKey, group, expectedRevision, fields: ['description'], reads,
        beforeSend: async (request: unknown) => {
          await recordPublicationRequests(context, [{ ...owner, request: { intentVersion: 1, writes: [{ field: 'description', value: { state: 'value', value: group.description } }], request, proof: { digest: stored.digest, phase } } }])
          const marked = await prisma.channelListingSnapshot.updateMany({ where: { publishEventId: operationId, reason: 'publish', outcome: 'UNACCEPTED' }, data: { reason: 'publish-proof' } })
          if (marked.count !== 1) throw new Error('The proof journal was not isolated before the send.')
          checkpoint('journal-ready', { phase, operationId })
        } }).catch((error: any) => { checkpoint('send-stopped', { phase, notSent: error?.notSent === true, error: String(error?.message ?? error).slice(0, 300) }); throw error })
      const listingDescription = ebayXmlText((receipt.readBack?.raw.item as any)?.Description) ?? ''
      const groupMatches = canonical(receipt.readBack?.raw.group?.description) === canonical(group.description)
      const listingHasComment = listingDescription.includes(proposal.comment)
      // The official settle step, scoped to this proof's publish-proof rows: journal AND audit move together (as the Amazon proof).
      const result = { id: operationId, status: groupMatches ? 'VERIFIED' : 'UNVERIFIED', message: 'Proof read-back',
        results: [{ sku: owner.sku, status: groupMatches ? 'VERIFIED' : 'ACCEPTED', reference: proposal.groupKey, message: groupMatches ? 'Read back' : 'Read-back differs' }] }
      await prisma.$transaction(async (tx: any) => {
        const proofTx = new Proxy(tx, { get(target, key) {
          if (key !== 'channelListingSnapshot') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value }
          return new Proxy(target.channelListingSnapshot, { get(model, method) {
            if (method === 'findMany') return (q: any) => model.findMany({ ...q, where: { ...q.where, reason: 'publish-proof' } })
            const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value
          } })
        } })
        await settlePublicationRecords(proofTx, context, result)
      })
      checkpoint(`${phase}-read-back`, { groupMatches, listingHasComment, listingDescriptionBytes: Buffer.byteLength(listingDescription), senderVerified: receipt.verified, warnings: receipt.warnings })
      if (!groupMatches) throw new Error(`${phase}: the group read-back does not show the sent description. Stop; inspect the listing.`)
      return { receipt, listingHasComment }
    }
    const sent = await step('temporary', proposal.temporaryGroup, before.revision!)
    const middle = await read()
    if (canonical(middle.raw.group) !== canonical(proposal.temporaryGroup)) throw new Error('The group changed independently during the proof. The restore is held for review.')
    const restored = await step('restore', proposal.originalGroup, middle.revision!)
    await new Promise(r => setTimeout(r, DELAY_MS))
    const delayed = await read()
    const delayedOk = canonical(delayed.raw.group) === canonical(proposal.originalGroup)
    const listingClean = !String(ebayXmlText((delayed.raw.item as any)?.Description) ?? '').includes(proposal.comment)
    run.result = { temporaryListingShowedComment: sent.listingHasComment, restoreListingClean: !restored.listingHasComment, delayedGroupOriginal: delayedOk, delayedListingClean: listingClean,
      ok: delayedOk && !restored.listingHasComment && listingClean }
    checkpoint(run.result.ok ? 'complete-restored' : 'needs-review', run.result)
    if (!run.result.ok) exitCode = 1
  })
} catch (error) {
  exitCode = 1
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), unknownIsNotSuccess: true }))
} finally {
  process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'false'
  clearTimeout(safety); await prisma.$disconnect().catch(() => {})
}
process.exit(exitCode)
