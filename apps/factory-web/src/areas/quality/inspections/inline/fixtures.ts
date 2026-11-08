import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../_shared/hooks'
import { ready } from '../../_shared/model'
import { PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../_shared/fixtures'
import { AMENDMENTS_NONE, inDepthShell, INLINE, INLINE_FIRST } from '../depth/demo/fixtures'
import { AMEND_DRAFT, depthCan, draftFor } from '../depth/model'
import type { AmendmentsState } from '../depth/use-amendments'
import { InlineRecordView, type InlineRecordModel, type InlineTab } from './view/InlineRecordView'

/**
 * SCR-076-inline — an in-process check (the one list's In-line rows open it; B-W2b-99, answered on the line tablet SCR-176),
 * made-up data: an end-of-line fail with its DHU (no operator named: the site's legal basis is not in place), a first piece
 * holding the run with its plan's checks, the decision and the amendments.
 */

interface InlineCase {
  readonly role: RoleCase
  readonly model: InlineRecordModel
}

const amendmentsOf = (over: Partial<AmendmentsState> = {}): AmendmentsState => ({ read: null, dialog: null, draft: AMEND_DRAFT, refuseReason: '', busy: false, problem: null, lines: [], done: null, ...over })
const CHECK_AMENDMENTS = { ...AMENDMENTS_NONE, record: { ...AMENDMENTS_NONE.record, type: 'InProcessCheck' as const, id: INLINE.id, label: 'End of line · DEMO-WO-0151' }, fields: AMENDMENTS_NONE.fields.slice(0, 1) }

const model = (tab: InlineTab, over: Partial<InlineRecordModel> = {}, role: RoleCase = 'owner'): InlineCase => ({
  role,
  model: { prefix: PREFIX, tab, read: INLINE, depth: depthCan(ROLE_PERMISSIONS[role]), workOrdersView: true, amendments: amendmentsOf({ read: ready(CHECK_AMENDMENTS) }), ...over },
})

function InlineDesign({ model: value }: { model: InlineCase }) {
  const [amendments, setAmendments] = useState(value.model.amendments)
  useEffect(() => setAmendments(value.model.amendments), [value])
  const amend = (change: Partial<AmendmentsState>) => setAmendments((current) => ({ ...current, ...change }))
  return inDepthShell(
    '/quality/inspections/inline/[id]',
    createElement(InlineRecordView, {
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

export const designScreen = defineDesignScreen<InlineCase>({
  screen: 'SCR-076-inline',
  title: 'Inspections: an in-line check',
  view: InlineDesign,
  cases: [
    { id: 'end-of-line', label: 'End of line, failed: 2 of 10 pieces, 3 defects, DHU 30.0; no operator named (legal basis not in place)', model: model('check') },
    { id: 'decision', label: 'Decision: the outcome, the note, the amendments (none yet)', model: model('decision') },
    { id: 'first-piece', label: 'A first piece holding the run: its plan’s checks, one answered', model: model('check', { read: INLINE_FIRST, amendments: amendmentsOf() }) },
    { id: 'first-piece-decision', label: 'A first piece not decided yet: amendments come after', model: model('decision', { read: INLINE_FIRST, amendments: amendmentsOf() }) },
    { id: 'read-only', label: 'Read-only: seen, asking a correction held with the reason', model: model('decision', { amendments: amendmentsOf({ read: ready({ ...CHECK_AMENDMENTS, may: { request: false, sign: false } }) }) }, 'readOnly') },
  ],
})
