import { isApiError } from '../../../../../lib/api/errors'
import type { CaptureRead } from './api'

/**
 * Admin › Connections › Your mail domain › Capture address — the pure part (B-W2b-397 on B-W2b-394's capture routes; COL-021;
 * design admin.connections sec:mail-domain "Capture address (W2b): forward or BCC any mail to it"). The company's one live
 * address `c-<token>@<its receiving domain>`: copy it; where mail it cannot place lands (a team inbox, or Mail to sort); make
 * one, replace a leaked one (the old one stops in the same step) or turn it off. Every write is email.inboxes.manage; the
 * address needs the company's mail domain first.
 */

export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly data: T } | { readonly status: 'error'; readonly problem: string }

export type CaptureConfirm = 'replace' | 'turnOff'

export interface CaptureCardModel {
  readonly read: Read<CaptureRead>
  /** The switched-on team inboxes for the default's choice; null while not read or not readable (email.triage). */
  readonly inboxes: readonly { readonly id: string; readonly name: string }[] | null
  readonly busy: boolean
  readonly notice: { readonly key: string; readonly tone: 'success' | 'warning' | 'danger' } | null
  readonly confirm: CaptureConfirm | null
  /** The company's address prefix (`/w/<code>`): the Home › Mail link. */
  readonly prefix: string
}

/** Why Make a capture address waits (a key of `mail-depth`), or null. */
export function makeHeld(read: CaptureRead, busy: boolean): string | null {
  if (!read.mayManage) return 'captureAdmin.held.noRight'
  if (read.receivingDomain === null) return 'captureAdmin.held.noDomain'
  if (busy) return 'captureAdmin.held.busy'
  return null
}

/** Why Replace, Turn off or the default inbox wait (a key of `mail-depth`), or null. */
export function changeHeld(read: CaptureRead, busy: boolean): string | null {
  if (!read.mayManage) return 'captureAdmin.held.noRight'
  if (busy) return 'captureAdmin.held.busy'
  return null
}

/** A write that failed, in words (a key of `mail-depth`): a capture changed meanwhile is read again. */
export function captureWriteProblem(error: unknown): { key: string; reload: boolean } {
  if (!isApiError(error)) return { key: 'captureAdmin.notice.failed', reload: false }
  if (error.kind === 'conflict') return { key: 'captureAdmin.notice.changed', reload: true }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'captureAdmin.notice.forbidden', reload: false }
  if (error.kind === 'not_found') return { key: 'captureAdmin.notice.changed', reload: true }
  if (error.kind === 'invalid') return { key: 'captureAdmin.notice.invalid', reload: true }
  if (error.kind === 'unavailable') return { key: 'captureAdmin.notice.unavailable', reload: false }
  return { key: 'captureAdmin.notice.failed', reload: false }
}

/** A read that failed, in words (a key of `mail-depth`). */
export function captureReadProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'forbidden') return 'capture.problem.forbidden'
  if (isApiError(error) && error.kind === 'unavailable') return 'capture.problem.unavailable'
  return 'capture.problem.read'
}
