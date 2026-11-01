import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { base, inShell, WORKER_SITE, type Role } from '../fixtures'
import { CODES } from '../offstd/fixtures'
import type { FloorRulesModel } from '../view/FloorRulesView'
import { FloorRulesView } from '../view/FloorRulesView'
import { RoutingView, type RoutingModel } from '../view/RoutingView'
import type { HelpCode, Route, SiteTeam } from '../w2b-api'
import { markKey } from '../w2b-model'

/**
 * Design cases of Floor rules & codes › Help-call routing (B-W2b-58; design production.settings fr-calls, MES-144, MES-148;
 * a section of SCR-074, reviewed as SCR-074-calls): the site's help-call types, the group each goes to (a team of the site
 * or the site's team leaders) and how many people it holds, escalate after minutes, the off-standard code the waiting
 * books to; saved per cell. Teams are named, never who is in them. Made-up teams and codes only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const SITE_ID = WORKER_SITE.site.id
const team = (n: number, code: string, name: string, line: string | null): SiteTeam => ({ id: uid('4343', n), code, name, status: 'ACTIVE', line: line ? { id: uid('4444', n), code: line } : null })
const TEAMS: SiteTeam[] = [team(1, 'L1-A', 'Squadra L1-A', 'L1'), team(2, 'MNT', 'Manutenzione', null), team(3, 'MAG', 'Magazzino', null), team(4, 'QUA', 'Qualità', null)]
const WAIT = CODES.filter((entry) => entry.active && entry.kind === 'OFF_STANDARD')

const route = (n: number, over: Partial<Route> & Pick<Route, 'code' | 'kind' | 'labelIt' | 'labelEn'>): Route => ({
  id: uid('4545', n),
  siteId: SITE_ID,
  labelI18n: {},
  icon: null,
  colour: null,
  codeListed: true,
  responder: { kind: 'TEAM_LEADERS', team: null, members: 3 },
  escalateAfterMinutes: null,
  waitingCode: null,
  sortOrder: n * 10,
  active: true,
  version: 1,
  usedCount: 0,
  openCount: 0,
  ...over,
})
const asTeam = (entry: SiteTeam, members: number) => ({ kind: 'TEAM' as const, team: { id: entry.id, code: entry.code, name: entry.name, active: true }, members })
const waiting = (codeName: string) => {
  const found = CODES.find((entry) => entry.code === codeName)!
  return { id: found.id, code: found.code, labelIt: found.labelIt, labelEn: found.labelEn, active: found.active }
}
const ROUTES: Route[] = [
  route(1, { code: 'MACHINE_STOP', kind: 'MACHINE', labelIt: 'Macchina ferma', labelEn: 'Machine stopped', icon: 'alert', colour: '#e5484d', responder: asTeam(TEAMS[1]!, 3), escalateAfterMinutes: 5, waitingCode: waiting('WAIT_HELP'), usedCount: 31, openCount: 1 }),
  route(2, { code: 'MATERIAL_SHORT', kind: 'MATERIAL', labelIt: 'Manca materiale', labelEn: 'Material short', icon: 'package', colour: '#b87503', responder: asTeam(TEAMS[2]!, 4), escalateAfterMinutes: 10, waitingCode: waiting('WAIT_HELP'), usedCount: 58, openCount: 2 }),
  route(3, { code: 'QUALITY_DOUBT', kind: 'QUALITY', labelIt: 'Dubbio qualità', labelEn: 'Quality doubt', icon: 'shield', colour: '#7400bc', responder: asTeam(TEAMS[3]!, 2), usedCount: 12 }),
  route(4, { code: 'TEAM_LEADER', kind: 'SUPERVISOR', labelIt: 'Caposquadra', labelEn: 'Team leader', escalateAfterMinutes: 5, usedCount: 20 }),
  route(5, { code: 'RECUT', kind: 'MATERIAL', labelIt: 'Ritaglio', labelEn: 'Recut needed', active: false, responder: { kind: 'TEAM', team: { id: uid('4343', 9), code: 'TAG', name: 'Taglio (vecchia)', active: false }, members: 0 }, usedCount: 4 }),
]
const HELP: HelpCode[] = [
  ...ROUTES.map((entry, index) => ({ id: uid('4646', index + 1), code: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn })),
  { id: uid('4646', 9), code: 'NEEDLE_BREAK', labelIt: 'Ago rotto', labelEn: 'Needle broken' },
]

interface RoutingCase {
  role: Role
  page: FloorRulesModel
  editor: RoutingModel
}

function editor(over: Partial<RoutingModel> = {}): RoutingModel {
  return { site: { code: WORKER_SITE.site.code, name: WORKER_SITE.site.name }, load: { status: 'ready' }, routes: ROUTES, canManage: true, teams: TEAMS, codes: WAIT, helpCodes: HELP, marks: {}, notice: null, busy: false, dialog: null, changedElsewhere: false, ...over }
}
const routingCase = (role: Role, over: Partial<RoutingModel> = {}, page: Partial<FloorRulesModel> = {}): RoutingCase => ({ role, page: base(role, WORKER_SITE, page, 'calls').model, editor: editor(over) })

function RoutingDesign({ model }: { model: RoutingCase }) {
  return inShell(createElement(FloorRulesView, { model: model.page, routing: createElement(RoutingView, { model: model.editor }) }), model.role)
}

export const designScreen = defineDesignScreen<RoutingCase>({
  screen: 'SCR-074-calls',
  title: 'Help-call routing (Production › Settings › Floor rules & codes)',
  view: RoutingDesign,
  cases: [
    { id: 'routing', label: 'Production manager: type → group, members, escalate after, waiting books to, on/off', model: routingCase('production'), note: 'RECUT is off and its team archived: shown, never silently re-routed.' },
    { id: 'saving', label: 'Saved per cell: saving, refused (an archived team), escalation out of range', model: routingCase('production', { marks: { [markKey(uid('4545', 1), 'team')]: { state: 'saving' }, [markKey(uid('4545', 2), 'team')]: { state: 'refused', problem: 'fr.refusal.TEAM_NOT_ACTIVE' }, [markKey(uid('4545', 4), 'escalate')]: { state: 'refused', problem: 'fr.route.escalateRange' } } }) },
    { id: 'selected', label: 'Rows selected: Switch 2 off · Switch 2 on', model: routingCase('production', { selected: [uid('4545', 3), uid('4545', 5)] }) },
    { id: 'new', label: 'New type: a help-call reason not yet a type, its kind, the group, escalation', model: routingCase('production', { dialog: { kind: 'new', draft: { code: 'NEEDLE_BREAK', kind: 'MACHINE', teamId: TEAMS[1]!.id, escalate: 5 }, problem: null } }) },
    { id: 'new-refused', label: 'New type refused: not an active help-call reason (in words)', model: routingCase('production', { dialog: { kind: 'new', draft: { code: 'NEEDLE_BREAK', kind: 'MACHINE', teamId: '', escalate: '' }, problem: 'fr.refusal.CODE_NOT_LISTED' } }) },
    { id: 'no-codes', label: 'Every help-call reason is a type already: New type held, with the way to Reason codes', model: routingCase('production', { helpCodes: HELP.slice(0, ROUTES.length) }) },
    { id: 'no-people', label: 'A manager without people.view: the group shows as text, said why', model: routingCase('production', { teams: null }) },
    { id: 'supervisor', label: 'Floor supervisor: looks, changes nothing', model: routingCase('supervisor', { canManage: false }) },
    { id: 'empty', label: 'No type at this site: Add the first type', model: routingCase('production', { routes: [] }) },
    { id: 'keys', label: 'The keys (the footer’s information icon)', model: routingCase('production', { dialog: { kind: 'keys' } }) },
    { id: 'loading', label: 'Loading', model: routingCase('production', { load: { status: 'loading' }, routes: null }) },
    { id: 'error', label: 'The read failed: in words, Try again', model: routingCase('production', { load: { status: 'error', problem: 'fr.problem.offline' }, routes: null }) },
    { id: 'no-access', label: 'A role without production.calls.view: the tab says so', model: routingCase('supervisor', {}, { can: { view: true, manage: false, reasons: true, privacy: false, offstd: true, offstdManage: false, calls: false, callsManage: false, people: false, cost: false } }) },
  ],
})
