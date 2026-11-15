import type { Cadence, EventKind, PreferenceChannel } from '@nexus/factory-domain/notifications/preferences/preferences'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { matrixSchema, roleDefaultsSchema, type Matrix, type RoleDefaults } from './model'

/**
 * Notification preferences' calls (B-W2b-388), on B-W2b-385's routes: GET/PUT/DELETE /notifications/preferences (my matrix; a
 * cell saves at once and answers the whole matrix; Reset = my choices go) and, for an admin, GET/PUT /notifications/role-defaults
 * (an office role's defaults; null removes one). Problems as `home-mywork` keys.
 */

export function fetchMatrix(api: ApiClient, signal?: AbortSignal): Promise<Matrix> {
  return api.get('/notifications/preferences', { schema: matrixSchema, signal })
}

export function saveCell(api: ApiClient, cell: { readonly event: EventKind; readonly channel: PreferenceChannel; readonly cadence: Cadence }): Promise<Matrix> {
  return api.request('PUT', '/notifications/preferences', { body: cell, schema: matrixSchema, idempotencyKey: newIdempotencyKey() })
}

export function resetMatrix(api: ApiClient): Promise<Matrix> {
  return api.request('DELETE', '/notifications/preferences', { schema: matrixSchema, idempotencyKey: newIdempotencyKey() })
}

export function fetchRoleDefaults(api: ApiClient, roleId: string | null, signal?: AbortSignal): Promise<RoleDefaults> {
  return api.get('/notifications/role-defaults', { query: { roleId: roleId ?? undefined }, schema: roleDefaultsSchema, signal })
}

export function saveRoleDefault(api: ApiClient, cell: { readonly roleId: string; readonly event: EventKind; readonly channel: PreferenceChannel; readonly cadence: Cadence | null }): Promise<RoleDefaults> {
  return api.request('PUT', '/notifications/role-defaults', { body: cell, schema: roleDefaultsSchema, idempotencyKey: newIdempotencyKey() })
}

export function preferencesProblem(error: unknown): string {
  if (!isApiError(error)) return 'prefs.problem.failed'
  if (error.kind === 'forbidden') return 'prefs.problem.forbidden'
  if (error.kind === 'invalid') return 'prefs.problem.invalid'
  if (error.kind === 'unavailable') return 'prefs.problem.offline'
  return 'prefs.problem.failed'
}
