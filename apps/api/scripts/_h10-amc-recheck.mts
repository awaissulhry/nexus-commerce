/** H10 cross-check — is AMC/DSP still unprovisioned? READ-ONLY GETs. */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

const conn = await prisma.amazonAdsConnection.findFirst({
  where: { marketplace: 'IT', isActive: true }, select: { profileId: true, region: true },
})
if (!conn) { console.log('no IT connection'); process.exit(1) }
const ctx = { profileId: conn.profileId, region: (conn.region as 'EU') ?? 'EU' }

async function probe(label: string, path: string, accept?: string) {
  try {
    const r = await liveCall({ ...ctx, method: 'GET', path, acceptHeader: accept, contentType: accept })
    console.log(`${label.padEnd(22)} 200  ${JSON.stringify(r).slice(0, 260)}`)
  } catch (e) {
    const err = e as Error & { statusCode?: number; body?: string }
    console.log(`${label.padEnd(22)} ${String(err.statusCode ?? '—').padEnd(4)} ${(err.body ?? err.message).slice(0, 260)}`)
  }
}

await probe('AMC accounts', '/amc/accounts')
await probe('AMC instances', '/amc/instances')
await probe('DSP advertisers', '/dsp/advertisers', 'application/vnd.dspadvertisers.v1+json')
await probe('Sponsored TV', '/st/campaigns/list')
await prisma.$disconnect()
