'use client'

import { useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { applyAmendment, cancelOrder, closeLines, getCancelCheck, reopenLines, type CancelCheck, type CloseLinesAnswer } from '../api'
import { previewCloseLines, type ClosePreview } from '../api' // F-OP-107
import { appliedNotice } from '../daily-model' // F-OO-144: the notice after the requested date's amendment
import { readProblem } from '../model'
// ---- F-OP-111: Split into new orders… (POST …/split; the customer's delivery addresses for a part's Ship to) ----
import { listShipToAddresses, splitOrder, type ShipToAddress } from '../api'
import { splitBodyOf, splitRefusals, type SplitRefusal } from '../model'
import { PART_LOADING, type OrderRecordActions, type OrderRecordModel, type Part, type RecordActsBase, type RecordDialog } from './record-model'
import { requestedBodyOf } from './record-model' // F-OO-144: Requested's small dialog (one amendment, no lines since ol-s1)

export type LinesActsModel = Pick<OrderRecordModel, 'closedLines' | 'cancelCheck' | 'split' /* F-OP-111 */ | 'closePreview' /* F-OP-107 */>
export type LinesActsActions = Pick<
  OrderRecordActions,
  | 'onClosePreview' // F-OP-107
  | 'onCloseLines'
  | 'onReopenLines'
  | 'onCancelOrder'
  | 'onSplit' // F-OP-111
  | 'onChangeShipTo' // F-OP-110 → F-OL-04
  | 'onRequestedDate' // F-OO-144
  | 'onCustomerRef' // F-OL-04
  | 'onShipTo' // F-OL-04
>

const part = <T,>(value: T): Part<T> => ({ value, problem: null })

/**
 * F-OP-134 (N-5): the lines' own windows — close and reopen lines (the reason optional since ol-s1), the cancel's impact check when its
 * dialog opens, then the cancel with the typed number; F-OP-111: Split into new orders (the customer's delivery addresses read as it
 * opens, parties.view; a refusal said at its place); F-OO-144 / F-OL-04: the order fields' small windows (Requested by customer,
 * Customer PO, Ship to) — each ONE amendment with no lines. F-OL-05: the old amendment draft ("Amend order") went: the Lines tab's
 * table changes in place (use-lines-draft.ts). Mounted by the container (OrderRecord.tsx), which hands what it returns to the view as
 * plain props; a view never imports it.
 */
export function useLinesActs(
  input: RecordActsBase & {
    readonly setDialog: (dialog: RecordDialog | null) => void
    /** F-OP-111: the person's rights (a part's Ship to reads the customer's addresses with parties.view). */
    readonly permissions: readonly string[]
  },
): {
  model: LinesActsModel
  actions: LinesActsActions
  readCancelCheck: () => void
  opened: (next: RecordDialog | null) => void
} {
  const { api, orderId, current, write, version, setNotice, setDialog, permissions } = input
  const [cancelCheck, setCancelCheck] = useState<Part<CancelCheck> | null>(null)
  const [closedLines, setClosedLines] = useState<CloseLinesAnswer | null>(null)
  // ---- F-OP-107: Close remaining lines' preview (the latest ask wins: an answer for other lines is dropped) ----
  const [closePreview, setClosePreview] = useState<Part<ClosePreview> | null>(null)
  const closeSeq = useRef(0)
  // ---- F-OP-111: the split's addresses (null: no right to read them), its refusals by place, the orders it made ----
  const mayAddresses = permissions.includes('parties.view')
  const [addresses, setAddresses] = useState<Part<ShipToAddress[]> | null>(null)
  const [refusals, setRefusals] = useState<readonly SplitRefusal[]>([])
  const [made, setMade] = useState<readonly { id: string; number: string }[] | null>(null)
  const readAddresses = (partyId: string) => {
    setAddresses(PART_LOADING)
    listShipToAddresses(api, partyId)
      .then((rows) => setAddresses(part(rows)))
      .catch((error: unknown) => setAddresses({ value: null, problem: readProblem(error) }))
  }
  // ---- end F-OP-111

  // The cancel dialog's impact check (read when it opens, again on Try again).
  const readCancelCheck = () => {
    setCancelCheck(PART_LOADING)
    getCancelCheck(api, orderId)
      .then((answer) => setCancelCheck(part(answer)))
      .catch((error: unknown) => setCancelCheck({ value: null, problem: readProblem(error) }))
  }

  const actions: LinesActsActions = {
    // F-OL-04 (pick D7): ⋯ Change ship-to… and Order facts' Ship to "Change…" open the Ship to window (the addresses read as it opens).
    onChangeShipTo: () => {
      const value = current.current
      setDialog({ kind: 'shipTo' })
      if (value && mayAddresses) readAddresses(value.partyId)
      else setAddresses(null)
    },
    // ---- F-OP-107: Close remaining lines' preview of the lines chosen (nothing written) ----
    onClosePreview: (lineIds) => {
      const mine = ++closeSeq.current
      if (lineIds.length === 0) return setClosePreview(null)
      setClosePreview(PART_LOADING)
      previewCloseLines(api, orderId, lineIds)
        .then((answer) => mine === closeSeq.current && setClosePreview(part(answer)))
        .catch((error: unknown) => mine === closeSeq.current && setClosePreview({ value: null, problem: readProblem(error) }))
    },
    onCloseLines: (lineIds, reason, reasonCode, extraOutcome) =>
      void write(
        async () => {
          // F-OL-04: the reason only when typed (optional since ol-s1).
          const answer = await closeLines(api, orderId, { version: version(), ...(reason.trim() ? { reason: reason.trim() } : {}), ...(reasonCode ? { reasonCode } : {}), ...(lineIds.length > 0 ? { lineIds } : {}), ...(extraOutcome ? { extraOutcome } : {}) /* F-OP-107 */ })
          setClosedLines(answer)
          return answer.order
        },
        null,
        true,
      ),
    onReopenLines: (lineIds, reason) => void write(async () => (await reopenLines(api, orderId, { version: version(), ...(reason.trim() ? { reason: reason.trim() } : {}) /* F-OL-04 */, ...(lineIds.length > 0 ? { lineIds } : {}) })).order, 'notice.reopened'),
    onCancelOrder: (reason, typed, extraOutcome) => void write(async () => (await cancelOrder(api, orderId, { version: version(), reason, confirmNumber: typed, ...(extraOutcome ? { extraOutcome } : {}) /* F-OP-107 */ })).order, 'notice.cancelled'),
    // ---- F-OP-111: the parts become orders of their own (the order's version as read); the dialog then shows them, each a link, and
    // the page stays. A refusal is said at its place (a part, or the split as a whole) beside the dialog's one problem line.
    onSplit: ({ parts, reason }) => {
      const value = current.current
      if (!value) return
      const body = splitBodyOf(value, parts, reason, value.version)
      const key = newIdempotencyKey()
      setRefusals([])
      void write(
        async () => {
          try {
            const answer = await splitOrder(api, orderId, body, key)
            setMade(answer.orders)
            setNotice({ tone: 'success', words: { key: 'split.notice', params: { numbers: answer.orders.map((entry) => entry.number).join(', ') } } })
            return answer.order
          } catch (error) {
            if (isApiError(error) && error.kind === 'invalid') setRefusals(splitRefusals(error.issues, body, value))
            throw error
          }
        },
        null,
        true,
      )
    },
    // ---- end F-OP-111
    // ---- F-OO-144 (order overview 10-design §4.2; review F7): Requested by customer's small dialog — ONE amendment through the page's
    // one write (the same route as Apply): every line as it is, the new date, the order's version as read. It applies at once (no
    // yes asked); the dialog closes and the order the API answers replaces the page's. A refusal is said inside the dialog (a stale
    // version reads the order again).
    onRequestedDate: ({ date, reason }) => {
      const key = newIdempotencyKey()
      void write(async () => {
        const value = current.current!
        const answer = await applyAmendment(api, orderId, requestedBodyOf(value, date, reason), key)
        setNotice({ tone: 'success', words: appliedNotice(answer.amendment?.revision ?? (value.amendments.latestRevision ?? 0) + 1, answer.workOrders, null) })
        return answer.order
      }, null)
    },
    // ---- end F-OO-144
    // ---- F-OL-04 (pick D7; ol-s1 B-OL-020): Order facts' Customer PO and Ship to — the amendment with NO lines, the version as read, the
    // reason only when typed. The address alone writes no amendment (said as that).
    onCustomerRef: ({ value, reason }) => {
      const key = newIdempotencyKey()
      void write(async () => {
        const current0 = current.current!
        const answer = await applyAmendment(api, orderId, { version: current0.version, customerRef: value || null, ...(reason ? { reason } : {}) }, key)
        setNotice({ tone: 'success', words: { key: 'orderFacts.ref.done' } })
        return answer.order
      }, null)
    },
    onShipTo: (addressId) => {
      const key = newIdempotencyKey()
      void write(async () => {
        const current0 = current.current!
        const answer = await applyAmendment(api, orderId, { version: current0.version, shipToAddressId: addressId }, key)
        setNotice({ tone: 'success', words: { key: 'edit.shipToDone' } })
        return answer.order
      }, null)
    },
    // ---- end F-OL-04
  }

  return {
    model: { closedLines, cancelCheck, split: { addresses, refusals, made } /* F-OP-111 */, closePreview /* F-OP-107 */ },
    actions,
    readCancelCheck,
    // A dialog opens or closes: the lines the last close closed are not said again; the cancel reads its impact check as it opens.
    opened: (next) => {
      setClosedLines(null)
      // F-OP-107: Close remaining lines reads its preview as its lines are chosen (the dialog asks); nothing of an older one stays.
      closeSeq.current += 1
      setClosePreview(null)
      if (next?.kind === 'cancel') readCancelCheck()
      // F-OP-111: the split opens with nothing said yet; its Ship to reads the customer's delivery addresses (parties.view).
      setRefusals([])
      setMade(null)
      if (next?.kind === 'split' || next?.kind === 'shipTo' /* F-OL-04: Ship to reads the same addresses */) {
        const value = current.current
        if (value && mayAddresses) readAddresses(value.partyId)
        else setAddresses(null)
      }
    },
  }
}
