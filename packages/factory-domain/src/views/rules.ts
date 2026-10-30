import type { Issue } from '../core/errors'

/**
 * Who sees and who keeps a saved view (B-W2a-23; PLT-163; design shell.lists pop:save-view "Name, who sees it (Only
 * me · My team · Role default — role default needs views.manage)"). The factory has no teams (W2b People): "my team" is
 * the holders of a role the person holds (B-W2a-01's decision), so the audiences are
 *
 *   ONLY_ME   its owner only                                                  views.save
 *   ROLE      the holders of one office role (the owner must hold it too)      views.save; views.manage for any role
 *   EVERYONE  everyone who sees the list                                       views.manage
 *   ROLE + roleDefault  that role's default view of the list: the list opens on it for its holders (one per list and
 *             role; the database refuses a second)                            views.manage
 *
 * The owner changes and removes their own views (views.save); views.manage changes and removes the views others shared
 * (never another person's ONLY_ME view: nobody else sees it). Reading needs no permission. Pure.
 */

export const VIEW_AUDIENCES = ['ONLY_ME', 'EVERYONE', 'ROLE'] as const
export type ViewAudience = (typeof VIEW_AUDIENCES)[number]

export interface ViewSharing {
  readonly audience: ViewAudience
  readonly roleId: string | null
  readonly roleDefault: boolean
}

export interface ViewFacts extends ViewSharing {
  readonly ownerId: string
}

/** The person as the view rules see them: their live office roles and what they may do with views. */
export interface ViewReader {
  readonly userId: string
  /** The office roles they hold now, in the order they were given (the first role default wins). */
  readonly roleIds: readonly string[]
  readonly save: boolean
  readonly manage: boolean
}

/** The reader sees the view. */
export function viewSeenBy(view: ViewFacts, reader: ViewReader): boolean {
  if (view.ownerId === reader.userId) return true
  if (view.audience === 'EVERYONE') return true
  return view.audience === 'ROLE' && view.roleId !== null && reader.roleIds.includes(view.roleId)
}

/** Why the reader may not set this sharing, in words (empty: they may). */
export function sharingProblems(sharing: ViewSharing, reader: ViewReader): Issue[] {
  const problems: Issue[] = []
  if (!reader.save && !reader.manage) problems.push({ path: 'body', message: 'Saving a view needs views.save.' })
  if (sharing.audience === 'ROLE' && !sharing.roleId) problems.push({ path: 'body/roleId', message: 'Name the role whose holders see the view.' })
  if (sharing.audience !== 'ROLE' && sharing.roleId) problems.push({ path: 'body/roleId', message: 'Only a view shared with a role names one.' })
  if (sharing.roleDefault && sharing.audience !== 'ROLE') problems.push({ path: 'body/roleDefault', message: "A role's default view is shared with that role." })
  if (sharing.audience === 'EVERYONE' && !reader.manage) problems.push({ path: 'body/audience', message: 'Sharing a view with everyone who sees the list needs views.manage.' })
  if (sharing.roleDefault && !reader.manage) problems.push({ path: 'body/roleDefault', message: "Making a view a role's default needs views.manage." })
  if (sharing.audience === 'ROLE' && sharing.roleId && !reader.manage && !reader.roleIds.includes(sharing.roleId)) {
    problems.push({ path: 'body/roleId', message: 'You can share a view only with a role you hold (views.manage shares with any role).' })
  }
  return problems
}

/** Why the reader may not change or remove the view (null: they may). Another person's ONLY_ME view is never seen at all. */
export function changeRefusal(view: ViewFacts, reader: ViewReader): string | null {
  if (view.ownerId === reader.userId) {
    if (view.roleDefault && !reader.manage) return "This view is a role's default: changing it needs views.manage."
    if (view.audience === 'EVERYONE' && !reader.manage) return 'This view is shared with everyone: changing it needs views.manage.'
    return reader.save || reader.manage ? null : 'Changing your views needs views.save.'
  }
  if (view.audience === 'ONLY_ME') return 'This view is not yours.'
  return reader.manage ? null : 'Only its owner changes this view (views.manage changes the views others shared).'
}

/** The view the list opens on for the reader: the default of the first role they hold that has one, else none. */
export function roleDefaultFor<T extends ViewFacts & { readonly id: string }>(views: readonly T[], reader: ViewReader): T | null {
  for (const roleId of reader.roleIds) {
    const found = views.find((view) => view.roleDefault && view.audience === 'ROLE' && view.roleId === roleId)
    if (found) return found
  }
  return null
}

/** The reader's views of a list in menu order: their own first (by name), then the shared ones (by name). */
export function menuOrder<T extends ViewFacts & { readonly name: string }>(views: readonly T[], reader: ViewReader): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' })
  const seen = views.filter((view) => viewSeenBy(view, reader))
  return [...seen.filter((view) => view.ownerId === reader.userId).sort(byName), ...seen.filter((view) => view.ownerId !== reader.userId).sort(byName)]
}
