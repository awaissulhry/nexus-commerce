import { createElement } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { NoticeAcks, RulesDetail, SiteRules } from './api'
import { floorRulesCan, type Tab } from './model'
import { FloorRulesView, type FloorRulesModel } from './view/FloorRulesView'

/**
 * Design cases of SCR-074, Production › Settings › Floor rules & codes (made-up data: an invented company, two sites
 * "STAB-N" and "MAG-S", a made-up agreement reference, invented people for "recorded by"). Roles from factory-domain's
 * templates: the owner, the production manager (changes the rules), the floor supervisor and read-only (see them), the
 * warehouse and sales (no permission). No worker is named anywhere (Owner answer W1). The Reason codes tab is SCR-088
 * (./codes/fixtures.ts, B-W2a-46).
 */

const PREFIX = '/w/DEMO'
const COMPANY = DEMO_COMPANIES[0].id
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const NORTH = { id: uid('2222', 1), companyId: COMPANY, code: 'STAB-N', name: 'Stabilimento Demo Nord' }
const SOUTH = { id: uid('2222', 2), companyId: COMPANY, code: 'MAG-S', name: 'Magazzino Demo Sud' }

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']
const ROLES = {
  owner: [...OWNER_PERMISSIONS, ...template('production_manager'), 'privacy.view', 'production.settings.manage'],
  production: template('production_manager'),
  supervisor: template('floor_supervisor'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  warehouse: template('warehouse'),
  sales: template('sales'),
} as const
export type Role = keyof typeof ROLES

export function inShell(page: ReturnType<typeof createElement>, role: Role) {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLES[role]])),
    path: '/production/settings',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/production/settings' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const BASIS = { kind: 'UNION_AGREEMENT' as const, reference: 'Accordo RSU n. 14/2026 del 12/10/2026', recordedAt: at(12, 15, 20), recordedById: uid('5151', 1), recordedByName: 'Giulia Esempio' }
const AFFECTED = { openWorkOrders: 4, workersActive: 36, workersNotAcknowledged: 2, devicesWithoutStation: 1 }

const rulesOf = (over: Partial<RulesDetail['rules']>): RulesDetail['rules'] => ({ scanSubject: 'WORKER', isDefault: false, legalBasis: BASIS, standardBundleSize: 12, version: 3, updatedAt: at(12, 15, 20), ...over })
const detailOf = (site: typeof NORTH, rules: RulesDetail['rules'], ready = true): RulesDetail => ({ site, rules, status: { readyForFloor: ready }, affected: AFFECTED })
const entryOf = (detail: RulesDetail): SiteRules => ({ site: detail.site, rules: detail.rules, status: detail.status })

export const WORKER_SITE = detailOf(NORTH, rulesOf({}))
const STATION_SITE = detailOf(NORTH, rulesOf({ scanSubject: 'STATION', legalBasis: null }))
const DEFAULT_SITE = detailOf(NORTH, rulesOf({ isDefault: true, legalBasis: null, standardBundleSize: 10, version: null, updatedAt: null }), false)
const SOUTH_SITE = detailOf(SOUTH, rulesOf({ scanSubject: 'STATION', legalBasis: null, version: 1 }))
const ACKS: NoticeAcks = { workers: { active: 36, acknowledged: 34, notAcknowledged: 2 }, versions: [{ noticeVersion: '2026-10', workers: 34 }, { noticeVersion: '2026-09', workers: 3 }] }

export function base(role: Role, detail: RulesDetail = WORKER_SITE, over: Partial<FloorRulesModel> = {}, tab: Tab = 'rules'): { role: Role; model: FloorRulesModel } {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: floorRulesCan(ROLES[role]),
      tab,
      timeZone: 'Europe/Rome',
      sites: { status: 'ready', items: [entryOf(detail)] },
      siteId: detail.site.id,
      detail: { value: detail, problem: null },
      acks: { value: ACKS, problem: null },
      asOf: at(30, 9, 42),
      busy: null,
      notice: null,
      changedElsewhere: false,
      stepUp: { open: false, busy: false, problem: null },
      ...over,
    },
  }
}

function FloorRulesDesign({ model }: { model: { role: Role; model: FloorRulesModel } }) {
  return inShell(createElement(FloorRulesView, { model: model.model }), model.role)
}

const widenDraft = { subject: 'WORKER' as const, basisKind: 'UNION_AGREEMENT' as const, reference: 'Accordo RSU n. 14/2026 del 12/10/2026', reason: 'L’accordo con la RSU è firmato: le registrazioni nominano chi lavora.' }

