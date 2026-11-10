import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANY_ID, NOW, PREFIX } from '../library/demo'
import { ACTIVE_ROWS, canOf, COUNTS, ROWS, STYLE_OPTIONS } from './demo'
import { groupDraftOf, NO_FILTERS } from './model'
import type { GroupFormModel, OptionsViewModel } from './view-model'
import { OptionsView } from './view/OptionsView'

/**
 * SCR-114 Options & rules (B-W2b-242; design products.options, workspace-list) — made-up data only (PLAN §3.1): an invented
 * factory's option groups (DEMO- codes). Role cases: the Owner (every right and grain), a product developer (the
 * production manager's template: keeps the library), sales (prices options, reads the library), quality (reads).
 */

const base: OptionsViewModel = {
  prefix: PREFIX,
  companyId: COMPANY_ID,
  can: canOf('owner'),
  filters: NO_FILTERS,
  rows: { items: ACTIVE_ROWS, problem: null, ignored: [] },
  counts: COUNTS,
  countsFailed: false,
  style: null,
  asOf: NOW,
  updates: 0,
  dismissed: [],
  notice: null,
  busy: false,
  newGroup: null,
}

const asRole = (role: 'developer' | 'sales' | 'quality'): OptionsViewModel => ({ ...base, can: canOf(role) })

const form = (extra: Partial<GroupFormModel> = {}, draft: Partial<GroupFormModel['draft']> = {}): GroupFormModel => ({
  mode: 'new',
  draft: { ...groupDraftOf(null, COMPANY_ID), ...draft },
  companies: [{ id: COMPANY_ID, name: 'Demo Factory S.r.l.' }],
  everyCompany: true,
  busy: false,
  problem: null,
  refused: [],
  messages: [],
  ...extra,
})

const outside = ACTIVE_ROWS.filter((row) => row.outsideCertificate > 0)

export const designScreen = defineDesignScreen<OptionsViewModel>({
  screen: 'SCR-114',
  title: 'Options & rules',
  view: OptionsView,
  cases: [
    { id: 'owner', label: 'Owner: the option groups', model: base, note: 'The tile is a saved filter; one notice Banner (the most serious) and "1 more notice"; Group is a real link to the record; Kind, Options (with how many take a garment outside its certificate), Min–max, Styles, Rules, Status.' },
    { id: 'developer', label: 'Product developer (production manager): keeps the library', model: asRole('developer') },
    { id: 'sales', label: 'Sales: prices options, reads the library', model: asRole('sales'), note: 'New option group held with the right that has it; Archive N held.' },
    { id: 'quality', label: 'Quality: reads', model: asRole('quality') },
    { id: 'notices-open', label: 'Every notice listed', model: { ...base, filters: { ...NO_FILTERS, kind: 'HUMP' }, rows: { ...base.rows, ignored: ['kind=HUMP'] }, noticesOpen: true }, note: 'The ignored filter first (warning, its action removes it), then the groups without options (warning), then the groups no style offers (info); the last two dismissed by their value.' },
    { id: 'ignored-filter', label: 'A filter the server could not apply', model: { ...base, filters: { ...NO_FILTERS, kind: 'HUMP' }, rows: { ...base.rows, ignored: ['kind=HUMP'] } }, note: 'Its chip says "Not applied"; the list shows every kind.' },
    { id: 'tile-outside', label: 'Tile: options outside the certificate (pressed)', model: { ...base, filters: { ...NO_FILTERS, outside: true }, rows: { ...base.rows, items: outside } }, note: 'The chip in the filter row; the tile\'s number is the list\'s total under it.' },
    { id: 'style-link', label: 'From a style: its options, option lines and steps', model: { ...base, filters: { ...NO_FILTERS, style: STYLE_OPTIONS.style.id }, style: { id: STYLE_OPTIONS.style.id, options: STYLE_OPTIONS, problem: null } }, note: 'The Style studio\'s ⋯ "Options & rules of this style": the grid narrowed to its groups, and under it the BOM lines and routing steps only for an option, per revision.' },
    { id: 'style-unread', label: 'From a style that could not be read', model: { ...base, filters: { ...NO_FILTERS, style: STYLE_OPTIONS.style.id }, style: { id: STYLE_OPTIONS.style.id, options: null, problem: 'problem.read.forbidden' } } },
    { id: 'selected', label: 'Two groups selected', model: { ...base, selected: [ROWS[0]!.id, ROWS[5]!.id] }, note: 'Restore 2 (held: none archived), Archive 2, Export 2.' },
    { id: 'archive-dialog', label: 'Archive 2 (one offered on styles)', model: { ...base, selected: [ROWS[0]!.id, ROWS[5]!.id], dialog: 'archive' } },
    { id: 'archived', label: 'Archived view', model: { ...base, filters: { ...NO_FILTERS, view: 'archived' }, rows: { ...base.rows, items: ROWS.filter((row) => row.status === 'ARCHIVED') } } },
    { id: 'all', label: 'Every group (active and archived)', model: { ...base, filters: { ...NO_FILTERS, view: 'all' }, rows: { ...base.rows, items: ROWS } } },
    { id: 'updates', label: 'Live changes waiting', model: { ...base, updates: 2 } },
    { id: 'result', label: 'After archiving', model: { ...base, notice: { key: 'notice.archived', tone: 'success', params: { count: 1 } } } },
    { id: 'new', label: 'New option group', model: { ...base, newGroup: form() } },
    { id: 'new-filled', label: 'New option group, filled (several choices, 0 to 2)', model: { ...base, newGroup: form({}, { code: 'DEMO-PATCH', name: 'Toppe in pelle', kind: 'MULTI', minPicks: '0', maxPicks: '2', description: 'Toppe di rinforzo a scelta' }) } },
    { id: 'new-problems', label: 'New option group: what to fix', model: { ...base, newGroup: form({}, { code: 'demo patch', name: 'Toppe', kind: 'SINGLE', minPicks: '2', maxPicks: '' }) }, note: 'The code has a space; a single choice takes at most 1 and at least 0 or 1; Create held with the count.' },
    { id: 'new-refused', label: 'New option group: code taken', model: { ...base, newGroup: form({ problem: 'problem.write.codeTaken', refused: ['code'], messages: ['The option group code DEMO-PERF is taken.'] }, { code: 'DEMO-PERF', name: 'Perforazione bis' }) } },
    { id: 'no-match', label: 'Nothing matches', model: { ...base, filters: { ...NO_FILTERS, q: 'zzz' }, rows: { ...base.rows, items: [] } } },
    { id: 'empty', label: 'No option groups yet', model: { ...base, rows: { ...base.rows, items: [] }, counts: { all: 0, outsideCertificate: 0 } } },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { ...base.rows, items: null }, counts: null, asOf: null }, note: 'The tile says "—" until counted.' },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { ...base.rows, items: null, problem: 'problem.read.unavailable' }, counts: null, countsFailed: true }, note: 'Never drawn as an empty list; the tile says "—" with "Couldn\'t count".' },
    { id: 'offline', label: 'Offline', model: { ...base, offline: true }, note: 'The rows stay readable with their time; New option group is held: changes wait until the connection is back.' },
    { id: 'no-permission', label: 'No access', model: { ...base, can: { ...canOf('quality'), view: false }, rows: { ...base.rows, items: null, problem: 'problem.read.forbidden' }, counts: null }, note: 'The page is absent from the Pages overlay; a direct address says who has access.' },
  ],
})
