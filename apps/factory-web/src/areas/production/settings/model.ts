import { MAX_BUNDLE_SIZE } from '@nexus/factory-domain/production/bundles/rules'
import { monitoringChangeOf, REASON_MAX, REFERENCE_MAX, type MonitoringChange } from '@nexus/factory-domain/production/settings/monitoring'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Affected, BasisKind, NoticeAcks, Rules, RulesDetail, ScanSubject } from './api'

/**
 * Production › Settings › Floor rules & codes (SCR-074; design production.settings, fr-monitor, fr-rules, fr-reasons),
 * pure: what this person may do, the monitoring switch's draft and what applying it does (narrowing never asks;
 * widening needs the legal basis on record, a reason and a fresh code), the site's readiness and a change's reach in
 * this page's words (keys of `floor-rules`, prefix `fr.`) and the standard bundle size (the W2b sections: w2b-model.ts). Counts
 * are counts: no worker is ever named here (Owner answer W1; Statuto dei Lavoratori art. 4).
 */

export const FLOOR_RULES_NAMESPACES = ['floor-rules', 'lists', 'ds-words'] as const
/** B-W2b-58: + Off-standard codes (fr-offstd) and Help-call routing (fr-calls), grids saved per cell, each its own tab. */
export const TABS = ['rules', 'codes', 'offstd', 'calls'] as const
export type Tab = (typeof TABS)[number]
export const tabOf = (value: string | null | undefined): Tab => (TABS.includes(value as Tab) ? (value as Tab) : 'rules')

export interface FloorRulesCan {
  view: boolean
  manage: boolean
  /** B-W2a-46 (SCR-088): the reason lists (reasons.view reads them; reasons.manage keeps them, the editor says which). */
  reasons: boolean
  /** Admin › Privacy & notices (the notice's text and versions). */
  privacy: boolean
  /** B-W2b-58: Off-standard codes (production.offstandard.view; .codes keeps them). */
  offstd: boolean
  offstdManage: boolean
  /** B-W2b-58: Help-call routing (production.calls.view; .manage keeps it). */
  calls: boolean
  callsManage: boolean
  /** people.view: the site's teams to pick as a call's group. */
  people: boolean
  /** money.cost: the scrap limit says a value limit is not kept yet. */
  cost: boolean
}

export function floorRulesCan(permissions: readonly string[]): FloorRulesCan {
  const held = new Set(permissions)
  return {
    view: held.has('production.settings.view'),
    manage: held.has('production.settings.manage'),
    reasons: held.has('reasons.view'),
    privacy: held.has('privacy.view'),
    offstd: held.has('production.offstandard.view'),
    offstdManage: held.has('production.offstandard.codes'),
    calls: held.has('production.calls.view'),
    callsManage: held.has('production.calls.manage'),
    people: held.has('people.view'),
    cost: held.has('money.cost'),
  }
}

// ---- the monitoring switch ------------------------------------------------------------------------------------------------

export interface SwitchDraft {
  subject: ScanSubject
  /** '' while no basis kind is chosen. */
  basisKind: BasisKind | ''
  reference: string
  /** Why floor records will name workers from now on (widening only). */
  reason: string
}

export const draftOf = (rules: Rules): SwitchDraft => ({ subject: rules.scanSubject, basisKind: rules.legalBasis?.kind ?? '', reference: rules.legalBasis?.reference ?? '', reason: '' })

export type ApplyAction = 'scanSubject' | 'legalBasis' | null

export interface SwitchPlan {
  change: MonitoringChange
  /** A basis typed that differs from the one on record (recorded with the change, or on its own). */
  basisChanged: boolean
  /** The call Apply makes; null: nothing to apply. */
  action: ApplyAction
  /** Why Apply is held (a key of `floor-rules`), or null. */
  held: string | null
  /** The confirm "Record stations only" (narrowing). */
  confirm: boolean
  /** Widening asks a fresh code (the API's 403 `stepUp`). */
  stepUp: boolean
  /** Changes counted for the save bar. */
  changes: number
}

