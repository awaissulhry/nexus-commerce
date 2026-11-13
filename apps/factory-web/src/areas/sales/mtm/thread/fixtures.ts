import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { PanelMessage } from '../../../../record-panels/model'
import type { RecordPanelsViewModel } from '../../../../record-panels/view/RecordPanelsView'
import { RecordPanelsView } from '../../../../record-panels/view/RecordPanelsView'
import { inShell, RECORD, REV3, uid, type RoleCase } from '../demo/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import type { ProfileRecordModel } from '../record/view-model'
import { ProfileRecordView } from '../record/view/ProfileRecordView'

/**
 * SCR-036-thread — the rider profile's thread (B-W2b-371, XF2:02; design rider.activity "Thread: internal notes and messages to the
 * party") with made-up data only: one thread per rider and garment type (on its first revision) under the record's own timeline —
 * internal notes about the fit, a message to the customer; the empty thread; a role that reads no threads (said in words). Readers
 * of threads who read no measurements never reach it (the platform's thread gate: finance, the warehouse, read only).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: ProfileRecordModel
}

const base = (recordScreen.cases.find((one) => one.id === 'activity') ?? recordScreen.cases[0]!).model as DesignModel
const EMPTY = (panelsScreen.cases.find((one) => one.id === 'empty') ?? panelsScreen.cases[0]!).model
const first = RECORD.revisions.at(-1)?.id ?? REV3.id
const note = (n: number, body: string, at: string, direction: PanelMessage['direction'] = 'INTERNAL_NOTE'): PanelMessage => ({ id: uid('7201', n), direction, channel: direction === 'INTERNAL_NOTE' ? 'APP' : 'EMAIL', authorKind: 'USER', authorName: n === 1 ? 'Demo Pattern Maker' : 'Alex Demo', at, body, mentions: [], attachments: [], email: null })
const panels = (messages: readonly PanelMessage[]): RecordPanelsViewModel => ({
  ...EMPTY,
  record: { type: 'MeasurementProfile', id: first, companyId: null, siteId: null },
  title: `${RECORD.riderName} · ${RECORD.garmentType}`,
  party: { id: RECORD.partyId, name: RECORD.customer.name, emails: [] },
  messages: { items: [...messages], more: false },
})
const shown = (thread: RecordPanelsViewModel | null, role: RoleCase = 'owner'): DesignModel => ({ role, model: { ...base.model, tab: 'activity', thread: thread ? createElement(RecordPanelsView, { model: thread }) : null } })

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-036-thread',
  title: 'Rider profile › Activity with its thread (made-to-measure)',
  view: ({ model }: { model: DesignModel }) => inShell(`/sales/made-to-measure/${RECORD.id}`, createElement(ProfileRecordView, { model: model.model }), model.role),
  cases: [
    {
      id: 'thread',
      label: 'Activity: the timeline, then the thread (internal notes about the fit, a message to the customer)',
      model: shown(panels([note(2, 'Demo: the left sleeve a little longer, the rider rides with the arm bent.', '2026-11-12T15:20:00.000Z'), note(1, 'Demo: posture checked in the showroom, no asymmetry beyond the sleeve.', '2026-11-12T11:05:00.000Z')])),
    },
    { id: 'thread-empty', label: 'Activity: the thread without a message yet (the composer offers a note or a mail)', model: shown(panels([])) },
    { id: 'no-threads', label: 'A custom role that reads measurements but no threads: said in words, the timeline stays', model: shown(null) },
  ],
})
