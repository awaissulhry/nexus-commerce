/**
 * AE.2 — assortments and assortment shares between business profiles.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §14. No database access here (PH.4a): every
 * route calls a service in services/assortment/.
 *
 * Permissions (permissions-manifest.ts): /api/assortments reads at products.view and writes at
 * products.edit; /api/assortment-shares is settings.workspace.edit, because it names other
 * businesses. The OWNER checks are in the service, with the database as the backstop — a route
 * permission is role-based and knows nothing about which business a share points at.
 *
 * Every change is a POST that names the version being changed. Nothing is deleted: archive and
 * revoke keep the row and its history, so no DELETE verb promises otherwise.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { WorkspaceError } from '../lib/workspace-context.js'
import {
  addMembers, archiveAssortment, createAssortment, listAssortments, listMembers, removeMembers, updateAssortment,
} from '../services/assortment/assortment.service.js'
import { followerDecision, listShares, offerShare, ownerAction } from '../services/assortment/assortment-share.service.js'
import { isFollowerDecision, isOwnerAction } from '../services/assortment/share-rules.js'
import { previewCopy } from '../services/assortment/copy-preview.service.js'
import { advanceCopyRun, confirmCopy, getCopyRun, listCopyRuns } from '../services/assortment/copy-run.service.js'
import { productSharing, setProductInAssortment } from '../services/assortment/product-sharing.service.js'
import { applyListingLayout, applyShareLayout, listingLayout, shareLayout } from '../services/assortment/listing-layout.service.js'
import { catalogLinkState } from '../services/assortment/sync.service.js'
import { followAgain, resyncShare } from '../services/assortment/sync-worker.js'

type Body = Record<string, unknown> | undefined

const assortmentsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Assortments ────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { includeArchived?: string } }>('/assortments', async (request, reply) =>
    respond(reply, async () => ({ success: true, assortments: await listAssortments({ includeArchived: request.query.includeArchived === 'true' }) })),
  )

  fastify.post<{ Body: Body }>('/assortments', async (request, reply) =>
    respond(reply, async () => ({ success: true, assortment: await createAssortment(request.body ?? {}) }), 201),
  )

  fastify.post<{ Params: { id: string }; Body: Body }>('/assortments/:id/update', async (request, reply) =>
    respond(reply, async () => ({ success: true, assortment: await updateAssortment(request.params.id, request.body ?? {}) })),
  )

  fastify.post<{ Params: { id: string }; Body: Body }>('/assortments/:id/archive', async (request, reply) =>
    respond(reply, async () => ({ success: true, assortment: await archiveAssortment(request.params.id, request.body ?? {}) })),
  )

  fastify.get<{ Params: { id: string }; Querystring: { cursor?: string; take?: string } }>('/assortments/:id/members', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await listMembers(request.params.id, { cursor: request.query.cursor, take: Number(request.query.take) || undefined })) })),
  )

  fastify.post<{ Params: { id: string }; Body: Body }>('/assortments/:id/members/add', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await addMembers(request.params.id, request.body ?? {})) })),
  )

  fastify.post<{ Params: { id: string }; Body: Body }>('/assortments/:id/members/remove', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await removeMembers(request.params.id, request.body ?? {})) })),
  )

  // Sharing studio step 2 — one product in or out of an assortment, whatever the assortment's rule (list or
  // "every product"). The product studio's "Other businesses" page. Writes at products.edit (/api/assortments).
  fastify.post<{ Params: { id: string }; Body: Body }>('/assortments/:id/product', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await setProductInAssortment(request.params.id, request.body ?? {})) })),
  )

  // Sharing studio step 2 — one product's sharing on both sides of the wall, and its stock source. Reads at
  // products.view (/api/products).
  fastify.get<{ Params: { id: string } }>('/products/:id/sharing', async (request, reply) =>
    respond(reply, async () => ({ success: true, sharing: await productSharing(request.params.id) })),
  )

  // Sharing studio step 3 — the shared product's listing layout (channels, markets, aliases; never the other
  // business's accounts or item ids), and making it here as drafts on accounts of this business.
  fastify.get<{ Params: { id: string } }>('/products/:id/sharing/layout', async (request, reply) =>
    respond(reply, async () => ({ success: true, layout: await listingLayout(request.params.id) })),
  )
  fastify.post<{ Params: { id: string }; Body: Body }>('/products/:id/sharing/layout', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await applyListingLayout(request.params.id, request.body ?? {})) })),
  )

  // ── Shares ────────────────────────────────────────────────────────────────
  fastify.get('/assortment-shares', async (_request, reply) =>
    respond(reply, async () => ({ success: true, ...(await listShares()) })),
  )

  fastify.post<{ Body: Body }>('/assortment-shares', async (request, reply) =>
    respond(reply, async () => ({ success: true, share: await offerShare(request.body ?? {}) }), 201),
  )

  // AE.3 — Review 1 of a copy: what would arrive in this (the follower) business. Read-only.
  fastify.get<{ Params: { id: string }; Querystring: { market?: string } }>('/assortment-shares/:id/copy/preview', async (request, reply) =>
    respond(reply, async () => ({ success: true, preview: (await previewCopy({ shareId: request.params.id, market: request.query.market ?? '' })).preview })),
  )

  // AE.3 — confirm a copy: re-checks Review 1, creates the definitions, stages the product review.
  fastify.post<{ Params: { id: string }; Body: Body }>('/assortment-shares/:id/copy', async (request, reply) =>
    respond(reply, async () => ({ success: true, run: await confirmCopy({ shareId: request.params.id, ...(request.body ?? {}) }) }), 201),
  )

  // This business's copy runs for one share, newest first.
  fastify.get<{ Params: { id: string } }>('/assortment-shares/:id/copy-runs', async (request, reply) =>
    respond(reply, async () => ({ success: true, runs: await listCopyRuns(request.params.id) })),
  )

  fastify.get<{ Params: { id: string } }>('/assortment-copy-runs/:id', async (request, reply) =>
    respond(reply, async () => ({ success: true, run: await getCopyRun(request.params.id) })),
  )

  // Idempotent: finishes the run if its product review has been applied, otherwise reports where it is.
  fastify.post<{ Params: { id: string } }>('/assortment-copy-runs/:id/advance', async (request, reply) =>
    respond(reply, async () => ({ success: true, run: await advanceCopyRun(request.params.id) })),
  )

  // Sharing studio step 3 — the listing layout of every product of an incoming share, one choice per channel and
  // account of the sharing business, made here as drafts. Registered before the generic `/:action` route below.
  fastify.get<{ Params: { id: string } }>('/assortment-shares/:id/layout', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await shareLayout(request.params.id)) })),
  )
  fastify.post<{ Params: { id: string }; Body: Body }>('/assortment-shares/:id/layout', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await applyShareLayout(request.params.id, request.body ?? {})) })),
  )

  // AE.4 — live sync. On demand: queue every link of an incoming share (an OWNER of this business).
  fastify.post<{ Params: { id: string } }>('/assortment-shares/:id/resync', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await resyncShare(request.params.id)) })),
  )

  // AE.4 — a product's link: where it comes from, a held rename, and each followed field's state now.
  fastify.get<{ Querystring: { productId?: string } }>('/catalog-links', async (request, reply) =>
    respond(reply, async () => {
      const productId = String(request.query.productId ?? '').trim()
      if (!productId) throw new WorkspaceError('invalid_product', 'Name the product.', 400)
      return { success: true, ...(await catalogLinkState(productId)) }
    }),
  )

  // AE.4 — "Follow again": stop keeping these fields ("all": every kept field); the next sync applies the source.
  fastify.post<{ Params: { id: string }; Body: Body }>('/catalog-links/:id/follow-again', async (request, reply) =>
    respond(reply, async () => {
      const fields = request.body?.fields
      if (fields !== 'all' && !(Array.isArray(fields) && fields.every((field) => typeof field === 'string'))) {
        throw new WorkspaceError('invalid_fields', 'Choose the fields to follow again, or "all".', 400)
      }
      return { success: true, ...(await followAgain(request.params.id, fields as string[] | 'all')) }
    }),
  )

  // One route per side keeps the manifest and the audit readable: the owner pauses, resumes and
  // revokes; the follower accepts, declines and leaves. An action for the other side is a 404.
  fastify.post<{ Params: { id: string; action: string }; Body: Body }>('/assortment-shares/:id/:action', async (request, reply) =>
    respond(reply, async () => {
      const { id, action } = request.params
      if (isOwnerAction(action)) return { success: true, share: await ownerAction(id, action, request.body ?? {}) }
      if (isFollowerDecision(action)) return { success: true, share: await followerDecision(id, action, request.body ?? {}) }
      throw new WorkspaceError('unknown_action', 'Choose pause, resume, revoke, accept, decline or leave.', 404)
    }),
  )
}

/**
 * A WorkspaceError carries its status and a sentence written for the operator. Anything else is
 * rethrown so an unexpected fault stays a 500 with a stack, not a tidy 400 that hides it.
 */
async function respond<T extends object>(reply: FastifyReply, work: () => Promise<T>, successStatus = 200) {
  try {
    const result = await work()
    return reply.code(successStatus).send(result)
  } catch (error) {
    if (error instanceof WorkspaceError) {
      const refused = (error as WorkspaceError & { refused?: unknown }).refused
      return reply.code(error.statusCode).send({ success: false, error: error.message, code: error.code, ...(refused ? { refused } : {}) })
    }
    throw error
  }
}

export default assortmentsRoutes
