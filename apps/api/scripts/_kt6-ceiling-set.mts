/** _kt6-ceiling-set.mts — create/remove a real IT ceiling so the refusal can be verified BY CLICKING.
 *  Writes only AdSpendCeiling. `--set <cents>` or `--clear`. */
import '../src/env.js'
import prisma from '../src/db.js'
async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--clear') {
    const n = await prisma.adSpendCeiling.deleteMany({ where: { createdBy: 'kt6-click-verify' } })
    console.log(`cleared ${n.count} ceiling(s)`); return
  }
  const cents = Number(args[1] ?? 1000)
  const row = await prisma.adSpendCeiling.upsert({
    where: { grain_scopeId: { grain: 'MARKET', scopeId: 'IT' } },
    create: { grain: 'MARKET', scopeId: 'IT', label: 'the IT market', dailyCapCents: cents, createdBy: 'kt6-click-verify', note: 'KT.6 click verification — removed after' },
    update: { dailyCapCents: cents, createdBy: 'kt6-click-verify' },
  })
  console.log(`IT MARKET ceiling set to €${(cents / 100).toFixed(2)} (id ${row.id})`)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0, 300)); await prisma.$disconnect(); process.exit(1) })
