/**
 * ACR.1.2 — verify the Levers view against prod BEFORE any UI is built on it. READ-ONLY.
 *
 * Calls the service directly (no HTTP), so what prints is exactly what the endpoint returns.
 * The point is to catch a lever that claims a posture it does not have — this whole surface
 * exists because the previous board was confidently wrong about what was running.
 *
 * Usage: cd apps/api && railway run npx tsx scripts/_acr12-levers.mts
 *   (railway run so the env GATES are prod's; without it every flag reads local.)
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { getEngineLevers } = await import('../src/services/advertising/ads-control-room.service.js')
const { levers, global } = await getEngineLevers()

console.log(`\nACCOUNT DIAL  autonomy=${global.autonomy}  halted=${global.halted}  envKill=${global.envKill}  degraded=${global.degraded}\n`)
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))
console.log(pad('LEVER', 22) + pad('MODE', 9) + pad('SCOPE', 34) + pad('LAST RUN', 21) + '7d')
console.log('─'.repeat(110))
for (const l of levers) {
  const last = l.lastRunAt ? `${l.lastRunAt.toISOString().slice(5, 16).replace('T', ' ')} ${l.lastRunStatus}` : '(never)'
  console.log(
    pad(l.name, 22) + pad(l.mode, 9) + pad(l.scope ?? '—', 34) + pad(last, 21) +
    `${l.runs7d} runs${l.failures7d ? ` / ${l.failures7d} failed` : ''}`,
  )
  if (l.warning) console.log(`  ⚠ ${l.warning}`)
}
console.log('\nWHY EACH MODE:')
for (const l of levers) console.log(`  ${pad(l.name, 22)} ${l.modeReason}`)
console.log('\nLAST SUMMARY:')
for (const l of levers) if (l.lastRunSummary) console.log(`  ${pad(l.name, 22)} ${l.lastRunSummary.slice(0, 90)}`)
console.log('\nDone — read-only.\n')
process.exit(0)
