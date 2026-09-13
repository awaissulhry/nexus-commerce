import { normalizeLanguage } from '../services/pim/content-language.js'
/**
 * PES.8 — the AI enrichment routes, deliberately split across two prefixes.
 *
 *   POST /api/ai/product-enrichment/estimate   ai:view / ai:run
 *   POST /api/ai/product-enrichment/generate   ai:view / ai:run
 *   GET  /api/products/ai/drafts               products:view
 *   POST /api/products/ai/drafts/approve       products:edit
 *   POST /api/products/ai/drafts/reject        products:edit
 *
 * The split is load-bearing, not cosmetic. `permissions-manifest.ts` resolves a
 * route by FIRST MATCHING PREFIX, and `pfx('/api/ai/')` sits at :155 while
 * `pfx('/api/products')` sits at :395. So generation — which spends money —
 * lands on `ai:run`, and approval — which puts a value into the catalogue —
 * lands on `products:edit`. Both are gates the operator should have to pass,
 * and they are not the same gate. Mounting the whole lane under one prefix
 * would have made one of them unreachable.
 *
 * (Worth knowing while reading that manifest: its :400 entry,
 * `pfx('/api/products-ai')`, is already unreachable for the same reason — :395
 * matches it first. Not this lane's to fix, but it is why these paths were
 * chosen rather than a third `/api/products-ai/...` sibling.)
 */
import type { FastifyPluginAsync } from 'fastify'

import {
  approveDrafts,
  listDrafts,
  rejectDrafts,
  type DraftStatus,
} from '../services/ai/enrichment/draft.service.js'
import {
  runEnrichment,
  type EnrichmentScope,
} from '../services/ai/enrichment/generate.service.js'

interface RunBody {
  productIds?: string[]
  market?: string
  channel?: string | null
  marketplace?: string | null
  aliasId?: string | null
  locale?: string | null
  columns?: string[]
  provider?: string | null
}

const VALID_STATUS = new Set<DraftStatus>([
  'pending',
  'approved',
  'rejected',
  'superseded',
  'failed',
])

function readScope(body: RunBody): EnrichmentScope {
  const channel = body.channel ? String(body.channel).trim().toUpperCase() : null
  return {
    channel,
    marketplace: body.marketplace ? String(body.marketplace).trim().toUpperCase() : null,
    aliasId: body.aliasId ? String(body.aliasId).trim() : null,
    locale: body.locale ? normalizeLanguage(String(body.locale).trim()) : null,
  }
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
}

/** Generation. Mounted at `/api` so the paths land under `/api/ai/...`. */
export const productEnrichmentAiRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * Price a batch without calling the vendor. This is the number the operator
   * agrees to before anything runs — it builds every prompt for real, so it is
   * the same arithmetic the run itself will do, not a separate guess.
   */
  fastify.post<{ Body: RunBody }>(
    '/ai/product-enrichment/estimate',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body ?? {}
      const market = String(body.market ?? '').trim().toUpperCase()
      if (!market) return reply.code(400).send({ error: 'market is required' })

      const result = await runEnrichment({
        productIds: ids(body.productIds),
        market,
        scope: readScope(body),
        columns: ids(body.columns),
        dryRun: true,
        provider: body.provider ?? null,
        userId: request.authUser?.id ?? null,
      })
      return result
    },
  )

  /**
   * Run the batch. Writes ProductAiDraft rows and nothing else — there is no
   * path from here to a Product column, by construction.
   *
   * Rate limit is tight on purpose: each call fans out to one vendor request
   * per product, and a stuck client retry loop is real money.
   */
  fastify.post<{ Body: RunBody }>(
    '/ai/product-enrichment/generate',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body ?? {}
      const market = String(body.market ?? '').trim().toUpperCase()
      if (!market) return reply.code(400).send({ error: 'market is required' })

      const result = await runEnrichment({
        productIds: ids(body.productIds),
        market,
        scope: readScope(body),
        columns: ids(body.columns),
        dryRun: false,
        provider: body.provider ?? null,
        userId: request.authUser?.id ?? null,
      })
      // A refusal is a 200 carrying its reason, not an error: every refusal
      // here is a state the operator can act on (kill switch, no provider, no
      // product type, budget), and the UI shows all of them the same way.
      return result
    },
  )
}

/** Review + decision. Mounted at `/api` so the paths land under `/api/products/...`. */
export const productAiDraftRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * The sheet overlay: every draft for the products on screen, with the diff's
   * base value and whether the cell has moved under it since.
   */
  fastify.get('/products/ai/drafts', async (request) => {
    const q = request.query as Record<string, unknown>
    const csv = (v: unknown): string[] =>
      v === undefined || v === null
        ? []
        : [
            ...new Set(
              (Array.isArray(v) ? v : [v])
                .flatMap((x) => String(x).split(','))
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ]

    const status = csv(q.status).filter((s): s is DraftStatus => VALID_STATUS.has(s as DraftStatus))
    const channelRaw = typeof q.channel === 'string' ? q.channel.trim().toUpperCase() : undefined
    const marketplaceRaw =
      typeof q.marketplace === 'string' ? q.marketplace.trim().toUpperCase() : undefined

    // `?locale=de` scopes to that locale's drafts; absent means the master's own values.
    const localeRaw = typeof q.locale === 'string' ? q.locale.trim() : ''
    const drafts = await listDrafts({
      locale: localeRaw && localeRaw.toLowerCase() !== 'master' ? normalizeLanguage(localeRaw) : null,
      productIds: csv(q.productIds),
      runId: typeof q.runId === 'string' && q.runId ? q.runId : undefined,
      // 'master' is how a caller asks for the master scope, since an absent
      // channel means "any scope" and a null one means "the master scope".
      channel: channelRaw === undefined ? undefined : channelRaw === 'MASTER' ? null : channelRaw,
      marketplace:
        marketplaceRaw === undefined ? undefined : marketplaceRaw === 'MASTER' ? null : marketplaceRaw,
      status: status.length > 0 ? status : undefined,
      limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
    })

    return {
      drafts,
      counts: {
        total: drafts.length,
        pending: drafts.filter((d) => d.status === 'pending').length,
        failed: drafts.filter((d) => d.status === 'failed').length,
        stale: drafts.filter((d) => d.stale).length,
      },
    }
  })

  /**
   * Approve drafts by id. Each approved cell is replayed through
   * `PATCH /api/products/bulk` — the same route the sheet autosaves through —
   * so it meets the same validation, the same 409 and the same audit trail.
   *
   * `allowStale` must be sent explicitly, per call. Without it a cell that has
   * changed since the draft was generated is refused, because approving it
   * would silently overwrite whatever the operator (or a sync) put there.
   */
  fastify.post<{ Body: { draftIds?: string[]; allowStale?: boolean } }>(
    '/products/ai/drafts/approve',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const draftIds = ids(request.body?.draftIds)
      if (draftIds.length === 0) return reply.code(400).send({ error: 'draftIds[] required' })
      if (draftIds.length > 500) {
        return reply.code(400).send({ error: 'Max 500 drafts per approval' })
      }
      const result = await approveDrafts(fastify, request, draftIds, {
        allowStale: request.body?.allowStale === true,
      })
      return result
    },
  )

  fastify.post<{ Body: { draftIds?: string[] } }>(
    '/products/ai/drafts/reject',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const draftIds = ids(request.body?.draftIds)
      if (draftIds.length === 0) return reply.code(400).send({ error: 'draftIds[] required' })
      return rejectDrafts(request, draftIds)
    },
  )
}

export default productAiDraftRoutes
