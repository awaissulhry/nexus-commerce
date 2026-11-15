import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Notice } from './api'
import type { NoticeModel } from './model'
import { NoticeView } from './view/NoticeView'

/**
 * SCR-598 — Tracking & delivery › Customer notice (B-W2b-410 on B-W2b-398; design sh-notice "sent at, to whom, delivery
 * state · Send again"). Made-up data only (contacts "Bianca Demo", "Ufficio Ordini Demo"; addresses on example.test).
 */

const uid = (n: number) => `0190f0e2-7415-7000-8000-${String(n).padStart(12, '0')}`

const notice = (over: Partial<Notice> = {}): Notice => ({
  shipment: { id: uid(1), number: 'SH-26-0107', status: 'SHIPPED', siteId: uid(2) },
  switchOn: true,
  automaticHeld: 'SENT',
  sendHeld: null,
  mayManage: true,
  recipients: [
    { contactId: uid(11), name: 'Bianca Demo', email: 'bianca@cliente-demo.example.test' },
    { contactId: uid(12), name: 'Ufficio Ordini Demo', email: 'ordini@cliente-demo.example.test' },
  ],
  mails: [
    { id: uid(21), to: ['bianca@cliente-demo.example.test', 'ordini@cliente-demo.example.test'], locale: 'it', status: 'DELIVERED', queuedAt: '2026-11-12T15:01:00.000Z', sentAt: '2026-11-12T15:01:20.000Z', deliveredAt: '2026-11-12T15:01:40.000Z', bouncedAt: null, failedAt: null, automatic: true },
  ],
  ...over,
})

const model = (over: Partial<NoticeModel> = {}, value: Notice = notice()): NoticeModel => ({ notice: { state: 'ready', value }, dialog: null, busy: false, problem: null, sent: null, ...over })

export const designScreen = defineDesignScreen<NoticeModel>({
  screen: 'SCR-598',
  title: 'Shipment › Tracking & delivery: the customer notice (sent at, to whom, delivery state, Send again)',
  view: NoticeView,
  part: true,
  cases: [
    { id: 'sent', label: 'Sent by itself when the goods left, delivered', model: model(), note: 'On Tracking & delivery of SCR-067.' },
    { id: 'off', label: 'The site\'s switch is off: by hand only, nothing sent yet', model: model({}, notice({ switchOn: false, automaticHeld: 'SWITCH_OFF', mails: [] })) },
    { id: 'send', label: 'Send again: both orders contacts ticked', model: model({ dialog: { contactIds: [uid(11), uid(12)] } }) },
    { id: 'sent-again', label: 'Sent again by hand: one address refuses our mail', model: model({ sent: { sent: 1, failed: 0, skipped: ['ordini@cliente-demo.example.test'], notice: notice() } }, notice({ mails: [{ id: uid(22), to: ['bianca@cliente-demo.example.test'], locale: 'it', status: 'SENT', queuedAt: '2026-11-15T09:00:00.000Z', sentAt: '2026-11-15T09:00:10.000Z', deliveredAt: null, bouncedAt: null, failedAt: null, automatic: false }, ...notice().mails] })) },
    { id: 'bounced', label: 'A mail bounced', model: model({}, notice({ mails: [{ ...notice().mails[0]!, status: 'BOUNCED', deliveredAt: null, bouncedAt: '2026-11-12T15:02:00.000Z' }] })) },
    { id: 'not-left', label: 'Not left yet: Send again held with why', model: model({}, notice({ shipment: { id: uid(1), number: 'SH-26-0107', status: 'PACKED', siteId: uid(2) }, automaticHeld: 'NOT_LEFT', sendHeld: 'NOT_LEFT', mails: [] })) },
    { id: 'test-labels', label: 'Left with TEST labels: never mailed', model: model({}, notice({ automaticHeld: 'TEST_LABELS', sendHeld: 'TEST_LABELS', mails: [] })) },
    { id: 'no-recipient', label: 'Nobody to mail: held with why', model: model({}, notice({ automaticHeld: 'NO_RECIPIENT', sendHeld: 'NO_RECIPIENT', recipients: [], mails: [] })) },
    { id: 'read-only', label: 'A reader without shipping.manage', model: model({}, notice({ mayManage: false })) },
    { id: 'loading', label: 'Loading', model: { notice: { state: 'loading' }, dialog: null, busy: false, problem: null, sent: null } },
    { id: 'error', label: 'Could not be read: Try again', model: { notice: { state: 'error', problem: { key: 'problem.read.unavailable' } }, dialog: null, busy: false, problem: null, sent: null } },
  ],
})
