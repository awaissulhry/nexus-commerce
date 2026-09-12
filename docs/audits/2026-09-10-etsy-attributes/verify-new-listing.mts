/** Verify new-listing authoring without reading, importing or assigning existing Etsy listings. */
import '../../../apps/api/src/env.js'
import '../../../apps/api/src/services/cx/connectors/etsy/spec.js'
import { writeFile } from 'node:fs/promises'
import prisma from '../../../apps/api/src/db.js'
import { withWorkspace, LEGACY_WORKSPACE_ID } from '../../../apps/api/src/lib/workspace-context.js'
import { getEtsyTaxonomy } from '../../../apps/api/src/services/etsy/taxonomy.js'
import { getSheetColumns } from '../../../apps/api/src/services/pim/sheet-columns.service.js'
import { getFieldCatalogue } from '../../../apps/api/src/services/pim/mapping/field-catalogue.service.js'

try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const accounts = await prisma.channelConnection.findMany({ where: { channelType: 'ETSY', isActive: true }, select: { id: true } })
    const evidence = []
    for (const account of accounts) {
      const taxonomy = await getEtsyTaxonomy(account.id)
      const sheet = await getSheetColumns({ market: 'GLOBAL', productTypes: [], onlyChannels: ['ETSY'], accountId: account.id, includeEmptyChannels: true, scopeKind: 'channel' })
      const mapping = await getFieldCatalogue({ channel: 'ETSY', marketplace: 'GLOBAL', accountId: account.id })
      const result = { accountId: account.id, observedAt: new Date().toISOString(), sellerCategoryCount: taxonomy.length, newListingColumnCount: sheet.columns.length,
        missing: sheet.schemaMissing, coverage: sheet.coverage, mappingCounts: mapping.counts,
        fields: mapping.fields.map(f => ({ key: f.fieldKey, label: f.label, sheetKey: f.sheetKey, rule: f.rule, editable: f.editable, shape: f.shape,
          managedBy: f.managedBy, sourceOwner: f.sourceOwner, status: f.status, readOnlyReason: f.readOnlyReason })) }
      evidence.push(result)
      console.log(JSON.stringify({ accountId: account.id, sellerCategoryCount: taxonomy.length, newListingColumnCount: sheet.columns.length, missing: sheet.schemaMissing,
        mappingCounts: mapping.counts, defaults: mapping.fields.filter(f => f.rule).map(f => ({ field: f.fieldKey, source: f.rule?.source })) }))
    }
    await writeFile(new URL('./new-listing-coverage.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
  })
} finally { await prisma.$disconnect() }
