/**
 * BP.S3 end-to-end probe — a real refused publish, through the real code, into the
 * real bell. Local development database only; refuses to run anywhere else.
 *
 * Safety, three layers deep:
 *   1. The refusal happens BEFORE any OutboundSyncQueue row exists, so there is no job
 *      to push. The probe ASSERTS that no row was created.
 *   2. Local background workers are disabled (NEXUS_DISABLE_BACKGROUND_JOBS=1).
 *   3. Every fixture it creates is removed in `finally`, and the share is restored to
 *      the mode it had before.
 *
 *   npx tsx scripts/bps3-refusal-e2e.mts            run and clean up
 *   npx tsx scripts/bps3-refusal-e2e.mts --keep     leave the notice for a visual check
 */
import '../src/env.js'
import prisma from '../src/db.js'
import { withWorkspace } from '../src/lib/workspace-context.js'

const url = process.env.DATABASE_URL ?? ''
const host = (() => { try { return new URL(url).hostname } catch { return '' } })()
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error(`REFUSING: DATABASE_URL host is "${host}", not the local development database.`)
  process.exit(2)
}
if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') {
  console.error('REFUSING: business profiles are not enabled for this API.')
  process.exit(2)
}
const keep = process.argv.includes('--keep')

const OWNER_WS = 'nexus_legacy_workspace'
const GUEST_WS = '263c4024-3559-4d27-ac08-a56d33a0d983'
const USER = 'cmr44sxfw0001nj00whzur39t'
const CONN = 'cmr4aaqb00025nz016k18rup9' // eBay xaviaracing, owned by OWNER_WS
const SKU = `E2E-REFUSAL-${Date.now()}`
const MARKET = 'IT'

const owner = <T>(w: () => Promise<T>) => withWorkspace({ workspaceId: OWNER_WS, actorUserId: USER, membershipId: null, roleKeys: ['OWNER'] }, w)
const guestJob = <T>(w: () => Promise<T>) => withWorkspace({ workspaceId: GUEST_WS, actorUserId: null, membershipId: null, roleKeys: [] }, w)
const guestUser = <T>(w: () => Promise<T>) => withWorkspace({ workspaceId: GUEST_WS, actorUserId: USER, membershipId: null, roleKeys: ['OWNER'] }, w)

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => { if (ok) { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`) } else { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`) } }

console.log(`database: ${host} (local)   sku: ${SKU}\n`)

// Every grant read and write runs AS THE OWNER. The grant's own policy is owner-only, so
// the same statement with no business in context finds nothing — which is exactly what
// the first run of this probe proved, by failing on its first line.
const originalMode = (await owner(() => prisma.channelAccountGrant.findUnique({ where: { connectionId_workspaceId: { connectionId: CONN, workspaceId: GUEST_WS } } }))) ?.mode ?? null
let productId: string | null = null
let listingId: string | null = null

