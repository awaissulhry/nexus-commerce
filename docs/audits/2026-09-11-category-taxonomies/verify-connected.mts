/** Real provider reference reads + local cache writes. Never publishes marketplace products. */
import '../../../apps/api/src/env.js'
import { writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import prisma from '../../../apps/api/src/db.js'
import { withWorkspace, LEGACY_WORKSPACE_ID } from '@nexus/database/workspace-context'
import '../../../apps/api/src/services/cx/connectors/amazon-sp/spec.js'
import '../../../apps/api/src/services/cx/connectors/ebay/spec.js'
import '../../../apps/api/src/services/cx/connectors/etsy/spec.js'
import '../../../apps/api/src/services/cx/connectors/shopify/spec.js'
import { listTaxonomySources, searchTaxonomy, readTaxonomyRequirements, requestTaxonomyRefresh } from '../../../apps/api/src/services/taxonomy/repository.js'
import { runTaxonomyRefresh } from '../../../apps/api/src/jobs/taxonomy-refresh.job.js'

const target = new URL(process.env.DATABASE_URL!)
if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname)) throw new Error('This verification only writes to the local development database.')
const timer = setTimeout(() => { console.error('Connected taxonomy verification timed out.'); process.exit(2) }, 15 * 60_000)
const report: Record<string, unknown> = { at: new Date().toISOString(), target: 'local development', providerOperations: 'reference reads only' }
try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    if (process.argv.includes('--retry-failed')) {
      for (const source of (await listTaxonomySources()).filter(s => s.supported && s.state === 'failed')) await requestTaxonomyRefresh(source.channel, source.market)
    }
    if (process.argv.includes('--ingest')) {
      // Each tick runs at most two configured sources, preserving the ordinary durable queue.
      for (let tick = 0; tick < 12; tick++) {
        const sources = await listTaxonomySources()
        const pending = sources.filter(s => s.supported && ['missing', 'queued'].includes(s.state))
        if (!pending.length) break
        console.log(JSON.stringify({ tick, pending: pending.map(s => `${s.channel}/${s.market}`) }))
        await runTaxonomyRefresh()
      }
    }
    const sources = await listTaxonomySources()
    const checks = []
    for (const source of sources.filter(s => s.supported && s.snapshotId)) {
      const start = performance.now()
      const result = await searchTaxonomy(source.channel, source.market, { query: 'suit', assignableOnly: true })
      assert.equal(result.snapshotId, source.snapshotId)
      assert.ok(result.items.length <= 50)
      checks.push({ channel: source.channel, market: source.market, total: result.total, returned: result.items.length, elapsedMs: performance.now() - start })
    }
    report.searches = checks
    if (process.argv.includes('--requirements')) {
      const requirements: { channel: string; market: string; categoryId?: string; state?: string; error?: string }[] = []
      for (const [channel, market] of [['AMAZON', 'IT'], ['EBAY', 'IT'], ['ETSY', 'GLOBAL'], ['SHOPIFY', 'GLOBAL']]) {
        try {
          const matches = await searchTaxonomy(channel, market, { query: channel === 'AMAZON' ? 'SUIT' : '', assignableOnly: true })
          const node = matches.items[0]
          if (!node) { requirements.push({ channel, market, state: 'missing-tree' }); continue }
          const state = (await readTaxonomyRequirements(channel, market, node.externalId)).state
          if (channel !== 'SHOPIFY' && ['missing', 'stale'].includes(state)) await requestTaxonomyRefresh(channel, market, node.externalId)
          requirements.push({ channel, market, categoryId: node.externalId, state })
        } catch (error) { requirements.push({ channel, market, error: (error as Error).message }) }
      }
      for (let tick = 0; tick < 3; tick++) await runTaxonomyRefresh()
      for (const item of requirements) if (item.categoryId) item.state = (await readTaxonomyRequirements(item.channel, item.market, item.categoryId)).state
      report.requirements = requirements
    }
    report.sources = (await listTaxonomySources()).map(s => ({ channel: s.channel, market: s.market, state: s.state, nodes: s.nodeCount, error: s.error }))
    await writeFile(new URL('./connected-evidence.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  })
} finally { clearTimeout(timer); await prisma.$disconnect() }
// Imported workers can own idle Redis sockets; every awaited reference operation is complete.
process.exit(0)
