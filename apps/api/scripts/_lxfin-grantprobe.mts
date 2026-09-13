import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
const { default: prisma } = await import('../src/db.js')
console.log('db', (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS db'))[0])
const key = { channel: 'AMAZON', connectionId: 'lxfin-probe', marketplace: 'ZZ', productType: 'LXFIN_GRANT_PROBE', fieldKey: 'merchant_shipping_group' }
try { console.log('READ  through the app client:', JSON.stringify(await prisma.sellerReferenceLabel.findFirst({ where: key }))) }
catch (e: any) { console.log('READ  REFUSED:', e?.message?.split('\n').filter((l: string) => l.trim()).slice(-2).join(' | ')) }
let id: string | null = null
try { const row = await prisma.sellerReferenceLabel.create({ data: { ...key, labels: { 'probe-id': 'Probe label' } } }); id = row.id; console.log('WRITE through the app client: created', row.id, JSON.stringify(row.labels), 'fetchedAt', row.fetchedAt.toISOString()) }
catch (e: any) { console.log('WRITE REFUSED:', e?.message?.split('\n').filter((l: string) => l.trim()).slice(-2).join(' | ')) }
if (id) {
  await new Promise(r => setTimeout(r, 8500))
  console.log('READ BACK at', new Date().toISOString(), JSON.stringify(await prisma.sellerReferenceLabel.findFirst({ where: key, select: { id: true, labels: true } })))
  await prisma.sellerReferenceLabel.delete({ where: { id } })
  await new Promise(r => setTimeout(r, 8500))
  console.log('AFTER DELETE at', new Date().toISOString(), 'rows on the table:', await prisma.sellerReferenceLabel.count(), '· probe row:', JSON.stringify(await prisma.sellerReferenceLabel.findFirst({ where: key })))
}
await prisma.$disconnect()
