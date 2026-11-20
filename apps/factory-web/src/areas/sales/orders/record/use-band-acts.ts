'use client'

import { useState } from 'react'
import { changePromise, closeOrder, copyAsQuote, markReady, type CopyAnswer, type Order } from '../api'
import { partnerProblem, portalAddress } from '../../../admin/users/partners/model'
import { openPreview } from '../../../admin/users/partners/preview'
// ---- F-SA-230: the ⋯ menu's People — the production lane's dialogs, reused in place (Assign supervisor…, Ask the supervisor…) ----
import { useAssignSupervisor } from '../../../_shared/production-supervisor/use-assign-supervisor'
import { useNoteDialog } from '../../../production/_shared/notes/use-note-dialog'
import type { OrderRecordActions, OrderRecordModel, Part, RecordActsBase, RecordDialog } from './record-model'
// ---- F-OP-101: the approver's yes in place — the approval engine's own routes, the page's step-up ----
import { newIdempotencyKey } from '../../../../lib/api/client'
import { readProblem } from '../model'
import { promiseBodyOf } from '../model' // F-OO-142: the picked reason and the office's note (B-OO-009)
import type { ProductionPart } from './overview/api' // F-OO-142: the production read's parts a promise save reads again
import { approveTask, listRejectReasons, rejectTask, type RejectReason } from '../../../home/approvals/api'
import { decidedNoticeOf } from '../depth/model'
import type { useStepUp } from '../hooks'

export type BandActsModel = Pick<OrderRecordModel, 'portal' | 'people' | 'copied' | 'refuseReasons'>
export type BandActsActions = Pick<OrderRecordActions, 'onPortal' | 'people' | 'onPromise' | 'onReady' | 'onClose' | 'onCopyAsQuote' | 'yes'>

/**
 * F-OP-134 (N-5): the band's acts — its primary and the ⋯: Change promise date, Mark ready, Close order, Copy as a new quote, See it
 * in the customer's portal (B-W2b-180), People: Assign supervisor… and Ask the supervisor… (F-SA-230). Mounted by the container
 * (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it (view-boundaries rule 2).
 * Each write goes through the container's one write, with the order's version as last read.
 */
