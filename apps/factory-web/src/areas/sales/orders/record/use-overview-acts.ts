'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
// ---- F-OO-106: the order's own credit hold — its read (sales.credit.view) and its two acts, through the page's one write ----
import { askCreditYes, checkCreditAgain, getRecordCredit, type CreditCustomer } from './credit/api'
import { creditAskedOf, creditAskNoticeOf, creditCheckNoticeOf, creditHoldWaits, creditRefusalOf, type CreditNotice, type CreditState } from './overview/where'
import { readProblem } from '../model'
import type { Approval } from '../depth/api' // walk #2: the yes's read names a credit hold the order read does not
// ---- end F-OO-106

export type OverviewActsModel = Pick<OrderRecordModel, 'overviewLine' | 'gateActs' /* F-OO-145 */ | 'credit' /* F-OO-106 */>
export type OverviewActsActions = Pick<OrderRecordActions, 'onOpenLine' | 'onRequestedChange' | 'onLineChange' /* F-OO-125 */ | 'onCustomerRefChange' /* F-OO-209 */ | 'onNoteSave' /* F-OO-210 */ | 'gateActs' /* F-OO-145 */ | 'credit' /* F-OO-106 */>

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
    /** F-OO-106: the reader's rights (sales.credit.view reads the order's credit) and what else is read again after a credit act. */
    readonly credit?: CreditInput
  } = {},
): { model: OverviewActsModel; actions: OverviewActsActions } {
  const [overviewLine, setOverviewLine] = useState<string | null>(null)
  const gates = useGateActs(input.gates, input.base) // F-OO-145
  const credit = useOrderCredit(input.base, input.credit, input.setDialog) // F-OO-106
  return {
    model: { overviewLine, gateActs: gates.model /* F-OO-145 */, credit: credit.model /* F-OO-106 */ },
    actions: {
      credit: credit.actions, // F-OO-106: Check credit again, Ask for a yes…, Try again
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

// ---- F-OO-106 (order overview §1.3, §1.4; review F8, F16; B-OO-004): the order's own credit hold ---------------------------------
/** What the container hands the credit part: the reader's rights, and the reads that follow a credit act (the yes's, the headline). */
export interface CreditInput {
  readonly permissions: readonly string[]
  readonly reread?: () => void
  /**
   * F-OO-106 (walk #2): the yes's read (GET …/approval, orders.view) — the order read sends no `waits`, so without it a hold with no
   * yes asked (or one this reader sees no task of) looked like no hold: nothing read, and no "who decides" said. Absent: not read.
   */
  readonly approval?: Pick<Approval, 'creditHold'> | null
}

/**
 * The order's credit, read (GET /sales/credit/records/SalesOrder/:id) only with sales.credit.view and only while the order waits on
 * its own credit hold — again when the order, or the credit yes asked on it, changes. Its two acts go through the page's one write,
 * each from its dialog in the page's one slot: Check credit again (no version: the check id is the lock — "checked meanwhile" is a
 * 409, plan F16) and Ask for a yes… on the hold's check. Answered: the dialog closes and the page's notice says what followed (who a
 * yes is asked of now: the credit read again names them); refused: the dialog says it in the page's words, and the credit is read
 * again. Either way the order is read again (the write), and the yes's read and the headline (`reread`).
 */
function useOrderCredit(base: RecordActsBase | undefined, input: CreditInput | undefined, setDialog: ((dialog: RecordDialog | null) => void) | undefined): { model: CreditState | null; actions: NonNullable<OverviewActsActions['credit']> } {
  const view = !!input?.permissions.includes('sales.credit.view')
  const order = base?.current.current ?? null
  const waits = !!order && creditHoldWaits(order, input?.approval) // walk #2: the yes's read says the order waits on its credit too
  const orderId = order?.id ?? null
  const asked = order?.openApprovals?.find((task) => task.kind === 'CREDIT_OVERRIDE')?.taskId ?? input?.approval?.creditHold?.requestTaskId ?? ''
  const key = view && waits && order ? `${order.id}:${order.version}:${asked}` : null
  const [record, setRecord] = useState<CreditState['record']>(null)
  const [tick, setTick] = useState(0)
  const api = base?.api ?? null
  useEffect(() => {
    if (!key || !api || !orderId) return setRecord(null)
    const abort = new AbortController()
    setRecord((known) => (known?.value ? known : { value: null, problem: null }))
    getRecordCredit(api, orderId, abort.signal)
      .then((value) => !abort.signal.aborted && setRecord({ value, problem: null }))
      .catch((error: unknown) => !abort.signal.aborted && setRecord((known) => (known?.value ? known : { value: null, problem: readProblem(error) })))
    return () => abort.abort()
  }, [key, tick, api, orderId])
  const reread = useRef(input?.reread)
  reread.current = input?.reread
  const again = useCallback(() => setTick((count) => count + 1), [])

  /** One credit act through the page's one write: its dialog stays open while it goes; the notice or the refusal follows. */
  const act = (open: CreditDialog, run: (api: RecordActsBase['api'], orderId: string) => Promise<{ readonly notice: (fresh: CreditCustomer | null) => CreditNotice; readonly readAgain: boolean }>) => {
    if (!base || !setDialog) return
    void base.write(
      async () => {
        const value = base.current.current
        if (!value) return null
        setDialog(open) // an earlier refusal is not said again while this one is asked
        try {
          const done = await run(base.api, value.id)
          // Who a yes is asked of now: the credit as it stands after the act (no read when the order went on).
          const fresh = done.readAgain ? await getRecordCredit(base.api, value.id).catch(() => null) : null
          if (fresh) setRecord({ value: fresh, problem: null })
          setDialog(null)
          base.setNotice(done.notice(fresh))
        } catch (error) {
          setDialog({ ...open, refused: creditRefusalOf(error) })
          again()
        }
        reread.current?.()
        return null
      },
      null,
      true,
    )
  }

  return {
    // Waiting on its credit: read with the right; without it nothing is read — the strip says who checks it, in words.
    model: waits ? { view, record: key ? record : null } : null,
    actions: {
      onCheck: () =>
        act({ kind: 'creditCheck' }, async (api, id) => {
          const answer = await checkCreditAgain(api, id, newIdempotencyKey())
          return { notice: (fresh) => creditCheckNoticeOf(answer, creditAskedOf(fresh)), readAgain: answer.result === 'HOLD' }
        }),
      onAsk: (checkId, note) =>
        act({ kind: 'creditAsk', checkId }, async (api) => {
          await askCreditYes(api, checkId, note, newIdempotencyKey())
          return { notice: (fresh) => creditAskNoticeOf(creditAskedOf(fresh)), readAgain: true }
        }),
      onRetry: again,
    },
  }
}
type CreditDialog = Extract<RecordDialog, { kind: 'creditCheck' | 'creditAsk' }>
// ---- end F-OO-106
