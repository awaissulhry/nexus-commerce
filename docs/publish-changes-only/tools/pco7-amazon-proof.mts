/** PCO-7: one existing Amazon IT keyword canary, with restoration. Main session alone runs production modes.
 *   npx tsx docs/publish-changes-only/tools/pco7-amazon-proof.mts
 *   npx tsx docs/publish-changes-only/tools/pco7-amazon-proof.mts --prepare
 *   npx tsx docs/publish-changes-only/tools/pco7-amazon-proof.mts --execute-approved --proposal <path> --digest <sha256>
 * Default is PLAN. Preparation makes catalog/schema reads in BEGIN READ ONLY, canonical listing GETs and validation
 * previews. Canonical clients can record normal OAuth refresh/leases and gateway logs. No catalog content or queue edit.
 * Execution requires the Owner's per-run word for this exact proposal. It sends at most one canary and one restore feed.
 * On the production server (`railway ssh`, no .env; since 2026-09-26 only the server can open the KMS-sealed channel logins)
 * the service's own settings are used; the same database-target check applies, and there is no git push to wait for.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { parse } from 'dotenv'
import pg from 'pg'

// The checkout this tool lives in, so the proof runs the code beside it (a fixed path ran a stale checkout).
const ROOT = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, ''), WORKSPACE = 'nexus_legacy_workspace'
const SERVER = process.env.RAILWAY_ENVIRONMENT_NAME === 'production' && !existsSync(`${ROOT}/.env`)
const SKU = 'GALE-JACKET-BLACK-MEN-S', MARKET = 'IT', MARKETPLACE_ID = 'APJ6JRA9NG5V4', ATTRIBUTE = 'generic_keyword', LANGUAGE = 'it_IT'
const args = process.argv.slice(2), prepare = args.includes('--prepare'), execute = args.includes('--execute-approved')
const arg = (key: string) => { const index = args.indexOf(`--${key}`); return index < 0 ? undefined : args[index + 1] }
if (prepare && execute) throw new Error('Choose prepare OR approved execution.')
console.log(JSON.stringify({ mode: execute ? 'execute-approved' : prepare ? 'prepare' : 'plan', sku: SKU, marketplace: MARKET, attribute: ATTRIBUTE,
  scope: 'One primary listing in nexus_legacy_workspace; one unique connected account is required.',
  sequence: ['read original', 'compile one language-scoped keyword change', 'validate send and restore', 'Owner reviews proposal/digest', 'send once', 'conclusive processing report', 'read back', 'restore once', 'conclusive restore report', 'read back', 'delayed read after 60 seconds'],
  unknown: 'An unknown feed result never permits another send or a premature restore. Keep the receipt and read channel history.',
  prerequisite: 'Approved execution requires deployed ChannelListingSnapshot.outcome and acceptedAt. This tool never migrates.',
  audit: 'Request/audit helpers are reused; every proof snapshot has reason publish-proof before dispatch and throughout settlement.' }, null, 2))
if (!prepare && !execute) process.exit(0)

const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const same = (a: unknown, b: unknown) => digest(a) === digest(b)
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function noPush() {
  if (SERVER) return // the production container has no git, no push and no ps
  try {
    const output = execSync('ps -axo pid=,command= | /usr/bin/grep -E "^ *[0-9]+ (/[^ ]*/)?git push|^ *[0-9]+ /bin/bash \\.githooks/pre-push"', { encoding: 'utf8', shell: '/bin/zsh' })
    if (output.trim()) throw new Error('A push is active; no evidence file will be edited.')
  } catch (error: any) { if (error.status !== 1 || error.stderr?.toString().trim()) throw error }
}
const save = (path: string, value: unknown, exclusive = false) => { noPush(); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w', mode: 0o600 }) }
const env = SERVER ? process.env as Record<string, string> : parse(readFileSync(`${ROOT}/.env`, 'utf8')), database = new URL(env.DATABASE_URL)
if (database.hostname !== 'ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech' || database.pathname !== '/neondb') throw new Error('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|AWS_)/.test(key)) process.env[key] = value
Object.assign(process.env, { NEXUS_WORKSPACES_ENABLED: '1', NEXUS_DATABASE_POOL_MAX: '2', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: '0',
  NEXUS_ENABLE_AMAZON_PUBLISH: 'false', AMAZON_PUBLISH_MODE: 'dry-run', NEXUS_ENABLE_EBAY_PUBLISH: 'false', NEXUS_ENABLE_SHOPIFY_PUBLISH: 'false' })

async function readOnly<T>(read: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: env.DATABASE_URL, statement_timeout: 15_000 })
  await db.connect()
  try { await db.query('BEGIN READ ONLY'); await db.query("SELECT set_config('nexus.workspace_id', $1, true)", [WORKSPACE]); return await read(db) }
  finally { await db.query('ROLLBACK').catch(() => {}); await db.end() }
}
async function discover(expectedAccount?: string) {
  return readOnly(async db => {
    const rows = (await db.query(`SELECT to_jsonb(l) AS listing, p.sku AS "productSku"
      FROM "ChannelListing" l JOIN "Product" p ON p.id=l."productId" JOIN "ChannelConnection" c ON c.id=l."channelConnectionId"
      WHERE l."workspaceId"=$1 AND p."workspaceId"=$1 AND c."workspaceId"=$1 AND p.sku=$2
        AND l.channel='AMAZON' AND l.marketplace='IT' AND l."aliasKey"='' AND l."externalListingId" IS NOT NULL
        AND p."deletedAt" IS NULL AND c."isActive"=true AND ($3::text IS NULL OR c.id=$3)`, [WORKSPACE, SKU, expectedAccount ?? null])).rows
    if (rows.length !== 1) throw new Error(`Expected one exact primary Amazon IT listing; found ${rows.length}.`)
    const row = rows[0], listing = row.listing
    const offers = (await db.query('SELECT sku FROM "Offer" WHERE "workspaceId"=$1 AND "channelListingId"=$2 AND "isActive"=true', [WORKSPACE, listing.id])).rows
    const pa = listing.platformAttributes ?? {}, flat = listing.flatFileSnapshot ?? {}
    const identities = [...new Set([...offers.map(row => row.sku), pa.sellerSku, pa.seller_sku, pa.sku, pa.item_sku, flat.item_sku].filter(Boolean))]
    if (identities.length > 1 || (identities.length && identities[0] !== SKU)) throw new Error('The exact Amazon seller SKU is ambiguous or differs from the canary SKU.')
    if (execute) {
      const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ChannelListingSnapshot' AND column_name IN ('outcome','acceptedAt')`)).rows
      if (columns.length !== 2) throw new Error('Deploy the additive PCO receipt migration before approved execution. Nothing was sent.')
    }
    return listing
  })
}
async function cachedSchema(productType: string) {
  return readOnly(async db => {
    const rows = (await db.query(`SELECT "schemaDefinition", "schemaVersion", to_char("fetchedAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "fetchedAt"
      FROM "CategorySchema" WHERE "workspaceId"=$1 AND channel='AMAZON' AND marketplace='IT' AND "productType"=$2 AND "isActive"=true
      ORDER BY "fetchedAt" DESC LIMIT 1`, [WORKSPACE, productType])).rows
    if (rows.length !== 1) throw new Error('The exact product-type schema is not cached. Refresh it separately; this proof does not refresh schemas.')
    return rows[0]
  })
}

