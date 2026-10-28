import { defineDesignScreen } from '../../lib/design/design-screen'
import { DEMO_COMPANIES, demoPdf } from '../design-data'
import type { LinkState } from './link-state'
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
    { id: 'used', label: 'Already used', model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('used') } },
    { id: 'expired', label: 'Expired', model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('expired') } },
    { id: 'wrong-person', label: 'Wrong person', model: { sender: SENDER, title: 'Quote Q-2026-0042', body: link('wrong_person') } },
    { id: 'withdrawn', label: 'Withdrawn', model: { sender: PLAIN_SENDER, title: 'Purchase order PO-2026-0007', body: link('withdrawn') }, note: 'A sender without a logo: the name, no accent.' },
    {
      id: 'unavailable',
      label: 'Opens nothing (what the API says today)',
      model: { sender: null, title: null, body: link('unavailable') },
      note: 'The API answers one 404 for used, expired, withdrawn or unknown: the page cannot name the sender.',
    },
    { id: 'missing', label: 'No token in the address', model: { sender: null, title: null, body: link('missing') } },
    { id: 'loading', label: 'Opening', model: { sender: null, title: null, body: link('loading') } },
    { id: 'error', label: 'API down', model: { sender: null, title: null, body: link('error') } },
    { id: 'privacy-notice', label: 'Privacy notice (slot)', model: { sender: SENDER, title: null, body: { kind: 'privacy', notice: null } }, note: 'GDPR art. 13/14 slot at /privacy/<company>; the text comes with B-W1-36.' },
  ],
})
