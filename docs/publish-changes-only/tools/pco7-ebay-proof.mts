// PCO-7: ONE existing Trading IT item. Append one ASCII HTML comment to Description, then restore the exact original.
// Main alone runs production reads (R-40). A listing write needs the Owner's word for THIS digest.
// --prepare: BEGIN READ ONLY discovery + canonical GetItem + local compiled preview; no listing write.
// Canonical reads may refresh OAuth and write gateway audit rows. No Nexus content/queue write occurs.
// --execute-approved --proposal <file> --digest <sha256>: one send, verified read, one restore, delayed read.
// Unknown receipt/read-back STOPS (no duplicate retry); the run file retains operation/journal recovery IDs.
// Description uses full replacement; DescriptionReviseMode is deprecated/default Replace. Keep >12h conservatively.
// No buyer-visible text change is intended. A stripped comment fails the proof; local preview is not provider acceptance.
// https://developer.ebay.com/devzone/xml/docs/reference/ebay/ReviseFixedPriceItem.html#Request.Item.Description
// On the production server (`railway ssh`, no .env; since 2026-09-26 only the server can open the KMS-sealed channel logins)
// the service's own settings are used; the same database-target check applies, and there is no git push to wait for.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { parse } from 'dotenv'
import pg from 'pg'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)), RECORDS = join(ROOT, 'docs/publish-changes-only/records')
const SERVER = process.env.RAILWAY_ENVIRONMENT_NAME === 'production' && !existsSync(join(ROOT, '.env'))
const WORKSPACE = 'nexus_legacy_workspace', TTL_MS = 2 * 60 * 60_000, DELAY_MS = 60_000
const { values: args } = parseArgs({ options: { prepare: { type: 'boolean' }, 'execute-approved': { type: 'boolean' },
  proposal: { type: 'string' }, digest: { type: 'string' }, listing: { type: 'string' } }, strict: true })
if (!args.prepare && !args['execute-approved']) {
  console.log('Prepare: npx tsx docs/publish-changes-only/tools/pco7-ebay-proof.mts --prepare [--listing ID]')
  console.log('After the Owner approves that digest: --execute-approved --proposal FILE --digest SHA256')
  process.exit(0)
}
if (args.prepare && args['execute-approved']) throw new Error('Choose preparation or an approved execution, never both.')
if (args['execute-approved'] && (!args.proposal || !/^[a-f0-9]{64}$/.test(args.digest ?? '') || args.listing)) throw new Error('Approved execution requires the proposal and its exact digest; no target override.')

class Refusal extends Error {}
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const sourceFiles = ['apps/api/src/services/pim/studio-publication-ebay.ts', 'apps/api/src/services/pim/studio-publication-ebay-changes.ts',
  'apps/api/src/services/channel-drift/ebay-content-compare.ts', 'apps/api/src/services/pim/studio-publication-changes.ts',
  'apps/api/src/services/pim/studio-publication-records.ts', 'docs/publish-changes-only/tools/pco7-ebay-proof.mts']
const sourceDigest = () => digest(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex')]))
function noPush() {
  if (SERVER) return // the production container has no git, no push and no ps
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (ps.status !== 0) throw new Refusal('The required push check failed.')
  const match = spawnSync('/usr/bin/grep', ['-E', '^ *[0-9]+ (/[^ ]*/)?git push|^ *[0-9]+ /bin/bash \\.githooks/pre-push'], { input: ps.stdout, encoding: 'utf8' })
  if (match.status !== 1 || match.stdout.trim() || match.stderr.trim()) throw new Refusal('A push is active or its check failed; no file or channel mutation is allowed.')
}
function recordPath(path: string) {
  const absolute = resolve(ROOT, path)
  if (!absolute.startsWith(RECORDS + sep) || !absolute.endsWith('.json')) throw new Refusal('Proof files must be JSON files in the PCO records directory.')
  return absolute
}
function save(path: string, data: unknown, exclusive = false) {
  noPush()
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w', mode: 0o600 })
}
// Never print a client exception's payload, stack, token, request headers or database URL.
const safeError = (error: unknown) => error instanceof Refusal ? error.message : `Client failure (${error instanceof Error ? error.name : 'unknown'}); inspect the saved operation IDs and canonical call audit.`

function assertPassiveDescription(description: string) {
  if (!description.trim()) throw new Refusal('The live description is empty or unavailable.')
  // Inspect decoded attributes for obvious active content; preserve the actual original string byte for byte.
  const decoded = description.replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (entity, digits: string) => {
    const code = parseInt(digits.replace(/^x/i, ''), /^x/i.test(digits) ? 16 : 10)
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity
  }).replace(/&colon;/gi, ':').replace(/&(?:tab|newline);/gi, ' ')
  if (/<\s*\/?\s*(?:script|form|object|embed|iframe|applet)\b/i.test(decoded)
    || /<[^>]*[\s/]on[a-z]+\s*=/i.test(decoded)
    || /(?:javascript|vbscript):/i.test(decoded.replace(/[\x00-\x20\x7f]/g, ''))) {
    throw new Refusal('The original description contains active HTML; this proof will not resubmit it.')
  }
}
function descriptionEvidence(description: string) {
  return { sha256: createHash('sha256').update(description, 'utf8').digest('hex'), bytes: Buffer.byteLength(description, 'utf8') }
}

