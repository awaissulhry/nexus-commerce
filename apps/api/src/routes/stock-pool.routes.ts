/**
 * Shared stock between business profiles — the profile switch and the product switch.
 *
 * Plan: docs/2026-09-19-shared-stock-plan.md §4; contract docs/2026-09-19-shared-stock-build.md §2.
 * No database access here (PH.4a): every route calls a service in services/stock-pool/.
 *
 * Permissions (permissions-manifest.ts): reads at inventory.view; the profile switch at
 * settings.workspace.edit (it names another business, like product shares); the product switch at
 * inventory.adjust. The OWNER checks are in the services, with the database guards as the backstop —
 * a route permission is role-based and knows nothing about which business a grant points at.
 *
 * Every change is a POST that names the version being changed. Nothing is deleted.
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { WorkspaceError } from '../lib/workspace-context.js'
import { borrowerDecision, grantImpact, lenderAction, lendableLocations, listGrants, offerGrant } from '../services/stock-pool/pool-grants.service.js'
import { isBorrowerDecision, isLenderAction } from '../services/stock-pool/grant-rules.js'
import { listPoolProducts, previewSwitch, switchProducts } from '../services/stock-pool/pool-links.service.js'

type Body = Record<string, unknown> | undefined

const stockPoolRoutes: FastifyPluginAsync = async (fastify) => {
  // ── The profile switch ────────────────────────────────────────────────────
  fastify.get('/stock-pool/grants', async (_request, reply) =>
    respond(reply, async () => ({ success: true, ...(await listGrants()) })),
  )

  fastify.get('/stock-pool/lendable-warehouses', async (_request, reply) =>
    respond(reply, async () => ({ success: true, warehouses: await lendableLocations() })),
  )

  fastify.post<{ Body: Body }>('/stock-pool/grants', async (request, reply) =>
    respond(reply, async () => ({ success: true, grant: await offerGrant(request.body ?? {}) }), 201),
  )

  // What pausing, ending or leaving would do to the borrower's listings, as counts. Read-only.
  fastify.get<{ Params: { id: string } }>('/stock-pool/grants/:id/impact', async (request, reply) =>
    respond(reply, async () => ({ success: true, impact: await grantImpact(request.params.id) })),
  )

  // One route per side keeps the manifest and the audit readable: the lender pauses, resumes and ends;
  // the borrower accepts, declines and leaves. An action for the other side is a 404.
  fastify.post<{ Params: { id: string; action: string }; Body: Body }>('/stock-pool/grants/:id/:action', async (request, reply) =>
    respond(reply, async () => {
      const { id, action } = request.params
      if (isLenderAction(action)) return { success: true, grant: await lenderAction(id, action, request.body ?? {}) }
      if (isBorrowerDecision(action)) return { success: true, grant: await borrowerDecision(id, action, request.body ?? {}) }
      throw new WorkspaceError('unknown_action', 'Choose pause, resume, end, accept, decline or leave.', 404)
    }),
  )

  // ── The product switch (borrower) ─────────────────────────────────────────
  fastify.get<{ Querystring: { grantId?: string; cursor?: string; take?: string } }>('/stock-pool/products', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await listPoolProducts(request.query)) })),
  )

  fastify.post<{ Body: Body }>('/stock-pool/products/preview', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await previewSwitch(request.body ?? {})) })),
  )

  fastify.post<{ Body: Body }>('/stock-pool/products/switch', async (request, reply) =>
    respond(reply, async () => ({ success: true, ...(await switchProducts(request.body ?? {})) })),
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
    if (error instanceof WorkspaceError) return reply.code(error.statusCode).send({ success: false, error: error.message, code: error.code })
    throw error
  }
}

export default stockPoolRoutes