const filled = (text: string) => text.trim() !== ''

/** What Apply does with the draft, and why it is held. */
export function planOf(rules: Rules, draft: SwitchDraft): SwitchPlan {
  const change = monitoringChangeOf(rules.scanSubject, draft.subject)
  const naming = draft.subject === 'WORKER'
  const typedBasis = naming && (draft.basisKind !== '' || filled(draft.reference))
  const basisComplete = draft.basisKind !== '' && filled(draft.reference)
  const recorded = rules.legalBasis
  const basisChanged = naming && basisComplete && (!recorded || recorded.kind !== draft.basisKind || recorded.reference !== draft.reference.trim())
  let held: string | null = null
  if (naming && !recorded && !basisComplete) held = draft.basisKind === '' && !filled(draft.reference) ? 'fr.held.basis' : draft.basisKind === '' ? 'fr.held.basisKind' : 'fr.held.reference'
  else if (typedBasis && !basisComplete) held = draft.basisKind === '' ? 'fr.held.basisKind' : 'fr.held.reference'
  else if (draft.reference.trim().length > REFERENCE_MAX) held = 'fr.held.referenceLong'
  else if (change === 'WIDEN' && !filled(draft.reason)) held = 'fr.held.reason'
  else if (draft.reason.trim().length > REASON_MAX) held = 'fr.held.reasonLong'
  const subjectChanged = change !== 'NONE'
  // A site without rules names workers by default: recording a basis there is the first write.
  const action: ApplyAction = subjectChanged ? 'scanSubject' : basisChanged ? 'legalBasis' : null
  const changes = (subjectChanged ? 1 : 0) + (basisChanged ? 1 : 0)
  return { change, basisChanged, action, held: action ? held : null, confirm: change === 'NARROW', stepUp: change === 'WIDEN', changes }
}

/** The body of the scan-subject call. */
export function subjectBody(rules: Rules, draft: SwitchDraft, plan: SwitchPlan) {
  return {
    scanSubject: draft.subject,
    ...(plan.change === 'WIDEN' ? { reason: draft.reason.trim() } : {}),
    ...(plan.basisChanged && draft.basisKind ? { legalBasis: { kind: draft.basisKind, reference: draft.reference.trim() } } : {}),
    ...(rules.version !== null ? { version: rules.version } : {}),
  }
}

export interface Line {
  key: string
  params?: Readonly<Record<string, string | number>>
}

/** The site's state for real floor work, in this page's words. */
export function readinessOf(detail: Pick<RulesDetail, 'rules' | 'affected'>, acks: NoticeAcks | null): { ready: boolean; lines: Line[] } {
  const { rules } = detail
  if (rules.scanSubject === 'STATION') return { ready: true, lines: [{ key: 'fr.status.station' }] }
  if (!rules.legalBasis) return { ready: false, lines: [{ key: rules.isDefault ? 'fr.status.noBasisDefault' : 'fr.status.noBasis' }] }
  const waiting = acks?.workers.notAcknowledged ?? detail.affected.workersNotAcknowledged
  return { ready: true, lines: [{ key: 'fr.status.worker' }, ...(waiting > 0 ? [{ key: 'fr.status.waiting', params: { count: waiting } }] : [])] }
}

/** What moving the switch means at the site (counts only), in this page's words; empty when it does not move. */
export function impactOf(from: ScanSubject, to: ScanSubject, affected: Affected): Line[] {
  const change = monitoringChangeOf(from, to)
  if (change === 'NONE') return []
  const lines: Line[] = []
  if (change === 'NARROW') {
    lines.push({ key: 'fr.impact.narrow' })
    if (affected.devicesWithoutStation > 0) lines.push({ key: 'fr.impact.devices', params: { count: affected.devicesWithoutStation } })
  } else {
    lines.push({ key: 'fr.impact.widen' })
    if (affected.workersNotAcknowledged > 0) lines.push({ key: 'fr.impact.notAcknowledged', params: { count: affected.workersNotAcknowledged, active: affected.workersActive } })
  }
  if (affected.openWorkOrders > 0) lines.push({ key: 'fr.impact.openOrders', params: { count: affected.openWorkOrders } })
  lines.push({ key: 'fr.impact.keep' })
  return lines
}

