import { LOCATIONS, SITE, uid } from '../../../../_shared/stock/fixtures'
import type { BlockedPlace, DueCounts, Schedule } from '../api'
import { blankSchedule, draftOfSchedule } from '../model'
import type { CountSchedulesModel, SchedulesDialog } from '../use-count-schedules'

/**
 * B-W2b-320 — made-up count schedules of the demo site (design-only): a monthly count of rack A overdue, the class-A
 * materials due today, the leather due this week, a retired schedule; the places running counts block. Nothing here is
 * real business data.
 */

export const TODAY = '2026-10-30'

export function schedule(n: number, over: Partial<Schedule> = {}): Schedule {
  return {
    id: uid('7373', n),
    companyId: SITE.companyId,
    siteId: SITE.id,
    name: `Calendario demo ${n}`,
    location: null,
    abcClass: null,
    itemKind: null,
    everyDays: 30,
    nextDueOn: TODAY,
    lastCountedOn: null,
    lastCount: null,
    active: true,
    note: null,
    due: 'DUE_TODAY',
    overdueDays: 0,
    openTaskId: null,
    version: 2,
    ...over,
  }
}

export const SCHEDULES: Schedule[] = [
  schedule(1, { name: 'Scaffale A ogni mese', location: { id: LOCATIONS.rackA.id, code: LOCATIONS.rackA.code, name: LOCATIONS.rackA.name, path: 'N-MAG/N-MAG-A' }, nextDueOn: '2026-10-27', lastCountedOn: '2026-09-27', lastCount: { id: uid('7474', 1), number: 'CNT-D-0001' }, due: 'OVERDUE', overdueDays: 3 }),
  schedule(2, { name: 'Classe A ogni 2 settimane', abcClass: 'A', everyDays: 14, nextDueOn: TODAY, lastCountedOn: '2026-10-16', due: 'DUE_TODAY' }),
  schedule(3, { name: 'Pelli ogni settimana', itemKind: 'LEATHER', everyDays: 7, nextDueOn: '2026-11-02', lastCountedOn: '2026-10-26', due: 'DUE_SOON', openTaskId: uid('7575', 1) }),
]
export const RETIRED = schedule(4, { name: 'Banchina ricevimento (vecchio)', location: { id: LOCATIONS.receiving.id, code: LOCATIONS.receiving.code, name: LOCATIONS.receiving.name, path: 'N-RCV' }, active: false, due: 'RETIRED', nextDueOn: '2026-08-01' })
export const LATER = schedule(5, { name: 'Classe C ogni trimestre', abcClass: 'C', everyDays: 90, nextDueOn: '2026-12-15', due: 'LATER', lastCountedOn: '2026-09-15' })

export const DUE: DueCounts = { today: TODAY, tiles: { overdue: 1, dueToday: 1, dueThisWeek: 3 }, rows: SCHEDULES }

export const BLOCKED: BlockedPlace[] = [
  { id: LOCATIONS.binA1.id, siteId: SITE.id, siteCode: SITE.code, code: LOCATIONS.binA1.code, name: LOCATIONS.binA1.name, block: { reason: 'COUNT', until: null, holds: true, countNumber: 'CNT-D-0001' } },
  { id: LOCATIONS.binA2.id, siteId: SITE.id, siteCode: SITE.code, code: LOCATIONS.binA2.code, name: LOCATIONS.binA2.name, block: { reason: 'COUNT', until: null, holds: true, countNumber: 'CNT-D-0001' } },
  { id: LOCATIONS.cutting.id, siteId: SITE.id, siteCode: SITE.code, code: LOCATIONS.cutting.code, name: LOCATIONS.cutting.name, block: { reason: 'DAMAGE', until: '2026-11-03', holds: true, countNumber: null } },
]

export function schedulesModel(over: Partial<CountSchedulesModel> = {}): CountSchedulesModel {
  return { due: { value: DUE, problem: null }, blocked: BLOCKED, starting: [], dialog: null, notice: null, today: TODAY, ...over }
}

export function schedulesDialog(over: Partial<SchedulesDialog> = {}): SchedulesDialog {
  return { filter: 'true', list: { items: [...SCHEDULES, LATER], problem: null }, form: null, busy: false, problem: null, ...over }
}

export const NEW_FORM = { ...blankSchedule(SITE.id, TODAY), name: 'Ripiano A1 ogni 10 giorni', locationId: LOCATIONS.binA1.id, everyDays: '10' }
export const EDIT_FORM = draftOfSchedule(SCHEDULES[1]!)
export const BAD_FORM = { ...blankSchedule(SITE.id, TODAY), name: 'Senza ambito', everyDays: '400' }
