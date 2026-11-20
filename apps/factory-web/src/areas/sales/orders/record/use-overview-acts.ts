'use client'

import { useState } from 'react'
import type { OrderRecordActions, OrderRecordModel, RecordActsBase, RecordDialog } from './record-model'
import { amendStyleAnchorOf } from './record-model' // F-OO-125
import { CUSTOMER_REF_FIELD_ID } from './record-model' // F-OO-209
// ---- F-OO-210: the office note through the Orders sheet's own write (the list tools' bulk apply) ----
import { newIdempotencyKey } from '../../../../lib/api/client'
import { applyBulk } from '../../../_shared/list-tools/api'
import { problemOf } from '../../../../list-frame/tools/transport'
import { noteBodyOf, noteFailureOf, noteRefusalOf } from './overview/facts'
import type { Phrase } from '../model'
import { useGateActs, type GateActsInput } from './use-gate-acts' // F-OO-145: Next dates' gates with Planning's own dialogs

export type OverviewActsModel = Pick<OrderRecordModel, 'overviewLine' | 'gateActs' /* F-OO-145 */>
export type OverviewActsActions = Pick<OrderRecordActions, 'onOpenLine' | 'onRequestedChange' | 'onLineChange' /* F-OO-125 */ | 'onCustomerRefChange' /* F-OO-209 */ | 'onNoteSave' /* F-OO-210 */ | 'gateActs' /* F-OO-145 */>

/**
 * F-OP-134 (N-5): Overview's acts — F-SA-232: the line whose sizes the centred window shows (Overview › Progress by line). Mounted by
 * the container (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it. The production
 * read Overview draws is the container's (the band and every tab read it).
 * F-OO-144 (order overview 10-design §4.2; review F7): Next dates' requested date "Change…" opens the small dialog in the page's one
 * dialog slot (`{ kind: 'requested' }`; its write is Lines' amendment, use-lines-acts) — the F-OP-104 hop to Lines went.
 * F-OO-125 (order overview 10-design §2.3): a line's "Change quantity or sizes…" — the same one edit path (Amend on Lines), with that
 * line's style group focused (`amend-style-<styleId>` in LinesEditor). No second editor.
 * F-OO-209 (order overview 11-design §7.2): Order facts' Customer PO "Change…" — the same one edit path, the customer PO focused
 * (CUSTOMER_REF_FIELD_ID on the Lines edit header). Ship to keeps the band's own door (use-lines-acts onChangeShipTo).
 * F-OO-210 (order overview 11-design §7.3; Owner D4): the office note's Save note — the Orders sheet's own write (`applyBulk`, list
 * `sales.orders`: the command sales.orders.editCells, which checks the version, refuses a closed or cancelled order and moves the
 * version), through the page's one write; the order is read again after it.
 * F-OO-145 (order overview 10-design §4.2): Next dates' steps before production — Planning's own gate dialogs from a one-order model of
 * the page's read (use-gate-acts, mounted here: the container's hook), their writes Planning's routes through the page's one write.
 */
export function useOverviewActs(
  input: {
    readonly startAmend?: () => void
    readonly focus?: (id: string) => void
    /** F-OO-144: the page's one dialog slot (the container's). */
    readonly setDialog?: (dialog: RecordDialog | null) => void
    /** F-OO-210: the API, the order as last read and the page's one write (the container's acts base). */
    readonly base?: RecordActsBase
    /** F-OO-145: the production read and its re-read, the reader's rights and id, the prefix, the live stream (Planning's model). */
    readonly gates?: GateActsInput
  } = {},
): { model: OverviewActsModel; actions: OverviewActsActions } {
  const [overviewLine, setOverviewLine] = useState<string | null>(null)
  const gates = useGateActs(input.gates, input.base) // F-OO-145
  return {
    model: { overviewLine, gateActs: gates.model /* F-OO-145 */ },
    actions: {
      onOpenLine: setOverviewLine,
      gateActs: gates.actions, // F-OO-145: Move the date…, Mark done…, Start before the gate… and the dialogs' own acts
      // F-OO-144: the small dialog (held there by amendHeld, as the door is); no page hop.
      onRequestedChange: () => input.setDialog?.({ kind: 'requested' }),
      // F-OO-125: edit mode (an open draft kept: use-lines-acts' onAmendStart), the line's style group focused.
      onLineChange: (styleId) => {
        input.startAmend?.()
        input.focus?.(amendStyleAnchorOf(styleId))
      },
      // F-OO-209: edit mode (an open draft kept), the customer PO focused.
      onCustomerRefChange: () => {
        input.startAmend?.()
        input.focus?.(CUSTOMER_REF_FIELD_ID)
      },
      // ---- F-OO-210: one row of the sheet's write — the order, its version as read, the note. A refusal stays in the dialog in the
      // page's words (stale: someone changed it first, read again; closed or cancelled; the right); taken: the dialog closes, the notice
      // says so. Either way the order is read again (its note and its new version).
      onNoteSave: (note) => {
        const { base, setDialog } = input
        if (!base || !setDialog) return
        const key = newIdempotencyKey()
        void base.write(
          async () => {
            const value = base.current.current
            if (!value) return null
            setDialog({ kind: 'note' }) // an earlier refusal is not said again while this one is asked
            let refused: Phrase | null
            try {
              const results = await applyBulk(base.api, noteBodyOf(value, note), key)
              refused = noteRefusalOf(results.find((row) => row.id === value.id))
            } catch (error) {
              refused = noteFailureOf(problemOf(error))
            }
            if (refused) setDialog({ kind: 'note', refused })
            else {
              setDialog(null)
              base.setNotice({ tone: 'success', words: { key: 'facts.note.saved' } })
            }
            return null
          },
          null,
          true,
        )
      },
      // ---- end F-OO-210
    },
  }
}