type Target = { listingId: string; productId: string; accountId: string; aliasKey: string; workspaceId: string; itemId: string;
  nexusSku: string; listingVersion: number; productVersion: number; syncPaused: boolean; presenceIntent: string | null;
  offerClosedAt: string | null; endedAt: string | null; listingStatus: string; kind: 'standalone' | 'family'; participants: Participant[] }
type Participant = Pick<Target, 'listingId' | 'productId' | 'nexusSku' | 'listingVersion' | 'productVersion' | 'syncPaused' | 'presenceIntent' | 'offerClosedAt' | 'endedAt' | 'listingStatus'>
type Snapshot = { title: string; description: string; providerSku: string; revision: string; content: Record<string, unknown> }
type Request = { operation: string; xml: string }
type Proposal = { version: 1; kind: 'pco7-ebay-description-proof'; createdAt: string; expiresAt: string; sourceDigest: string; target: Target;
  database: { host: string; name: string };
  providerSku: string; beforeRevision: string; title: string; oldDescription: string; temporaryDescription: string; restoreDescription: string; comment: string;
  writeId: string; restoreId: string; writeRequest: Request; restoreRequest: Request; delayMs: number; preview: string; readSideEffects: string }

const env = SERVER ? process.env as Record<string, string> : parse(readFileSync(join(ROOT, '.env'), 'utf8')), targetUrl = new URL(env.DATABASE_URL)
if (!/neon\.tech$/.test(targetUrl.hostname) || targetUrl.pathname !== '/neondb') throw new Refusal('Unexpected production database target.')
for (const [key, value] of Object.entries(env)) if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key] = value
Object.assign(process.env, { NEXUS_WORKSPACES_ENABLED: '1', NEXUS_DATABASE_POOL_MAX: '2', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: '0',
  NEXUS_EBAY_REAL_API: 'true', EBAY_SANDBOX: 'false', NEXUS_ENABLE_AMAZON_PUBLISH: 'false', NEXUS_ENABLE_SHOPIFY_PUBLISH: 'false', NEXUS_ENABLE_EBAY_PUBLISH: 'false' })

