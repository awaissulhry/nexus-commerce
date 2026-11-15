import { z } from 'zod'
import type { Loaded } from '../model'

/**
 * Today › My saved views (B-W2b-388; design home.today `my-views` "Pinned saved views with live counts (PLT-163)": "Chips: 'Late
 * lines · 6', 'My customers · 41', 'Lots on hold · 2'. Chip → the list with that view"). A view is pinned to Today by following
 * it (B-W2b-385: GET/PUT/DELETE /notifications/following/views; Columns ▾ › Pin to Today): its count is the one the scheduler
 * counted for the person last (every 15 minutes, and at once when pinned), with when.
 */

export const followedViewsSchema = z.object({
  views: z.array(
    z.object({
      followId: z.string(),
      viewId: z.string(),
      name: z.string(),
      listKey: z.string(),
      companyId: z.string().nullable(),
      count: z.number().int().nullable(),
      capped: z.boolean(),
      countedAt: z.string().nullable(),
      since: z.string(),
    }),
  ),
  max: z.number().int(),
})
export type FollowedViews = z.infer<typeof followedViewsSchema>

/** A chip as the section draws it. */
export interface ViewChip {
  readonly viewId: string
  readonly name: string
  /** The count in words: a number, "1000+" when capped, or null (not counted yet). */
  readonly count: { readonly key: string; readonly count: number } | null
  readonly countedAt: string | null
  /** The list with the view (`?savedView=`), or null while its page is not built (the chip says why). */
  readonly href: string | null
}

export interface MyViewsModel {
  readonly views: Loaded<readonly ViewChip[]>
  /** The read's clock (AsOf). */
  readonly now: number
  /** Why unpinning is held now (offline, a change in flight): a message key of `home-mywork`, or null. */
  readonly held: string | null
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger'; readonly params?: Readonly<Record<string, string>> } | null
}

/** A list's page from its key (`production.work-orders` → `/production/work-orders`: views/state listKeyOf, backwards). */
export const pageOfList = (listKey: string): string => `/${listKey.split('.').join('/')}`

/** The chips: each with its count in words and where it opens (its list page when built). */
export function chipsOf(answer: FollowedViews, prefix: string, built: ReadonlySet<string>): ViewChip[] {
  return answer.views.map((view) => {
    const page = pageOfList(view.listKey)
    return {
      viewId: view.viewId,
      name: view.name,
      count: view.count === null ? null : view.capped ? { key: 'views.capped', count: view.count } : { key: 'views.count', count: view.count },
      countedAt: view.countedAt,
      href: built.has(page) ? `${prefix}${page}?savedView=${encodeURIComponent(view.viewId)}` : null,
    }
  })
}
