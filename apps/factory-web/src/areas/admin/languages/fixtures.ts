import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANIES, inShell, NOW, PREFIX, SITES } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { CompanyLanguage, FloorSite, LanguagesViewModel } from './model'
import { LanguagesView } from './view/LanguagesView'

/** SCR-016 Languages & formats with the two Demo companies, made-up people and the sites' floor languages (made up). */

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

/**
 * B-W2a-41: the Nord plant offers Italiano, English and Română (its worker notice has those three and Shqip); the Sud
 * warehouse only Italiano (two workers of it read Română: not offered yet); the Esempio lab has no worker notice in force.
 */
const floorSite = (index: number, locales: string[], over: Partial<FloorSite> = {}): FloorSite => {
  const site = SITES[index]!
  const owner = COMPANIES.find((item) => item.id === site.companyId)!
  return {
    id: site.id,
    companyId: site.companyId,
    companyCode: owner.code,
    companyName: owner.legalName,
    code: site.code,
    name: site.name,
    status: 'ACTIVE',
    locales,
    version: site.version,
    workers: {},
    notice: { id: `00000000-0000-4000-8000-0000000016${String(index).padStart(2, '0')}`, label: '2026-10', locales: ['en', 'it', 'ro', 'sq'] },
    canManage: true,
    ...over,
  }
}
const floorSites: FloorSite[] = [
  floorSite(0, ['it', 'en', 'ro'], { workers: { it: 9, en: 1, ro: 2 } }),
  floorSite(1, ['it'], { workers: { it: 4, ro: 2 } }),
  floorSite(2, ['it', 'en'], { workers: { it: 3 }, notice: null }),
]

const base = (over: Partial<LanguagesViewModel> = {}): LanguagesViewModel => ({
  prefix: PREFIX,
  companies: loaded(companies),
  people,
  floor: loaded(floorSites),
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
    { id: 'normal', label: 'Languages, formats, zones and the floor', model: base(), note: 'The Esempio site keeps another zone; the Nord plant offers Română, which the floor screens do not speak yet; the Esempio lab has no worker notice in force.' },
    { id: 'editing', label: 'A company\'s language changed, not saved', model: base({ draft: { [companies[0]!.id]: 'en' } }), note: 'The EditModeBar holds the change; ⌘S saves it.' },
    { id: 'saved', label: 'Saved', model: base({ notice: { key: 'langs.done.saved', tone: 'success', params: { count: 1 } } }) },
    { id: 'conflict', label: 'Someone changed a company meanwhile', model: base({ notice: { key: 'langs.problem.conflict', tone: 'warning', params: { count: 0 } } }) },
    { id: 'read-only', label: 'Without the right to change companies', model: base({ can: { manage: false } }) },
    { id: 'no-people-rights', label: 'Without the right to see people and sites', model: base({ people: null, floor: null }), note: 'The counts and the floor section are absent, not locked.' },
    {
      id: 'floor-add',
      label: 'Floor languages: adding Shqip to the Sud warehouse',
      model: base({ floorDialog: { siteId: floorSites[1]!.id, action: 'add', code: 'sq' } }),
      note: 'The confirm says the floor screens show Italiano or English until their Shqip words exist. In the picker, العربية, 中文, اردو and বাংলা are held: the worker notice in force has no text in them.',
    },
    { id: 'floor-remove', label: 'Floor languages: removing English from the Esempio lab', model: base({ floorDialog: { siteId: floorSites[2]!.id, action: 'remove', code: 'en' } }) },
    {
      id: 'floor-refused',
      label: 'Floor languages: a removal refused, workers read it',
      model: base({ floorProblem: { siteId: floorSites[0]!.id, key: 'langs.floor.problem.workers', params: { language: 'Română', count: 2 } } }),
      note: 'Shown in the site\'s block in the page\'s words; the API\'s own message never reaches the screen.',
    },
    { id: 'floor-saved', label: 'Floor languages: a language added', model: base({ notice: { key: 'langs.floor.done.added', tone: 'success', params: { site: 'DEMO › Magazzino Demo Sud' } } }) },
    {
      id: 'floor-no-notice',
      label: 'Floor languages: no worker notice in force anywhere',
      model: base({ floor: loaded(floorSites.map((site) => ({ ...site, notice: null }))) }),
      note: '"Add a language" is held with the reason and a link to Admin › Privacy.',
    },
    {
      id: 'floor-no-right',
      label: 'Floor languages: without the right to change sites',
      model: base({ floor: loaded(floorSites.map((site) => ({ ...site, canManage: false }))) }),
      note: 'Every add and remove is held: "Needs the right: Manage sites, lines and stations".',
    },
    {
      id: 'floor-no-workers-right',
      label: 'Floor languages: without the right to see floor workers',
      model: base({ floor: loaded(floorSites.map((site) => ({ ...site, workers: null }))) }),
      note: 'No worker counts; the API still refuses removing a language workers read.',
    },
    { id: 'floor-no-site', label: 'Floor languages: no active site yet', model: base({ floor: loaded([]) }) },
    { id: 'floor-error', label: 'Floor languages: the read failed, the other sections keep working', model: base({ floor: failed('problem.unavailable') }) },
    { id: 'loading', label: 'Loading', model: base({ companies: loading(), people: loading(), floor: loading(), asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: base({ companies: failed('problem.unavailable'), floor: failed('problem.unavailable'), asOf: null }) },
    { id: 'no-company', label: 'No company yet', model: base({ companies: loaded([]) }) },
  ],
})
