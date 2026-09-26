import type { FastifyPluginAsync } from 'fastify'
import {
  activateSet, decideField, diffSets, getSet, listSets, listUses, MappingError, newVersionFrom, retireSet, type FieldDecision,
} from '../services/channel-mapping/store.js'

/**
 * CHMAP (`docs/studies/channel-mappings.md` §8.7) — the file-mapping versions behind the Mapping page.
 * Under `/api/pim`, so reads and writes need `pim.manage` (permissions manifest). Only a DRAFT changes; an ACTIVE
 * version is frozen, and activating one retires the form's previous ACTIVE version.
 */
const channelMappingSetRoutes: FastifyPluginAsync = async (fastify) => {
  const actor = (request: any): string | null => request.user?.id ?? request.authUser?.id ?? null
  const guard = async <T>(reply: any, work: () => Promise<T>) => {
    try { return await work() } catch (error) {
      if (error instanceof MappingError) return reply.status(error.status).send({ error: error.message })
      throw error
    }
  }

  fastify.get<{ Querystring: { channel?: string; marketplace?: string } }>('/pim/channel-mapping-sets', async (request) => ({
    sets: await listSets({ channel: request.query.channel?.toUpperCase(), marketplace: request.query.marketplace?.toUpperCase() }),
  }))

  fastify.get<{ Params: { id: string } }>('/pim/channel-mapping-sets/:id', async (request, reply) => guard(reply, async () => {
    const [set, uses] = await Promise.all([getSet(request.params.id), listUses(request.params.id, 20)])
    return { set, uses: uses.map(u => ({ id: u.id, action: u.action, reference: u.reference, detail: u.detail, createdAt: u.createdAt.toISOString() })) }
  }))

  fastify.get<{ Params: { id: string; otherId: string } }>('/pim/channel-mapping-sets/:id/diff/:otherId', async (request, reply) => guard(reply, async () => ({
    diff: await diffSets(request.params.otherId, request.params.id),
  })))

  /** The fields a column can be mapped to: the channel spec of every product type (or category) of the form. */
  fastify.get<{ Params: { id: string } }>('/pim/channel-mapping-sets/:id/targets', async (request, reply) => guard(reply, async () => {
    const set = await getSet(request.params.id)
    if (set.channel === 'SHOPIFY') {
      // NCF — the store's saved field list only (never a live Shopify read); the native fields when none is saved.
      const { shopifyStoreSpec } = await import('../services/pim/catalog-shopify-csv.js')
      const { spec, storeFields } = await shopifyStoreSpec(set.formKey)
      return { targets: spec.fields.map(f => ({ key: f.key, label: f.label, englishLabel: f.englishLabel ?? null, requirement: f.requirement, shape: f.shape, kind: f.kind, productTypes: [] as string[] })).sort((a, b) => a.key.localeCompare(b.key)),
        missingSchemas: storeFields ? [] : ['this store’s field list (metafields)'] }
    }
    const { loadAmazonSpec, loadEbaySpec } = await import('../services/pim/channel-specs/index.js')
    const categories = set.formKey.split('+').filter(c => c && c !== 'UNKNOWN')
    const byKey = new Map<string, { key: string; label: string; englishLabel: string | null; requirement: string; shape: string; kind: string; productTypes: string[] }>()
    const missing: string[] = []
    for (const category of categories) {
      const spec = set.channel === 'AMAZON' ? await loadAmazonSpec(set.marketplace, category) : await loadEbaySpec(set.marketplace, [category])
      if (spec.absent) { missing.push(category); continue }
      for (const f of spec.fields) {
        const entry = byKey.get(f.key) ?? { key: f.key, label: f.label, englishLabel: f.englishLabel ?? null, requirement: f.requirement, shape: f.shape, kind: f.kind, productTypes: [] }
        entry.productTypes.push(category)
        byKey.set(f.key, entry)
      }
    }
    return { targets: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)), missingSchemas: missing }
  }))

  fastify.patch<{ Params: { id: string }; Body: FieldDecision & { channelKey: string } }>('/pim/channel-mapping-sets/:id/fields', async (request, reply) => guard(reply, async () => {
    const { channelKey, ...decision } = request.body ?? ({} as FieldDecision & { channelKey: string })
    if (!channelKey) return reply.status(400).send({ error: 'Name the column (channelKey)' })
    return { set: await decideField(request.params.id, channelKey, decision as FieldDecision) }
  }))

  fastify.post<{ Params: { id: string } }>('/pim/channel-mapping-sets/:id/versions', async (request, reply) => guard(reply, async () => ({
    set: await newVersionFrom(request.params.id, actor(request)),
  })))

  /** The difference list shown before an activation (or `?on=retire`): what the push starts or stops sending, and how many listings it touches. */
  fastify.get<{ Params: { id: string }; Querystring: { on?: string } }>('/pim/channel-mapping-sets/:id/push-impact', async (request, reply) => guard(reply, async () => {
    const { pushImpact } = await import('../services/channel-mapping/push.js')
    const impact = await pushImpact(request.params.id, request.query.on === 'retire' ? 'retire' : 'activate')
    if (!impact) throw new MappingError('This mapping version does not exist', 404)
    return { impact }
  }))

  fastify.post<{ Params: { id: string } }>('/pim/channel-mapping-sets/:id/activate', async (request, reply) => guard(reply, async () => ({
    set: await activateSet(request.params.id, actor(request)),
  })))

  fastify.post<{ Params: { id: string } }>('/pim/channel-mapping-sets/:id/retire', async (request, reply) => guard(reply, async () => ({
    set: await retireSet(request.params.id),
  })))

  /** Upload an Amazon template once: Nexus keeps it as the export base and finds or makes its mapping version. */
  fastify.post('/pim/channel-mapping-sets/templates', async (request, reply) => guard(reply, async () => {
    const part = await request.file({ limits: { files: 1, fileSize: 10 * 1024 * 1024 } })
    if (!part) return reply.status(400).send({ error: 'Choose the Amazon template you downloaded from Seller Central' })
    const { registerAmazonTemplate } = await import('../services/channel-mapping/amazon-import.js')
    try { return reply.code(201).send({ template: await registerAmazonTemplate(await part.toBuffer(), part.filename) }) }
    catch (error) { if (error instanceof MappingError) throw error; return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) }) }
  }))

  /** NCF — the connected Shopify stores (a Shopify product CSV names none; the page chooses one when there are several). */
  fastify.get('/pim/channel-mapping-sets/shopify-stores', async () => {
    const { shopifyStores } = await import('../services/pim/catalog-shopify-csv.js')
    return { stores: await shopifyStores() }
  })

  /**
   * NCF — read Shopify's own product CSV for its PREVIEW: the mapping version it reads with (found, or made as a DRAFT)
   * and what an import would write, exclude and refuse. Nothing else is saved; the import itself is applied from the
   * Catalog page or a product's sheet. Read on the parse worker, like every channel file.
   */
  fastify.post('/pim/channel-mapping-sets/shopify-files', async (request, reply) => guard(reply, async () => {
    const part = await request.file({ limits: { files: 1, fileSize: 10 * 1024 * 1024 } })
    if (!part) return reply.status(400).send({ error: 'Choose the product CSV you exported from Shopify (Products → Export)' })
    const accountField = (part.fields as Record<string, { value?: unknown } | undefined>)?.accountId
    const accountId = typeof accountField?.value === 'string' && accountField.value ? accountField.value : undefined
    const bytes = await part.toBuffer()
    const [{ openWorkbookParser }, { resolveShopifyCsv, shopifyFilePreview }] = await Promise.all([import('../services/pim/workbook-parse.js'), import('../services/pim/catalog-shopify-csv.js')])
    const session = openWorkbookParser({ resolveBaseline: async () => { throw new Error('An editing workbook belongs to its product sheet.') } })
    try {
      const outcome = await session.read(part.filename, bytes, 128 * 1024 * 1024)
      if (outcome.kind !== 'shopify') return reply.status(400).send({ error: `${part.filename} is not Shopify’s product CSV. Export it from Shopify (Products → Export → All products → Plain CSV file).` })
      const result = await resolveShopifyCsv(outcome.table, { accountId })
      if (!result.mapping) return reply.status(500).send({ error: 'The mapping version for this file could not be read; nothing was saved.' })
      return reply.code(201).send({ preview: { ...result.mapping, ...shopifyFilePreview(outcome.table, result, { id: result.accountId, label: result.storeLabel }) } })
    } catch (error) {
      if (error instanceof MappingError) throw error
      return reply.status(400).send({ error: error instanceof Error ? error.message : String(error) })
    } finally { await session.close() }
  }))

  /**
   * Write Amazon's own template from what Nexus holds, through an ACTIVE version. Always a PARTIAL update: a blank
   * cell keeps Amazon's value (stock, fulfilment and every column Nexus does not carry stay untouched on upload).
   */
  fastify.post<{ Params: { id: string }; Body: { skus?: string[]; includePrices?: boolean } }>('/pim/channel-mapping-sets/:id/export', async (request, reply) => guard(reply, async () => {
    const set = await getSet(request.params.id)
    if (set.status !== 'ACTIVE') throw new MappingError(`Activate version ${set.version} before exporting with it.`, 409)
    if (set.formKind === 'SHOPIFY_PRODUCT_CSV') {
      // NCF N7 — Shopify's own product CSV: only products Nexus links; a blank never erases, options never move.
      const { exportShopifyCsv } = await import('../services/channel-mapping/shopify-export-host.js')
      const out = await exportShopifyCsv({ setId: set.id, skus: request.body?.skus ?? [], includePrices: request.body?.includePrices ?? true })
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${out.filename.replace(/"/g, '')}"`)
      reply.header('X-Nexus-Export-Summary', encodeURIComponent(JSON.stringify({ rows: out.rows.length, products: out.products, gaps: out.refused.length, blankColumns: out.omitted.length, mapping: out.set.label,
        omitted: out.omitted.map(o => o.header), refused: out.refused.slice(0, 10).map(r => ({ sku: r.sku, reason: r.reason })) })))
      return reply.send(out.bytes)
    }
    if (set.formKind === 'EBAY_WORKBOOK') {
      const { exportEbayWorkbook } = await import('../services/channel-mapping/ebay-export-host.js')
      const out = await exportEbayWorkbook({ marketplace: set.marketplace, setId: set.id, skus: request.body?.skus ?? [] })
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      reply.header('Content-Disposition', `attachment; filename="${out.filename.replace(/"/g, '')}"`)
      reply.header('X-Nexus-Export-Summary', encodeURIComponent(JSON.stringify({ rows: out.rows.length, gaps: out.gaps.filter(g => g.required).length, blankColumns: out.blankByDesign.size, mapping: out.set.label })))
      return reply.send(out.bytes)
    }
    if (set.channel !== 'AMAZON' || set.formKind !== 'AMAZON_TEMPLATE') throw new MappingError('Old Amazon flat files are read only; export with a current template version.', 409)
    const { exportAmazonTemplate } = await import('../services/channel-mapping/amazon-export-host.js')
    const out = await exportAmazonTemplate({ marketplace: set.marketplace, setId: set.id, skus: request.body?.skus ?? [], includePrices: request.body?.includePrices ?? true, recordAction: 'partial_update' })
    reply.header('Content-Type', 'application/vnd.ms-excel.sheet.macroEnabled.12')
    reply.header('Content-Disposition', `attachment; filename="${out.filename.replace(/"/g, '')}"`)
    reply.header('X-Nexus-Export-Summary', encodeURIComponent(JSON.stringify({ rows: out.rows, gaps: out.gaps.filter(g => g.required).length, blankColumns: out.blankByDesign.length, mapping: out.set.label })))
    return reply.send(out.bytes)
  }))
}

export default channelMappingSetRoutes
