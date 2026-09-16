/**
 * AE.2 — the rules of an assortment share, as pure functions.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §3.4, §3.10 and §14.
 *
 * The database enforces the same rules (packages/database/workspaces/assortment-share.sql):
 * the CHECK on field groups and the status guard trigger. This file exists so a refusal can be
 * explained in words BEFORE the database refuses it. Two copies of one rule drift, so
 * `share-rules.vitest.test.ts` reads the SQL file and fails if the field-group list differs, and
 * the database suite drives every (side, from, to) combination through the real trigger and
 * compares it with `canTransition`.
 */
import { WorkspaceError } from '@nexus/database/workspace-context'

/** Plan §3.4. Channel listings are never a group: each business lists with its own accounts. */
export const FIELD_GROUPS = [
  'identity', 'content', 'attributes', 'translations', 'media', 'physical', 'compliance', 'structure', 'price', 'status',
] as const
export type FieldGroup = (typeof FIELD_GROUPS)[number]

/** Followed unless the owner says otherwise. Price and status are business decisions, so they are off. */
export const DEFAULT_FIELD_GROUPS: readonly FieldGroup[] = [
  'identity', 'content', 'attributes', 'translations', 'media', 'physical', 'compliance', 'structure',
]

export const SHARE_STATUSES = ['pending', 'active', 'paused', 'declined', 'revoked'] as const
export type ShareStatus = (typeof SHARE_STATUSES)[number]
export const OPEN_STATUSES: readonly ShareStatus[] = ['pending', 'active', 'paused']

export type ShareSide = 'owner' | 'follower'
export type OwnerAction = 'pause' | 'resume' | 'revoke'
export type FollowerDecision = 'accept' | 'decline' | 'leave'

/** Exactly the transitions the database guard allows, by the side that acts. */
const ALLOWED: Record<ShareSide, Partial<Record<ShareStatus, readonly ShareStatus[]>>> = {
  owner: { pending: ['revoked'], active: ['paused', 'revoked'], paused: ['active', 'revoked'] },
  follower: { pending: ['active', 'declined'], active: ['revoked'], paused: ['revoked'] },
}

export function canTransition(side: ShareSide, from: ShareStatus, to: ShareStatus): boolean {
  return ALLOWED[side][from]?.includes(to) ?? false
}

const OWNER_TARGET: Record<OwnerAction, ShareStatus> = { pause: 'paused', resume: 'active', revoke: 'revoked' }
const FOLLOWER_TARGET: Record<FollowerDecision, ShareStatus> = { accept: 'active', decline: 'declined', leave: 'revoked' }

export function ownerTarget(action: OwnerAction): ShareStatus {
  return OWNER_TARGET[action]
}
export function followerTarget(decision: FollowerDecision): ShareStatus {
  return FOLLOWER_TARGET[decision]
}
// An own-property check, not `in`: `'toString' in OWNER_TARGET` is true through the prototype chain, and
// the value comes straight from a URL segment.
export function isOwnerAction(value: unknown): value is OwnerAction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OWNER_TARGET, value)
}
export function isFollowerDecision(value: unknown): value is FollowerDecision {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FOLLOWER_TARGET, value)
}

/** The sentence shown when an action does not fit the share's current state. */
export function transitionRefusal(side: ShareSide, action: OwnerAction | FollowerDecision, from: ShareStatus): string {
  if (from === 'declined' || from === 'revoked') return `This share has ended (${from}). Offer a new one to share again.`
  if (side === 'owner') {
    if (action === 'pause') return from === 'paused' ? 'This share is already paused.' : 'Only an active share can be paused.'
    if (action === 'resume') return from === 'active' ? 'This share is already active.' : 'Only a paused share can be resumed. A pending share waits for the other business to accept it.'
  } else {
    if (action === 'accept' || action === 'decline') return `This share is ${from}; only a pending share can be accepted or declined.`
    if (action === 'leave') return 'A pending share is declined, not left.'
  }
  return `A ${from} share cannot be changed this way.`
}

/**
 * Undefined → the defaults. Anything else must be a non-empty list of known groups; a malformed
 * list is refused rather than narrowed or widened silently.
 */
export function normaliseFieldGroups(value: unknown): FieldGroup[] {
  if (value === undefined || value === null) return [...DEFAULT_FIELD_GROUPS]
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string' || !(FIELD_GROUPS as readonly string[]).includes(entry))) {
    throw new WorkspaceError('invalid_field_groups', `Choose one or more of: ${FIELD_GROUPS.join(', ')}.`, 400)
  }
  // Stable order, no duplicates: the stored list is what the follower consented to, read by people.
  return FIELD_GROUPS.filter((group) => (value as string[]).includes(group))
}
