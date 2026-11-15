import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { setMyFollow } from '../../../../record-panels/tasks/api'
import { unpinView } from '../my-views/api'
import { followingSchema, type FollowingAnswer, type FollowingItem } from './model'

/**
 * Changed since you looked's calls (B-W2b-388): GET /home/following (the lines), POST /notifications/done (Mark seen: the line's
 * news done), and Unfollow — a record on its followers (PUT /threads/:type/:id/followers/me, the record panels' own call), a
 * saved view on B-W2b-385's follow (DELETE /notifications/following/views/:viewId).
 */

export function fetchFollowing(api: ApiClient, signal?: AbortSignal): Promise<FollowingAnswer> {
  return api.get('/home/following', { schema: followingSchema, signal })
}

export async function markSeen(api: ApiClient, item: Pick<FollowingItem, 'ids'>): Promise<void> {
  await api.post('/notifications/done', { body: { ids: item.ids, done: true }, idempotencyKey: newIdempotencyKey() })
}

export async function unfollow(api: ApiClient, item: Pick<FollowingItem, 'view' | 'record'>): Promise<void> {
  if (item.view) await unpinView(api, item.record.id)
  else await setMyFollow(api, { type: item.record.type, id: item.record.id }, { following: false, muted: false })
}

/** A failed read or change, as a message key of `home-mywork`. */
export function followingProblem(error: unknown): string {
  if (!isApiError(error)) return 'following.problem.read'
  if (error.kind === 'forbidden') return 'following.problem.forbidden'
  if (error.kind === 'not_found') return 'following.problem.gone'
  if (error.kind === 'unavailable') return 'following.problem.offline'
  return 'following.problem.read'
}
