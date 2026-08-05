// READ-ONLY diagnosis for the "Internal Server Error" on
// POST /api/ebay-ads/builder/launch (General / CPS, 6 ads, scheduled).
// Checks every precondition that throws BEFORE any eBay call is made.
// Performs no writes of any kind.
const prisma = (await import('../src/db.js')).default

const line = (s: string) => console.log(s)
line('── eBay ads launch pre-flight (read-only) ──────────────────────────\n')

// 1. killSwitchCheck — the first thing every write op calls.
const ceilings = await prisma.marketingSpendCeiling.findMany({ where: { channel: 'EBAY' } })
line(`MarketingSpendCeiling rows (EBAY): ${ceilings.length}`)
for (const c of ceilings) {
  line(`  · marketplace=${c.marketplace} killSwitch=${c.killSwitch} monthlyCapCents=${(c as Record<string, unknown>).monthlyCapCents ?? '—'}`)
}
const killed = ceilings.filter((c) => c.killSwitch)
line(killed.length ? `  ⛔ KILL SWITCH ON for: ${killed.map((c) => c.marketplace).join(', ')}` : '  ✓ no kill switch set')

const state = await prisma.marketingAutomationState.findUnique({ where: { channel: 'EBAY' } })
line(`\nMarketingAutomationState(EBAY): ${state ? `globalMode=${state.globalMode} halted=${state.halted} reason=${state.haltReason ?? '—'}` : 'NO ROW'}`)
if (state?.halted) line('  ⛔ HALTED — every ad write throws before reaching eBay')
else line('  ✓ not halted')

// 2. the connection lookup (findFirstOrThrow → throws if none)
const conns = await prisma.channelConnection.findMany({
  where: { channelType: 'EBAY' },
  select: { id: true, isActive: true, managedBy: true, marketplace: true },
})
line(`\nChannelConnection(EBAY): ${conns.length} rows`)
const active = conns.filter((c) => c.isActive)
line(`  active: ${active.length}  ${active.map((c) => `${c.id.slice(0, 8)}(managedBy=${c.managedBy})`).join(' ')}`)
line(active.length ? '  ✓ findFirstOrThrow will resolve' : '  ⛔ findFirstOrThrow WILL THROW (no active EBAY connection)')
const oauth = conns.filter((c) => c.isActive && c.managedBy === 'oauth')
line(oauth.length ? '  ✓ getActiveEbayAdsAuth will find a token source' : '  ⛔ getActiveEbayAdsAuth returns null → "no active eBay connection" (live mode only)')

// 3. write gate — decides whether an eBay call is attempted at all
line(`\nNEXUS_MARKETING_WRITES_EBAY (this process) = ${JSON.stringify(process.env.NEXUS_MARKETING_WRITES_EBAY)}`)
line(`  → mode here: ${process.env.NEXUS_MARKETING_WRITES_EBAY === '1' ? 'LIVE' : 'sandbox'} (prod may differ — read GET /api/ebay-ads/write-mode)`)
line(`NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS = ${process.env.NEXUS_MARKETING_MAX_WRITE_VALUE_CENTS ?? '50000 (default)'}`)

// 4. did any live write EVER fire?
const actions = await prisma.campaignAction.findMany({
  where: { channel: 'EBAY' },
  orderBy: { createdAt: 'desc' },
  take: 8,
  select: { actionType: true, entityType: true, channelResponseStatus: true, payloadAfter: true, createdAt: true },
})
line(`\nLast ${actions.length} CampaignAction rows (EBAY):`)
for (const a of actions) {
  const mode = (a.payloadAfter as Record<string, unknown> | null)?._mode ?? '?'
  line(`  · ${a.createdAt.toISOString()} ${a.actionType}/${a.entityType} status=${a.channelResponseStatus} _mode=${String(mode)}`)
}
const anyLive = actions.some((a) => (a.payloadAfter as Record<string, unknown> | null)?._mode === 'live')
line(anyLive ? '  → at least one LIVE write has fired' : '  → all recent writes are sandbox')

// 5. campaigns + goal sanity
const camps = await prisma.ebayCampaign.count()
const running = await prisma.ebayCampaign.count({ where: { status: 'RUNNING' } })
line(`\nEbayCampaign rows: ${camps} (RUNNING ${running})`)

// 6. economics for the 6 listings the wizard staged
const eco = await prisma.ebayListingEconomics.groupBy({ by: ['dataStatus'], _count: { _all: true } })
line(`\nEbayListingEconomics by dataStatus: ${eco.map((e) => `${e.dataStatus}=${e._count._all}`).join(' ') || '(no rows)'}`)

await prisma.$disconnect()
line('\n── done (no writes performed) ──')