const { default: prisma } = await import(`${ROOT}/apps/api/src/db.js`)
const { withWorkspace } = await import(`${ROOT}/apps/api/src/lib/workspace-context.js`)
const { withCachedSchemas } = await import(`${ROOT}/apps/api/src/services/pim/cached-schema-context.js`)
await import(`${ROOT}/apps/api/src/services/cx/connectors/index.js`)
const { assertPushAllowed } = await import('@nexus/shared/push-lock')
const { AmazonSpApiClient } = await import(`${ROOT}/apps/api/src/clients/amazon-sp-api.client.js`)
const { getAmazonSellerId, getAmazonRegion } = await import(`${ROOT}/apps/api/src/lib/amazon-sp-client.js`)
const { amazonSpecFromDefinition } = await import(`${ROOT}/apps/api/src/services/pim/channel-specs/amazon.js`)
const { amazonRootPatch } = await import(`${ROOT}/apps/api/src/services/amazon/mapping-payload.js`)
const { prepareAmazonChanges, compileAmazonChanges, amazonContentField } = await import(`${ROOT}/apps/api/src/services/pim/studio-publication-amazon-changes.js`)
let report: any = null, reportPath: string | null = null
function checkpoint() {
  if (!report || !reportPath) return
  // Evidence-file contention must not prevent an already authorized cleanup. Stdout retains the receipt.
  try { save(reportPath, report) } catch (error) { report.evidenceWriteError = (error as Error).message }
  console.log(JSON.stringify({ stage: report.stage, sendFeed: report.send?.feedId, restoreFeed: report.restore?.feedId, error: report.error ?? null }))
}
const safety = setTimeout(() => { if (report) { report.error = 'Safety deadline reached; outcome UNKNOWN. Do not resend. Read the saved feed receipt/channel history.'; checkpoint() }; console.error('PCO-7 deadline: UNKNOWN; no automatic retry.'); process.exit(2) }, execute ? 20 * 60_000 : 180_000)
safety.unref()
try {
  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, () => withCachedSchemas(async () => {
    const path = execute ? resolve(arg('proposal') ?? '') : `${ROOT}/docs/publish-changes-only/records/pco7-amazon-proposal-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    let proposal: any
    if (execute) {
      if (!arg('proposal') || !/^[a-f0-9]{64}$/.test(arg('digest') ?? '')) throw new Error('Approved execution requires the exact proposal path and SHA-256 digest.')
      const { digest: recordedDigest, ...body } = JSON.parse(readFileSync(path, 'utf8'))
      if (recordedDigest !== arg('digest') || digest(body) !== recordedDigest) throw new Error('Proposal digest mismatch.')
      if (body.kind !== 'pco7-amazon-proof' || body.proposalPath !== path || body.scope?.workspaceId !== WORKSPACE || body.scope?.sku !== SKU || body.scope?.marketplace !== MARKET || body.scope?.marketplaceId !== MARKETPLACE_ID || body.scope?.aliasKey !== '' || body.attribute !== ATTRIBUTE) throw new Error('Proposal scope mismatch.')
      if (!Number.isFinite(Date.parse(body.preparedAt)) || Date.now() < Date.parse(body.preparedAt) || Date.now() - Date.parse(body.preparedAt) > 2 * 60 * 60_000) throw new Error('Proposal expired; prepare and review a fresh proposal.')
      proposal = body
    }
    const listing = await discover(proposal?.scope.accountId)
    const refusal = assertPushAllowed(listing)
    if (refusal) throw new Error(refusal.sentence)
    const accountId = listing.channelConnectionId, sellerId = await getAmazonSellerId(accountId), region = await getAmazonRegion(accountId)
    const client = new AmazonSpApiClient({ id: accountId, region })
    async function readRoot() {
      const response = await client.getListingsItem({ sellerId, sku: SKU, marketplaceId: MARKETPLACE_ID, includedData: ['summaries', 'attributes'] })
      const raw = response.rawResponse as any, summary = raw?.summaries?.find((summary: any) => summary.marketplaceId === MARKETPLACE_ID)
      if (!response.success || raw?.sku !== SKU || !response.asin || response.asin !== listing.externalListingId || !summary?.productType || !raw.attributes) throw new Error('The canonical Amazon read did not confirm this exact seller SKU, ASIN, marketplace and attributes.')
      const root = raw.attributes[ATTRIBUTE] ?? null
      if (root !== null && (!Array.isArray(root) || root.some((entry: any) => !entry || typeof entry.value !== 'string' || typeof entry.language_tag !== 'string' || entry.marketplace_id !== MARKETPLACE_ID))) throw new Error('The keyword selector/value shape is not safe for this proof.')
      return { productType: summary.productType, root, at: new Date().toISOString() }
    }
    const before = await readRoot(), cached = await cachedSchema(before.productType)
    const spec = amazonSpecFromDefinition({ marketplace: MARKET, productType: before.productType, schemaDefinition: cached.schemaDefinition })
    const scope = { workspaceId: WORKSPACE, productId: listing.productId, listingId: listing.id, accountId, aliasKey: listing.aliasKey, sku: SKU, marketplace: MARKET, marketplaceId: MARKETPLACE_ID, sellerId, asin: listing.externalListingId, productType: before.productType }
    const token = proposal?.token ?? `nexuspco20260925${randomUUID().replace(/-/g, '').slice(0, 8)}`
    if (!/^nexuspco20260925[a-f0-9]{8}$/.test(token)) throw new Error('Unexpected canary token.')
    const original = (before.root ?? []) as any[], italian = original.filter(entry => entry.language_tag === LANGUAGE)
    const desired = italian.length ? italian.map((entry, index) => index === 0 ? { ...entry, value: `${entry.value} ${token}`.trim() } : entry)
      : [{ value: token, marketplace_id: MARKETPLACE_ID, language_tag: LANGUAGE }]
    const publication = { kind: 'amazon' as const, sellerId, marketplaceId: MARKETPLACE_ID, products: [{ productId: listing.productId, sku: SKU }],
      feed: { header: { sellerId, version: '2.0', issueLocale: 'it_IT' }, messages: [{ messageId: 1, sku: SKU, productType: before.productType, operationType: 'PARTIAL_UPDATE', attributes: { [ATTRIBUTE]: desired } }] } }
    const restore = { ...publication, feed: { ...publication.feed, messages: [{ messageId: 1, sku: SKU, productType: before.productType, operationType: 'PATCH',
      patches: [original.length ? amazonRootPatch(spec, ATTRIBUTE, original) : amazonRootPatch(spec, ATTRIBUTE, undefined, desired)] }] } }
    async function validate(plan: any) {
      const message = plan.feed.messages[0]
      const checked = await client.validateListing({ sellerId, sku: SKU, marketplaceId: MARKETPLACE_ID, productType: before.productType, patches: message.patches })
      if (!checked.available || !checked.ok) throw new Error(`Amazon validation refused: ${checked.errors ?? 'preview unavailable'}`)
      return { available: checked.available, ok: checked.ok }
    }
    if (prepare) {
      const facts = { scope: { channel: 'AMAZON', marketplace: MARKET, accountId }, destination: { aliasKey: listing.aliasKey }, parent: { id: listing.productId, sku: SKU },
        products: [{ id: listing.productId, sku: SKU }], listings: [listing], languages: ['it'], resolved: [] }
      const plan = await prepareAmazonChanges(facts as any, publication, new Map())
      const field = amazonContentField(ATTRIBUTE, MARKETPLACE_ID, LANGUAGE), change = plan.changes.find((change: any) => change.field === field)
      if (!change?.selectable || change.selectedByDefault || plan.changes.length !== 1) throw new Error('The sparse compiler did not produce exactly one explicit keyword choice.')
      const send = compileAmazonChanges(plan, [change.id]), temporaryRoot = send.feed.messages[0].patches?.[0]?.value
      const expectedTemporary = [...desired, ...original.filter(entry => entry.language_tag !== LANGUAGE)]
      if (send.feed.messages.length !== 1 || send.feed.messages[0].patches?.length !== 1 || send.feed.messages[0].patches[0].path !== `/attributes/${ATTRIBUTE}` || !same(temporaryRoot, expectedTemporary)) throw new Error('The compiled canary differs from the one-field proposal.')
      proposal = { kind: 'pco7-amazon-proof', proposalPath: path, preparedAt: new Date().toISOString(), scope, attribute: ATTRIBUTE, token, schemaDigest: digest(cached.schemaDefinition),
        originalRoot: before.root, originalDigest: digest(before.root), temporaryRoot, send, restore,
        preview: { send: await validate(send), restore: await validate(restore) }, delayedReadSeconds: 60 }
      const sha = digest(proposal)
      save(path, { ...proposal, digest: sha }, true)
      console.log(JSON.stringify({ proposal: path, digest: sha, scope, before: proposal.originalRoot, temporary: temporaryRoot, restore: restore.feed.messages[0].patches, preview: proposal.preview }, null, 2))
      return
    }
    if (!same(scope, proposal.scope) || !same(before.root, proposal.originalRoot) || digest(before.root) !== proposal.originalDigest || digest(cached.schemaDefinition) !== proposal.schemaDigest || !same(restore, proposal.restore)) throw new Error('The listing scope, original value, or cached schema changed since preparation. Nothing was sent.')
    const expectedTemporary = [...desired, ...original.filter(entry => entry.language_tag !== LANGUAGE)]
    const send = proposal.send, message = send?.feed?.messages?.[0]
    if (!same(proposal.temporaryRoot, expectedTemporary) || send.sellerId !== sellerId || send.marketplaceId !== MARKETPLACE_ID || send.feed.messages.length !== 1 || message.sku !== SKU || message.productType !== before.productType || message.operationType !== 'PATCH'
      || message.patches?.length !== 1 || message.patches[0].op !== 'replace' || message.patches[0].path !== `/attributes/${ATTRIBUTE}` || !same(message.patches[0].value, expectedTemporary)) throw new Error('The saved canary payload does not match the exact one-field scope.')
    await validate(send); await validate(restore)
    const run = `pco7-amazon-${arg('digest')!.slice(0, 32)}`, phaseIds = [`${run}-send`, `${run}-restore`]
    if (await prisma.channelListingSnapshot.count({ where: { publishEventId: { in: phaseIds } } })) throw new Error('This proposal already has a request journal. Do not resend; inspect its saved receipt.')
    reportPath = `${path}.execution.json`
    if (existsSync(reportPath)) throw new Error('This proposal was already started. An interrupted run must be reconciled, never blindly retried.')
    report = { proposal: path, digest: arg('digest'), scope, startedAt: new Date().toISOString(), stage: 'approved-preflight-complete', send: {}, restore: {} }
    save(reportPath, report, true)
    const { sendAmazonPublication, readAmazonPublication } = await import(`${ROOT}/apps/api/src/services/pim/studio-publication-amazon.js`)
    const { recordPublicationRequests, settlePublicationRecords } = await import(`${ROOT}/apps/api/src/services/pim/studio-publication-records.js`)
    async function settle(phase: 'send' | 'restore', result: any) {
      const context = { reviewId: `${run}-${phase}`, userId: null, channel: 'AMAZON', marketplace: MARKET, accountId, aliasKey: listing.aliasKey }
      try {
        await prisma.$transaction(async tx => {
          // Only the helper's journal lookup changes scope; its locks, acceptance rules and audit updates remain intact.
          const proofTx = new Proxy(tx, { get(target, key) {
            if (key !== 'channelListingSnapshot') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value }
            return new Proxy(target.channelListingSnapshot, { get(model, method) {
              if (method === 'findMany') return (args: any) => model.findMany({ ...args, where: { ...args.where, reason: 'publish-proof' } })
              const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value
            } })
          } })
          await settlePublicationRecords(proofTx, context, result)
        })
      } catch (error) { report[phase].auditError = (error as Error).message }
    }
    async function dispatchAndConclude(phase: 'send' | 'restore', plan: any) {
      const id = `${run}-${phase}`, context = { reviewId: id, userId: null, channel: 'AMAZON', marketplace: MARKET, accountId, aliasKey: listing.aliasKey }
      report.stage = `${phase}-starting`; report[phase].startedAt = new Date().toISOString(); checkpoint()
      const feedId = await sendAmazonPublication(plan, accountId, async request => {
        await recordPublicationRequests(context, [{ productId: listing.productId, sku: SKU, request: { proof: true, phase, ...request } }])
        const changed = await prisma.channelListingSnapshot.updateMany({ where: { publishEventId: id, channelListingId: listing.id, outcome: 'UNACCEPTED' }, data: { reason: 'publish-proof' } })
        if (changed.count !== 1 || await prisma.channelListingSnapshot.count({ where: { publishEventId: id, reason: 'publish-proof', channelListingId: listing.id } }) !== 1) throw new Error('The proof journal was not isolated before dispatch.')
      })
      report[phase].feedId = feedId; report.stage = `${phase}-submitted`; checkpoint()
      await settle(phase, { id, status: 'SUBMITTED', message: 'Proof feed submitted', results: [{ sku: SKU, status: 'SUBMITTED', reference: feedId, message: 'Awaiting processing report' }] })
      const until = Date.now() + 6 * 60_000
      while (Date.now() < until) {
        const result = await readAmazonPublication(feedId, accountId, [SKU]).catch(error => { report[phase].lastReadError = (error as Error).message; return null })
        if (result) {
          report[phase].processingReport = result; report[phase].conclusive = true; checkpoint()
          const failed = result.results[0].failed
          await settle(phase, { id, status: failed ? 'FAILED' : 'ACCEPTED', message: 'Conclusive proof processing report', results: [{ sku: SKU, status: failed ? 'FAILED' : 'ACCEPTED', reference: feedId, message: result.results[0].message }] })
          return !failed
        }
        await pause(15_000)
      }
      throw new Error(`${phase} feed ${feedId} is still unresolved. No retry or premature restore is permitted; inspect this receipt.`)
    }
    async function observe(want: unknown) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const now = await readRoot()
        if (same(now.root ?? [], want ?? [])) return { matched: true, ...now }
        if (attempt < 11) await pause(15_000)
      }
      return { matched: false, ...await readRoot() }
    }
    Object.assign(process.env, { NEXUS_ENABLE_AMAZON_PUBLISH: 'true', AMAZON_PUBLISH_MODE: 'live' })
    const accepted = await dispatchAndConclude('send', send)
    if (!accepted) throw new Error('Amazon rejected the canary. Its conclusive report is saved; no automatic second send was made.')
    report.canaryRead = await observe(proposal.temporaryRoot); report.stage = 'canary-read-complete'; checkpoint()
    const beforeRestore = await readRoot()
    if (!same(beforeRestore.root ?? [], proposal.temporaryRoot ?? []) && !same(beforeRestore.root ?? [], proposal.originalRoot ?? [])) throw new Error('Keyword content changed independently during the proof. The saved restore is held for review.')
    if (!await dispatchAndConclude('restore', restore)) throw new Error('Amazon rejected restoration. Keep the restore receipt and inspect the listing; never resend blindly.')
    report.restoreRead = await observe(proposal.originalRoot); report.stage = 'restore-read-complete'; checkpoint()
    await pause(30_000); await pause(30_000)
    report.delayedRead = await readRoot()
    report.delayedMatched = same(report.delayedRead.root ?? [], proposal.originalRoot ?? [])
    report.ok = report.canaryRead.matched && report.restoreRead.matched && report.delayedMatched && !report.send.auditError && !report.restore.auditError
    report.stage = report.ok ? 'complete-restored' : 'needs-review'; report.completedAt = new Date().toISOString(); checkpoint()
    if (!report.ok) throw new Error('The proof did not pass every read-back/audit check. Inspect the evidence; no success is claimed.')
  }))
} catch (error) {
  if (report) { report.error = (error as Error).message; report.ok = false; checkpoint() }
  console.error(JSON.stringify({ error: (error as Error).message, report: reportPath, unknownIsNotSuccess: true })); process.exitCode = 1
} finally {
  process.env.NEXUS_ENABLE_AMAZON_PUBLISH = 'false'; process.env.AMAZON_PUBLISH_MODE = 'dry-run'
  clearTimeout(safety); await prisma.$disconnect().catch(() => {})
}
console.log(JSON.stringify({ mode: prepare ? 'prepare' : 'execute-approved', report: reportPath, ok: report?.ok ?? process.exitCode !== 1 }))
process.exit(process.exitCode ?? 0)
