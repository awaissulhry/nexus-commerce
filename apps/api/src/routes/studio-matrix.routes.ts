/**
 * MX.1 — the Matrix page's four routes (`@nexus/shared/matrix-contract` `MATRIX_ENDPOINTS`):
 *
 *   GET   /api/products/:id/studio/matrix                      → MatrixRead        (`matrix.service.ts`)
 *   PATCH /api/products/:id/studio/matrix                      → MatrixWriteResult (`matrix-write.service.ts`, the one door)
 *   POST  /api/products/:id/studio/matrix/verbs                → VerbPreview (commit:false) | { operation, results } (commit:true)
 *   POST  /api/products/:id/studio/matrix/verbs/:opId/revert   → { operation, results }
 *
 * Mounted under `/api` beside `product-studio.routes.ts`. RBAC: an EXPLICIT manifest entry (most-specific-first,
 * `lib/auth/permissions-manifest.ts`) maps GET → products.view and every write → products.edit; the financial
 * permission `products.price.edit` is enforced INSIDE the services on the price cells (Add 4(d)) using the
 * permissions the RBAC hook already resolved for this request (`req.__rbacResolved`). The type-to-confirm word a
 * verb dialog collects is UX: the server re-runs the shared preview per change and refuses what it would refuse.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { MatrixVerbRequest, MatrixWriteCell, VerbPreview } from '@nexus/shared/matrix-contract'
import { hasPermission } from '../lib/auth/rbac.js'
import { UnknownProductError } from '../services/pim/studio-sheet.service.js'
import { ProductRelationshipError } from '../services/pim/product-relationship.service.js'
import { getMatrixRead } from '../services/pim/matrix.service.js'
import { revertMatrixOperation, runMatrixVerb, writeMatrixCells } from '../services/pim/matrix-write.service.js'

/**
 * `can(permission)` for THIS request, from the permissions the RBAC gate resolved. Without a resolved set (an
 * anonymous request in shadow mode) the answer is the gate's own: allowed in shadow, refused under enforce.
 */
export function permissionCheckerFor(req: FastifyRequest): (permission: string) => boolean {
  const resolved = req.__rbacResolved
  if (resolved) return (permission) => hasPermission(resolved, permission)
  const enforcing = process.env.NEXUS_RBAC_MODE === 'enforce' || process.env.NEXUS_WORKSPACES_ENABLED === '1'
  return () => !enforcing
}

export function actorOf(req: FastifyRequest): string {
  return req.authUser?.email ?? req.authUser?.id ?? 'studio-matrix'
}

function sendError(reply: FastifyReply, err: unknown, log: { error: (o: unknown, m: string) => void }, context: Record<string, unknown>) {
  if (err instanceof UnknownProductError) return reply.code(404).send({ error: err.code, message: err.message })
  if (err instanceof ProductRelationshipError) return reply.code(err.statusCode).send({ error: err.code, message: err.message })
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown }
  if (typeof e?.statusCode === 'number' && typeof e?.code === 'string' && e.statusCode >= 400 && e.statusCode < 500) {
    return reply.code(e.statusCode).send({ error: e.code, message: String(e.message ?? '') })
  }
  log.error({ err, ...context }, '[studio-matrix] request failed')
  return reply.code(500).send({ error: 'matrix_request_failed', message: err instanceof Error ? err.message : String(err) })
}

const WRITABLE = new Set(['fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'price', 'salePrice'])

/** The body is parsed at ONE boundary: a malformed cell is refused with a sentence, never half-applied. */
function parseCells(body: unknown): { cells: MatrixWriteCell[] } | { problem: string } {
  const raw = (body as { cells?: unknown } | null)?.cells
  if (!Array.isArray(raw)) return { problem: 'The write carried no `cells` array' }
  if (raw.length > 500) return { problem: 'At most 500 cells per write' }
  const cells: MatrixWriteCell[] = []
  for (const c of raw as Array<Record<string, unknown>>) {
    if (typeof c?.rowId !== 'string' || typeof c?.coordinateKey !== 'string' || typeof c?.cell !== 'string' || !WRITABLE.has(c.cell) || typeof c?.expectedVersion !== 'number')
      return { problem: 'Each cell needs rowId, coordinateKey, a writable cell kind and a numeric expectedVersion' }
    cells.push({ rowId: c.rowId, coordinateKey: c.coordinateKey, cell: c.cell as MatrixWriteCell['cell'], value: c.value, expectedVersion: c.expectedVersion })
  }
  return { cells }
}

function parseVerb(body: unknown): { req: MatrixVerbRequest & { preview?: VerbPreview } } | { problem: string } {
  const b = body as { params?: { verb?: unknown }; targets?: unknown; commit?: unknown; preview?: unknown } | null
  if (!b || typeof b !== 'object' || typeof b.params?.verb !== 'string') return { problem: 'The verb request carried no `params.verb`' }
  if (!Array.isArray(b.targets)) return { problem: 'The verb request carried no `targets` array' }
  if (b.targets.length > 2000) return { problem: 'At most 2000 targets per verb' }
  for (const t of b.targets as Array<Record<string, unknown>>) if (typeof t?.rowId !== 'string' || typeof t?.coordinateKey !== 'string') return { problem: 'Each target needs rowId and coordinateKey' }
  const preview = b.preview && typeof b.preview === 'object' && Array.isArray((b.preview as VerbPreview).changes) ? (b.preview as VerbPreview) : undefined
  return { req: { params: b.params as MatrixVerbRequest['params'], targets: b.targets as MatrixVerbRequest['targets'], commit: b.commit === true, ...(preview ? { preview } : {}) } }
}

const studioMatrixRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/products/:id/studio/matrix', async (request, reply) => {
    const { id } = request.params as { id: string }
    const q = request.query as { accountId?: string; locale?: string }
    const can = permissionCheckerFor(request)
    try {
      return await getMatrixRead({ productId: id, accountId: q.accountId ?? null, locale: q.locale ?? null, canEditPrice: can(F.productsPriceEdit) })
    } catch (err) { return sendError(reply, err, request.log, { id, route: 'matrix.read' }) }
  })

  fastify.patch('/products/:id/studio/matrix', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = parseCells(request.body)
    if ('problem' in parsed) return reply.code(400).send({ error: 'invalid_write', message: parsed.problem })
    try {
      return await writeMatrixCells({ productId: id, actor: actorOf(request), can: permissionCheckerFor(request) }, parsed.cells)
    } catch (err) { return sendError(reply, err, request.log, { id, route: 'matrix.write' }) }
  })

  fastify.post('/products/:id/studio/matrix/verbs', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = parseVerb(request.body)
    if ('problem' in parsed) return reply.code(400).send({ error: 'invalid_verb', message: parsed.problem })
    try {
      return await runMatrixVerb({ productId: id, actor: actorOf(request), can: permissionCheckerFor(request) }, parsed.req)
    } catch (err) { return sendError(reply, err, request.log, { id, route: 'matrix.verb', verb: parsed.req.params.verb }) }
  })

  fastify.post('/products/:id/studio/matrix/verbs/:operationId/revert', async (request, reply) => {
    const { id, operationId } = request.params as { id: string; operationId: string }
    try {
      return await revertMatrixOperation({ productId: id, actor: actorOf(request), can: permissionCheckerFor(request) }, operationId)
    } catch (err) { return sendError(reply, err, request.log, { id, operationId, route: 'matrix.revert' }) }
  })
}

export default studioMatrixRoutes