try {
  // ── set the scene ──
  await owner(() => prisma.channelAccountGrant.update({ where: { connectionId_workspaceId: { connectionId: CONN, workspaceId: GUEST_WS } }, data: { mode: 'publish', revokedAt: null } }))
  const { claimCoordinate } = await import('../src/services/listing-claim.service.js')
  const held = await owner(() => claimCoordinate({ connectionId: CONN, marketplace: MARKET, sellerSku: SKU }))
  check('the OWNER business holds the coordinate first', held.result === 'acquired', held.result)

  await guestUser(async () => {
    const product = await prisma.product.create({ data: { sku: SKU, name: 'E2E refusal probe jacket', basePrice: 0 } })
    productId = product.id
    const listing = await prisma.channelListing.create({
      data: { productId: product.id, channel: 'EBAY', region: MARKET, marketplace: MARKET, channelMarket: `EBAY_${MARKET}`, channelConnectionId: CONN },
    })
    listingId = listing.id
  })
  check('the GUEST business has its own product + listing on the shared account', !!listingId)

  const unreadBefore = await guestUser(() => prisma.notification.count({ where: { userId: USER, readAt: null } }))

  // ── the real publish path ──
  const { enqueueOutboundRowsInstant } = await import('../src/services/outbound-enqueue.js')
  let refusal: { code?: string; statusCode?: number } | null = null
  await guestJob(async () => {
    try {
      await enqueueOutboundRowsInstant(prisma as never, [{
        productId, channelListingId: listingId, targetChannel: 'EBAY', targetRegion: MARKET,
        syncType: 'FULL_SYNC', payload: { source: 'E2E_PROBE' },
      }], { source: 'CONTENT_AUTO_PUBLISH' })
    } catch (e) { refusal = e as { code?: string; statusCode?: number } }
  })

  check('🔴 the publish is REFUSED', refusal !== null, refusal ? `${(refusal as { code?: string }).code}` : 'it went through')
  check('with the named reason, as a 409', (refusal as { code?: string } | null)?.code === 'listing_coordinate_claimed' && (refusal as { statusCode?: number } | null)?.statusCode === 409)

  const queued = await guestUser(() => prisma.outboundSyncQueue.count({ where: { channelListingId: listingId! } }))
  check('🔴 and NOTHING was queued for the channel', queued === 0, `${queued} row(s)`)

  // ── the point of this unit: a person is told ──
  const notices = await guestUser(() => prisma.notification.findMany({ where: { userId: USER, type: 'publish-refused-shared-account', entityId: listingId! } }))
  check('🔴 a notice reached the guest business’s owner', notices.length === 1, `${notices.length} notice(s)`)
  if (notices[0]) {
    console.log(`\n        title: ${notices[0].title}\n        body:  ${notices[0].body}\n        href:  ${notices[0].href}\n`)
    check('it names the business that holds the SKU', (notices[0].body ?? '').includes('Existing business'))
    check('and links to the product, where it can be fixed', notices[0].href === `/products/${productId}/edit`)
  }
  const unreadAfter = await guestUser(() => prisma.notification.count({ where: { userId: USER, readAt: null } }))
  check('the bell’s unread count went up by exactly one', unreadAfter === unreadBefore + 1, `${unreadBefore} → ${unreadAfter}`)

  const ownerSees = await owner(() => prisma.notification.count({ where: { entityId: listingId! } }))
  check('🔴 the OWNER business sees none of it — the notice names it, so this would leak', ownerSees === 0, `${ownerSees}`)

  // ── re-firing on every edit must not flood ──
  for (let i = 0; i < 5; i++) {
    await guestJob(async () => {
      try { await enqueueOutboundRowsInstant(prisma as never, [{ productId, channelListingId: listingId, targetChannel: 'EBAY', targetRegion: MARKET, syncType: 'FULL_SYNC', payload: {} }]) } catch { /* expected */ }
    })
  }
  const afterFlood = await guestUser(() => prisma.notification.count({ where: { userId: USER, entityId: listingId! } }))
  check('five more refusals of the same listing do NOT stack', afterFlood === 1, `${afterFlood} notice(s)`)
} catch (error) {
  fail++
  console.log(`\n  FAIL  the probe threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (keep) {
    console.log('\n--keep: fixtures left in place for a visual check. Re-run without --keep to clean up.')
  } else {
    await guestUser(async () => {
      if (listingId) await prisma.notification.deleteMany({ where: { entityId: listingId } })
      if (listingId) await prisma.channelListing.deleteMany({ where: { id: listingId } })
      if (productId) await prisma.product.deleteMany({ where: { id: productId } })
    })
    await owner(() => prisma.channelListingClaim.deleteMany({ where: { connectionId: CONN, sellerSku: SKU } }))
    await owner(() => prisma.channelAccountGrant.update({ where: { connectionId_workspaceId: { connectionId: CONN, workspaceId: GUEST_WS } }, data: { mode: originalMode ?? 'read' } }))
    console.log(`\ncleaned up; share restored to "${originalMode ?? 'read'}"`)
  }
  await prisma.$disconnect()
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
