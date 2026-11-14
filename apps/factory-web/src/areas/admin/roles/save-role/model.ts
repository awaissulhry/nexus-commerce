import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Grain, PermissionCatalogue, Role } from '../../shared/api'
import { GRAINS } from '../../shared/model'

/**
 * Change role (B-W2b-413 on B-W2b-404's API; PLT-031; design admin.roles "Every permission: custom roles: tick and untick,
 * then Save (EditModeBar → popup save-role)" and pop:save-role "ReviewChangesModal: adds · removes · grains · '4 people get
 * this at their next request'. Raising rights asks for a fresh code"), pure: the draft of a custom role's permissions and
 * money sight, why it cannot be changed, the body sent to review and save (a role that sees costs or margins asks for
 * two-factor: the body says so), the review as rows, and refusals in words (`admin-security-depth` `saveRole.*`).
 */

export interface RoleDraft {
  permissions: string[]
  grains: Grain[]
}

/** Grains that make a role ask for two-factor (factory-domain roleProblems). */
const TWO_FACTOR_GRAINS: readonly Grain[] = ['cost', 'margin']

export const draftOf = (role: Pick<Role, 'permissions' | 'grains'>): RoleDraft => ({ permissions: [...role.permissions], grains: [...role.grains] })

/** The permissions a custom (office) role may hold, in the catalogue's order: never the floor's. */
export const editablePermissions = (catalogue: PermissionCatalogue) => catalogue.permissions.filter((permission) => permission.area !== 'floor')

export function toggled(draft: RoleDraft, name: string, on: boolean): RoleDraft {
  const rest = draft.permissions.filter((item) => item !== name)
  return { ...draft, permissions: on ? [...rest, name] : rest }
}

export function grainToggled(draft: RoleDraft, grain: Grain, on: boolean): RoleDraft {
  const rest = draft.grains.filter((item) => item !== grain)
  return { ...draft, grains: GRAINS.filter((item) => (item === grain ? on : rest.includes(item))) }
}

export interface DraftDiff {
  added: string[]
  removed: string[]
  grainsAdded: Grain[]
  grainsRemoved: Grain[]
  count: number
}

export function draftDiff(role: Pick<Role, 'permissions' | 'grains'>, draft: RoleDraft): DraftDiff {
  const added = draft.permissions.filter((name) => !role.permissions.includes(name))
  const removed = role.permissions.filter((name) => !draft.permissions.includes(name))
  const grainsAdded = draft.grains.filter((grain) => !role.grains.includes(grain))
  const grainsRemoved = role.grains.filter((grain) => !draft.grains.includes(grain))
  return { added, removed, grainsAdded, grainsRemoved, count: added.length + removed.length + grainsAdded.length + grainsRemoved.length }
}

/** Why this role cannot be changed here (a message key), or null: ready-made, archived, held by me, or no right. */
export function editHeld(role: Pick<Role, 'system'> & { archivedAt?: string | null }, can: { manage: boolean; heldByMe: boolean }): string | null {
  if (role.system) return 'saveRole.held.readyMade'
  if (role.archivedAt) return 'saveRole.held.archived'
  if (!can.manage) return 'saveRole.held.right'
  if (can.heldByMe) return 'saveRole.held.mine'
  return null
}

/** The body of the review and of the save: the draft, and two-factor asked when it now sees costs or margins. */
export function bodyOf(role: Pick<Role, 'requireMfa'>, draft: RoleDraft): { permissions: string[]; grains: Grain[]; requireMfa?: boolean } {
  const asks = !role.requireMfa && draft.grains.some((grain) => TWO_FACTOR_GRAINS.includes(grain))
  return { permissions: [...draft.permissions].sort(), grains: [...draft.grains], ...(asks ? { requireMfa: true } : {}) }
}

/** The review the API answers (POST /auth/roles/:id/review). */
export interface RoleReview {
  version: number
  permissionsAdded: string[]
  permissionsRemoved: string[]
  grainsAdded: Grain[]
  grainsRemoved: Grain[]
  requireMfa: { before: boolean; after: boolean }
  raises: boolean
  asksFreshCode: boolean
  holders: number
  refusals: Array<{ path: string; message: string }>
}

