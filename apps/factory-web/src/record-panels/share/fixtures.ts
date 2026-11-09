import { createElement } from 'react'
import { defineDesignScreen } from '../../lib/design/design-screen'
import type { RecordPanelsViewModel } from '../model'
import { RecordPanelsView } from '../view/RecordPanelsView'
import type { OfficeShare, RecordShares } from './api'
import { newInviteDraft, type SharesPanelModel } from './model'

/**
 * SCR-006-share — the record panels' Partners tab (B-W2b-200; COL-061, COL-062; "Share with a partner"; design shell.panels
 * "the record's followers and external participants"): made-up order, customer, people and addresses only. Invitations in
 * every state (active with each set of rights, ended, revoked), nobody invited yet, loading, a read error, a person who may
 * only see (production manager), a record with no partner, the invitation dialog (a contact on file, another address, its
 * checks, a refusal), the link given once, mailed, Change what they may do, and the revoke confirm.
 */

const id = (n: number) => `0190f0e2-5200-7000-8000-${String(n).padStart(12, '0')}`
const RECORD = { type: 'SalesOrder', id: id(1), companyId: id(2), siteId: null }
const NOW = Date.parse('2026-11-10T09:00:00.000Z')

function share(n: number, over: Partial<OfficeShare> = {}): OfficeShare {
  return {
    id: id(100 + n),
    email: 'dana@studio-fittizio.example.com',
    contact: { id: id(30 + n), name: 'Dana Esempio' },
    permissions: ['VIEW', 'COMMENT', 'UPLOAD'],
    notifyByEmail: true,
    expiresAt: '2026-11-30T22:59:00.000Z',
    state: 'LIVE',
    invitedAt: '2026-11-03T08:30:00.000Z',
    invitedBy: 'Carlo Prova',
    revoked: null,
    lastOpenedAt: '2026-11-09T16:12:00.000Z',
    may: { change: true, revoke: true },
    version: 2,
    ...over,
  }
}

const SHARES: OfficeShare[] = [
  share(1),
  share(2, { email: 'aldo.agente@agenzia-fittizia.example.com', contact: null, permissions: ['VIEW', 'COMMENT'], notifyByEmail: false, lastOpenedAt: null, version: 1 }),
  share(3, { email: 'lab@laboratorio-fittizio.example.com', contact: null, permissions: ['VIEW'], state: 'EXPIRED', expiresAt: '2026-11-01T22:59:00.000Z', may: { change: false, revoke: false } }),
  share(4, { email: 'marco@squadra-fittizia.example.com', contact: { id: id(44), name: 'Marco Esempio' }, permissions: ['VIEW', 'UPLOAD'], state: 'REVOKED', revoked: { at: '2026-11-05T10:00:00.000Z', byName: 'Carlo Prova' }, may: { change: false, revoke: false }, version: 3 }),
]

const DATA: RecordShares = {
  record: { type: 'SalesOrder', id: id(1), reference: 'SO-2026-0042' },
  party: { id: id(3), name: 'Squadra Corse Fittizia S.r.l.', language: 'it' },
  contacts: [
    { id: id(31), name: 'Dana Esempio', email: 'dana@studio-fittizio.example.com', language: 'it' },
    { id: id(32), name: 'Marco Esempio', email: 'marco@squadra-fittizia.example.com', language: 'en' },
  ],
  held: null,
  may: { invite: true },
  shares: SHARES,
}

function panel(over: Partial<SharesPanelModel> = {}): SharesPanelModel {
  return { can: { manage: true }, read: { status: 'ready', data: DATA }, invite: null, change: null, revoke: null, busy: false, notice: null, link: null, now: NOW, ...over }
}

const DRAFT = { ...newInviteDraft(DATA, NOW), until: '2026-12-10', note: 'Guardate le foto del campione e diteci se il collo va bene.' }