export const designScreen = defineDesignScreen<{ role: Role; model: FloorRulesModel }>({
  screen: 'SCR-074',
  title: 'Floor rules & codes (Production › Settings)',
  view: FloorRulesDesign,
  cases: [
    { id: 'worker-basis', label: 'Owner: the site names the worker, the RSU agreement on record; notice counts only', model: base('owner'), note: 'Choose “Name the station only”: the save bar appears; Apply asks “Record stations only”.' },
    { id: 'station', label: 'Production manager: the site names the station only (ready for the floor)', model: base('production', STATION_SITE) },
    { id: 'default-no-basis', label: 'A site without floor rules: names workers by default, no basis — not ready, in words', model: base('production', DEFAULT_SITE) },
    { id: 'widen-held', label: 'STATION → WORKER chosen, no basis yet: Apply held until the basis and reference are given', model: base('production', STATION_SITE, { draft: { subject: 'WORKER', basisKind: '', reference: '', reason: '' } }) },
    { id: 'widen-ready', label: 'STATION → WORKER with the basis and the reason: “Apply (asks a code)”, the reach in counts', model: base('production', STATION_SITE, { draft: widenDraft }) },
    { id: 'step-up', label: 'Widening: the fresh code is asked (step-up)', model: base('production', STATION_SITE, { draft: widenDraft, busy: 'switch', stepUp: { open: true, busy: false, problem: null } }) },
    { id: 'step-up-wrong', label: 'Step-up: a wrong code, in words', model: base('production', STATION_SITE, { draft: widenDraft, busy: 'switch', stepUp: { open: true, busy: false, problem: 'fr.stepUp.wrong' } }) },
    { id: 'narrow-confirm', label: 'WORKER → STATION: “Record stations only” confirm (records already made keep their names)', model: base('owner', WORKER_SITE, { draft: { subject: 'STATION', basisKind: 'UNION_AGREEMENT', reference: BASIS.reference, reason: '' }, confirmOpen: true }) },
    { id: 'basis-replace', label: 'A renewed agreement: the basis replaced (no code asked)', model: base('production', WORKER_SITE, { draft: { subject: 'WORKER', basisKind: 'UNION_AGREEMENT', reference: 'Accordo RSU n. 3/2027 del 15/01/2027', reason: '' } }) },
    { id: 'saved', label: 'Saved: “Floor records name the station only from now on”', model: base('production', STATION_SITE, { notice: { tone: 'success', key: 'fr.done.narrowed' } }) },
    { id: 'changed-elsewhere', label: 'Changed by someone else meanwhile: Reload', model: base('production', WORKER_SITE, { changedElsewhere: true }) },
    { id: 'refused', label: 'Refused: the rules moved meanwhile (in words)', model: base('production', WORKER_SITE, { notice: { tone: 'danger', key: 'fr.problem.write' } }) },
    { id: 'bundle-typed', label: 'Standard bundle size typed: 20 (Save)', model: base('production', WORKER_SITE, { bundleDraft: 20 }) },
    { id: 'bundle-range', label: 'Standard bundle size out of range (600): held, in words', model: base('production', WORKER_SITE, { bundleDraft: 600 }) },
    { id: 'supervisor', label: 'Floor supervisor: sees the rules, changes nothing (“Only the production manager or the Owner changes this”)', model: base('supervisor', WORKER_SITE) },
    { id: 'read-only', label: 'Read-only: sees the rules and counts, no reason codes (no production.scan)', model: base('readOnly', STATION_SITE) },
    { id: 'two-sites', label: 'Two sites: the site picker', model: base('owner', WORKER_SITE, { sites: { status: 'ready', items: [entryOf(WORKER_SITE), entryOf(SOUTH_SITE)] } }) },
    { id: 'acks-failed', label: 'The notice counts could not be read (the rest shows)', model: base('owner', WORKER_SITE, { acks: { value: null, problem: 'fr.problem.offline' } }) },
    { id: 'loading', label: 'Loading', model: base('owner', WORKER_SITE, { sites: { status: 'loading' } }) },
    { id: 'error', label: 'The read failed: in words with Try again', model: base('owner', WORKER_SITE, { sites: { status: 'error', problem: 'fr.problem.offline' } }) },
    { id: 'no-sites', label: 'No site within the person’s access', model: base('owner', WORKER_SITE, { sites: { status: 'ready', items: [] } }) },
    { id: 'no-permission-warehouse', label: 'Warehouse: no permission (production.settings.view)', model: base('warehouse') },
    { id: 'no-permission-sales', label: 'Sales: no permission', model: base('sales') },
  ],
})
