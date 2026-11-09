import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_COMPANIES, demoPdf } from '../design-data'
import type { LinkState } from './link-state'
import type { LinkRenew, RenewState } from './renew/model'
import { LinkFrameView, type LinkFrameViewModel, type LinkSender } from './view/LinkFrameView'

// A made-up sender: name, an inline logo (an SVG word mark), an accent that passes the DS contrast check, a contact.
const LOGO = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><rect width="40" height="40" rx="8" fill="#7a2e0e"/><text x="52" y="27" font-family="Helvetica" font-size="18" font-weight="700" fill="#3b1a08">Officina Demo</text></svg>')}`
// The same mark for the dark theme: light text (the DS swaps it in under `.dark`).
const LOGO_DARK = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><rect width="40" height="40" rx="8" fill="#e8a27c"/><text x="52" y="27" font-family="Helvetica" font-size="18" font-weight="700" fill="#f4e4d8">Officina Demo</text></svg>')}`
const SENDER: LinkSender = {
  name: DEMO_COMPANIES[0].name,
  logoUrl: LOGO,
  logoDarkUrl: LOGO_DARK,
  accent: '#7a2e0e',
  companyId: DEMO_COMPANIES[0].id,
  contact: { name: 'Ufficio vendite Demo', email: 'vendite@example.com', phone: '+39 000 000 0000' },
}
const PLAIN_SENDER: LinkSender = { name: DEMO_COMPANIES[1].name, companyId: DEMO_COMPANIES[1].id }

const link = (state: LinkState, extra: Partial<Extract<LinkFrameViewModel['body'], { kind: 'link' }>> = {}): LinkFrameViewModel['body'] => ({
  kind: 'link',
  state,
  purpose: null,
  expiresAt: null,
  usesLeft: null,
  ...extra,
})

// B-W2b-169: "Ask for a new link" on a dead link (the landing's provider gives it live; a case gives its state).
const renew = (state: RenewState = 'idle', waitUntil: string | null = null): LinkRenew => ({ state, waitUntil, ask: () => undefined })

const PDF = demoPdf(['Officina Demo S.r.l.', 'Delivery note DDT 2026/0042 (made-up)', '', 'Demo jacket, black, size 50 - 2 pieces', 'Demo gloves, size L - 4 pairs'])

export const designScreen = defineDesignScreen<LinkFrameViewModel>({
  screen: 'SCR-028',
  title: 'Link frame & link states',
  view: LinkFrameView,
  cases: [
    {
      id: 'valid',
      label: 'Valid',
      model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('valid', { purpose: 'QUOTE_ACCEPT', expiresAt: '2026-11-27T22:59:00.000Z', usesLeft: 1 }) },
      note: 'Sender logo and accent (branding tokens), title, language, privacy notice link. The quote itself is W1 (SCR-099).',
    },
    {
      id: 'valid-document',
      label: 'Valid: a document',
      model: { sender: SENDER, title: 'DDT 2026/0042', body: link('valid', { purpose: 'DOCUMENT_VIEW', expiresAt: '2026-11-27T22:59:00.000Z', usesLeft: 19, document: { title: 'DDT 2026/0042', fileName: 'DDT-2026-0042.pdf', data: PDF } }) },
      note: 'The PDF viewer with this app\'s lazily loaded pdf.js.',
    },
    { id: 'used', label: 'Already used: Ask for a new link', model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('used'), renew: renew() } },
    { id: 'expired', label: 'Expired: Ask for a new link', model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('expired'), renew: renew() } },
    { id: 'wrong-person', label: 'Wrong person', model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('wrong_person') } },
    { id: 'withdrawn', label: 'Withdrawn', model: { sender: PLAIN_SENDER, title: 'Purchase order PO-2026-0007', body: link('withdrawn') }, note: 'A sender without a logo: the name, no accent.' },
    {
      id: 'unavailable',
      label: 'Opens nothing (what the API says today)',
      model: { sender: null, title: null, body: link('unavailable'), renew: renew() },
      note: 'The API answers one 404 for used, expired, withdrawn or unknown: the page cannot name the sender. Ask for a new link sends the dead token (POST /link/renew).',
    },
    // B-W2b-169: the states of "Ask for a new link" (design links.frame sec:ask-new-link).
    { id: 'ask-busy', label: 'Ask for a new link: asking', model: { sender: null, title: null, body: link('unavailable'), renew: renew('busy') } },
    {
      id: 'ask-done',
      label: 'Asked — we passed it on (one answer, whatever the link was)',
      model: { sender: null, title: null, body: link('unavailable'), renew: renew('done') },
      note: 'Pressed once → held. The new link only ever goes to the address on file.',
    },
    { id: 'ask-checking', label: 'Ask for a new link: the connection is checked first (after suspicious traffic)', model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('expired'), renew: renew('checking') } },
    { id: 'ask-wait', label: 'Asked too often: held until 10:57', model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('used'), renew: renew('wait', '2026-11-09T09:57:00.000Z') } },
    { id: 'ask-failed', label: 'The request did not reach us: Ask again', model: { sender: null, title: null, body: link('unavailable'), renew: renew('failed') } },
    // B-W2b-F17: the reader's note to the sender, and the answer naming who was told.
    {
      id: 'ask-note',
      label: 'Ask for a new link with a note for the sender',
      model: { sender: SENDER, title: 'Approval request', body: link('expired', { purpose: 'APPROVAL' }), renew: { ...renew(), note: 'Made-up: we need a few more days to look at the sample.', setNote: () => undefined } },
      note: 'A kind with no renewer (an approval, a quote, a payment, an invitation): the person who made the link is told, with the record and this note; no new link by itself.',
    },
    {
      id: 'ask-done-sender',
      label: 'Asked — passed on to the sender by name',
      model: { sender: SENDER, title: 'Approval request', body: link('expired', { purpose: 'APPROVAL' }), renew: { ...renew('done'), note: 'Made-up note', setNote: () => undefined } },
    },
    { id: 'missing', label: 'No token in the address', model: { sender: null, title: null, body: link('missing') } },
    { id: 'loading', label: 'Opening', model: { sender: null, title: null, body: link('loading') } },
    { id: 'error', label: 'API down', model: { sender: null, title: null, body: link('error') } },
    { id: 'privacy-notice', label: 'Privacy notice (slot)', model: { sender: SENDER, title: null, body: { kind: 'privacy', notice: null } }, note: 'GDPR art. 13/14 slot at /privacy/<company>; the text comes with B-W1-36.' },
  ],
})
