import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_SITES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { LocalMailboxModel, MailboxMessage } from './model'
import { LocalMailboxView } from './view/LocalMailboxView'

/**
 * SCR-007-mailbox (B-W2b-F58): the Local mailbox of the Owner's local test server, with made-up mail (example.com addresses,
 * made-up tokens that open nothing).
 */

const SHELL: OfficeShellViewModel = {
  nav: officeNavFor(permissionCheck(OWNER_PERMISSIONS)),
  path: '/me/mailbox',
  switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: DEMO_SITES, site: null, path: '/me/mailbox' },
  user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
  tenantTag: DEMO_TAG,
  banners: [],
  localMailbox: true,
}

function MailboxDesign({ model }: { model: LocalMailboxModel }) {
  return createElement(OfficeShellView, { model: SHELL }, createElement(LocalMailboxView, { model }))
}

const INVITE: MailboxMessage = {
  id: 'fake-0190f0e2-0001',
  sentAt: '2026-11-15T17:40:12.000Z',
  templateKey: 'auth.invitation',
  from: 'Officina Demo <no-reply@demo.example.com>',
  to: ['nina.nuova@example.com'],
  cc: [],
  bcc: [],
  subject: 'You are invited to Officina Demo',
  text: 'Hello Nina,\n\nAda Esempio invited you to Officina Demo on Nexus Factory.\nSet your password here (the link works for 7 days):\nhttp://localhost:3300/accept-invitation#token=made-up-invitation-token\n\nOfficina Demo',
  links: ['http://localhost:3300/accept-invitation#token=made-up-invitation-token'],
}
const RESET: MailboxMessage = {
  id: 'fake-0190f0e2-0002',
  sentAt: '2026-11-15T17:52:40.000Z',
  templateKey: 'auth.password_reset',
  from: 'Officina Demo <no-reply@demo.example.com>',
  to: ['ada.esempio@example.com'],
  cc: [],
  bcc: [],
  subject: 'Reset your password',
  text: 'Someone asked to reset the password of ada.esempio@example.com.\nChoose a new one here (the link works for one hour):\nhttp://localhost:3300/reset-password#token=made-up-reset-token\n\nNot you? Ignore this mail.',
  links: ['http://localhost:3300/reset-password#token=made-up-reset-token'],
}
const QUOTE: MailboxMessage = {
  id: 'fake-0190f0e2-0003',
  sentAt: '2026-11-15T18:05:03.000Z',
  templateKey: 'record.email',
  from: 'Sara Vendite via Officina Demo <sales@demo.example.com>',
  to: ['buyer@brand.example.com'],
  cc: ['sara.vendite@demo.example.com'],
  bcc: ['archive@demo.example.com'],
  subject: 'Quote Q-2026-00042 for the spring jackets',
  text: 'Dear buyer,\n\nhere is our quote Q-2026-00042. You can accept it online:\nhttp://localhost:3300/l#token=made-up-quote-token\n\nKind regards,\nSara Vendite',
  links: ['http://localhost:3300/l#token=made-up-quote-token'],
}

export const designScreen = defineDesignScreen<LocalMailboxModel>({
  screen: 'SCR-007-mailbox',
  title: 'Local mailbox (local test server only)',
  view: MailboxDesign,
  cases: [
    { id: 'normal', label: 'Three mails', model: { state: 'ok', messages: [QUOTE, RESET, INVITE] }, note: 'Newest first: a quote with its accept link, a password reset, an invitation. Each link opens in a new tab; the banner says to use a private window for links that sign someone in.' },
    { id: 'empty', label: 'No mail yet', model: { state: 'ok', messages: [] } },
    { id: 'failed', label: 'The API did not answer', model: { state: 'failed', code: 'unavailable' } },
  ],
})
