import type { ApprovalDecision, ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { statusTone, type BrandRoundStatus } from '@nexus/factory-domain/sales/portal-samples/rules'
import type { ScanState } from '@nexus/factory-domain/product/techpack/scan'
import type { ActionDueState } from '@nexus/ui/patterns/ActionList/index'
import type { ApprovalRead } from '../home/api'
import type { RoundRead, SamplesRead, StyleRead, TechPack, WaitingRead } from './api'

/**
 * The brand's Samples & tech packs (B-W2b-262, SCR-225; design portal.customer.samples). Pure: the rows the three sections
 * draw, the decision dialog's rules (the same as the Approve link and Home's pop-up: B-W2b-184 — words needed with changes
 * and with a rejection, signed with the typed name), the address (`?decide=<request>`, `?style=<style>`), the band.
 */

export const NS = 'portal-samples'
export const PAGE_PERMISSION = 'portal.samples.view'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

// ── the address ───────────────────────────────────────────────────────────────────────────────────────────────────────
export interface SamplesAddress {
  /** A request to decide (a task's or notification's link; Home's row): the dialog opens on it. */
  decide: string | null
  /** A style's rounds only (a row of Your styles in development). */
  style: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function addressOf(params: { get(name: string): string | null } | null): SamplesAddress {
  const pick = (name: string) => {
    const value = params?.get(name)?.trim() ?? ''
    return UUID.test(value) ? value.toLowerCase() : null
  }
  return { decide: pick('decide'), style: pick('style') }
}

export function addressQuery(address: SamplesAddress): string {
  const query = new URLSearchParams()
  if (address.style) query.set('style', address.style)
  if (address.decide) query.set('decide', address.decide)
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ── what waits ────────────────────────────────────────────────────────────────────────────────────────────────────────
const HOUR = 3_600_000

/** The ActionList's due: overdue, today (within 24 h), soon (within 3 days), later. */
export function dueStateOf(dueAt: string, now: number): ActionDueState {
  const at = Date.parse(dueAt)
  if (!Number.isFinite(at)) return 'none'
  if (at < now) return 'overdue'
  if (at - now <= 24 * HOUR) return 'today'
  if (at - now <= 72 * HOUR) return 'soon'
  return 'later'
}

/** The waiting rows in the API's order (overdue first, then the earliest due). */
export const waitingIds = (waiting: readonly WaitingRead[] | null): string[] => (waiting ?? []).map((row) => row.requestId)

/** The request next to this one in the queue (J / K), or null at an end. */
export function neighbourOf(queue: readonly string[], id: string, step: 1 | -1): string | null {
  const index = queue.indexOf(id)
  if (index < 0) return queue[0] ?? null
  return queue[index + step] ?? null
}

/** What is decided: "Fit · round 2" for a round; a colour, leather or artwork its kind and style code. */
export function decisionWhat(row: Pick<WaitingRead, 'kind' | 'round' | 'style'>, t: Translate, locale: 'it' | 'en'): string {
  if (row.round && row.kind === 'SAMPLE') return row.round.label[locale].split(' · ').slice(1).join(' · ') || row.round.number
  return [t(`kind.${row.kind}`), row.style?.code].filter(Boolean).join(' · ')
}

/** "Decide on Fit · round 2". */
export const decisionTitle = (row: Pick<WaitingRead, 'kind' | 'round' | 'style'> | null, t: Translate, locale: 'it' | 'en'): string => (row ? t('decide.title', { what: decisionWhat(row, t, locale) }) : t('decide.loading'))

// ── the decision (B-W2b-184's answer, in the sample's words) ──────────────────────────────────────────────────────────
/** The limits the API checks (factory-domain approvals-out rules: that module is server-only). */
export const ANSWER_LIMITS = Object.freeze({ answer: 4000, typedName: 200 })

/** Approve · Approve with comments (where the kind allows) · Reject. */
export const decisionsOf = (page: Pick<ApprovalRead, 'may'>): ApprovalDecision[] => (page.may.withChanges ? ['APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED'] : ['APPROVED', 'REFUSED'])

/** Words are needed with comments and with a rejection (the API refuses either without). */
export const commentNeeded = (decision: ApprovalDecision | null): boolean => decision === 'APPROVED_WITH_CHANGES' || decision === 'REFUSED'

/** Why the signed answer cannot go yet (a key of `portal-samples`), in the order the person fixes it. */
export function answerProblem(decision: ApprovalDecision | null, comment: string): { key: string; field: 'decision' | 'comment' } | null {
  if (decision === null) return { key: 'decide.problem.choose', field: 'decision' }
  const words = comment.trim()
  if (decision === 'REFUSED' && words === '') return { key: 'decide.problem.why', field: 'comment' }
  if (decision === 'APPROVED_WITH_CHANGES' && words === '') return { key: 'decide.problem.what', field: 'comment' }
  if (words.length > ANSWER_LIMITS.answer) return { key: 'decide.problem.long', field: 'comment' }
  return null
}

/** A refused answer in this page's words (`reload`: read the request again; `gone`: it no longer waits for you). */
export function answerRefusal(kind: string | null): { key: string; reload?: boolean; gone?: boolean } {
  switch (kind) {
    case 'not_found':
      return { key: 'decide.problem.gone', gone: true }
    case 'forbidden':
      return { key: 'decide.problem.forbidden' }
    case 'conflict':
      return { key: 'decide.problem.changed', reload: true }
    case 'invalid':
      return { key: 'decide.problem.invalid' }
    case 'unavailable':
    case 'rate_limited':
      return { key: 'decide.problem.unavailable' }
    default:
      return { key: 'decide.problem.failed' }
  }
}

/** The request's own reason it cannot be answered (answered, withdrawn, past due), a key — or null. */
export function requestHeld(page: Pick<ApprovalRead, 'may' | 'request'>): string | null {
  if (page.may.answer) return null
  const status: ApprovalStatus = page.request.status
  return status === 'APPROVED' || status === 'APPROVED_WITH_CHANGES' || status === 'REFUSED' ? 'held.answered' : 'held.closed'
}

/**
 * Why the whole decision is held, a key with its words, the first that applies: an office preview, a role that may not
 * approve (naming the admins to ask), no connection, a send on its way, the request not read yet, the request's own state.
 */
export function decisionHeld(input: { preview: boolean; mayApprove: boolean; offline: boolean; busy: boolean; page: Pick<ApprovalRead, 'may' | 'request'> | null; admins: readonly string[] }): { key: string; params?: Record<string, string> } | null {
  if (input.preview) return { key: 'held.preview' }
  if (!input.mayApprove) return input.admins.length > 0 ? { key: 'held.mayApproveAsk', params: { admins: input.admins.join(', ') } } : { key: 'held.mayApprove' }
  if (input.offline) return { key: 'held.offline' }
  if (input.busy) return { key: 'held.busy' }
  if (!input.page) return { key: 'held.reading' }
  const own = requestHeld(input.page)
  return own ? { key: own } : null
}

/** The decision's tone at the end (an approval succeeds; a rejection is said plainly). */
export const decidedTone = (status: ApprovalStatus): 'success' | 'warning' | 'neutral' => (status === 'REFUSED' ? 'warning' : status === 'APPROVED' || status === 'APPROVED_WITH_CHANGES' ? 'success' : 'neutral')

export const isPicture = (contentType: string): boolean => /^image\/(png|jpe?g|webp|gif)$/i.test(contentType)
export const isPdf = (contentType: string): boolean => contentType.toLowerCase() === 'application/pdf'

/** A dialog file as read: a picture's object address, a PDF's bytes. */
export interface DialogFile {
  id: string
  name: string
  state: 'loading' | 'error' | 'ready'
  /** A picture: its object address; a PDF: its bytes. */
  src: string | Uint8Array | null
  pdf: boolean
}

// ── the rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const roundTone = (status: BrandRoundStatus) => statusTone(status)

export const techPackTone = (state: ScanState): 'success' | 'info' | 'warning' | 'neutral' => (state === 'CURRENT' ? 'success' : state === 'DRAFT' ? 'info' : state === 'OBSOLETE' ? 'neutral' : 'warning')

/** A round's shipment in one line: "BRT · 0012345" (carrier and tracking number), or null. */
export function trackingText(shipment: RoundRead['shipment']): string | null {
  if (!shipment) return null
  const parts = [shipment.carrierName, shipment.trackingNumber].map((part) => part?.trim() ?? '').filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The rounds the page shows: one style's (a row of Your styles in development) or every one. */
export const roundsShown = (rounds: readonly RoundRead[], style: string | null): RoundRead[] => (style ? rounds.filter((round) => round.style.id === style) : [...rounds])

/** The styles' copy to open first (the API's choice) and the older ones. */
export const olderPacks = (style: StyleRead): TechPack[] => style.techPacks.filter((pack) => pack.id !== style.techPack?.id)

/** What the band and the page say at a glance. */
export function summaryOf(read: SamplesRead | null): { waiting: number | null; open: number; styles: number } {
  return { waiting: read?.counts.waiting ?? null, open: read?.counts.open ?? 0, styles: read?.counts.styles ?? 0 }
}

// ── the band ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The frame's band (design h: AsOf; "Approve waiting samples" — the primary when any wait, it opens the first; ⋯ "Ask a
 * question", which the frame adds) and the page's keys. One builder for the live page and its design cases.
 */
export function samplesBandOf(input: { t: Translate; asOf: string | null; waiting: number; onDecideFirst: (() => void) | null; held: string | null }) {
  const { t } = input
  return {
    title: t('title'),
    status: input.asOf ? { label: t('band.updated', { time: input.asOf }), tone: 'neutral' as const } : null,
    actions: input.waiting > 0 && input.onDecideFirst ? [{ id: 'decide', label: t('band.decide', { count: input.waiting }), variant: 'primary' as const, onClick: input.onDecideFirst, heldReason: input.held }] : [],
    more: [],
    keys: [
      { keys: ['j', 'k'], words: t('keys.rows') },
      { keys: ['↵'], words: t('keys.open') },
      { keys: ['J', 'K'], words: t('keys.nextSample') },
      { keys: ['a'], words: t('keys.approve') },
      { keys: ['r'], words: t('keys.reject') },
      { keys: ['Esc'], words: t('keys.close') },
    ],
  }
}
