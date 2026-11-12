import type { MilestoneStep } from '@nexus/ui/components/MilestoneTracker/index'
import { DEPTH_LIMITS, photosNeeded } from '@nexus/factory-domain/sales/repairs-depth/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { formatNumber } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import type { ReturnableItem, ReturnableRead } from '../api'
import type { Repair, RepairKind, RepairRequestBody } from './api'

/**
 * The customer's repairs in the portal, pure (B-W2b-342; SAL-384, SAL-385, SAL-387; RR1:02; design
 * portal.customer.returns "Start a return or claim" with the same forms as links.claim, the repair's own record): the
 * repair's part of the start (the garment from what we delivered or by its serial, a repair or an alteration, what is
 * wrong, the work wanted), the record's address and tabs, the stepper's steps, the held actions' words by code, the
 * estimate's money in the reader's language (only when the API sent it: the price grain), and a refusal in our words.
 * Words of `returns-repair` (`common.*`, `portal.*`).
 */

export const NS = 'returns-repair'

/** A garment that is not among what we delivered (named by its serial only). */
export const OTHER_GARMENT = '+'

export const LIMITS = Object.freeze({ serial: DEPTH_LIMITS.serial, problem: DEPTH_LIMITS.problem, workWanted: DEPTH_LIMITS.workWanted, declineReason: DEPTH_LIMITS.declineReason, photos: DEPTH_LIMITS.photos })

/** The repair's fields of the start's draft (the portal's StartDraft carries them beside a return's and a complaint's). */
export interface RepairDraft {
  repairKind: RepairKind
  /** An item's key (what we delivered), OTHER_GARMENT, or '' (none picked yet). */
  repairItem: string
  repairSerial: string
  problem: string
  workWanted: string
}

export const EMPTY_REPAIR_DRAFT: RepairDraft = Object.freeze({ repairKind: 'REPAIR', repairItem: '', repairSerial: '', problem: '', workWanted: '' }) as RepairDraft

const blank = (text: string): boolean => text.trim() === ''
const orNull = (text: string): string | null => (blank(text) ? null : text.trim())

/** The items a repair may name: one garment of an order line (each once). */
export function repairItems(read: Pick<ReturnableRead, 'items'> | null): ReturnableItem[] {
  const seen = new Set<string>()
  return (read?.items ?? []).filter((item) => item.salesOrderLineId !== null && !seen.has(item.key) && (seen.add(item.key), true))
}

/** The problems of the repair's draft at its fields (`repairItem`, `repairSerial`, `problem`, `workWanted`): keys of `returns-repair`. */
export function repairStartProblems(draft: RepairDraft, read: Pick<ReturnableRead, 'items'> | null): Record<string, string> {
  const problems: Record<string, string> = {}
  const items = repairItems(read)
  if (draft.repairItem === '' || (draft.repairItem !== OTHER_GARMENT && !items.some((item) => item.key === draft.repairItem))) problems.repairItem = 'returns-repair:check.item'
  if (draft.repairItem === OTHER_GARMENT && blank(draft.repairSerial)) problems.repairSerial = 'returns-repair:check.serial'
  if (draft.repairSerial.trim().length > LIMITS.serial) problems.repairSerial = 'returns-repair:check.long'
  if (draft.repairKind === 'REPAIR' && blank(draft.problem)) problems.problem = 'returns-repair:check.problem'
  if (draft.problem.trim().length > LIMITS.problem) problems.problem = 'returns-repair:check.long'
  if (draft.repairKind === 'ALTERATION' && blank(draft.workWanted)) problems.workWanted = 'returns-repair:check.workWanted'
  if (draft.workWanted.trim().length > LIMITS.workWanted) problems.workWanted = 'returns-repair:check.long'
  return problems
}

/** What POST /portal/repairs takes from the draft. */
export function repairBodyOf(draft: RepairDraft, read: Pick<ReturnableRead, 'items'> | null): RepairRequestBody {
  const item = draft.repairItem && draft.repairItem !== OTHER_GARMENT ? (repairItems(read).find((entry) => entry.key === draft.repairItem) ?? null) : null
  return { kind: draft.repairKind, salesOrderLineId: item?.salesOrderLineId ?? null, size: item?.size ?? null, serial: orNull(draft.repairSerial), problem: orNull(draft.problem), workWanted: orNull(draft.workWanted) }
}

