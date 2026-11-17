import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { defineExportSource, partyTerm } from '../../../platform/exports/source'
import { listProjects, PROJECT_SORTS, PROJECT_TARGETS, PROJECT_VIEWS, type ProjectListQuery, type ProjectListRow } from './list'

/**
 * Products › Development › Projects (`/products/projects`; threads plan TH-5, B-TH-070, PROJ.list-F07): the list as it shows, through
 * its own read (threads.read over each project's company and outside company: a person limited to brand A exports brand A's and
 * office-only projects only — screen = file, W30). The address is the page's: `?view=` (MINE, ACTIVE, ON_HOLD, CLOSED, ALL),
 * `?company=`, `?party=` (or `?outside=none`), `?lead=`, `?season=`, `?target=`, `?q=`, `?sort=`. The columns are the list's; no
 * money, no count of anyone's messages (only the reader's own new marks stay on the screen, never in a file).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WORDS = {
  it: { 'status.ACTIVE': 'Attivo', 'status.ON_HOLD': 'In pausa', 'status.CLOSED': 'Chiuso', officeOnly: 'Solo interno' },
  en: { 'status.ACTIVE': 'Active', 'status.ON_HOLD': 'On hold', 'status.CLOSED': 'Closed', officeOnly: 'Office only' },
} as const

const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | undefined => ((allowed as readonly string[]).includes(value ?? '') ? (value as T) : undefined)

export const projectsExport = defineExportSource<ProjectListQuery, ProjectListRow>({
  listKey: 'products.projects',
  permission: THREADS_READ,
  page: '/products/projects',
  query(address) {
    const company = address.get('company')
    const lead = address.get('lead')
    const season = address.get('season')?.trim()
    const q = (address.get('q') ?? '').trim().slice(0, 100)
    const party = partyTerm(address)
    return {
      view: pick(address.get('view'), PROJECT_VIEWS) ?? 'ALL',
      ...(company && UUID.test(company) ? { companyId: company } : {}),
      ...(address.get('outside') === 'none' ? { outside: 'none' as const } : party ? { partyId: party } : {}),
      ...(lead && UUID.test(lead) ? { leadId: lead } : {}),
      ...(season ? { seasonCode: season.slice(0, 20) } : {}),
      ...(pick(address.get('target'), PROJECT_TARGETS) ? { target: pick(address.get('target'), PROJECT_TARGETS)! } : {}),
      ...(q ? { q } : {}),
      ...(pick(address.get('sort'), PROJECT_SORTS) ? { sort: pick(address.get('sort'), PROJECT_SORTS)! } : {}),
    }
  },
  async read(caller, query, cursor, limit) {
    const page = await listProjects(caller, { ...query, ...(cursor ? { cursor } : {}), limit: Math.min(Math.max(limit, 1), 200) })
    return { rows: page.rows, next: page.next }
  },
  idOf: (row) => row.id,
  columns: {
    number: { value: (row) => row.number },
    name: { value: (row) => row.name },
    outsideCompany: { value: (row, words) => row.party?.name ?? words('officeOnly') },
    lead: { value: (row) => row.lead.name },
    status: { value: (row, words) => words(`status.${row.status}`) },
    targetDate: { value: (row) => row.targetDate },
    season: { value: (row) => row.seasonCode },
    lastMessage: { value: (row) => row.lastMessageAt },
    linked: { value: (row) => row.linked },
  },
  words: WORDS,
})
