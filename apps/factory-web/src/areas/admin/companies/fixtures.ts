import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANIES, inShell, NOW, panels, PREFIX, SITES } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import { companyDraft, type CompaniesViewModel, type CompanyRecordModel } from './model'
import { CompaniesView } from './view/CompaniesView'
import { CompanyRecordView } from './view/CompanyRecordView'

/**
 * SCR-008 Companies & sites (the tree) and the Company record, with made-up companies ("Demo", "Esempio"), invented
 * VAT numbers and example.com PEC addresses. Each case is one state the Owner reviews.
 */

type Case = { page: 'list'; model: CompaniesViewModel } | { page: 'company'; model: CompanyRecordModel; dock?: boolean }

const CAN = { manageCompanies: true, viewSites: true, manageSites: true }
const list = (over: Partial<CompaniesViewModel> = {}): Case => ({
  page: 'list',
  model: { prefix: PREFIX, companies: loaded(COMPANIES), asOf: NOW, can: CAN, query: '', showArchived: false, collapsed: [], page: 1, ...over },
})
const record = (over: Partial<CompanyRecordModel> = {}, dock = false): Case => ({
  page: 'company',
  dock,
  model: { prefix: PREFIX, tab: 'legal', company: COMPANIES[0]!, sites: loaded(COMPANIES[0]!.sites), can: CAN, ...over },
})
const esempio = COMPANIES[1]!

function CompaniesDesign({ model }: { model: Case }) {
  if (model.page === 'list') return inShell('/admin/companies', createElement(CompaniesView, { model: model.model }))
  const company = model.model.company
  const panel = company ? panels({ type: 'Company', id: company.id, companyId: company.id }, company.legalName) : null
  return inShell(`/admin/companies/${company?.id ?? 'x'}`, createElement(CompanyRecordView, { model: { ...model.model, dockOpen: model.dock }, panels: panel }))
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-008',
  title: 'Companies & sites, and the Company record',
  view: CompaniesDesign,
  cases: [
    { id: 'tree', label: 'The tree: companies and their sites', model: list(), note: 'Esempio cannot issue invoices yet: the banner says what is missing and Fix opens Legal & tax.' },
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
    { id: 'record-activity', label: 'Company: Activity (record panels)', model: record({ tab: 'activity' }) },
    { id: 'record-dock', label: 'Company: thread beside Legal & tax (≥ 1280 px, ⌘J)', model: record({}, true), note: 'Owner O1: wide screens only; narrower, the button opens Activity.' },
    { id: 'record-archive', label: 'Company: archive held while a site is active', model: record({ archiving: true }) },
    { id: 'record-archive-ok', label: 'Company: archive (no active site)', model: record({ archiving: true, company: esempio, sites: loaded(SITES.filter((site) => site.companyId === esempio.id).map((site) => ({ ...site, status: 'ARCHIVED' as const }))) }) },
    { id: 'record-loading', label: 'Company: loading', model: record({ company: null, sites: loading() }) },
    { id: 'record-not-found', label: 'Company: not found', model: record({ company: null, problem: 'problem.notFound', sites: failed('problem.notFound') }) },
  ],
})
