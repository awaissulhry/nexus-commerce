import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANIES, inShell, NOW, PREFIX } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { CompanyLanguage, LanguagesViewModel } from './model'
import { LanguagesView } from './view/LanguagesView'

/** SCR-016 Languages & formats with the two Demo companies, made-up people and floor workers. */

const companies: CompanyLanguage[] = COMPANIES.map((company, index) => ({
  id: company.id,
  code: company.code,
  legalName: company.legalName,
  locale: index === 0 ? 'it' : 'en',
  timezone: company.timezone,
  status: company.status,
  version: company.version,
  sites: company.sites.map((site) => ({ id: site.id, name: site.name, kind: site.kind, timezone: index === 1 ? 'Europe/London' : site.timezone, status: site.status })),
}))
const people = loaded([...Array.from({ length: 5 }, () => ({ locale: 'it' })), { locale: 'en' }, { locale: 'en' }])
const workers = loaded([...Array.from({ length: 9 }, () => ({ locale: 'it' })), { locale: 'ro' }, { locale: 'ro' }, { locale: 'sq' }, { locale: 'ur' }])

const base = (over: Partial<LanguagesViewModel> = {}): LanguagesViewModel => ({
  prefix: PREFIX,
  companies: loaded(companies),
  people,
  workers,
  completeness: { it: 100, en: 100 },
  can: { manage: true },
  asOf: NOW,
  ...over,
})

function LanguagesDesign({ model }: { model: LanguagesViewModel }) {
  return inShell('/admin/languages', createElement(LanguagesView, { model }))
}

export const designScreen = defineDesignScreen<LanguagesViewModel>({
  screen: 'SCR-016',
  title: 'Languages & formats',
  view: LanguagesDesign,
  cases: [
    { id: 'normal', label: 'Languages, formats, zones and the floor', model: base(), note: 'The Esempio site keeps another zone; three floor languages are not on the floor screens yet.' },
    { id: 'editing', label: 'A company\'s language changed, not saved', model: base({ draft: { [companies[0]!.id]: 'en' } }), note: 'The EditModeBar holds the change; ⌘S saves it.' },
    { id: 'saved', label: 'Saved', model: base({ notice: { key: 'langs.done.saved', tone: 'success', params: { count: 1 } } }) },
    { id: 'conflict', label: 'Someone changed a company meanwhile', model: base({ notice: { key: 'langs.problem.conflict', tone: 'warning', params: { count: 0 } } }) },
    { id: 'read-only', label: 'Without the right to change companies', model: base({ can: { manage: false } }) },
    { id: 'no-people-rights', label: 'Without the right to see people and workers', model: base({ people: null, workers: null }), note: 'The counts and the floor section are absent, not locked.' },
    { id: 'loading', label: 'Loading', model: base({ companies: loading(), people: loading(), workers: loading(), asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: base({ companies: failed('problem.unavailable'), workers: failed('problem.unavailable'), asOf: null }) },
    { id: 'no-company', label: 'No company yet', model: base({ companies: loaded([]) }) },
  ],
})
