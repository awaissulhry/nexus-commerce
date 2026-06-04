/**
 * FM.4 — value-map + size-scale API.
 *
 * Mounted under /api. Backs the FM.9 Global Mapping Console's value-map +
 * size-scale editors and the AI seed action. Writes go through the
 * value-map service so the lookup caches stay coherent.
 *
 *   GET    /pim/value-maps?channel=&marketplace=&attribute=
 *   PUT    /pim/value-maps                  → manual upsert (operator-reviewed)
 *   DELETE /pim/value-maps/:id
 *   POST   /pim/value-maps/seed-ai          → Amazon cross-market AI seed
 *   GET    /pim/size-scales?scale=
 *   PUT    /pim/size-scales                 → upsert one conversion
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  listValueMaps,
  upsertValueMap,
  removeValueMap,
  listSizeScales,
  upsertSizeScale,
  seedValueMapsFromAI,
} from '../services/pim/value-map.service.js'

const valueMapRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { channel?: string; marketplace?: string; attribute?: string } }>(
    '/pim/value-maps',
    async (request, reply) => {
      const { channel, marketplace, attribute } = request.query
      if (!channel) return reply.status(400).send({ error: 'channel is required' })
      const valueMaps = await listValueMaps({ channel, marketplace: marketplace ?? null, attribute })
      return reply.send({ valueMaps })
    },
  )

  fastify.put<{
    Body: { channel: string; marketplace?: string; attribute: string; fromValue: string; toValue: string }
  }>('/pim/value-maps', async (request, reply) => {
    const b = request.body
    if (!b?.channel || !b?.attribute || !b?.fromValue || typeof b?.toValue !== 'string') {
      return reply.status(400).send({ error: 'channel, attribute, fromValue, toValue are required' })
    }
    const valueMap = await upsertValueMap({ ...b, confidence: 'MANUAL', reviewed: true })
    return reply.send({ ok: true, valueMap })
  })

  fastify.delete<{ Params: { id: string } }>('/pim/value-maps/:id', async (request, reply) => {
    await removeValueMap(request.params.id)
    return reply.send({ ok: true })
  })

  fastify.post<{
    Body: {
      marketplace?: string
      attribute: string
      productType: string
      values: string[]
      targetMarkets: string[]
      colLabelEn?: string
    }
  }>('/pim/value-maps/seed-ai', async (request, reply) => {
    const b = request.body
    if (!b?.attribute || !b?.productType || !Array.isArray(b?.values) || !Array.isArray(b?.targetMarkets)) {
      return reply.status(400).send({ error: 'attribute, productType, values[], targetMarkets[] are required' })
    }
    try {
      const { written, result } = await seedValueMapsFromAI(b)
      return reply.send({ ok: true, written, mappings: result.mappings, errors: result.errors })
    } catch (err: any) {
      request.log.error({ err }, 'value-map seed-ai failed')
      return reply.status(500).send({ error: err?.message ?? 'seed failed' })
    }
  })

  fastify.get<{ Querystring: { scale?: string } }>('/pim/size-scales', async (request, reply) => {
    const sizeScales = await listSizeScales({ scale: request.query.scale })
    return reply.send({ sizeScales })
  })

  fastify.put<{
    Body: { scale: string; fromSystem: string; toSystem: string; fromValue: string; toValue: string }
  }>('/pim/size-scales', async (request, reply) => {
    const b = request.body
    if (!b?.scale || !b?.fromSystem || !b?.toSystem || !b?.fromValue || typeof b?.toValue !== 'string') {
      return reply.status(400).send({ error: 'scale, fromSystem, toSystem, fromValue, toValue are required' })
    }
    const sizeScale = await upsertSizeScale(b)
    return reply.send({ ok: true, sizeScale })
  })
}

export default valueMapRoutes
