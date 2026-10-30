import { isApiError, issuePath } from '../../../lib/api/errors'
import type { PlanningSite } from './api'

/**
 * Planning › Planning settings (design planning.settings, SCR-124 + SCR-127), the page's own rules, pure: its tabs (the
 * design's five sections), what this person may do on each, the site the address shows, the save status the band says,
 * and a failed read or write in this page's words (keys of `planning-settings`, prefix `ps.`). Each tab's own rules live
 * in its folder: `calendars/` (SCR-124) and `params/` (SCR-127: item parameters, reorder rules, horizon, line efficiency).
 */

export const PLANNING_SETTINGS_NAMESPACES = ['planning-settings', 'calendar-kit', 'lists'] as const

/** The design's sections, in its order; the address's `?tab=`. */
export const SETTINGS_TABS = ['calendars', 'items', 'reorder', 'horizon', 'efficiency'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]
export const tabOf = (value: string | null | undefined): SettingsTab => (SETTINGS_TABS.includes(value as SettingsTab) ? (value as SettingsTab) : 'calendars')
/** SCR-124 is the calendars tab; SCR-127 the four others. */
export const screenOfTab = (tab: SettingsTab): 'SCR-124' | 'SCR-127' => (tab === 'calendars' ? 'SCR-124' : 'SCR-127')

export interface SettingsCan {
  /** planning.view: the page and every tab's numbers (the page's navigation row). */
  view: boolean
  /** calendars.view: the Calendars & shifts tab. */
  calendars: boolean
  /** calendars.manage: keep the site's, lines' and workshops' calendars and the shift patterns (the company's: over every site). */
  manageCalendars: boolean
  /** planning.settings.manage: horizon, buckets, the default efficiency, the nightly run; each line's efficiency and people. */
  manageSettings: boolean
  /** planning.items.manage: item parameters and reorder rules. */
  manageItems: boolean
  /** purchasing.view: an item's approved suppliers (to pick the preferred one). */
  suppliers: boolean
  /** audit.read: "Changed by …" opens the audit log. */
  audit: boolean
}

export function settingsCan(permissions: readonly string[]): SettingsCan {
  const held = new Set(permissions)
  return {
    view: held.has('planning.view'),
    calendars: held.has('calendars.view'),
    manageCalendars: held.has('calendars.manage'),
    manageSettings: held.has('planning.settings.manage'),
    manageItems: held.has('planning.items.manage'),
    suppliers: held.has('purchasing.view'),
    audit: held.has('audit.read'),
  }
}

/** The permission a tab's changes need, for its held reason (`ps.held.<key>`); null: nothing to keep there. */
export function manageHeld(tab: SettingsTab, can: SettingsCan): string | null {
  if (tab === 'calendars') return can.manageCalendars ? null : 'ps.held.calendars'
  if (tab === 'items' || tab === 'reorder') return can.manageItems ? null : 'ps.held.items'
  return can.manageSettings ? null : 'ps.held.settings'
}

/** The site the address names, else the first the person plans at (null: none). */
export function chosenSite(sites: readonly PlanningSite[], wanted: string | null | undefined): PlanningSite | null {
  return sites.find((site) => site.id === wanted) ?? sites[0] ?? null
}

/** The page's address for a site and a tab (other terms of the tab are its own). */
export function settingsHref(prefix: string, siteId: string | null, tab: SettingsTab): string {
  const query = new URLSearchParams()
  if (siteId) query.set('site', siteId)
  query.set('tab', tab)
  return `${prefix}/planning/settings?${query.toString()}`
}

/**
 * What the band says about saving (design: SaveStatus; form tabs "Unsaved changes", grid tabs "All changes saved · 10:42").
 * A tab reports it; null says nothing (nothing saved yet on this visit).
 */
export type SaveStatus = { kind: 'saved'; at: string } | { kind: 'saving' } | { kind: 'unsaved'; count: number } | { kind: 'failed'; count: number }

/** What the page gives each tab's container (the tab reads and writes its own data). */
export interface TabHost {
  /** `/w/<company>`. */
  prefix: string
  site: PlanningSite
  /** Every site the person plans at (the closure's other sites, a make site). */
  sites: readonly PlanningSite[]
  can: SettingsCan
  /** The band's save words; null says nothing. */
  onStatus: (status: SaveStatus | null) => void
  /** The address's own terms of the tab (`?cal=`, `?month=`, `?q=` …). */
  param: (name: string) => string | null
  /** Replaces those terms (null removes one); the site and the tab stay. */
  setParams: (patch: Readonly<Record<string, string | null>>) => void
}

/** A failed read in this page's words. A failed read is never drawn as empty (design: every section's error state). */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'ps.problem.read'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'ps.problem.forbidden'
  if (error.kind === 'unavailable') return 'ps.problem.offline'
  if (error.kind === 'not_found') return 'ps.problem.gone'
  if (error.kind === 'signed_out') return 'ps.problem.signedOut'
  return 'ps.problem.read'
}

/** A refused write in this page's words: the kind, and for a 400 the first issue's field (`body/<field>`). */
export function writeProblem(error: unknown): { key: string; field: string | null; conflict: boolean; unknown: boolean } {
  if (!isApiError(error)) return { key: 'ps.problem.write', field: null, conflict: false, unknown: true }
  const first = error.issues[0]
  const field = first ? issuePath(first).replace(/^body[/.]/, '').split(/[/.]/)[0] ?? null : null
  switch (error.kind) {
    case 'conflict':
      return { key: 'ps.problem.conflict', field, conflict: true, unknown: false }
    case 'forbidden':
    case 'step_up':
      return { key: 'ps.problem.writeForbidden', field, conflict: false, unknown: false }
    case 'invalid':
      return { key: 'ps.problem.invalid', field, conflict: false, unknown: false }
    case 'not_found':
      return { key: 'ps.problem.gone', field, conflict: false, unknown: false }
    case 'unavailable':
      // No answer: the change may or may not have been made (said so, never shown as saved or as refused).
      return { key: 'ps.problem.unknown', field, conflict: false, unknown: true }
    case 'signed_out':
      return { key: 'ps.problem.signedOut', field, conflict: false, unknown: false }
    default:
      return { key: 'ps.problem.write', field, conflict: false, unknown: false }
  }
}

/** The audit log of a record ("Changed by …"), when the person may read it. */
export function auditHref(prefix: string, recordType: string, recordId?: string | null): string {
  const query = new URLSearchParams({ type: recordType })
  if (recordId) query.set('record', recordId)
  return `${prefix}/admin/audit?${query.toString()}`
}
