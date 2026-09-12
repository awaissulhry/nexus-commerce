/** Read-only access preflight. Never prints credentials or enables publishing. */
import '../../../../apps/api/src/env.js'
import prisma from '../../../../apps/api/src/db.js'
import { shopifyAdmin } from '../../../../apps/api/src/services/shopify/admin-client.js'
const timer = setTimeout(() => { console.log(JSON.stringify({ status: 'ACCESS_CHECK_TIMEOUT' })); process.exit(2) }, 45000)
try {
  const accounts = await prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY' }, select: { id: true, displayName: true, region: true, isActive: true, managedBy: true } })
  console.log(JSON.stringify({ status: 'ACCOUNTS', accounts }, null, 2))
  for (const account of accounts.filter(a => a.isActive)) {
    try {
      const { graphql } = await shopifyAdmin(account.id)
      const result = await graphql(`query NexusReviewAccess { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } shopLocales { locale primary published } }`)
      console.log(JSON.stringify({ accountId: account.id, status: 'VERIFIED_READ_ACCESS', ...result }, null, 2))
    } catch (error) { console.log(JSON.stringify({ accountId: account.id, status: 'ACCESS_UNAVAILABLE', message: (error as Error).message })) }
  }
} catch (error) { console.log(JSON.stringify({ status: 'DATABASE_UNAVAILABLE', name: (error as Error).name, code: (error as any).code })) }
finally { clearTimeout(timer); await prisma.$disconnect() }
