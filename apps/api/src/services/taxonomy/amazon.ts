import prisma from '../../db.js'
import { listActiveConnections, chooseConnection } from '../connection-resolver.service.js'
import { amazonMarketplaceId } from '../categories/marketplace-ids.js'
import { TaxonomyError } from './model.js'

/** Public reference data still needs credentials from an account in the market's region. */
export async function amazonTaxonomyScope(market: string) {
  const configured = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code: market, isActive: true }, select: { marketplaceId: true, region: true } })
  const marketplaceId = configured?.marketplaceId || amazonMarketplaceId(market)
  if (!/^A[A-Z0-9]{6,}$/.test(marketplaceId)) throw new TaxonomyError('Configure the Amazon marketplace ID before synchronizing its taxonomy.', 409)
  const region = configured?.region.toLowerCase()
  if (!region || !['eu', 'na', 'fe'].includes(region)) throw new TaxonomyError('Configure the Amazon marketplace region before synchronizing its taxonomy.', 409)
  const candidates = (await listActiveConnections('AMAZON')).filter(a => {
    const value = (a.region ?? '').toLowerCase()
    return value === region || (region === 'eu' && value.startsWith('eu-')) || (region === 'na' && /^(us|ca)-/.test(value)) || (region === 'fe' && value.startsWith('ap-'))
  })
  if (!candidates.length) throw new TaxonomyError(`Connect an Amazon account in the ${region.toUpperCase()} region to synchronize this marketplace.`, 409)
  return { marketplaceId, accountId: chooseConnection(candidates, { channel: 'AMAZON', wantPrimary: true }).id }
}