/** The answer of a change in words (the event's `change`). */
export function doneOf(change: 'WIDENED' | 'NARROWED' | 'BASIS_RECORDED' | 'BASIS_REPLACED' | null, changed: boolean): string {
  if (!changed) return 'fr.done.unchanged'
  switch (change) {
    case 'WIDENED':
      return 'fr.done.widened'
    case 'NARROWED':
      return 'fr.done.narrowed'
    case 'BASIS_RECORDED':
      return 'fr.done.basisRecorded'
    case 'BASIS_REPLACED':
      return 'fr.done.basisReplaced'
    default:
      return 'fr.done.saved'
  }
}

/** A refused change in this page's words: the rules moved meanwhile, the basis or reason the API refused, no right. */
export function changeProblem(error: unknown): { key: string; conflict?: boolean } {
  if (!isApiError(error)) return { key: 'fr.problem.write' }
  const paths = error.issues.map(issuePath)
  if (error.kind === 'conflict') return { key: 'fr.problem.changed', conflict: true }
  if (error.kind === 'invalid' && paths.some((path) => path.includes('legalBasis') || path.endsWith('kind') || path.endsWith('reference'))) return { key: 'fr.held.basis' }
  if (error.kind === 'invalid' && paths.some((path) => path.endsWith('reason'))) return { key: 'fr.held.reason' }
  if (error.kind === 'invalid' && paths.some((path) => path.includes('standardBundleSize'))) return { key: 'fr.bundle.range' }
  if (error.kind === 'invalid') return { key: 'fr.problem.invalid' }
  if (error.kind === 'forbidden') return { key: 'fr.problem.forbidden' }
  if (error.kind === 'not_found') return { key: 'fr.problem.gone' }
  if (error.kind === 'unavailable') return { key: 'fr.problem.offline' }
  return { key: 'fr.problem.write' }
}

/** A refused authenticator code in words. */
export function stepUpProblem(error: unknown): string {
  if (!isApiError(error)) return 'fr.stepUp.unavailable'
  if (error.kind === 'rate_limited') return 'fr.stepUp.locked'
  if (error.kind === 'invalid' || error.kind === 'forbidden' || error.kind === 'signed_out') return 'fr.stepUp.wrong'
  return 'fr.stepUp.unavailable'
}

export class StepUpCancelled extends Error {
  override name = 'StepUpCancelled'
}

/** Run `work`; on a 403 that asks for a step-up, wait for a code the API took and run it once more. */
export async function withStepUp<T>(work: () => Promise<T>, askForCode: () => Promise<void>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!isApiError(error) || error.kind !== 'step_up') throw error
    await askForCode()
    return work()
  }
}

// ---- the bundle size ---------------------------------------------------------------------------------------------------------

export const bundleHeld = (value: number | '', saved: number): string | null =>
  value === '' || !Number.isInteger(value) || value < 1 || value > MAX_BUNDLE_SIZE ? 'fr.bundle.range' : value === saved ? 'fr.bundle.same' : null

export const MAX_BUNDLE = MAX_BUNDLE_SIZE

/** The site the page shows: the address's, else the first by code. */
export function chosenSite<T extends { site: { id: string; code: string } }>(sites: readonly T[], siteId: string | null): T | null {
  if (sites.length === 0) return null
  return sites.find((entry) => entry.site.id === siteId) ?? [...sites].sort((a, b) => a.site.code.localeCompare(b.site.code))[0]!
}
