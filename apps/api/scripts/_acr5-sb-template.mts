/**
 * ACR Stage 5 — can an SB creative be built from this account's own brand assets? READ-ONLY.
 *
 * SB is the one family that cannot launch from structured fields alone: it needs a brand logo
 * in Amazon's asset library, a registered brand name and a landing page. Rather than build an
 * asset-upload flow, `resolveSbTemplate` reads them off the 4 existing SB campaigns. If this
 * prints a template per marketplace, SB is reachable today.
 *
 * Usage: cd apps/api && railway run npx tsx scripts/_acr5-sb-template.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { resolveSbTemplate } = await import('../src/services/advertising/ads-create.service.js')

const markets = await prisma.campaign.findMany({
  where: { adProduct: 'SPONSORED_BRANDS' }, select: { marketplace: true }, distinct: ['marketplace'],
})
console.log(`\nMarketplaces with SB campaigns: ${markets.map(m => m.marketplace).join(', ') || '(none)'}\n`)

for (const { marketplace } of markets) {
  const t = await resolveSbTemplate(marketplace)
  if (!t) { console.log(`${marketplace}: no usable template — SB cannot be created here without an asset upload flow`); continue }
  console.log(`${marketplace}:`)
  console.log(`  brandName    ${t.brandName || '(missing)'}`)
  console.log(`  logoAssetId  ${t.logoAssetId ? t.logoAssetId.slice(0, 62) + '…' : '(missing)'}`)
  console.log(`  landing      ${t.landingType}${t.landingUrl ? ` → ${t.landingUrl}` : ''}`)
  console.log(`  cloned from  ${t.sourceCampaign}`)
  console.log(`  USABLE       ${t.brandName && t.logoAssetId ? 'YES' : 'NO — missing a required asset'}`)
}
await prisma.$disconnect(); process.exit(0)
