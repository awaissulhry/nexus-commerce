/**
 * Shared stock — the rules of a lending permission ("profile switch"), as pure functions.
 *
 * Plan: docs/2026-09-19-shared-stock-plan.md §4; contract docs/2026-09-19-shared-stock-build.md §2.
 *
 * The database enforces the same rules (packages/database/workspaces/stock-pool.sql, the grant guard).
 * This file exists so a refusal can be explained in words BEFORE the database refuses it. Two copies of
 * one rule drift, so grant-rules.vitest.test.ts compares this table with the guard, and the database
 * suite drives every (side, from, to) combination through the real trigger.
 */
import { WorkspaceError } from '@nexus/database/workspace-context'

export const GRANT_STATUSES = ['pending', 'active', 'paused', 'declined', 'revoked'] as const
export type GrantStatus = (typeof GRANT_STATUSES)[number]
export const OPEN_GRANT_STATUSES: readonly GrantStatus[] = ['pending', 'active', 'paused']

/** The lender offers, pauses, resumes and ends; the borrower accepts, declines and leaves. */
export type GrantSide = 'owner' | 'borrower'
export type LenderAction = 'pause' | 'resume' | 'end'
export type BorrowerDecision = 'accept' | 'decline' | 'leave'

/** Exactly the transitions the database guard allows, by the side that acts. */
const ALLOWED: Record<GrantSide, Partial<Record<GrantStatus, readonly GrantStatus[]>>> = {
  owner: { pending: ['revoked'], active: ['paused', 'revoked'], paused: ['active', 'revoked'] },
  borrower: { pending: ['active', 'declined'], active: ['revoked'], paused: ['revoked'] },
}

export function canTransition(side: GrantSide, from: GrantStatus, to: GrantStatus): boolean {
  return ALLOWED[side][from]?.includes(to) ?? false
}

const LENDER_TARGET: Record<LenderAction, GrantStatus> = { pause: 'paused', resume: 'active', end: 'revoked' }
const BORROWER_TARGET: Record<BorrowerDecision, GrantStatus> = { accept: 'active', decline: 'declined', leave: 'revoked' }

export function lenderTarget(action: LenderAction): GrantStatus {
  return LENDER_TARGET[action]
}
export function borrowerTarget(decision: BorrowerDecision): GrantStatus {
  return BORROWER_TARGET[decision]
}
// An own-property check, not `in`: `'toString' in LENDER_TARGET` is true through the prototype chain,
// and the value comes straight from a URL segment (the AE.2 lesson).
export function isLenderAction(value: unknown): value is LenderAction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LENDER_TARGET, value)
}
export function isBorrowerDecision(value: unknown): value is BorrowerDecision {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BORROWER_TARGET, value)
}

/** The sentence shown when an action does not fit the grant's current state. */
export function transitionRefusal(side: GrantSide, action: LenderAction | BorrowerDecision, from: GrantStatus): string {
  if (from === 'declined' || from === 'revoked') return 'This shared stock has ended. The lending business can make a new offer.'
  if (side === 'owner') {
    if (action === 'pause') return from === 'paused' ? 'This shared stock is already paused.' : 'Only shared stock that is on can be paused.'
    if (action === 'resume') return from === 'active' ? 'This shared stock is already on.' : 'Only paused shared stock can be resumed. A pending offer waits for the other business to accept it.'
  } else {
    if (action === 'accept' || action === 'decline') return `This shared stock is ${from}; only a pending offer can be accepted or declined.`
    if (action === 'leave') return 'A pending offer is declined, not left.'
  }
  return `Shared stock that is ${from} cannot be changed this way.`
}

export function expectVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new WorkspaceError('version_required', 'Reload the shared stock and try again: this change needs the version you are looking at.', 400)
  }
  return value as number
}

/** A list of distinct non-empty ids, or a refusal naming what is wrong. */
export function idList(value: unknown, what: string, max = 500): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new WorkspaceError(`invalid_${what}`, `Choose one or more ${what.replace(/_/g, ' ')}.`, 400)
  }
  const ids = [...new Set((value as string[]).map((v) => v.trim()))]
  if (ids.length > max) throw new WorkspaceError(`too_many_${what}`, `Choose at most ${max} ${what.replace(/_/g, ' ')} at a time.`, 400)
  return ids
}
