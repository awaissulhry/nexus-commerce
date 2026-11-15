import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { followedViewsSchema, type FollowedViews } from './model'

/**
 * My saved views' calls (B-W2b-388), on B-W2b-385's routes: GET /notifications/following/views (my pinned views with their
 * last counts) and DELETE /notifications/following/views/:viewId (Unpin: stop following). Problems as `home-mywork` keys.
 */

export function fetchFollowedViews(api: ApiClient, signal?: AbortSignal): Promise<FollowedViews> {
  return api.get('/notifications/following/views', { schema: followedViewsSchema, signal })
}

export function unpinView(api: ApiClient, viewId: string): Promise<FollowedViews> {
  return api.request('DELETE', `/notifications/following/views/${encodeURIComponent(viewId)}`, { schema: followedViewsSchema, idempotencyKey: newIdempotencyKey() })
}

/** A failed read or change, as a message key of `home-mywork`. */
export function viewsProblem(error: unknown): string {
  if (!isApiError(error)) return 'views.problem.read'
  if (error.kind === 'forbidden') return 'views.problem.forbidden'
  if (error.kind === 'unavailable') return 'views.problem.offline'
  return 'views.problem.read'
}

/** Columns ▾ › Pin to Today (list frame tools): the views I pinned, by id. */
export async function pinnedViewIds(api: ApiClient): Promise<string[]> {
  return (await fetchFollowedViews(api)).views.map((view) => view.viewId)
}

/** Pin (follow, counted now as me) or unpin a view: a list without a count to follow, or the limit reached, answers in words. */
export async function setViewPinned(api: ApiClient, viewId: string, pinned: boolean): Promise<'ok' | 'notFollowable' | 'tooMany'> {
  try {
    if (pinned) await api.request('PUT', `/notifications/following/views/${encodeURIComponent(viewId)}`, { schema: followedViewsSchema, idempotencyKey: newIdempotencyKey() })
    else await unpinView(api, viewId)
    return 'ok'
  } catch (error) {
    if (isApiError(error) && error.kind === 'conflict') return error.issues.map(issuePath).includes('views/NOT_FOLLOWABLE') ? 'notFollowable' : 'tooMany'
    throw error
  }
}
