import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../_shared/hooks'
import { failedRead, ready } from '../../_shared/model'
import { canFor, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../_shared/fixtures'
import { AMENDMENTS, INCOMING, INCOMING_OPEN, inDepthShell } from '../depth/demo/fixtures'
import { AMEND_DRAFT, depthCan, draftFor } from '../depth/model'
import type { AmendmentsState } from '../depth/use-amendments'
import { IncomingRecordView, type IncomingRecordModel, type IncomingTab } from './view/IncomingRecordView'

/**
 * SCR-076-incoming — an incoming inspection (the one list's Incoming rows open it; B-W2b-98's record), made-up data: the lot,
 * the sample and its result per class, hide by hide with the area against the tannery, the decision with its next step and
 * Place hold, the amendments (one countersigned), an open one recorded on the tablet, the roles and the states.
 */

interface IncomingCase {
  readonly role: RoleCase
  readonly model: IncomingRecordModel
}

const amendmentsOf = (over: Partial<AmendmentsState> = {}): AmendmentsState => ({ read: null, dialog: null, draft: AMEND_DRAFT, refuseReason: '', busy: false, problem: null, lines: [], done: null, ...over })
const INCOMING_AMENDMENTS = { ...AMENDMENTS, record: { ...AMENDMENTS.record, type: 'IncomingInspection' as const, id: INCOMING.inspection.id, label: INCOMING.inspection.number }, corrections: AMENDMENTS.corrections.filter((entry) => entry.state === 'SIGNED').map((entry) => ({ ...entry, field: 'note', fieldWords: 'Note', row: null, beforeWords: '', afterWords: 'Hide 2 went back to the tannery.' })), fields: AMENDMENTS.fields.slice(0, 1).map((field) => ({ ...field, waiting: null })), waiting: 0 }

const model = (tab: IncomingTab, over: Partial<IncomingRecordModel> = {}, role: RoleCase = 'owner'): IncomingCase => ({
  role,
  model: { prefix: PREFIX, tab, read: INCOMING, can: canFor(role), depth: depthCan(ROLE_PERMISSIONS[role]), amendments: amendmentsOf({ read: ready(INCOMING_AMENDMENTS) }), ...over },
})

function IncomingDesign({ model: value }: { model: IncomingCase }) {
  const [amendments, setAmendments] = useState(value.model.amendments)
  useEffect(() => setAmendments(value.model.amendments), [value])
  const amend = (change: Partial<AmendmentsState>) => setAmendments((current) => ({ ...current, ...change }))
  return inDepthShell(
    '/quality/inspections/incoming/[id]',
    createElement(IncomingRecordView, {
      model: { ...value.model, amendments },
      stepUp: STEP_UP_CLOSED,
      actions: {
        onOpen: (dialog) => {
          const field = amendments.read?.value?.fields.find((entry) => entry.waiting === null)
          amend({ dialog, draft: dialog?.kind === 'amend' && field ? draftFor(field) : AMEND_DRAFT })
        },
        onDraft: (draft) => amend({ draft }),
        onRefuseReason: (refuseReason) => amend({ refuseReason }),
      },
    }),
    value.role,
  )
}

export const designScreen = defineDesignScreen<IncomingCase>({
  screen: 'SCR-076-incoming',
  title: 'Inspections: an incoming inspection',
  view: IncomingDesign,
  cases: [
    { id: 'units', label: 'Decided, failed: the lot, the sample and the result per class, hide by hide, the lot short of the tannery', model: model('units'), note: 'No person in a list; the inspector is named only where the site’s legal basis allows it.' },
    { id: 'decision', label: 'Decision & signature: the split, the next step in words, Place hold on the rejected hide, the amendments', model: model('decision') },
    { id: 'amend', label: 'Amend signed result (the note)', model: model('decision', { amendments: amendmentsOf({ read: ready(INCOMING_AMENDMENTS), dialog: { kind: 'amend' }, draft: { ...draftFor(INCOMING_AMENDMENTS.fields[0]!), value: 'Hide 2 back to the tannery; claim opened.', reason: 'The bench forgot the claim.' } }) }) },
    { id: 'open', label: 'Open: recorded hide by hide on the tablet', model: model('units', { read: INCOMING_OPEN, amendments: amendmentsOf() }) },
    { id: 'open-decision', label: 'Open: nothing decided, no amendments yet', model: model('decision', { read: INCOMING_OPEN, amendments: amendmentsOf() }) },
    { id: 'hold-held', label: 'Production manager: Place hold held (no quality.holds.place)', model: model('decision', {}, 'production') },
    { id: 'amend-failed', label: 'The amendments could not be read', model: model('decision', { amendments: amendmentsOf({ read: failedRead('problem.unavailable') }) }) },
  ],
})
