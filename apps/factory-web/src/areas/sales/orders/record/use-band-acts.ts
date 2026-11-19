'use client'

import { useState } from 'react'
import { changePromise, closeOrder, copyAsQuote, markReady, type CopyAnswer, type Order } from '../api'
import { partnerProblem, portalAddress } from '../../../admin/users/partners/model'
import { openPreview } from '../../../admin/users/partners/preview'
// ---- F-SA-230: the ⋯ menu's People — the production lane's dialogs, reused in place (Assign supervisor…, Ask the supervisor…) ----
import { useAssignSupervisor } from '../../../_shared/production-supervisor/use-assign-supervisor'
import { useNoteDialog } from '../../../production/_shared/notes/use-note-dialog'
import type { OrderRecordActions, OrderRecordModel, RecordActsBase, RecordDialog } from './record-model'

export type BandActsModel = Pick<OrderRecordModel, 'portal' | 'people' | 'copied'>
export type BandActsActions = Pick<OrderRecordActions, 'onPortal' | 'people' | 'onPromise' | 'onReady' | 'onClose' | 'onCopyAsQuote'>

/**
 * F-OP-134 (N-5): the band's acts — its primary and the ⋯: Change promise date, Mark ready, Close order, Copy as a new quote, See it
 * in the customer's portal (B-W2b-180), People: Assign supervisor… and Ask the supervisor… (F-SA-230). Mounted by the container
 * (OrderRecord.tsx), which hands what it returns to the view as plain props; a view never imports it (view-boundaries rule 2).
 * Each write goes through the container's one write, with the order's version as last read.
 */
export function useBandActs(input: RecordActsBase & { readonly order: Order | null; readonly permissions: readonly string[] }): { model: BandActsModel; actions: BandActsActions; opened: (next: RecordDialog | null) => void } {
  const { api, orderId, current, write, version, setNotice, load, order, permissions } = input
  const [copied, setCopied] = useState<CopyAnswer | null>(null)

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
    onPromise: ({ date, reason, lineIds }) => void write(() => changePromise(api, orderId, { version: version(), promiseDate: date, reason, ...(lineIds ? { lineIds } : {}) }), 'notice.promise'),
    onReady: (reason) => void write(() => markReady(api, orderId, { version: version(), reason }), 'notice.ready'),
    onClose: (reason) => void write(() => closeOrder(api, orderId, { version: version(), ...(reason ? { reason } : {}) }), 'notice.closed'),
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
    model: { portal, people, copied },
    actions,
    // A dialog opens or closes: the copy the last one made is not said again.
    opened: () => setCopied(null),
  }
}
