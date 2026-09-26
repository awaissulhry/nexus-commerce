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

  fastify.post<{ Params: { id: string } }>('/pim/channel-mapping-sets/:id/activate', async (request, reply) => guard(reply, async () => ({
    set: await activateSet(request.params.id, actor(request)),
  })))

  fastify.post<{ Params: { id: string } }>('/pim/channel-mapping-sets/:id/retire', async (request, reply) => guard(reply, async () => ({
    set: await retireSet(request.params.id),
  })))
}

export default channelMappingSetRoutes
