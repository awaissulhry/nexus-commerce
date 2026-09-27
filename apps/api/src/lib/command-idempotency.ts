/**
 * Durable Idempotency-Key handling for commands a double-click must not run twice.
 *
 * Replaces the NN.2 in-memory cache (`services/idempotency.service.ts`, removed), which lived
 * in one process: a second API replica or a restart ran the command again, and two
 * simultaneous requests both missed it. Receipts live in the database, so every
 * replica sees the same claim before the handler runs.
 *
 * Semantics follow the IETF Idempotency-Key draft:
 *   - The first request with a key claims a pending receipt, then runs the handler.
 *   - The same key and request while that runs → 409. After a 2xx → the stored
 *     response is replayed and the handler does not run.
 *   - The same key with a different request (params, query, body or actor) → 422.
 *   - A non-2xx response releases the key: a failed command may be retried as is,
 *     exactly as with the old cache, which only kept successes.
 *   - A receipt lasts RECEIPT_WINDOW_MS, the old cache's window. The web builds some
 *     keys from content (`pim-attach:<parent>:<ids>`), so a long window would turn a
 *     deliberate repeat (attach, detach, attach again) into a silent replay. After
 *     the window an abandoned pending receipt (its server died mid-request) is
 *     replaced, so the command can run again.
 *
 * The response is captured before serialization and stored as JSON, so a replay is
 * compressed (or not) for the client asking, not for the one that asked first.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { withWorkspace, workspaceContext, type WorkspaceContext } from './workspace-context.js'

export const RECEIPT_WINDOW_MS = 10 * 60_000

/** POST routes whose Idempotency-Key is honoured, keyed by Fastify route URL. */
const COMMAND_SCOPES: Record<string, string> = {
  '/api/products/bulk-replicate': 'replicate',
  '/api/pim/attach-to-parent': 'pim-attach',
  '/api/pim/promote-to-parent': 'pim-promote',
  '/api/listing-wizard/:id/submit': 'wizard-submit',
  // Attribute parity P3 — one "Download rules" click, one sequential run of provider fetches.
  '/api/categories/schema/download': 'schema-download',
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** Key order must not change the fingerprint of an otherwise identical request. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  }
  return value ?? null
}

/**
 * A keyless wizard submit is keyed on the wizard's saved state. Two submits of the same
 * state coalesce; a submit changes `updatedAt`, so a deliberate retry after a FAILED
 * result is a new command rather than a replay of the failure.
 */
async function wizardFallbackKey(request: FastifyRequest): Promise<string | null> {
  const { id } = request.params as { id: string }
  const wizard = await prisma.listingWizard.findUnique({ where: { id }, select: { updatedAt: true } })
  return wizard ? `wizard:${id}:${wizard.updatedAt.toISOString()}` : null // no row: the route answers 404
}

type Claim =
  | { kind: 'owner'; id: string }
  | { kind: 'replay'; httpStatus: number; response: unknown }
  | { kind: 'running' }
  | { kind: 'mismatch' }

async function claimReceipt(scope: string, keyHash: string, requestHash: string, actorUserId: string | null): Promise<Claim> {
  // Two rounds: an expired receipt is removed in the first and re-claimed in the second.
  for (let round = 0; round < 2; round++) {
    const now = new Date()
    const id = randomUUID()
    const created = await prisma.commandReceipt.createMany({
      data: [{ id, scope, keyHash, requestHash, actorUserId, expiresAt: new Date(now.getTime() + RECEIPT_WINDOW_MS) }],
      skipDuplicates: true,
    })
    if (created.count === 1) return { kind: 'owner', id }

    const existing = await prisma.commandReceipt.findUnique({
      where: { scope_keyHash: workspaceKey({ scope, keyHash }) },
    })
    if (!existing) continue // released between the insert and the read
    if (existing.expiresAt <= now) {
      // Conditional on updatedAt: a request that re-claimed it meanwhile keeps its claim.
      await prisma.commandReceipt.deleteMany({ where: { id: existing.id, updatedAt: existing.updatedAt } })
      continue
    }
    if (existing.requestHash !== requestHash) return { kind: 'mismatch' }
    if (existing.status === 'completed' && existing.httpStatus !== null) {
      return { kind: 'replay', httpStatus: existing.httpStatus, response: existing.response }
    }
    return { kind: 'running' }
  }
  return { kind: 'running' }
}

/** Register after the workspace and RBAC hooks, so a replay is never served to a caller they refuse. */
export function registerCommandIdempotency(app: FastifyInstance): void {
  // The business context is kept with the claim: the receipt is row-level secured,
  // and onResponse runs after the request's context may have ended.
  const owned = new WeakMap<FastifyRequest, { id: string; completed: boolean; context: WorkspaceContext }>()

  app.addHook('preHandler', async (request, reply) => {
    const scope = request.method === 'POST' ? COMMAND_SCOPES[request.routeOptions.url ?? ''] : undefined
    if (!scope) return
    const header = request.headers['idempotency-key']
    if (header !== undefined && (typeof header !== 'string' || !header.trim())) {
      return reply.code(400).send({ error: 'Idempotency-Key must be a non-empty string.' })
    }
    // The workspace hook runs first and always sets a business (the legacy one when
    // profiles are off). A route outside it has no receipt to claim.
    const context = workspaceContext()
    if (!context) return
    const key = typeof header === 'string' ? header : scope === 'wizard-submit' ? await wizardFallbackKey(request) : null
    if (!key) return

    const actorUserId = context.actorUserId ?? null
    const fingerprint = canonical({ params: request.params, query: request.query, body: request.body, actorUserId })
    const claim = await claimReceipt(scope, sha256(key), sha256(JSON.stringify(fingerprint)), actorUserId)
    switch (claim.kind) {
      case 'owner':
        owned.set(request, { id: claim.id, completed: false, context })
        return
      case 'replay':
        return reply.code(claim.httpStatus).send(claim.response)
      case 'mismatch':
        return reply.code(422).send({ error: 'This Idempotency-Key was already used for a different request.' })
      case 'running':
        return reply.code(409).header('retry-after', '1')
          .send({ error: 'The same request is still running. Wait for its result before sending it again.' })
    }
  })

  // Objects only: every command above answers with a JSON object. A string or
  // buffer response is not stored; onResponse releases its key instead.
  app.addHook('preSerialization', async (request, reply, payload) => {
    const receipt = owned.get(request)
    if (!receipt || reply.statusCode < 200 || reply.statusCode >= 300) return payload
    try {
      const stored = await withWorkspace(receipt.context, () => prisma.commandReceipt.updateMany({
        where: { id: receipt.id, status: 'pending' },
        data: { status: 'completed', httpStatus: reply.statusCode, response: JSON.parse(JSON.stringify(payload)) },
      }))
      receipt.completed = stored.count === 1
    } catch (error) {
      // The command already ran; its caller still gets the real response. The
      // pending receipt refuses duplicates until the window closes.
      logger.error('[command-idempotency] could not store a command response', {
        receiptId: receipt.id, error: error instanceof Error ? error.message : String(error),
      })
    }
    return payload
  })

  app.addHook('onResponse', async request => {
    const receipt = owned.get(request)
    if (!receipt || receipt.completed) return
    owned.delete(request)
    await withWorkspace(receipt.context, () => prisma.commandReceipt.deleteMany({ where: { id: receipt.id, status: 'pending' } })).catch(error => {
      logger.error('[command-idempotency] could not release a command key', {
        receiptId: receipt.id, error: error instanceof Error ? error.message : String(error),
      })
    })
  })
}
