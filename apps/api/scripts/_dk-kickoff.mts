/**
 * Manual first Data Kiosk economics cycle.
 *
 * Uses the same trailing window the cron would (T-9 → T-2, because economics
 * restates for a few days) across all four live markets. The create cycle
 * spaces itself 65s per marketplace: createQuery is limited to roughly one a
 * minute, and a REJECTED query still consumes quota.
 *
 * Creating a query does not return data. It queues one Amazon-side; the poll
 * cycle ingests it on completion, which can take 10+ minutes.
 *
 * Usage: cd apps/api && npx tsx scripts/_dk-kickoff.mts
 */
import { runEconomicsCreateCycle } from '../src/services/amazon/data-kiosk.service.js'

const day = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
const startDate = day(9)
const endDate = day(2)
const marketplaceIds = [
  'APJ6JRA9NG5V4',  // IT
  'A1PA6795UKMFR9', // DE
  'A13V1IB3VIYZZH', // FR
  'A1RKKUPIHCS9HS', // ES
]

console.log(`window ${startDate} → ${endDate} | markets ${marketplaceIds.join(',')}`)
console.log('expect ~3.5 minutes — 65s of spacing between each market\n')

const out = await runEconomicsCreateCycle({ startDate, endDate, marketplaceIds })
console.log('RESULT:', JSON.stringify(out, null, 2))
console.log('\nNext: npx tsx scripts/_dk-poll.mts   (repeat until done=4)')
process.exit(0)
