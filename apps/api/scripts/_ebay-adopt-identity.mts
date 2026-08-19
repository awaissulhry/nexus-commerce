/**
 * One-off: adopt the identified duplicate's identity + tokens onto the eBay
 * connection that actually owns the data, then deactivate the duplicate.
 *
 * Context: the operator's connect click created a SECOND active eBay row because
 * the original predates the identity permission and so had nothing to match on.
 * The original owns 981 rows; the new one owns 0 but holds the real identity and
 * identity-scoped tokens. Moving the identity is zero data movement; moving 981
 * attributions the other way would be the wrong direction.
 *
 * ⚠ ORDER MATTERS. `ChannelConnection_active_account_key` is unique on
 * (channelType, COALESCE(marketplace), COALESCE(externalAccountId)) WHERE isActive.
 * Writing the identity onto the keeper while the donor is still active collides
 * with it. Deactivate the donor first, in the same transaction.
 *
 * Dry-run by default. Pass --apply to commit.
 */
const { default: prisma } = await import('../src/db.js')
const APPLY = process.argv.includes('--apply')

const active = await prisma.channelConnection.findMany({
  where: { channelType: 'EBAY', isActive: true },
  orderBy: { createdAt: 'asc' },
})
if (active.length !== 2) {
  console.log(`Expected exactly 2 active eBay rows, found ${active.length}. Aborting.`)
  process.exit(1)
}
// Keeper = the one that owns the data. Donor = the one carrying the identity.
const counts = await Promise.all(active.map((c) => prisma.channelListing.count({ where: { channelConnectionId: c.id } })))
const keeper = counts[0]! >= counts[1]! ? active[0]! : active[1]!
const donor  = keeper.id === active[0]!.id ? active[1]! : active[0]!

console.log(`KEEPER (owns the data): ${keeper.id}  listings=${keeper.id===active[0]!.id?counts[0]:counts[1]}  identity=${JSON.stringify(keeper.externalAccountId)}`)
console.log(`DONOR  (carries id)   : ${donor.id}  listings=${donor.id===active[0]!.id?counts[0]:counts[1]}  identity=${JSON.stringify(donor.externalAccountId)}`)
if (!donor.externalAccountId) { console.log('\nDonor has no identity — nothing to adopt. Aborting.'); process.exit(1) }
if (keeper.externalAccountId) { console.log('\nKeeper already has an identity — this is not the migration case. Aborting.'); process.exit(1) }

console.log(`\nWould write onto the keeper:`)
console.log(`  externalAccountId : null -> ${JSON.stringify(donor.externalAccountId)}`)
console.log(`  displayName       : ${JSON.stringify(keeper.displayName)} -> ${JSON.stringify(donor.displayName)}`)
console.log(`  ebaySignInName    : ${JSON.stringify(keeper.ebaySignInName)} -> ${JSON.stringify(donor.ebaySignInName ?? donor.displayName)}`)
console.log(`  tokens            : replaced with the donor's identity-scoped pair`)
console.log(`And deactivate the donor (isActive=false, isPrimary=false). Nothing is deleted.`)

if (!APPLY) { console.log('\nDRY RUN — pass --apply to commit.'); await prisma.$disconnect(); process.exit(0) }

await prisma.$transaction([
  // 1. Free the identity value first, or the partial unique index rejects step 2.
  prisma.channelConnection.update({
    where: { id: donor.id },
    data: { isActive: false, isPrimary: false, lastSyncStatus: 'SUCCESS',
            lastSyncError: 'Superseded — identity adopted by the connection that owns this account\'s data' },
  }),
  prisma.channelConnection.update({
    where: { id: keeper.id },
    data: {
      externalAccountId: donor.externalAccountId,
      displayName: donor.displayName ?? keeper.displayName,
      ebaySignInName: donor.ebaySignInName ?? donor.displayName ?? keeper.ebaySignInName,
      ebayStoreName: donor.ebayStoreName ?? keeper.ebayStoreName,
      accessToken: donor.accessToken ?? keeper.accessToken,
      refreshToken: donor.refreshToken ?? keeper.refreshToken,
      tokenExpiresAt: donor.tokenExpiresAt ?? keeper.tokenExpiresAt,
      ebayAccessToken: donor.ebayAccessToken ?? keeper.ebayAccessToken,
      ebayRefreshToken: donor.ebayRefreshToken ?? keeper.ebayRefreshToken,
      ebayTokenExpiresAt: donor.ebayTokenExpiresAt ?? keeper.ebayTokenExpiresAt,
      isPrimary: true, isActive: true, lastSyncStatus: 'SUCCESS', lastSyncError: null,
    },
  }),
])
console.log('\nAPPLIED.')
await prisma.$disconnect()
