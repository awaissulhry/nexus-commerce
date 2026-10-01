import { savedViewRequest } from '@/design-system/grid/views/savedViewTransport'

/** One initial load only. Each new actor, business or sheet gets its own instance. */
export function createInitialSavedViewRead(baseUrl: string, scope: string, surfaces: readonly string[]) {
  const requested = [...new Set(surfaces)]
  const query = new URLSearchParams()
  for (const surface of requested) query.append('surfaces', surface)
  const url = `${baseUrl}/api/saved-views`
  let pending: Promise<unknown> | undefined
  const singles = new Map<string, Promise<{ items: unknown[] }>>()
  return {
    key: JSON.stringify([baseUrl, scope, requested]),
    async read(surface: string): Promise<{ items: unknown[] }> {
      if (!requested.includes(surface)) throw new Error('The saved-view namespace is outside this sheet load.')
      const raw = await (pending ??= savedViewRequest<unknown>(`${url}?${query}`))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The initial saved views could not be read.')
      const body = raw as { results?: unknown; items?: unknown }
      // During a staggered deploy, an older API ignores `surfaces` and answers
      // for its default products namespace. Never apply that answer to a sheet.
      if (!Array.isArray(body.results) && Array.isArray(body.items)) {
        let single = singles.get(surface)
        if (!single) {
          single = savedViewRequest<{ items: unknown[] }>(`${url}?surface=${encodeURIComponent(surface)}`)
          singles.set(surface, single)
        }
        const answer = await single
        if (!Array.isArray(answer?.items)) throw new Error('The saved-view list could not be read.')
        return answer
      }
      if (!Array.isArray(body.results)) throw new Error('The initial saved views could not be read.')
      const matches = (body.results as unknown[]).filter((entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as { surface?: unknown }).surface === surface)
      if (matches.length !== 1) throw new Error('The saved-view namespace could not be verified.')
      const result = matches[0]
      if ('error' in result) {
        if (typeof result.error !== 'string' || typeof result.status !== 'number' || !Number.isInteger(result.status) || result.status < 400 || result.status > 599) throw new Error('The saved-view error could not be read.')
        throw Object.assign(new Error(result.error), { status: result.status })
      }
      if (!Array.isArray(result.items)) throw new Error('The saved-view list could not be read.')
      return { items: result.items }
    },
  }
}
