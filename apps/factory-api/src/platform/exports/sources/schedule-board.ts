import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { ExportLocale } from '@nexus/factory-domain/views/exports'
import { officeContextOf } from '../../../modules/planning/access'
import { boardSheetRows, type BoardSheetRow } from '../../../modules/planning/schedule-log/sheet'
import { listSettings } from '../../../modules/planning/settings/settings'
import { defineExportSource } from '../source'

/**
 * Planning › Board as a sheet (B-W2b-329; PLN-154 "the board as XLSX"; design planning.board ⋯ "Export board (XLSX, W2b)"):
 * one row per bar of the board the person is looking at, in start order. The address is the board's (`/planning/board`):
 * `?site=` (a site of the screen's company the person plans, else the first by code), `?from=` `?to=` (days; default the
 * board's own: today and two weeks on), or `?version=<id>` for a published version (its bars as the floor was given them).
 * Read through the board's own read (planning.view over the site: modules/planning/schedule-log/sheet). Not paged. Per lane
 * and work order: no person, no money.
 */

interface Query {
  readonly site: string | null
  readonly from: string | null
  readonly to: string | null
  readonly version: string | null
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Row = BoardSheetRow & { readonly locale: ExportLocale }

export const scheduleBoard = defineExportSource<Query, Row>({
  listKey: 'planning.board',
  permission: PLANNING_VIEW,
  query(address) {
    const day = (name: string) => {
      const value = address.get(name) ?? ''
      return DAY.test(value) ? value : null
    }
    const version = address.get('version') ?? ''
    return { site: address.get('site') || null, from: day('from'), to: day('to'), version: UUID.test(version) ? version : null }
  },
  async read(caller, query, _cursor, _limit, options) {
    const locale: ExportLocale = options?.locale ?? 'it'
    if (query.version) return { rows: (await boardSheetRows(caller, { versionId: query.version })).map((row) => ({ ...row, locale })), next: null }
    const context = officeContextOf(caller)
    const sites = (await listSettings(caller, context.companyId ? { companyId: context.companyId } : {})).sites.map((entry) => entry.site).sort((a, b) => a.code.localeCompare(b.code))
    const siteId = sites.find((site) => site.id === query.site)?.id ?? sites[0]?.id ?? null
    if (!siteId) return { rows: [], next: null }
    const rows = await boardSheetRows(caller, { siteId, ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}) })
    return { rows: rows.map((row) => ({ ...row, locale })), next: null }
  },
  columns: {
    lane: { value: (row, words) => `${row.lane.code} · ${row.lane.name} · ${words(`kind.${row.lane.kind}`)}` },
    start: { value: (row) => ({ at: row.startAt }) },
    end: { value: (row) => ({ at: row.endAt }) },
    workOrder: { value: (row, words) => (row.rush ? `${row.workOrder} ${words('rush')}` : row.workOrder) },
    style: { value: (row) => row.style },
    operation: { value: (row, words) => (row.operation ? `Op ${row.operation.seq} ${row.operation.name}` : words('part')) },
    pieces: { value: (row) => row.pieces },
    minutes: { value: (row) => ({ decimal: row.minutes }) },
    due: { value: (row) => (row.dueDate ? { day: row.dueDate } : null) },
    schedule: { value: (row, words) => (row.schedule ? words(`schedule.${row.schedule}`) : null) },
    floor: { value: (row, words) => (row.floor ? (row.floor.state === 'RUNNING' || row.floor.state === 'PAUSED' ? `${words(`floor.${row.floor.state}`)} ${row.floor.done}/${row.floor.of}` : words(`floor.${row.floor.state}`)) : null) },
    pinned: { value: (row, words) => words(row.pinned ? 'yes' : 'no') },
    note: { value: (row) => row.note },
  },
  words: {
    it: {
      'kind.LINE': 'Linea',
      'kind.WORK_CENTRE': 'Centro di lavoro',
      'kind.WORKSHOP': 'Terzista',
      rush: 'URGENTE',
      part: 'Parte dell’ordine',
      'schedule.LATE': 'In ritardo',
      'schedule.AT_RISK': 'A rischio',
      'schedule.ON_TIME': 'In tempo',
      'schedule.NO_DUE_DATE': 'Senza consegna',
      'schedule.DONE': 'Fatto',
      'floor.NOT_STARTED': 'Non iniziato',
      'floor.RUNNING': 'In corso',
      'floor.PAUSED': 'In pausa',
      'floor.DONE': 'Fatto',
      yes: 'Sì',
      no: 'No',
    },
    en: {
      'kind.LINE': 'Line',
      'kind.WORK_CENTRE': 'Work centre',
      'kind.WORKSHOP': 'Workshop',
      rush: 'RUSH',
      part: 'Part of the order',
      'schedule.LATE': 'Late',
      'schedule.AT_RISK': 'At risk',
      'schedule.ON_TIME': 'On time',
      'schedule.NO_DUE_DATE': 'No due date',
      'schedule.DONE': 'Done',
      'floor.NOT_STARTED': 'Not started',
      'floor.RUNNING': 'Running',
      'floor.PAUSED': 'Paused',
      'floor.DONE': 'Done',
      yes: 'Yes',
      no: 'No',
    },
  },
})
