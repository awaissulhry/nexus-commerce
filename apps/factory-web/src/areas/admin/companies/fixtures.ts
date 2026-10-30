import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANIES, inShell, NOW, panels, PREFIX, SITES } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { Calendar, CalendarDayRow } from '../../planning/settings/api'
import type { CompanyCalendarsModel } from './calendars/model'
import { CompanyCalendarsView } from './calendars/view/CompanyCalendarsView'
import { companyDraft, type CompaniesViewModel, type CompanyRecordModel } from './model'
import { CompaniesView } from './view/CompaniesView'
import { CompanyRecordView } from './view/CompanyRecordView'

/**
 * SCR-008 Companies & sites (the tree) and the Company record, with made-up companies ("Demo", "Esempio"), invented
 * VAT numbers and example.com PEC addresses. Each case is one state the Owner reviews.
 */

type Case = { page: 'list'; model: CompaniesViewModel } | { page: 'company'; model: CompanyRecordModel; dock?: boolean; calendars?: CompanyCalendarsModel }

const CAN = { manageCompanies: true, viewSites: true, manageSites: true, viewCalendars: true, manageCalendars: true }
const list = (over: Partial<CompaniesViewModel> = {}): Case => ({
  page: 'list',
  model: { prefix: PREFIX, companies: loaded(COMPANIES), asOf: NOW, can: CAN, currentCompanyId: COMPANIES[0]!.id, query: '', showArchived: false, collapsed: [], pages: 1, ...over },
})
const record = (over: Partial<CompanyRecordModel> = {}, dock = false): Case => ({
  page: 'company',
  dock,
  model: { prefix: PREFIX, tab: 'legal', company: COMPANIES[0]!, sites: loaded(COMPANIES[0]!.sites), can: CAN, ...over },
})
const esempio = COMPANIES[1]!

// ---- B-W2a-59: Company › Calendars › Working days and holidays (2027; made-up names and dates beside the national list) ----

const demo = COMPANIES[0]!
const calId = (n: number) => `0190f0e2-5959-7000-8000-${String(n).padStart(12, '0')}`
const CALENDAR: Calendar = {
  id: calId(1),
  scope: 'COMPANY',
  companyId: demo.id,
  siteId: null,
  lineId: null,
  workCentreId: null,
  partyId: null,
  owner: { code: demo.code, name: demo.legalName },
  name: `Calendario ${demo.code}`,
  workingWeekdays: [1, 2, 3, 4, 5],
  shiftPattern: { id: calId(900), code: 'UN-TURNO', name: 'Un turno 08:00–17:00', status: 'ACTIVE' },
  status: 'ACTIVE',
  exceptions: 26,
  version: 9,
  updatedAt: NOW,
}
let dayN = 100
const day = (date: string, kind: CalendarDayRow['kind'], name: string, holidaySet: string | null = null): CalendarDayRow => ({ id: calId(dayN++), date, kind, name, shiftPattern: null, note: null, holidaySet, version: 1, updatedAt: NOW })
const range = (from: number, to: number, month: string, name: string) => Array.from({ length: to - from + 1 }, (_, index) => day(`2027-${month}-${String(from + index).padStart(2, '0')}`, 'CLOSURE', name))
const NATIONAL: CalendarDayRow[] = [
  day('2027-01-01', 'HOLIDAY', 'Capodanno', 'IT'),
  day('2027-01-06', 'HOLIDAY', 'Epifania', 'IT'),
  day('2027-03-28', 'HOLIDAY', 'Pasqua', 'IT'),
  day('2027-03-29', 'HOLIDAY', "Lunedì dell'Angelo", 'IT'),
  day('2027-04-25', 'HOLIDAY', 'Festa della Liberazione', 'IT'),
  day('2027-05-01', 'HOLIDAY', 'Festa del Lavoro', 'IT'),
  day('2027-06-02', 'HOLIDAY', 'Festa della Repubblica', 'IT'),
  day('2027-08-15', 'HOLIDAY', 'Ferragosto', 'IT'),
  day('2027-10-04', 'HOLIDAY', "San Francesco d'Assisi", 'IT'),
  day('2027-11-01', 'HOLIDAY', 'Ognissanti', 'IT'),
  day('2027-12-08', 'HOLIDAY', 'Immacolata Concezione', 'IT'),
  day('2027-12-25', 'HOLIDAY', 'Natale', 'IT'),
  day('2027-12-26', 'HOLIDAY', 'Santo Stefano', 'IT'),
]
const DAYS_2027: CalendarDayRow[] = [
  ...NATIONAL,
  day('2027-06-24', 'HOLIDAY', 'Santo patrono di Demoville'),
  ...range(9, 14, '08', 'Chiusura estiva'),
  ...range(16, 20, '08', 'Chiusura estiva'),
  ...range(27, 31, '12', 'Chiusura natalizia'),
]
const SITE_DAYS: CompanyCalendarsModel['sites'] = [
  { site: { id: SITES[0]!.id, code: SITES[0]!.code, name: SITES[0]!.name }, calendar: null, days: [] },
  // The warehouse counts its stock on the Immacolata: it opens that day on its own calendar.
  { site: { id: SITES[1]!.id, code: SITES[1]!.code, name: SITES[1]!.name }, calendar: { id: calId(2), version: 3 }, days: [{ date: '2027-12-08', kind: 'WORKING', name: 'Inventario di fine anno' }] },
]
const calendars = (over: Partial<CompanyCalendarsModel> = {}): CompanyCalendarsModel => ({
  prefix: PREFIX,
  company: { id: demo.id, legalName: demo.legalName, timezone: demo.timezone },
  year: 2027,
  today: '2026-10-30',
  load: { status: 'ready' },
  calendar: CALENDAR,
  days: DAYS_2027,
  working: null,
  patterns: [],
  sites: SITE_DAYS,
  canManage: true,
  busy: null,
  notice: null,
  changedElsewhere: false,
  ...over,
})
const onCalendars = (over: Partial<CompanyCalendarsModel> = {}, can: Partial<typeof CAN> = {}): Case => ({ ...record({ tab: 'calendars', can: { ...CAN, ...can } }), calendars: calendars(over) } as Case)