async function discover(listingId?: string, requireMigration = false): Promise<Target[]> {
  const db = new pg.Client({ connectionString: env.DATABASE_URL, statement_timeout: 15_000 })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    if ((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Refusal('Discovery is not read only.')
    // The server's runtime login sees rows only inside a business profile (row security); without it discovery finds nothing.
    await db.query("SELECT set_config('nexus.workspace_id', $1, true)", [WORKSPACE])
    if (requireMigration) {
      const columns = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ChannelListingSnapshot' AND column_name IN ('outcome','acceptedAt')`)
      if (columns.rows.length !== 2) throw new Refusal('PCO receipt migration is missing. Deploy it before approving/executing this proof; this tool never migrates.')
    }
    const result = await db.query(`SELECT l.id AS "listingId", l."productId", l."channelConnectionId" AS "accountId", l."aliasKey", l."workspaceId", l."externalListingId" AS "itemId",
      p.sku AS "nexusSku", l.version AS "listingVersion", p.version AS "productVersion", l."syncPaused", l."listingStatus",
      to_jsonb(l)->>'presenceIntent' AS "presenceIntent", to_jsonb(l)->>'offerClosedAt' AS "offerClosedAt", to_jsonb(l)->>'endedAt' AS "endedAt",
      CASE WHEN EXISTS (SELECT 1 FROM "Product" child WHERE child."parentId"=p.id AND child."deletedAt" IS NULL) THEN 'family' ELSE 'standalone' END AS kind
      FROM "ChannelListing" l JOIN "Product" p ON p.id=l."productId" JOIN "ChannelConnection" c ON c.id=l."channelConnectionId"
      WHERE l."workspaceId"=$1 AND p."workspaceId"=$1 AND c."workspaceId"=$1 AND l.channel='EBAY' AND l.marketplace='IT'
        AND ($2::text IS NULL OR l.id=$2) AND l."externalListingId" ~ '^[0-9]+$' AND l."isPublished"=true AND l."listingStatus"='ACTIVE'
        AND c."isActive"=true AND c."channelType"='EBAY' AND c."authStatus" IN ('connected','degraded') AND p."deletedAt" IS NULL
        AND p."parentId" IS NULL AND p."productType" IS DISTINCT FROM 'EBAY_LISTING_SHELL'
        AND upper(p.sku) NOT LIKE '%AIREON%' AND upper(p.name) NOT LIKE '%AIREON%'
        AND coalesce(l."fulfillmentMethod",'FBM')<>'FBA'
        AND NOT (coalesce(l."platformAttributes",'{}'::jsonb) ?| ARRAY['__offerIds','offerId','inventoryItemGroupKey'])
        AND NOT EXISTS (SELECT 1 FROM "ChannelListing" other JOIN "Product" sibling ON sibling.id=other."productId"
          WHERE other.channel='EBAY' AND other."channelConnectionId"=l."channelConnectionId" AND other."externalListingId"=l."externalListingId"
          AND (other."workspaceId"<>$1 OR sibling."workspaceId"<>$1 OR other.marketplace<>'IT' OR other."aliasKey"<>l."aliasKey"
            OR (sibling.id<>p.id AND sibling."parentId" IS DISTINCT FROM p.id) OR sibling."deletedAt" IS NOT NULL
            OR sibling."productType"='EBAY_LISTING_SHELL' OR upper(sibling.sku) LIKE '%AIREON%' OR upper(sibling.name) LIKE '%AIREON%'
            OR coalesce(other."fulfillmentMethod",'FBM')='FBA'
            OR coalesce(other."platformAttributes",'{}'::jsonb) ?| ARRAY['__offerIds','offerId','inventoryItemGroupKey']))
        AND NOT EXISTS (SELECT 1 FROM "SharedListingMembership" member
          WHERE member."itemId"=l."externalListingId" AND (member."channelConnectionId"=l."channelConnectionId" OR member."channelConnectionId" IS NULL)
          AND (member."workspaceId"<>$1 OR member.marketplace<>'IT'
            OR NOT EXISTS (SELECT 1 FROM "Product" participant JOIN "ChannelListing" linked ON linked."productId"=participant.id
              WHERE participant.id=member."productId" AND participant.sku=member.sku AND participant."workspaceId"=$1 AND participant."deletedAt" IS NULL
                AND (participant.id=p.id OR participant."parentId"=p.id) AND linked."workspaceId"=$1 AND linked.channel='EBAY'
                AND linked.marketplace='IT' AND linked."channelConnectionId"=l."channelConnectionId" AND linked."aliasKey"=l."aliasKey" AND linked."externalListingId"=l."externalListingId")))
      ORDER BY (CASE WHEN EXISTS (SELECT 1 FROM "Product" child WHERE child."parentId"=p.id AND child."deletedAt" IS NULL) THEN 1 ELSE 0 END),length(coalesce(l.title,p.name)),p.sku LIMIT 8`, [WORKSPACE, listingId ?? null])
    for (const candidate of result.rows) {
      candidate.participants = (await db.query(`SELECT l.id AS "listingId",l."productId",p.sku AS "nexusSku",l.version AS "listingVersion",p.version AS "productVersion",
        l."syncPaused",l."listingStatus",to_jsonb(l)->>'presenceIntent' AS "presenceIntent",to_jsonb(l)->>'offerClosedAt' AS "offerClosedAt",to_jsonb(l)->>'endedAt' AS "endedAt"
        FROM "ChannelListing" l JOIN "Product" p ON p.id=l."productId"
        WHERE l."workspaceId"=$1 AND p."workspaceId"=$1 AND l.channel='EBAY' AND l.marketplace='IT' AND l."channelConnectionId"=$2 AND l."aliasKey"=$3
          AND l."externalListingId"=$4 AND (p.id=$5 OR p."parentId"=$5) AND p."deletedAt" IS NULL ORDER BY (p.id=$5) DESC,p.sku`,
        [WORKSPACE,candidate.accountId,candidate.aliasKey,candidate.itemId,candidate.productId])).rows
    }
    return result.rows
  } finally { await db.query('ROLLBACK').catch(() => {}); await db.end() }
}

const { default: prisma } = await import(join(ROOT, 'apps/api/src/db.js'))
const { withWorkspace } = await import(join(ROOT, 'apps/api/src/lib/workspace-context.js'))
await import(join(ROOT, 'apps/api/src/services/cx/connectors/index.js'))
const { ebayAuthService } = await import(join(ROOT, 'apps/api/src/services/ebay-auth.service.js'))
const { callTradingApi, escapeXml } = await import(join(ROOT, 'apps/api/src/services/ebay-trading-api.service.js'))
const { readEbayPublication, sendEbayPublication, ebayLiveContentRevision } = await import(join(ROOT, 'apps/api/src/services/pim/studio-publication-ebay.js'))
const { prepareEbayChanges, compileEbayChanges, ebayPublicationRequest } = await import(join(ROOT, 'apps/api/src/services/pim/studio-publication-ebay-changes.js'))
const { parseEbayItemDocument, parseEbayPublicationItem, ebayXmlObject, ebayXmlText, ebayXmlList } = await import(join(ROOT, 'apps/api/src/services/channel-drift/ebay-content-compare.js'))
const { assertPushAllowed } = await import('@nexus/shared/push-lock')

// The SAME request the sender (studio-publication-ebay.ts requestLiveItem) makes: without the UTF-8 declaration eBay returned
// ~978 description characters differently (2026-09-26), so an "original" read that way was not eBay's exact text.
async function readItem(target: Target, choosing = false): Promise<Snapshot> {
  const lock = [target, ...target.participants].map(assertPushAllowed).find(Boolean)
  if (lock) throw new Refusal(lock.sentence)
  const oauthToken = await ebayAuthService.getValidToken(target.accountId)
  const answer = await callTradingApi('GetItem', `<?xml version="1.0" encoding="UTF-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(target.itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`,
    { oauthToken, siteId: '101', connectionId: target.accountId, market: 'IT' })
  if (!answer.raw || !['Success','Warning'].includes(answer.ack)) throw new Refusal('GetItem returned no usable acknowledgement/body.')
  const item = parseEbayItemDocument(answer.raw), status = ebayXmlObject(item.SellingStatus), title = ebayXmlText(item.Title)
  if (ebayXmlText(item.ItemID) !== target.itemId || ebayXmlText(status.ListingStatus) !== 'Active') throw new Refusal('GetItem did not confirm the exact active listing.')
  if (item.InventoryModel !== undefined || ebayXmlText(item.ListingType) !== 'FixedPriceItem') throw new Refusal('The live item is not a Trading fixed-price listing.')
  const liveVariants = ebayXmlList(ebayXmlObject(item.Variations).Variation).map(ebayXmlObject)
  const liveSkus = liveVariants.map(variant => ebayXmlText(variant.SKU)), children = target.participants.filter(product => product.productId !== target.productId)
  if (!target.participants.length || new Set(target.participants.map(product => product.productId)).size !== target.participants.length) throw new Refusal('The item participants are missing or ambiguous.')
  if (target.kind === 'standalone' ? item.Variations !== undefined || children.length > 0
    : !liveSkus.length || new Set(liveSkus).size !== liveSkus.length || liveSkus.some(sku => !sku || children.filter(child => child.nexusSku === sku).length !== 1) || children.some(child => !liveSkus.includes(child.nexusSku))) {
    throw new Refusal('Live variations do not match this one normal family; no shared or unaccounted-for participants are allowed.')
  }
  if (!title?.trim()) throw new Refusal('The live title is unavailable.')
  const description = ebayXmlText(item.Description)
  if (description === null) throw new Refusal('The live description is unavailable.')
  if (choosing) {
    const end = Date.parse(ebayXmlText(ebayXmlObject(item.ListingDetails).EndTime) ?? '')
    if (!Number.isFinite(end) || end-Date.now() <= 12*60*60_000) throw new Refusal('Choose another item: this description proof requires the listing to end more than12 hours away.')
    assertPassiveDescription(description)
  }
  return { title, description, providerSku: ebayXmlText(item.SKU) || target.nexusSku, revision: ebayLiveContentRevision(answer.raw), content: parseEbayPublicationItem(answer.raw) }
}

async function compile(target: Target, before: Snapshot, description: string, operationId: string) {
  assertPassiveDescription(description)
  const products = target.participants.map(participant => ({ productId: participant.productId, sku: participant.productId === target.productId ? before.providerSku : participant.nexusSku }))
  if (new Set(products.map(product => product.sku)).size !== products.length) throw new Refusal('The item/variation SKU attribution is ambiguous.')
  const facts = { scope: { channel: 'EBAY', marketplace: 'IT', accountId: target.accountId, listingId: target.listingId }, destination: { aliasKey: target.aliasKey },
    parent: { id: target.productId }, products: products.map(product => ({ id: product.productId, sku: product.sku })), resolved: [],
    listings: target.participants.map(participant => ({ id: participant.listingId, productId: participant.productId, externalListingId: target.itemId, channel: 'EBAY', marketplace: 'IT', channelConnectionId: target.accountId, aliasKey: target.aliasKey })) }
  const publication = { kind: 'ebay' as const, products, marketplace: 'IT', itemId: target.itemId,
    liveRevision: before.revision, liveContent: before.content, xml: `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><ItemID>${escapeXml(target.itemId)}</ItemID><Description>${escapeXml(description)}</Description></Item></ReviseFixedPriceItemRequest>` }
  const plan = await prepareEbayChanges(facts as any, publication, new Map())
  const choice = plan.changes.find((change: any) => change.productId === target.productId && change.field === 'description')
  if (!choice?.selectable) throw new Refusal('The requested description is not an eligible explicit change.')
  const selected = compileEbayChanges(plan, [choice.id]), request = ebayPublicationRequest(selected, operationId), item = parseEbayItemDocument(request.xml)
  if (canonical(selected.products) !== canonical(products) || ebayXmlText(item.Description) !== description
    || Object.keys(item).some(key => !['ItemID','Description','SKU','#text'].includes(key))
    || Object.values(selected.fieldWrites).flat().length !== 1
    || canonical(selected.fieldWrites[target.productId]?.[0]) !== canonical({ field: 'description', value: { state: 'value', value: description } })) throw new Refusal('Compiled request is not exactly one description change with required identifiers.')
  return { selected, request }
}

let run: any, runPath: string | undefined, exitCode = 0
const checkpoint = (event: string, details: unknown = {}) => {
  run.events.push({ at: new Date().toISOString(), event, details })
  try { save(runPath!, run) } catch (error) { console.warn(JSON.stringify({ event: 'evidence-file-unavailable', runPath, error: safeError(error) })) }
  console.log(JSON.stringify({ event, details })) // Evidence contention must not interrupt an approved restoration.
}
try {
  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    if (args.prepare) {
      const candidates = await discover(args.listing), declined: unknown[] = []
      let chosen: { target: Target; before: Snapshot } | undefined
      for (const target of candidates) {
        try { chosen = { target, before: await readItem(target, true) }; break }
        catch (error) { declined.push({ listingId: target.listingId, sku: target.nexusSku, reason: safeError(error) }) }
      }
      if (!chosen) throw new Refusal(`No eligible standalone or normal-family Trading item found in ${candidates.length} bounded candidates. ${JSON.stringify(declined)}`)
      const { target, before } = chosen, writeId = randomUUID(), restoreId = randomUUID(), comment = `<!-- nexuspco20260925${randomUUID().replace(/-/g, '')} -->`
      if (before.description.includes(comment)) throw new Refusal('The proof comment already exists; prepare again.')
      const temporaryDescription = before.description + comment, write = await compile(target, before, temporaryDescription, writeId)
      // Preview restoration against the expected temporary description; the real restore uses a fresh GetItem revision.
      const restore = await compile(target, { ...before, description: temporaryDescription, content: { ...before.content, Description: temporaryDescription } }, before.description, restoreId)
      const proposal: Proposal = { version: 1, kind: 'pco7-ebay-description-proof', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+TTL_MS).toISOString(), sourceDigest: sourceDigest(), target,
        database: { host: targetUrl.hostname, name: targetUrl.pathname },
        providerSku: before.providerSku, beforeRevision: before.revision, title: before.title, oldDescription: before.description, temporaryDescription, restoreDescription: before.description, comment, writeId, restoreId,
        writeRequest: write.request, restoreRequest: restore.request, delayMs: DELAY_MS,
        preview: 'Local compiled preview only: eBay has no VerifyReviseFixedPriceItem. This is not provider validation or acceptance.',
        readSideEffects: 'Canonical clients may refresh OAuth and record gateway calls. Discovery is BEGIN READ ONLY. No listing, Nexus content or queue mutation.' }
      const path = recordPath(args.proposal ?? join(RECORDS, `pco7-ebay-${stamp()}.proposal.json`)), checksum = digest(proposal)
      save(path, { proposal, digest: checksum }, true)
      console.log(JSON.stringify({ proposalPath: path, digest: checksum, itemId: target.itemId, sku: target.nexusSku, kind: target.kind,
        title: before.title, sourceDigest: proposal.sourceDigest,
        scope: 'One item-level description with an appended HTML comment; every participant shares this ItemID/account/alias. No buyer-visible text change is intended. No title, variation, price or quantity fields are sent.',
        participants: target.participants.map(participant => ({ listingId: participant.listingId, productId: participant.productId, sku: participant.nexusSku })),
        originalDescription: descriptionEvidence(before.description), comment, temporaryDescription: descriptionEvidence(temporaryDescription),
        restoreDescription: descriptionEvidence(before.description), preview: proposal.preview, expiresAt: proposal.expiresAt,
        next: 'Owner approval for this exact proposal/digest is required before --execute-approved.' }, null, 2))
      return
    }
    const proposalPath = recordPath(args.proposal!), stored = JSON.parse(readFileSync(proposalPath, 'utf8')), proposal = stored.proposal as Proposal
    if (!proposal || stored.digest !== args.digest || digest(proposal) !== args.digest || proposal.version !== 1 || proposal.kind !== 'pco7-ebay-description-proof') throw new Refusal('Proposal/digest mismatch.')
    if (proposal.database?.host !== targetUrl.hostname || proposal.database?.name !== targetUrl.pathname || proposal.target.workspaceId !== WORKSPACE || proposal.restoreDescription !== proposal.oldDescription
      || !/^<!-- nexuspco20260925[a-f0-9]{32} -->$/.test(proposal.comment) || proposal.oldDescription.includes(proposal.comment) || proposal.temporaryDescription !== proposal.oldDescription+proposal.comment
      || proposal.delayMs !== DELAY_MS || proposal.sourceDigest !== sourceDigest() || !Number.isFinite(Date.parse(proposal.expiresAt)) || Date.parse(proposal.expiresAt) <= Date.now()) throw new Refusal('Proposal is expired, altered, from another workspace, or built by different code. Prepare it again.')
    const targets = await discover(proposal.target.listingId, true), target = targets[0]
    if (!target || targets.length !== 1 || canonical(target) !== canonical(proposal.target)) throw new Refusal('The approved listing coordinate or Nexus version changed.')
    const before = await readItem(target, true)
    if (before.title !== proposal.title || before.description !== proposal.oldDescription || before.providerSku !== proposal.providerSku || before.revision !== proposal.beforeRevision) throw new Refusal('eBay changed since the approved preview. Prepare again; nothing was sent.')
    const write = await compile(target, before, proposal.temporaryDescription, proposal.writeId)
    if (canonical(write.request) !== canonical(proposal.writeRequest)) throw new Refusal('The final temporary request differs from the approved preview.')
    runPath = proposalPath.replace(/\.json$/, '.run.json')
    run = { proposalPath, proposalDigest: args.digest, writeId: proposal.writeId, restoreId: proposal.restoreId, target, title: proposal.title,
      oldDescription: descriptionEvidence(proposal.oldDescription), temporaryDescription: descriptionEvidence(proposal.temporaryDescription), comment: proposal.comment, status: 'started', events: [] }
    save(runPath, run, true) // Never rerun a proposal whose send may already have reached eBay.
    process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'; process.env.EBAY_PUBLISH_MODE = 'live'
    const { recordPublicationRequests } = await import(join(ROOT, 'apps/api/src/services/pim/studio-publication-records.js'))
    const { digestPayload } = await import(join(ROOT, 'apps/api/src/services/channel-publish-audit.service.js'))
    async function sendStep(phase: 'temporary' | 'restore', compiled: Awaited<ReturnType<typeof compile>>, operationId: string, expectedDescription: string) {
      if (phase === 'temporary') noPush()
      const context = { reviewId: operationId, userId: null, channel: 'EBAY', marketplace: 'IT', accountId: target.accountId, aliasKey: target.aliasKey }
      let snapshotIds: string[] = [], attemptIds: string[] = []
      const settle = async (outcome: 'ACCEPTED' | 'SUBMITTED' | 'FAILED' | 'UNKNOWN', receipt?: string) => {
        if (!snapshotIds.length || !attemptIds.length) return
        await prisma.$transaction(async (tx: any) => {
          const updated = await tx.channelListingSnapshot.updateMany({ where: { id: { in: snapshotIds }, reason: 'publish-proof', publishEventId: operationId },
            data: { outcome, ...(outcome === 'ACCEPTED' ? { acceptedAt: new Date() } : {}) } })
          const audited = await tx.channelPublishAttempt.updateMany({ where: { id: { in: attemptIds } }, data: { outcome: outcome === 'ACCEPTED' ? 'success' : outcome.toLowerCase(), ...(receipt ? { submissionId: receipt } : {}) } })
          if (updated.count !== snapshotIds.length || audited.count !== attemptIds.length) throw new Refusal('Proof journal attribution changed; receipt was not settled.')
        })
      }
      let receipt: Awaited<ReturnType<typeof sendEbayPublication>>
      try {
        receipt = await sendEbayPublication(compiled.selected, target.accountId, operationId, async (request: Request) => {
          if (canonical(request) !== canonical(compiled.request)) throw new Refusal('Native transport request differs from the approved local preview.')
          const items = compiled.selected.products.map((product: { productId: string; sku: string }) => ({ ...product,
            request: { intentVersion: 1, writes: compiled.selected.fieldWrites[product.productId] ?? [], request, proof: { proposalDigest: args.digest, phase } } }))
          await recordPublicationRequests(context, items)
          await prisma.$transaction(async (tx: any) => {
            const snapshots = await tx.channelListingSnapshot.findMany({ where: { publishEventId: operationId, channelListingId: { in: target.participants.map(participant => participant.listingId) }, reason: 'publish', outcome: 'UNACCEPTED' } })
            const attempts = await tx.channelPublishAttempt.findMany({ where: { channel: 'EBAY', marketplace: 'IT', sellerId: target.accountId,
              OR: items.map(item => ({ productId: item.productId, sku: item.sku, payloadDigest: digestPayload([item.request]) })) } })
            if (snapshots.length !== items.length || attempts.length !== items.length) throw new Refusal('The exact participant journal/audit pairs could not be identified; no transport send.')
            const marked = await tx.channelListingSnapshot.updateMany({ where: { id: { in: snapshots.map((snapshot: any) => snapshot.id) }, reason: 'publish', outcome: 'UNACCEPTED' }, data: { reason: 'publish-proof' } })
            if (marked.count !== items.length) throw new Refusal('Not every participant journal was marked publish-proof; no transport send.')
            snapshotIds = snapshots.map((snapshot: any) => snapshot.id); attemptIds = attempts.map((attempt: any) => attempt.id)
          })
          checkpoint('journal-ready', { phase, operationId, snapshotIds, attemptIds, reason: 'publish-proof' })
        })
      } catch (error) {
        await settle((error as any)?.notSent === true ? 'FAILED' : 'UNKNOWN').catch(() => {})
        checkpoint('send-stopped', { phase, operationId, snapshotIds, attemptIds, notSent: (error as any)?.notSent === true, error: safeError(error) })
        throw new Refusal('Transport stopped. No blind retry or subsequent write was attempted; retain the run file and operation IDs for a fresh recovery read.')
      }
      checkpoint('acknowledged', { phase, operationId, reference: receipt.reference })
      if (receipt.reference !== target.itemId) { await settle('UNKNOWN', receipt.reference); throw new Refusal('eBay acknowledged another item; no further write is allowed.') }
      await settle('SUBMITTED', receipt.reference)
      const active = await readEbayPublication(target.itemId, target.accountId, 'IT'), after = await readItem(target)
      if (!active?.verified || active.reference !== target.itemId || after.description !== expectedDescription || after.title !== proposal.title || after.providerSku !== before.providerSku) {
        await settle('UNKNOWN', receipt.reference)
        throw new Refusal('Proof not passed: the exact requested description/comment was not confirmed on the unchanged active item. No blind retry or restore; inspect the recovery IDs and read eBay again.')
      }
      await settle('ACCEPTED', receipt.reference)
      checkpoint('confirmed', { phase, description: descriptionEvidence(after.description), revision: after.revision, snapshotIds, attemptIds })
      return after
    }
    const changed = await sendStep('temporary', write, proposal.writeId, proposal.temporaryDescription)
    const currentTarget = (await discover(target.listingId, true))[0]
    if (!currentTarget || ['listingId','productId','accountId','aliasKey','workspaceId','itemId','nexusSku'].some(key => (currentTarget as any)[key] !== (target as any)[key])) throw new Refusal('Listing attribution changed before restoration; recovery requires a fresh review.')
    const participantScope = (scope: Target) => scope.participants.map(({ listingId, productId, nexusSku }) => ({ listingId, productId, nexusSku }))
    if (canonical(participantScope(currentTarget)) !== canonical(participantScope(target))) throw new Refusal('The family participant scope changed before restoration.')
    const lock = [currentTarget, ...currentTarget.participants].map(assertPushAllowed).find(Boolean); if (lock) throw new Refusal(lock.sentence)
    const restore = await compile(target, changed, proposal.restoreDescription, proposal.restoreId)
    if (canonical(restore.request) !== canonical(proposal.restoreRequest)) throw new Refusal('The restoration request differs from the reviewed exact-description restoration.')
    await sendStep('restore', restore, proposal.restoreId, proposal.restoreDescription)
    for (let elapsed = 0; elapsed < DELAY_MS; elapsed += 30_000) { console.log(JSON.stringify({ event: 'waiting-for-delayed-read', remainingSeconds: (DELAY_MS-elapsed)/1000 })); await new Promise(resolve => setTimeout(resolve, 30_000)) }
    const delayed = await readItem(currentTarget)
    if (delayed.description !== proposal.oldDescription || delayed.title !== proposal.title || delayed.providerSku !== before.providerSku) throw new Refusal('Delayed read did not confirm the exact restored description and unchanged item; no additional write was attempted.')
    run.status = 'restored-and-delayed-read-confirmed'; checkpoint('complete', { description: descriptionEvidence(delayed.description), delayMs: DELAY_MS })
  })
} catch (error) {
  exitCode = 1
  if (run) { run.status = 'stopped-recovery-may-be-required'; run.error = safeError(error); try { save(runPath!, run) } catch { /* stdout retains IDs if a push blocks the evidence write */ } }
  console.error(JSON.stringify({ error: safeError(error), runPath, recovery: run ? { proposalPath: run.proposalPath, target: run.target, title: run.title, oldDescription: run.oldDescription, temporaryDescription: run.temporaryDescription, writeId: run.writeId, restoreId: run.restoreId, events: run.events } : null }))
} finally {
  process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'false'
  await prisma.$disconnect().catch(() => {})
}
process.exit(exitCode)