export const repairDirty = (draft: RepairDraft): boolean => draft.repairItem !== '' || !blank(draft.repairSerial) || !blank(draft.problem) || !blank(draft.workWanted)

/** Photos a request asks (two for a damage; an alteration's fit photos are optional). */
export const photosAsked = (kind: RepairKind): number => photosNeeded(kind)

// ---- the record ---------------------------------------------------------------------------------------------------------

export const REPAIR_TABS = ['status', 'request'] as const
export type RepairTab = (typeof REPAIR_TABS)[number]
export const repairTabOf = (value: string | null | undefined): RepairTab => ((REPAIR_TABS as readonly string[]).includes(value ?? '') ? (value as RepairTab) : 'status')

export const repairHref = (prefix: string, id: string, tab?: RepairTab): string => `${prefix}/returns/repairs/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ''}`

const SHOWN: Readonly<Record<Repair['steps'][number]['state'], MilestoneStep['state']>> = { DONE: 'done', CURRENT: 'current', WAITING: 'todo', SKIPPED: 'skipped' }

/** The repair's stepper for the DS MilestoneTracker: received · estimated · approved · in repair · repaired · sent back. */
export function repairSteps(steps: Repair['steps'], t: Translate, at: (iso: string) => string): MilestoneStep[] {
  return steps.map((step) => ({ id: step.stage, label: t(`common.step.${step.stage}`), state: SHOWN[step.state], current: step.state === 'CURRENT', date: step.at ? at(step.at) : null }))
}

/** The stage's tone in a pill. */
export const stageTone = (entry: { open: boolean; next: { forYou: boolean } }): 'warning' | 'neutral' | 'info' => (!entry.open ? 'neutral' : entry.next.forYou ? 'warning' : 'info')

/** An amount in minor units in the reader's language, or null when the API sent none (no price grain). */
export function moneyText(minor: number | undefined, currency: string, locale: Locale): string | null {
  if (minor === undefined) return null
  return formatNumber(minor / 100, locale, { style: 'currency', currency })
}

/** A unit price (a decimal string) in the reader's language. */
export function unitPriceText(value: string | undefined, currency: string, locale: Locale): string | null {
  if (value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? formatNumber(number, locale, { style: 'currency', currency, maximumFractionDigits: 4 }) : value
}

/** The key of why Add photos waits (the API's code), or null. */
export function photosHeldKey(code: string | null, offline: boolean): string | null {
  if (offline) return 'portal.held.offline'
  return code ? `portal.held.photos.${code}` : null
}

/** The key of why Accept / Decline wait (the API's code), or null. */
export function answerHeldKey(code: string | null, offline: boolean, busy: boolean): string | null {
  if (busy) return 'portal.held.busy'
  if (offline) return 'portal.held.offline'
  return code ? `portal.held.answer.${code}` : null
}

/** A decline needs the customer's words (1 to 1000 characters). */
export function declineProblem(reason: string): string | null {
  if (blank(reason)) return 'portal.decline.needed'
  if (reason.trim().length > LIMITS.declineReason) return 'check.long'
  return null
}

/** A refusal of a write in our words (a key of `returns-repair`). */
export function repairRefusalKey(error: unknown): string {
  if (!isApiError(error)) return 'portal.problem.internal'
  if (error.kind === 'forbidden') return 'portal.problem.forbidden'
  if (error.kind === 'not_found') return 'portal.problem.missing'
  if (error.kind === 'conflict') return error.issues.some((issue) => issuePath(issue).endsWith('serial')) ? 'refusal.open' : 'portal.problem.changed'
  if (error.kind === 'invalid') {
    if (error.issues.some((issue) => /contentType$/.test(issuePath(issue)))) return 'portal.problem.photoType'
    if (error.issues.some((issue) => /sizeBytes$/.test(issuePath(issue)))) return 'portal.problem.photoSize'
    return 'portal.problem.invalid'
  }
  if (error.kind === 'rate_limited') return 'portal.problem.tooMany'
  if (error.kind === 'unavailable') return 'portal.problem.unavailable'
  return 'portal.problem.internal'
}

/** The garment in a line: style name, colour, size, serial. */
export function garmentLine(garment: Repair['garment'], t: Translate): string {
  return [garment.style?.name ?? t('common.garmentUnknown'), garment.colourway?.name ?? null, garment.size ? t('common.size', { size: garment.size }) : null, garment.serial ? t('common.serial', { serial: garment.serial }) : null].filter(Boolean).join(' · ')
}
