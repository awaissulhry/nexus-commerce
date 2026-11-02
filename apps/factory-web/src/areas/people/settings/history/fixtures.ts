import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { HistoryView, type HistoryModel } from './view/HistoryView'

/** SCR-265-audit — the settings' audit log in its own window, made-up changes only. */
const entries: Extract<HistoryModel['read'], { status: 'ready' }>['value'] = [
  { id: '0190f0e2-6001-7000-8000-000000000003', at: '2026-11-02T09:10:00.000Z', action: 'people.switchOnPurpose', actorName: 'Anna Esempio', recordType: 'PeopleLegalGate', reason: 'Informativa e valutazione pronte' },
  { id: '0190f0e2-6001-7000-8000-000000000002', at: '2026-10-30T15:20:00.000Z', action: 'people.saveWorkingTimeLimit', actorName: 'Anna Esempio', recordType: 'WorkingTimeRule', reason: null },
  { id: '0190f0e2-6001-7000-8000-000000000001', at: '2026-10-29T11:05:00.000Z', action: 'people.changeAttendanceSettings', actorName: 'Davide Modello', recordType: 'PeopleSettings', reason: null },
]

export const designScreen = defineDesignScreen<HistoryModel>({
  screen: 'SCR-265-audit',
  title: 'People settings (audit log)',
  view: HistoryView,
  cases: [
    { id: 'log', label: 'Newest first: who, what, why', model: { read: { status: 'ready', value: entries } } },
    { id: 'empty', label: 'Nothing changed yet', model: { read: { status: 'ready', value: [] } } },
    { id: 'loading', label: 'Loading', model: { read: { status: 'loading' } } },
    { id: 'no-right', label: 'Without audit.read', model: { read: { status: 'error', problem: 'problem.forbidden' } } },
    { id: 'error', label: "Couldn't be read", model: { read: { status: 'error', problem: 'problem.unavailable' } } },
  ],
})
