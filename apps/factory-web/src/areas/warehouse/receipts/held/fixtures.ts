import { createElement, Fragment } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CANCELLED_RECEIPT, heldModel, REFUSED_REQUESTS, RELEASED_RECEIPT } from './demo/fixtures'
import type { HeldModel } from './use-held-receipt'
import { CancelHeldDialog, HeldBanner } from './view/HeldBanner'

/**
 * SCR-062-held — a goods receipt that waits for a yes, on its record (B-W2b-382, the screen gap B-W2b-377 left; SCM-061), made-up
 * data only: the banner above the receipt's tabs (which lines wait and why, who is asked, the request opened in Home ›
 * Approvals, Cancel), a refused line, every line approved (Post), the cancel dialog with its reason, a person who does not
 * receive goods (Cancel held with why), offline, posted and cancelled receipts after the click, and the requests unread (a
 * person without approvals.view).
 */
function HeldDesign({ model }: { model: HeldModel }) {
  return createElement(Fragment, null, createElement(HeldBanner, { model }), createElement(CancelHeldDialog, { model }))
}

export const designScreen = defineDesignScreen<HeldModel>({
  screen: 'SCR-062-held',
  title: 'Goods receipt › waits for a yes (B-W2b-382)',
  view: HeldDesign,
  cases: [
    { id: 'waiting', label: 'Warehouse · one line beyond its tolerance waits for a yes from Purchasing', model: heldModel(), note: 'Nothing posted: no lot, no move, the order unchanged; Open the request; Cancel.' },
    { id: 'unread', label: 'A person without approvals.view: the request is not named (only that it waits)', model: heldModel({ requests: null, held: [] }) },
    { id: 'refused', label: 'The yes was refused: cancel and receive again within the tolerance', model: heldModel({ state: 'refused', requests: REFUSED_REQUESTS }) },
    { id: 'released', label: 'Every line has its yes: posted by itself in a moment, else Post here', model: heldModel({ receipt: RELEASED_RECEIPT, state: 'released', requests: null }) },
    { id: 'post-refused', label: 'Post refused: a line still waits (said in words, read again)', model: heldModel({ receipt: RELEASED_RECEIPT, state: 'released', requests: null, problem: 'held.problem.held' }) },
    { id: 'cancel-dialog', label: 'Cancel GR-2026-0024? — the reason (Cancel held until it is written)', model: heldModel({ dialog: { reason: '', problem: null } }) },
    { id: 'cancel-typed', label: 'Cancel with a reason typed', model: heldModel({ dialog: { reason: 'I pezzi in più tornano al fornitore.', problem: null } }) },
    { id: 'cancel-refused', label: 'Cancel refused: posted or cancelled meanwhile (read again)', model: heldModel({ dialog: { reason: 'Doppio ricevimento.', problem: 'held.problem.state' } }) },
    { id: 'cancelled', label: 'Cancelled: its requests withdrawn', model: heldModel({ receipt: CANCELLED_RECEIPT, state: 'none', done: { key: 'held.notice.cancelled', number: CANCELLED_RECEIPT.number } }) },
    { id: 'posted', label: 'Posted after the last yes (Post here)', model: heldModel({ receipt: { ...RELEASED_RECEIPT, status: 'POSTED' }, state: 'none', done: { key: 'held.notice.posted', number: RELEASED_RECEIPT.number } }) },
    { id: 'no-right', label: 'A buyer (no inventory.receive): Cancel held with why', model: heldModel({ actionHeld: 'held.noReceive' }) },
    { id: 'offline', label: 'Offline: Cancel held with why', model: heldModel({ actionHeld: 'held.offline' }) },
  ],
})
