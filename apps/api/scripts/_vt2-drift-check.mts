/**
 * AX-VT.2 verification, step 2 — CHECK and DISARM.
 *
 * Looks for the drift row the sync must now produce (ourValue = a portfolio, amazonValue = null),
 * then restores the campaign's local portfolioId to null and closes the row it created.
 *
 * Pass RESTORE=0 to inspect without disarming.
 */
const prisma = (await import('../src/db.js')).default
const p = prisma as any
const L = (s = '') => console.log(s)
const ID = process.env.CID ?? 'cmpee2e0m09lxoj01l4qhvbr9'

const c = await p.campaign.findUnique({ where: { id: ID }, select: { name: true, portfolioId: true, settingsSyncedAt: true, status: true } })
L(`campaign: ${c?.name}  (${c?.status})`)
L(`  local portfolioId: ${c?.portfolioId ?? 'null'}   ← armed value must SURVIVE the sync (VT.2 is compare-only)`)
L(`  settingsSyncedAt:  ${c?.settingsSyncedAt?.toISOString?.() ?? 'never'}`)

const d = await p.adDrift.findFirst({ where: { entityType: 'CAMPAIGN', entityId: ID, field: 'portfolioId' } })
L(`\n══ DRIFT ROW ══════════════════════════════════════════════════════`)
if (!d) {
  L('  NONE — the sync has not run since arming, or VT.2 did not fire.')
} else {
  L(`  field           ${d.field}`)
  L(`  ourValue        ${d.ourValue}`)
  L(`  amazonValue     ${JSON.stringify(d.amazonValue)}   ← null = "Amazon says: in no portfolio"`)
  L(`  classification  ${d.classification}`)
  L(`  entityName      ${d.entityName}`)
  L(`  firstDetectedAt ${d.firstDetectedAt?.toISOString?.()}`)
  L(`  occurrences     ${d.occurrences}`)
  L(`  resolvedAt      ${d.resolvedAt?.toISOString?.() ?? 'null (open)'}`)
  L(`\n  >>> VT.2 ${d.amazonValue === null ? 'VERIFIED ✓ — the class that produced 0 rows for 62 wrong campaigns is now detected' : 'UNEXPECTED: amazonValue is not null'}`)
}

L(`\n══ all portfolioId drift rows account-wide ═══════════════════════`)
const all = await p.adDrift.findMany({ where: { field: 'portfolioId' }, select: { entityName: true, ourValue: true, amazonValue: true, classification: true, resolvedAt: true } })
L(`  ${all.length} row(s)`)
for (const r of all) L(`    ${String(r.entityName).slice(0, 40).padEnd(42)} ours=${r.ourValue} amazon=${JSON.stringify(r.amazonValue)} ${r.classification}${r.resolvedAt ? ' RESOLVED' : ''}`)

if (process.env.RESTORE === '0') { L('\nRESTORE=0 — left armed.'); process.exit(0) }
await p.campaign.update({ where: { id: ID }, data: { portfolioId: null } })
if (d) await p.adDrift.delete({ where: { id: d.id } }).catch(() => {})
L(`\nDISARMED: local portfolioId restored to null; test drift row removed.`)
process.exit(0)
