import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { ClaimLinkModel } from './model'
import { OTHER_ADDRESS } from './model'
import { ClaimLinkDialog } from './view/ClaimLinkDialog'

/**
 * T.1 (order SHIPMENTS tab; F-OS-303, 10-design §5 / §6) — Send a claim link…, opened from a shipped row's ⋯ (for that shipment) or the
 * Complaints & returns head's ⋯ (for the order): to whom (a contact of the customer, or an address typed), sent, refused. Made-up data
 * only (Seed Customer One; addresses on example.com).
 */

const uid = (n: number) => `0190f0e2-7496-7000-8000-${String(n).padStart(12, '0')}`
const CONTACTS = [
  { id: uid(1), name: 'Lia Cliente', email: 'lia.cliente@example.com' },
  { id: uid(2), name: 'Ufficio acquisti', email: 'acquisti@seed-customer.example.com' },
]

const model = (over: Partial<ClaimLinkModel> = {}): ClaimLinkModel => ({ record: { type: 'Shipment', id: uid(12), number: 'SEED-SH-0012' }, contacts: CONTACTS, to: '', email: '', busy: false, problem: null, sent: null, ...over })
const sent = (delivery: 'SENT' | 'QUEUED' | 'FAILED') => ({ link: { id: uid(90), expiresAt: '2026-12-22T10:00:00.000Z', email: 'lia.cliente@example.com' }, delivery })

export const designScreen = defineDesignScreen<ClaimLinkModel>({
  screen: 'SCR-111-claim',
  title: 'Send a claim link…: a link for the customer to ask for a return or report a quality problem (the order\'s Shipments tab)',
  view: ClaimLinkDialog,
  part: true,
  cases: [
    { id: 'pick', label: 'For a shipment that left: nobody picked yet (Send held with why)', model: model() },
    { id: 'contact', label: 'To Lia Cliente (a contact with an e-mail)', model: model({ to: uid(1) }) },
    { id: 'other', label: 'To another address typed', model: model({ to: OTHER_ADDRESS, email: 'resi@seed-customer.example.com' }) },
    { id: 'order', label: 'For the whole order (the section head\'s ⋯)', model: model({ record: { type: 'SalesOrder', id: uid(2), number: 'SEED-SO-0002' }, to: uid(2) }) },
    { id: 'no-contact', label: 'No contact with an e-mail (or no right to read them): only an address typed', model: model({ contacts: [] }) },
    { id: 'reading', label: 'Reading the customer\'s contacts', model: model({ contacts: null }) },
    { id: 'sent', label: 'Sent: to whom and until when', model: model({ to: uid(1), sent: sent('SENT') }) },
    { id: 'sent-failed', label: 'Made, but the e-mail failed: send a new one later', model: model({ to: uid(1), sent: sent('FAILED') }) },
    { id: 'refused', label: 'Refused: the address bounced before', model: model({ to: OTHER_ADDRESS, email: 'lia.cliente@example.com', problem: 'claim.refusal.SUPPRESSED' }) },
  ],
})
