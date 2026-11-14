import { createElement } from 'react'
import { RULE_KINDS } from '@nexus/factory-domain/alerts/kinds'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BUILT, NOW, OFFICE_ROLES, OTIF_VERSIONS, PREFIX, fileOf, inShell, recordFor, valueOf, versionOf, type Role } from '../demo/fixtures'
import { DEFAULT_KPI_ADDRESS, draftOf, formProblems, kpisCanOf, type KpiAddress } from '../model'
import { KpiView, type KpiModel } from '../view/KpiView'

/**
 * SCR-470 — a KPI (design home.kpis rec:KPI: Definition, Where used, History; Targets is W3 and not drawn), with made-up data
 * only: On-time in full for the owner (a draft waiting, three uses, three versions compared), the same for a planner (read
 * only: "New version" held with why), a margin KPI without the margin rights, a version naming other facts than its
 * calculation, a KPI not installed, a withdrawn one, the period read per week, the owner's version form (new, problems,
 * fixing the facts, refused), the confirmations (put in force, delete the draft, withdraw), a done banner, a stale value,
 * nothing reading it, one version only, loading, a failed read, a KPI that does not exist and no permission.
 */

interface Case {
  readonly role: Role
  readonly model: KpiModel
}

const OWNER = kpisCanOf(['home.kpis.view', 'home.kpis.manage', 'roles.view'])
const PLANNER = kpisCanOf(['home.kpis.view'])

const kpi = (key: string, role: Role, change: Partial<KpiModel> = {}, address: Partial<KpiAddress> = {}): Case => ({
  role,
  model: {
    can: role === 'owner' ? OWNER : role === 'planner' ? PLANNER : kpisCanOf(['home.view']),
    prefix: PREFIX,
    key,
    address: { ...DEFAULT_KPI_ADDRESS, ...address },
    record: change.record ?? { value: recordFor(key, role === 'none' ? 'owner' : role), problem: null },
    built: BUILT,
    withCompany: true,
    ruleKinds: RULE_KINDS,
    now: NOW,
    roles: { value: OFFICE_ROLES, problem: null },
    ...change,
  },
})

function KpiDesign({ model }: { model: Case }) {
  return inShell('/home/kpis', createElement(KpiView, { model: model.model }), model.role)
}