const base = (over: Partial<SharesPanelModel> = {}): RecordPanelsViewModel => ({
  record: RECORD,
  title: 'Ordine SO-2026-0042',
  party: { id: id(3), name: DATA.party!.name, emails: ['marco@squadra-fittizia.example.com'] },
  can: { post: true, email: true, manage: true, readFiles: true, upload: true, share: true },
  thread: null,
  messages: { items: [], more: false },
  files: { items: [], more: false },
  uploads: [],
  timeline: { items: [], more: false },
  timelineFilter: 'all',
  people: [],
  tab: 'shares',
  shares: panel(over),
})

function SharesDesign({ model }: { model: RecordPanelsViewModel }) {
  return createElement(RecordPanelsView, { model })
}

export const designScreen = defineDesignScreen<RecordPanelsViewModel>({
  screen: 'SCR-006-share',
  title: 'Record panels › Partners: share with a partner',
  view: SharesDesign,
  cases: [
    { id: 'list', label: 'Invitations in every state', model: base(), note: 'Active with every right (Change, Revoke), active read-and-write with e-mails off, ended, revoked with who and when. The tab counts the active ones.' },
    { id: 'empty', label: 'Nobody invited yet', model: base({ read: { status: 'ready', data: { ...DATA, shares: [] } } }) },
    { id: 'loading', label: 'Loading', model: base({ read: { status: 'loading' } }) },
    { id: 'error', label: 'The invitations could not be read', model: base({ read: { status: 'failed', problem: 'problem.read' } }), note: 'Our words and Try again; never an empty list.' },
    { id: 'no-right', label: 'A person who may only see (production manager)', model: base({ can: { manage: false }, read: { status: 'ready', data: { ...DATA, may: { invite: false } } } }), note: 'Share with a partner, Change and Revoke held with the reason.' },
    { id: 'no-party', label: 'A record with nobody outside to invite', model: base({ read: { status: 'ready', data: { ...DATA, party: null, contacts: [], held: 'NO_PARTY', shares: [] } } }) },
    { id: 'invite', label: 'Share with a partner (a contact on file)', model: base({ invite: { draft: DRAFT, problems: {}, problem: null } }), note: 'Whom, what they may do (reading always), until which day, a few words, by e-mail or a link to pass on, their language.' },
    { id: 'invite-email', label: 'Share with another address of theirs', model: base({ invite: { draft: { ...DRAFT, to: 'email', email: 'aldo.agente@agenzia-fittizia.example.com', upload: true }, problems: {}, problem: null } }) },
    { id: 'invite-checks', label: 'The dialog’s own checks', model: base({ invite: { draft: { ...DRAFT, to: 'email', email: 'aldo@', until: '' }, problems: { email: 'invite.problem.email', until: 'invite.problem.until' }, problem: null } }) },
    { id: 'invite-refused', label: 'Refused: invited already', model: base({ invite: { draft: DRAFT, problems: {}, problem: 'invite.problem.already' } }) },
    { id: 'invite-link', label: 'Invite · a link to pass on', model: base({ invite: { draft: { ...DRAFT, send: false }, problems: {}, problem: null } }) },
    { id: 'link-once', label: 'The link given once', model: base({ link: { url: 'https://factory.example.com/l#token=demo-token-not-real', email: 'aldo.agente@agenzia-fittizia.example.com' }, notice: { key: 'note.linkOnce', tone: 'info' } }), note: 'Copy the link; it is not shown again.' },
    { id: 'mailed', label: 'Invited by e-mail', model: base({ notice: { key: 'note.mailed', tone: 'success', params: { email: 'dana@studio-fittizio.example.com' } } }) },
    { id: 'change', label: 'Change what they may do', model: base({ change: { shareId: SHARES[0]!.id, comment: true, upload: false, problem: null } }) },
    { id: 'change-stale', label: 'Change refused: someone changed it first', model: base({ change: { shareId: SHARES[0]!.id, comment: true, upload: true, problem: 'action.problem.changed' } }) },
    { id: 'revoke', label: 'Revoke (the confirm)', model: base({ revoke: { shareId: SHARES[0]!.id, problem: null } }) },
  ],
})
