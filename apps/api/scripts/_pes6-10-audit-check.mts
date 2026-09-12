// PES.6 parity audit — verify the claim in row 6.26 before it goes in a doc.
import prisma from '../src/db.js'
const rows = await prisma.marketplace.findMany({
  where: { isActive: true }, orderBy: [{ channel: 'asc' }, { code: 'asc' }],
  select: { channel: true, code: true, schemaMapping: true },
})
const empty: string[] = []; const withRules: string[] = []
for (const m of rows) {
  const sm: any = m.schemaMapping ?? {}
  const keys = new Set<string>(Object.keys(sm.fields ?? {}))
  for (const t of Object.keys(sm.byProductType ?? {})) for (const k of Object.keys(sm.byProductType[t] ?? {})) keys.add(k)
  ;(keys.size ? withRules : empty).push(`${m.channel}·${m.code}${keys.size ? ` (${keys.size})` : ''}`)
}
console.log('WITH rules :', withRules.join(', ') || '(none)')
console.log('WITHOUT    :', empty.join(', '))
console.log('Amazon without rules:', empty.filter(e => e.startsWith('AMAZON')).length)
await prisma.$disconnect()
