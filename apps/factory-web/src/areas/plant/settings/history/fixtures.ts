import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, inShell, uid } from '../../_shared/fixtures'
import type { AuditEntry } from '../depth-api'
import { DEMO_SITES } from '../_demo/fixtures'
import { HistoryView, type HistoryModel } from './view/HistoryView'

/** SCR-241-audit — Plant settings' audit log in its own window (B-W2b-141), made-up changes only. */
const entry = (n: number, over: Partial<AuditEntry>): AuditEntry => ({ id: uid('3939', n), at: at(30, 9, 60 - n * 5), action: 'plant.changeRoutingRule', actorName: 'Anna Esempio', recordType: 'RequestRoutingRule', recordId: uid('3737', 1), siteId: DEMO_SITES[0]!.id, reason: null, ...over })
const ENTRIES: AuditEntry[] = [
  entry(1, { action: 'plant.setLockSettings', recordType: 'PlantSettings', before: { hazardReportOnLock: true }, after: { hazardReportOnLock: false } }),
  entry(2, { action: 'plant.orderRoutingRules', recordType: 'Site' }),
  entry(3, { action: 'plant.removeRoutingRule', after: { outcome: 'SWITCHED_OFF', requests: 14 }, actorName: 'Marco Prova' }),
  entry(4, { action: 'plant.updateCheckType', recordType: 'MachineCheckType', siteId: null, before: { code: 'HEAT_PRESS_THERMO', active: true }, after: { code: 'HEAT_PRESS_THERMO', active: false } }),
  entry(5, { action: 'plant.createCheckType', recordType: 'MachineCheckType', siteId: null, after: { code: 'COMPRESSOR_VESSEL' } }),
  entry(6, { action: 'plant.updateSymptom', recordType: 'MachineSymptom', siteId: null, before: { code: 'NOISE' }, after: { code: 'NOISE' } }),
  entry(7, { action: 'plant.addRoutingRule', actorName: null }),
]

const model = (over: Partial<HistoryModel> = {}): HistoryModel => ({ canRead: true, read: { status: 'ready', value: ENTRIES }, sites: DEMO_SITES, ...over })

/** The window as the Office shows it (the production manager holds audit.read). */
function HistoryDesign({ model }: { model: HistoryModel }) {
  return inShell('/plant/settings/history', createElement(HistoryView, { model }), 'production')
}

export const designScreen = defineDesignScreen<HistoryModel>({
  screen: 'SCR-241-audit',
  title: 'Plant settings (audit log)',
  view: HistoryDesign,
  cases: [
    { id: 'log', label: 'Newest first: when, who, what, where, why', model: model(), note: 'A change the system made says Nexus; the group-wide lists say "The whole group".' },
    { id: 'empty', label: 'Nothing changed yet', model: model({ read: { status: 'ready', value: [] } }) },
    { id: 'loading', label: 'Loading', model: model({ read: { status: 'loading' } }) },
    { id: 'no-right', label: 'Without audit.read', model: model({ canRead: false }) },
    { id: 'error', label: "Couldn't be read", model: model({ read: { status: 'error', problem: 'problem.offlineSettings' } }) },
  ],
})