const output = recordFor('production.output')
const outputBase = output.versions[0]!
const newDraft = draftOf(outputBase, 'new')
const margin = recordFor('sales.order_margin')
const marginBase = margin.versions[0]!
const otifDraft = OTIF_VERSIONS[0]!
const brokenDraft = { ...draftOf(otifDraft, 'edit'), nameEn: '', definitionIt: '' }
const outputOne = recordFor('production.output', 'owner', { versions: [versionOf(fileOf('production.output'), 1, 'ACTIVE')] })

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-470',
  title: 'A KPI (Home › Insights › KPI library)',
  view: KpiDesign,
  cases: [
    {
      id: 'owner',
      label: 'Owner — On-time in full: Definition',
      model: kpi('delivery.otif', 'owner'),
      note: 'In words (definition, formula, unit, rights, owner, period, records that open their lists, facts it reads, period rules) beside Now: November’s value, the change on October (never coloured good or bad), 12 months as a line and a table, as of 10:05, Open the records behind it. A banner: draft version 3 waits — Edit draft · Put in force · Delete draft.',
    },
    { id: 'used-in', label: 'Owner — Where used', model: kpi('delivery.otif', 'owner', {}, { tab: 'used-in' }), note: 'The owner’s group dashboard (no page yet: said without a door), the Late orders report and the alert rule open their pages.' },
    { id: 'history', label: 'Owner — History (v2 against v3)', model: kpi('delivery.otif', 'owner', {}, { tab: 'history' }), note: 'Written, put in force, superseded — who and when, what changed; the draft against the version in force, field by field, both languages of the definition.' },
    { id: 'history-pick', label: 'History — v1 against v2', model: kpi('delivery.otif', 'owner', {}, { tab: 'history', compare: [1, 2] }), note: 'The pair lives in the address (`?compare=1-2`): name and definition changed.' },
    { id: 'history-one', label: 'History — one version only', model: kpi('production.output', 'owner', { record: { value: outputOne, problem: null } }, { tab: 'history' }) },
    {
      id: 'planner',
      label: 'Planner — read only',
      model: kpi('delivery.otif', 'planner'),
      note: '"New version" is held: "Changing a KPI is the owner’s". The draft banner says the owner puts it in force; its buttons are held with the same words.',
    },
    { id: 'needs-grain', label: 'Planner — a margin KPI', model: kpi('sales.margin_actual', 'planner'), note: 'The definition is readable; the value says "Reads lists outside your role" (no costing list): no sparkline, no table, no records link.' },
    { id: 'differs', label: 'Owner — a version naming other facts', model: kpi('sales.order_margin', 'owner'), note: 'Its version names orders.value; its calculation reads the margin and the value of lines with a cost. A new version written here names exactly those.' },
    { id: 'not-installed', label: 'Owner — not installed yet', model: kpi('production.leather_yield', 'owner'), note: 'The standard words are shown; Install the standard KPIs (one confirmation installs every one the company lacks).' },
    { id: 'withdrawn', label: 'Withdrawn, no calculation', model: kpi('sales.quotes_sent', 'owner'), note: 'Quotes sent: withdrawn on 20/10/2026; its fact is not built ("not built yet"); no value, no records link.' },
    { id: 'week', label: 'Read per week', model: kpi('delivery.otif', 'owner', { record: { value: recordFor('delivery.otif', 'owner', { value: valueOf(fileOf('delivery.otif'), { kind: 'WEEK' }) }), problem: null } }, { period: 'WEEK' }), note: 'The period kind is in the address (`?period=WEEK`): 12 ISO weeks.' },
    {
      id: 'stale',
      label: 'Value not fresh',
      model: kpi('production.scrap_rate', 'owner', { record: { value: recordFor('production.scrap_rate', 'owner', { value: valueOf(fileOf('production.scrap_rate'), { stale: true, missingDays: 2, asOf: '2026-11-14T04:05:00.000Z' }) }), problem: null } }),
      note: 'As of 05:05: the facts are more than 3 hours old; 2 days of the week are not built yet.',
    },
    { id: 'used-in-empty', label: 'Nothing reads it', model: kpi('production.wip_age_days', 'owner', {}, { tab: 'used-in' }) },
    {
      id: 'form-new',
      label: 'Owner — new version form',
      model: kpi('production.output', 'owner', { form: { mode: 'new', base: outputBase, draft: newDraft, problems: formProblems(newDraft, outputBase, output.calculation, 'new'), shown: false, busy: false, refusal: null } }),
      note: 'Starts from version 1 in force. Name, meaning and formula in Italian and English, records, owner role (the owner sees roles); the facts, unit and rights are its calculation’s, said in one line; What changed is required.',
    },
    {
      id: 'form-problems',
      label: 'Edit the draft — problems shown',
      model: kpi('delivery.otif', 'owner', { form: { mode: 'edit', base: otifDraft, draft: brokenDraft, problems: formProblems(brokenDraft, otifDraft, recordFor('delivery.otif').calculation, 'edit'), shown: true, busy: false, refusal: null } }),
    },
    {
      id: 'form-fixes',
      label: 'New version fixing the facts',
      model: kpi('sales.order_margin', 'owner', { form: { mode: 'new', base: marginBase, draft: { ...draftOf(marginBase, 'new'), changeNote: 'Name the facts the calculation reads.' }, problems: {}, shown: false, busy: false, refusal: null } }),
      note: 'The banner says the new version names its calculation’s facts, so it can be put in force.',
    },
    {
      id: 'form-refused',
      label: 'Save refused',
      model: kpi('production.output', 'owner', { form: { mode: 'new', base: outputBase, draft: { ...newDraft, changeNote: 'Wording.' }, problems: {}, shown: true, busy: false, refusal: 'refusal.stale' } }),
    },
    { id: 'confirm-activate', label: 'Put version 3 in force?', model: kpi('delivery.otif', 'owner', { confirm: 'activate' }) },
    { id: 'confirm-delete', label: 'Delete the draft?', model: kpi('delivery.otif', 'owner', { confirm: 'delete' }) },
    { id: 'confirm-retire', label: 'Withdraw the KPI?', model: kpi('delivery.otif', 'owner', { confirm: 'retire' }), note: 'Says how many uses go with it and that version 2 stays to explain old numbers.' },
    { id: 'done', label: 'Version put in force', model: kpi('delivery.otif', 'owner', { result: { tone: 'success', key: 'done.activated', params: { version: 3 } } }) },
    { id: 'refused', label: 'Put in force refused', model: kpi('delivery.otif', 'owner', { result: { tone: 'danger', key: 'refusal.MEASURES_DIFFER' } }) },
    { id: 'loading', label: 'Loading', model: kpi('delivery.otif', 'owner', { record: { value: null, problem: null } }) },
    { id: 'error', label: 'The KPI could not be read', model: kpi('delivery.otif', 'owner', { record: { value: null, problem: 'error.offline' } }) },
    { id: 'not-found', label: 'No such KPI', model: kpi('sales.unknown', 'owner', { record: { value: null, problem: 'error.notFound' } }) },
    { id: 'no-permission', label: 'No permission', model: kpi('delivery.otif', 'none'), note: 'Without home.kpis.view the page says so and asks the API nothing.' },
  ],
})