export interface ReviewRow {
  id: string
  what: string
  now: string
  next: string
  raise: boolean
  note?: string
}

/** The review as the modal's rows: each permission added or removed, each grain, the two-factor rule. */
export function reviewRows(review: RoleReview, words: { permission: (name: string) => string; risky: (name: string) => boolean; grain: (grain: Grain) => string; t: (key: string) => string }): ReviewRow[] {
  const { t } = words
  return [
    ...review.permissionsAdded.map((name) => ({ id: `add:${name}`, what: words.permission(name), now: t('saveRole.no'), next: t('saveRole.yes'), raise: true, note: t(words.risky(name) ? 'saveRole.risky' : 'saveRole.gives') })),
    ...review.permissionsRemoved.map((name) => ({ id: `remove:${name}`, what: words.permission(name), now: t('saveRole.yes'), next: t('saveRole.no'), raise: false })),
    ...review.grainsAdded.map((grain) => ({ id: `grain:${grain}`, what: words.grain(grain), now: t('saveRole.notSeen'), next: t('saveRole.seen'), raise: true, note: t('saveRole.gives') })),
    ...review.grainsRemoved.map((grain) => ({ id: `grain-off:${grain}`, what: words.grain(grain), now: t('saveRole.seen'), next: t('saveRole.notSeen'), raise: false })),
    ...(review.requireMfa.before !== review.requireMfa.after
      ? [{ id: 'mfa', what: t('saveRole.twoFactor'), now: t(review.requireMfa.before ? 'saveRole.asked' : 'saveRole.notAsked'), next: t(review.requireMfa.after ? 'saveRole.asked' : 'saveRole.notAsked'), raise: !review.requireMfa.after, note: t(review.requireMfa.after ? 'saveRole.mfaWhy' : 'saveRole.gives') }]
      : []),
  ]
}

/** A refusal of the review or the save as a message key and its values (the API's English never shows). */
export function refusalWords(path: string): { key: string; subject?: { permission?: string; grain?: string } } {
  const beyond = /^body\/(permissions|grains)\/([^/]+)\/beyondYou$/.exec(path)
  if (beyond) return beyond[1] === 'permissions' ? { key: 'saveRole.refusal.beyondPermission', subject: { permission: beyond[2]! } } : { key: 'saveRole.refusal.beyondGrain', subject: { grain: beyond[2]! } }
  if (path === 'roles/readyMade') return { key: 'saveRole.refusal.readyMade' }
  if (path === 'roles/ROLE_ARCHIVED') return { key: 'saveRole.refusal.archived' }
  if (path === 'roles/held') return { key: 'saveRole.refusal.held' }
  if (path === 'roles/lastAdmin') return { key: 'saveRole.refusal.lastAdmin' }
  if (path === 'body/permissions/ownerEvery') return { key: 'saveRole.refusal.ownerEvery' }
  if (path === 'body/requireMfa') return { key: 'saveRole.refusal.mfaNeeded' }
  if (path.startsWith('body/requireMfa/')) return { key: 'saveRole.refusal.mfaRule' }
  if (path === 'body/name') return { key: 'saveRole.refusal.name' }
  if (/^body\/(permissions|grains)\/\d+$/.test(path)) return { key: 'saveRole.refusal.content' }
  return { key: 'saveRole.refusal.other' }
}

/** A failed save as a message key (409 read again; 403 the right; refusals by their paths). */
export function saveProblem(error: unknown): { key: string; paths: string[] } {
  if (!isApiError(error)) return { key: 'saveRole.problem.failed', paths: [] }
  const paths = error.issues.map(issuePath).filter((path) => path !== '')
  if (paths.length > 0 && (error.kind === 'invalid' || error.kind === 'conflict' || error.kind === 'forbidden') && paths.some((path) => refusalWords(path).key !== 'saveRole.refusal.other')) return { key: 'saveRole.problem.refused', paths }
  if (error.kind === 'conflict') return { key: 'saveRole.problem.stale', paths }
  if (error.kind === 'forbidden') return { key: 'saveRole.problem.forbidden', paths }
  return { key: 'saveRole.problem.failed', paths }
}
