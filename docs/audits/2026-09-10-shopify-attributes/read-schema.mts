/** Read-only verification of the connected store; no mutations or subscription registration. */
import '../../../apps/api/src/env.js'
import '../../../apps/api/src/services/cx/connectors/shopify/spec.js'
import { writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.js'
import { withWorkspace, LEGACY_WORKSPACE_ID } from '../../../apps/api/src/lib/workspace-context.js'
import { shopifyAdmin } from '../../../apps/api/src/services/shopify/admin-client.js'
import { readLinkedStoreSchema } from '../../../apps/api/src/services/shopify/linked-products-gateway.js'
import { informationRegistry } from '../../../packages/shared/shopify-information.js'

const timer = setTimeout(() => { console.log('Schema read timed out.'); process.exit(2) }, 55_000)
try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const accounts = await prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY', isActive: true }, select: { id: true, displayName: true } })
    const evidence = []
    for (const account of accounts) {
      const { graphql, domain } = await shopifyAdmin(account.id)
      const schema = await readLinkedStoreSchema(graphql), registry = informationRegistry(schema)
      const sample = await prisma.channelListing.findFirst({ where: { channel: 'SHOPIFY', channelConnectionId: account.id, externalListingId: { not: null } }, select: { productId: true } })
      evidence.push({ store: domain, accountId: account.id, sampleProductId: sample?.productId, observedAt: new Date().toISOString(), definitionCount: schema.definitions.length, columnCount: registry.length, fields: registry.map(f => ({ id: f.id, label: f.label, owner: f.owner, type: f.type, group: f.group })), revision: schema.revision })
      console.log(JSON.stringify({ store: domain, definitions: schema.definitions.length, columns: registry.length, sampleProductId: sample?.productId }))
    }
    if (!accounts.length) throw new Error('No active Shopify account found.')
    await writeFile(new URL('./live-schema.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  })
} finally { clearTimeout(timer); await prisma.$disconnect() }
