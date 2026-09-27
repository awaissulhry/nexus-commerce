/**
 * `POST /api/amazon/listings/fill-asins` — read the ASIN of published Amazon listings from Amazon and record it.
 *
 * Body `{ listingIds?: string[], dryRun: boolean }`. Without `listingIds`, every Amazon row with no ASIN that is
 * published or past DRAFT, at most 200 (`unfilledAmazonListingIds`). `dryRun` is required, so a write is never the
 * default: `dryRun: true` only reads Amazon and writes nothing, which makes it safe against production. The per-row
 * report and the rules live in `services/amazon/listing-asin-fill.service.ts`.
 */
import type { FastifyInstance } from 'fastify'
import { ASIN_FILL_MAX, fillAmazonListingAsins, unfilledAmazonListingIds } from '../services/amazon/listing-asin-fill.service.js'

export type FillAsinsInput = { listingIds?: string[]; dryRun: boolean }

export function parseFillAsinsBody(body: unknown): FillAsinsInput | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send a JSON object with dryRun.' }
  const { listingIds, dryRun } = body as Record<string, unknown>
  if (typeof dryRun !== 'boolean') return { error: 'dryRun must be true or false.' }
  if (listingIds === undefined) return { dryRun }
  if (!Array.isArray(listingIds) || listingIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200))
    return { error: 'listingIds must be a list of listing ids.' }
  if (!listingIds.length) return { error: 'Name at least one listing, or leave listingIds out to read every listing with no ASIN.' }
  const ids = [...new Set(listingIds.map(id => (id as string).trim()))]
  if (ids.length > ASIN_FILL_MAX) return { error: `At most ${ASIN_FILL_MAX} listings can be read at once.` }
  return { listingIds: ids, dryRun }
}

export default async function amazonListingAsinRoutes(app: FastifyInstance) {
  app.post('/amazon/listings/fill-asins', async (req, reply) => {
    const input = parseFillAsinsBody(req.body)
    if ('error' in input) return reply.code(400).send({ error: input.error })
    try {
      return reply.send(await fillAmazonListingAsins(input.listingIds ?? await unfilledAmazonListingIds(), { dryRun: input.dryRun }))
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message.slice(0, 400) : 'The ASIN read failed.' })
    }
  })
}
