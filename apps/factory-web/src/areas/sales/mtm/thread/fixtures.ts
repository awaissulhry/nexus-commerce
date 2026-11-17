import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, RECORD, type RoleCase } from '../demo/fixtures'
import { designScreen as recordScreen, riderThread } from '../record/fixtures'
import type { ProfileRecordModel } from '../record/view-model'
import { ProfileRecordView } from '../record/view/ProfileRecordView'

/**
 * SCR-036-thread — the rider profile's thread (B-W2b-371, XF2:02; B-TH-258 docked, the rule of picture 38) with made-up data only:
 * ONE thread per rider and garment type (on its first revision), docked beside every tab of the record — internal notes about the
 * fit, messages to the rider's customer, the record's files; Activity's tools (Add task, Ask a partner to approve, Share with a
 * partner, Followers, Remind me) in its "⋯". Body data: a role that reads threads but no measurements never reaches it (the API's
 * thread gate: finance, the warehouse, read only); a role that reads measurements but no threads gets no dock and no Thread button.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: ProfileRecordModel
}

const base = (recordScreen.cases.find((one) => one.id === 'thread-docked') ?? recordScreen.cases[0]!).model as DesignModel
const shown = (over: Partial<ProfileRecordModel>, role: RoleCase = 'owner'): DesignModel => ({ role, model: { ...base.model, thread: riderThread(), ...over } })

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-036-thread',
  title: 'Rider profile › its thread, docked (made-to-measure)',
  view: ({ model }: { model: DesignModel }) => inShell(`/sales/made-to-measure/${RECORD.id}`, createElement(ProfileRecordView, { model: model.model }), model.role),
  cases: [
    { id: 'thread', label: 'The thread docked beside Measurements: notes about the fit, a message to the customer, the files line', model: shown({ tab: 'measurements' }) },
    { id: 'thread-photos', label: 'Beside Photos: the body photos stay in their tab (never the thread’s Files view)', model: shown({ tab: 'photos' }) },
    { id: 'thread-fittings', label: 'Beside Fittings: the same one thread on every tab', model: shown({ tab: 'fittings' }) },
    { id: 'no-threads', label: 'A custom role that reads measurements but no threads: no dock, no Thread button; History stays in Measurements', model: shown({ tab: 'measurements', thread: null }) },
  ],
})