// F-OP-101: + the page's step-up (the yes asks a fresh one when its rule does) and its one dialog slot (Refuse… opens there).
export function useBandActs(
  input: RecordActsBase & {
    readonly order: Order | null
    readonly permissions: readonly string[]
    readonly stepUp: Pick<ReturnType<typeof useStepUp>, 'ensureFresh' | 'guard'>
    readonly setDialog: (dialog: RecordDialog | null) => void
    /** F-OO-142 (W10's follow-up): read parts of the production read again (its `again`), after a promise save. */
    readonly againProduction?: (parts?: readonly ProductionPart[]) => void
  },
): { model: BandActsModel; actions: BandActsActions; opened: (next: RecordDialog | null) => void } {
  const { api, orderId, current, write, version, setNotice, load, order, permissions, stepUp, setDialog } = input
  const [copied, setCopied] = useState<CopyAnswer | null>(null)

  // ---- F-OP-101 (10-order-page §2.4; rule 42): the yes in place. Each decision sends the task's version as the order read lists it;
  // the engine re-checks it (W39-02's seeded request answers STALE on a yes: its words say so, the no still clears it). Once decided
  // the order is read again (the band re-reads: a confirmed order's primary becomes Make work orders).
  const [refuseReasons, setRefuseReasons] = useState<Part<RejectReason[]> | null>(null)
  const taskOf = (taskId: string) => (current.current?.openApprovals ?? []).find((task) => task.taskId === taskId) ?? null
  const readReasons = () => {
    setRefuseReasons({ value: null, problem: null })
    listRejectReasons(api)
      .then((reasons) => setRefuseReasons({ value: reasons, problem: null }))
      .catch((error: unknown) => setRefuseReasons({ value: null, problem: readProblem(error) }))
  }
  const yes: NonNullable<BandActsActions['yes']> = {
    onConfirm: (taskId) => {
      const task = taskOf(taskId)
      if (!task) return
      // One key for the yes and its repeat after the code: the engine answers the second from its receipt.
      const key = newIdempotencyKey()
      void write(async () => {
        if (task.requireStepUp) await stepUp.ensureFresh('approval.stepUp')
        await stepUp.guard('approval.stepUp', () => approveTask(api, { id: task.taskId, version: task.version }, null, key))
        return null
      }, decidedNoticeOf(task, 'approve'))
    },
    onRefuse: (taskId) => {
      if (!taskOf(taskId)) return
      setDialog({ kind: 'refuseYes', taskId })
      readReasons()
    },
    onRefuseConfirm: (taskId, reasonCode, words) => {
      const task = taskOf(taskId)
      if (!task) return
      void write(async () => {
        await stepUp.guard('approval.stepUp', () => rejectTask(api, { id: task.taskId, version: task.version }, reasonCode, words))
        return null
      }, decidedNoticeOf(task, 'reject'))
    },
    onRefuseReasons: readReasons,
  }
  // ---- end F-OP-101

  // B-W2b-180: "See it in the customer's portal" — the office person's preview of the customer's portal at this order.
  const [portalOpening, setPortalOpening] = useState(false)
  const portal = permissions.includes('partners.preview') ? { held: null, opening: portalOpening } : { held: { key: 'held.portalRight' }, opening: false }

  // ---- F-SA-230: the band's ⋯ People — Assign supervisor… (production.brand.manage) and Ask the supervisor… (threads.post: an office
  // note on THIS order, its supervisor asked), the production lane's own dialogs. A Send reads the order again.
  const assign = useAssignSupervisor(api, () => void load())
  const mayNote = permissions.includes('threads.post')
  const note = useNoteDialog(api, { can: mayNote, onDone: () => void load() })
  const people = {
    mayAssign: permissions.includes('production.brand.manage'),
    mayNote,
    assign: assign.model,
    note: note.model,
  }
  // ---- end F-SA-230

  const actions: BandActsActions = {
    onPortal: () => {
      if (!order?.party || portalOpening) return
      setPortalOpening(true)
      openPreview(api, order.partyId, portalAddress(order.party.code, { type: 'SalesOrder', id: order.id }))
        .catch((error: unknown) => {
          const problem = partnerProblem(error)
          setNotice({ tone: 'danger', words: { key: problem === 'problem.forbidden' ? 'portal.forbidden' : problem === 'problem.noKind' ? 'portal.noKind' : 'portal.failed' } })
        })
        .finally(() => setPortalOpening(false))
    },
    // ---- F-SA-230: the ⋯ People (the production lane's dialogs) ----
    people: {
      onAssign: () => {
        const value = current.current
        if (!value || !people.mayAssign) return
        assign.open([{ orderId: value.id, number: value.number, customerRef: value.customerRef, partyId: value.partyId, partyName: value.party?.legalName ?? value.party?.code ?? '—', companyId: value.companyId }])
      },
      onAsk: () => {
        const value = current.current
        if (!value || !mayNote) return
        note.open({ workOrders: [], salesOrders: [{ type: 'SalesOrder', id: value.id, label: value.number, partyId: value.partyId, partyName: value.party?.legalName ?? value.party?.code ?? null, companyId: value.companyId }], withoutOrder: 0 }, 'band', 'salesOrders')
      },
      assign: assign.actions,
      note: note.actions,
    },
    // F-OO-142 (B-OO-009): the picked reason (what the customer reads) and the office's note. A saved promise also reads the production
    // read's headline and dates again (Decide…'s refused-date row, the moves and "Plan says ready"), not only when the live stream hears it.
    onPromise: (promise) =>
      void write(async () => {
        const next = await changePromise(api, orderId, promiseBodyOf(promise, version()))
        input.againProduction?.(['headline', 'dates'])
        return next
      }, 'notice.promise'),
    onReady: (reason) => void write(() => markReady(api, orderId, { version: version(), reason }), 'notice.ready'),
    onClose: (reason) => void write(() => closeOrder(api, orderId, { version: version(), ...(reason ? { reason } : {}) }), 'notice.closed'),
    yes, // F-OP-101
    onCopyAsQuote: () =>
      void write(
        async () => {
          setCopied(await copyAsQuote(api, orderId))
          return null
        },
        null,
        true,
      ),
  }

  return {
    model: { portal, people, copied, refuseReasons },
    actions,
    // A dialog opens or closes: the copy the last one made is not said again; F-OP-101: the reasons go with their dialog.
    opened: (next) => {
      setCopied(null)
      if (next?.kind !== 'refuseYes') setRefuseReasons(null)
    },
  }
}