function CompaniesDesign({ model }: { model: Case }) {
  if (model.page === 'list') return inShell('/admin/companies', createElement(CompaniesView, { model: model.model }))
  const company = model.model.company
  const panel = company ? panels({ type: 'Company', id: company.id, companyId: company.id }, company.legalName) : null
  const tab = model.calendars ? createElement(CompanyCalendarsView, { model: model.calendars }) : null
  return inShell(`/admin/companies/${company?.id ?? 'x'}`, createElement(CompanyRecordView, { model: { ...model.model, dockOpen: model.dock }, panels: panel, calendars: tab }))
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-008',
  title: 'Companies & sites, and the Company record',
  view: CompaniesDesign,
  cases: [
    { id: 'tree', label: 'The tree: companies and their sites', model: list(), note: 'Esempio cannot issue invoices yet: the banner says what is missing and Fix opens Legal & tax.' },
    {
      id: 'holidays-entry',
      label: 'More ⋯ › Holidays for all sites',
      model: list(),
      note: 'B-W2a-59: the ⋯ menu beside New site opens the company calendar (Company › Calendars), which every site inherits. Without calendars.view the menu is not there.',
    },
    {
      id: 'no-stations',
      label: 'Every company ready; a plant without stations',
      model: list({ companies: loaded(COMPANIES.map((company) => ({ ...company, invoicing: { ready: true, issues: [] } }))) }),
    },
    { id: 'collapsed', label: 'A company folded (← / →)', model: list({ collapsed: [COMPANIES[0]!.id] }) },
    { id: 'search', label: 'Search finds a site', model: list({ query: 'magazzino' }) },
    { id: 'no-match', label: 'Search finds nothing', model: list({ query: 'zzz' }) },
    { id: 'loading', label: 'Loading', model: list({ companies: loading(), asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: list({ companies: failed('problem.unavailable'), asOf: null }) },
    { id: 'empty', label: 'First day: no company yet', model: list({ companies: loaded([]) }) },
    { id: 'read-only', label: 'A viewer (no manage rights): held actions', model: list({ can: { manageCompanies: false, viewSites: true, manageSites: false } }) },
    { id: 'new-company', label: 'New company', model: list({ dialog: 'new-company' }), note: 'The code is suggested from the name; ⌘Enter creates; the company opens on Legal & tax.' },
    { id: 'new-company-refused', label: 'New company: code taken', model: list({ dialog: 'new-company', dialogProblem: 'problem.conflict' }) },
    { id: 'new-site', label: 'New site', model: list({ dialog: 'new-site' }) },
    { id: 'record-legal', label: 'Company: Legal & tax', model: record(), note: 'Edit a field and the EditModeBar appears (⌘S saves, Discard puts it back).' },
    {
      id: 'record-editing',
      label: 'Company: unsaved changes with a problem',
      model: record({ draft: { ...companyDraft(COMPANIES[0]!), sdiReceiverCode: 'AB12', tradeName: 'Officina Demo Nord' } }),
      note: 'Save is held with its reason until the SDI code has 7 characters.',
    },
    { id: 'record-not-ready', label: 'Company: cannot issue invoices yet', model: record({ company: esempio, sites: loaded(esempio.sites) }), note: 'Each missing item is a link to its field.' },
    { id: 'record-read-only', label: 'Company: read-only (no companies.manage)', model: record({ can: { manageCompanies: false, viewSites: true, manageSites: false } }) },
    { id: 'record-saved', label: 'Company: saved', model: record({ notice: { key: 'company.saved', tone: 'success' } }) },
    { id: 'record-conflict', label: 'Company: changed by someone else', model: record({ notice: { key: 'problem.conflict', tone: 'warning' } }), note: 'The record is read again; nothing is overwritten.' },
    { id: 'record-sites', label: 'Company: Sites', model: record({ tab: 'sites' }) },
    { id: 'record-sites-empty', label: 'Company: no site yet', model: record({ tab: 'sites', company: esempio, sites: loaded([]) }) },
    { id: 'record-defaults', label: 'Company: Defaults', model: record({ tab: 'defaults' }) },
    {
      id: 'record-calendars',
      label: 'Company: Calendars — working days and holidays (2027)',
      model: onCalendars(),
      note: 'The year every site inherits: the Italian holidays, the patron saint, the August and Christmas closures. The warehouse DS1 opens on the Immacolata on its own calendar ("All sites but DS1 (open)"). Drag across days or Add holiday; ⌘S saves the working week.',
    },
    { id: 'record-calendars-loaded', label: 'Company: Italian holidays 2027 loaded', model: onCalendars({ notice: { tone: 'success', key: 'acal.done.loadedSkipped', params: { count: 12, skipped: 1, year: 2027 } } }), note: 'Dates the calendar already had are kept as they are.' },
    { id: 'record-calendars-add', label: 'Company: Add a holiday', model: onCalendars({ dialog: { from: '2027-06-24', to: '', name: 'Santo patrono di Demoville', kind: 'HOLIDAY', conflict: [], problem: null } }) },
    {
      id: 'record-calendars-conflict',
      label: 'Company: Add a closure over a day already set',
      model: onCalendars({ dialog: { from: '2027-08-09', to: '2027-08-20', name: 'Chiusura estiva', kind: 'CLOSURE', conflict: ['2027-08-15'], problem: 'acal.add.conflict' } }),
      note: 'Ferragosto is already set: the dialog names it and Add becomes "Replace 1 day".',
    },
    { id: 'record-calendars-week', label: 'Company: working week edited (save bar)', model: onCalendars({ weekDraft: [1, 2, 3, 4, 5, 6] }), note: 'Saturday added: the bar saves with ⌘S, Discard puts it back.' },
    { id: 'record-calendars-none', label: 'Company: no company calendar yet', model: onCalendars({ calendar: null, days: [], sites: SITE_DAYS.map((entry) => ({ ...entry, calendar: null, days: [] })) }), note: 'Said, never hidden: sites use Monday to Friday, one shift, until it is set up.' },
    {
      id: 'record-calendars-read-only',
      label: 'Company: Calendars read-only (no calendars.manage)',
      model: onCalendars({ canManage: false }, { manageCalendars: false }),
      note: 'Everything is drawn; Add holiday, Load and Remove stay focusable and say which right they need.',
    },
    { id: 'record-calendars-refused', label: 'Company: a site-limited grant is refused', model: onCalendars({ notice: { tone: 'danger', key: 'acal.problem.wholeCompany' } }) },
    { id: 'record-calendars-elsewhere', label: 'Company: changed by someone else', model: onCalendars({ changedElsewhere: true }) },
    { id: 'record-calendars-loading', label: 'Company: Calendars loading', model: onCalendars({ load: { status: 'loading' } }) },
    { id: 'record-calendars-error', label: 'Company: Calendars read failed', model: onCalendars({ load: { status: 'error', problem: 'ps.problem.offline' } }), note: 'A failed read is never drawn as an empty calendar: the reason and Try again; the other tabs keep working.' },
    { id: 'record-activity', label: 'Company: Activity (record panels)', model: record({ tab: 'activity' }) },
    { id: 'record-dock', label: 'Company: thread beside Legal & tax (≥ 1280 px, ⌘J)', model: record({}, true), note: 'Owner O1: wide screens only; narrower, the button opens Activity.' },
    { id: 'record-archive', label: 'Company: archive held while a site is active', model: record({ archiving: true }) },
    { id: 'record-archive-ok', label: 'Company: archive (no active site)', model: record({ archiving: true, company: esempio, sites: loaded(SITES.filter((site) => site.companyId === esempio.id).map((site) => ({ ...site, status: 'ARCHIVED' as const }))) }) },
    { id: 'record-loading', label: 'Company: loading', model: record({ company: null, sites: loading() }) },
    { id: 'record-not-found', label: 'Company: not found', model: record({ company: null, problem: 'problem.notFound', sites: failed('problem.notFound') }) },
  ],
})
