import type { FastifyRequest } from 'fastify'
import { ensureLoaded } from './guards.js'
import { hasPermission, resolvePermissions } from './rbac.js'

/** Operator attribution must never fall back to a shared or caller-supplied user. */
export function requestUserId(request: FastifyRequest): string {
  if (!request.authUser?.id) {
    throw Object.assign(new Error('A signed-in user is required for this operation.'), {
      statusCode: 403, code: 'forbidden',
    })
  }
  return request.authUser.id
}

/** Explicit route guards enforce in shadow mode too. Coarse API keys have no session actor. */
export async function assertRequestPermission(request: FastifyRequest, permission: string): Promise<void> {
  await ensureLoaded(request)
  requestUserId(request)
  const resolved = request.__rbacResolved ?? await resolvePermissions(request.authUser!)
  request.__rbacResolved = resolved
  if (!hasPermission(resolved, permission)) {
    throw Object.assign(new Error(`This operation requires ${permission}.`), {
      statusCode: 403, code: 'forbidden', required: permission,
    })
  }
}
