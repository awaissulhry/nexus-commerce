import { defineDesignScreen } from '../../design/design-screen'
import { newInviteDraft } from '../../../record-panels/share/model'
import type { RecordShares } from '../../../record-panels/share/api'
import { BRAND_ALPHA } from '../../testing/two-brands'
import { doorHolds, viewsOffered, whoAnswers, type HeadAbilities, type HeadModel } from './model'
import { HeadCase, type HeadCaseModel } from './view/HeadCase'

/**
 * SCR-006-head — the thread's Head (B-TH-209, threads plan T1, rule R-ACT; picture 7, drawn to the approved pictures' look):
 * at ~438 px, ~718 px and the phone's 375 px — who must answer next and for how long, a View chip, the count chips, the
 * width menu and the "⋯" with Activity's doors (each opens the existing record-panels dialog; one held with its reason),
 * "Close thread…" only in an admin's copy; the closed state, offline, a record without a party. Made-up data only.
 */

const id = (n: number) => `0190f0e2-7d00-7000-8000-${String(n).padStart(12, '0')}`
// Tuesday 17 November 2026, 11:42 in Rome.
const NOW = Date.UTC(2026, 10, 17, 10, 42)
const RECORD = 'SO-2026-0142'
const PARTY = { name: BRAND_ALPHA.tradeName, role: 'customer' as const }

const ALL: HeadAbilities = { task: true, approve: true, share: true, follow: true, remind: true, manage: false, audit: true }
const RIGHTS = { approve: 'Ask partners to approve', share: 'Invite partners to records', task: 'Keep tasks', follow: 'Read threads', remind: 'Read threads' }

const MESSAGES = [
  { direction: 'OUTBOUND' as const, author: { kind: 'USER' as const }, at: '2026-11-16T15:10:00.000Z' },
  { direction: 'INTERNAL_NOTE' as const, author: { kind: 'USER' as const }, at: '2026-11-17T09:30:00.000Z' },
  { direction: 'INBOUND' as const, author: { kind: 'PARTY' as const }, at: '2026-11-17T06:40:00.000Z' },
]

const counts: HeadModel['counts'] = {
  tasks: { kind: 'tasks', count: 2, lines: [{ id: 't1', label: 'Check the collar piping on the sample', meta: 'Bea Esempio · due 18 Nov' }, { id: 't2', label: 'Send the size chart', meta: 'Alex Demo' }] },
  approvals: { kind: 'approvals', count: 1, lines: [{ id: 'a1', label: 'Sample AX-100 v2', meta: `${BRAND_ALPHA.tradeName} · due 20 Nov` }] },
  followers: { kind: 'followers', count: 3, lines: [{ id: 'f1', label: 'Alex Demo', meta: 'made it' }, { id: 'f2', label: 'Bea Esempio', meta: 'was mentioned' }, { id: 'f3', label: 'Carlo Prova', meta: 'chose to' }] },
}

function head(over: Partial<HeadModel> = {}, can: HeadAbilities = ALL, hasParty = true): HeadModel {
  return {
    record: RECORD,
    party: hasParty ? PARTY : null,
    answers: whoAnswers(MESSAGES, hasParty),
    closed: null,
    offline: null,
    view: 'all',
    views: viewsOffered({ hasShared: true, hasNotes: true, canAudit: can.audit }),
    counts,
    holds: doorHolds({ can, hasParty, offline: false, rights: RIGHTS }),
    follow: { following: true, muted: false },
    reminder: null,
    canManage: can.manage,
    width: 'forty',
    print: true,
    now: NOW,
    ...over,
  }
}

const SHARES: RecordShares = {
  record: { type: 'SalesOrder', id: id(1), reference: RECORD },
  party: { id: id(3), name: BRAND_ALPHA.tradeName, language: 'en' },
  contacts: [{ id: id(31), name: BRAND_ALPHA.contact.name, email: BRAND_ALPHA.contact.email, language: 'en' }],
  held: null,
  may: { invite: true },
  shares: [],
}

const DIALOGS: HeadCaseModel['dialogs'] = {
  now: NOW,
  people: { status: 'ready', data: [{ id: id(11), name: 'Alex Demo', me: true }, { id: id(12), name: 'Bea Esempio', me: false }, { id: id(13), name: 'Carlo Prova', me: false }] },
  approvals: {
    can: { ask: true },
    read: { status: 'ready', kinds: ['SAMPLE', 'COLOUR', 'ARTWORK'], held: null, requests: [] },
    ask: { draft: { kind: 'SAMPLE', question: 'Here is the corrected sample with the yellow piping. Is it right for production?', dueAt: '2026-11-20T16:00:00.000Z', fileIds: [id(401)], send: true, email: BRAND_ALPHA.contact.email, language: '' }, problems: {}, problem: null },
    files: [{ id: id(401), name: 'AX-100 sample front.jpg', contentType: 'image/jpeg' }, { id: id(402), name: 'AX-100 sample back.jpg', contentType: 'image/jpeg' }],
    party: { name: BRAND_ALPHA.tradeName, emails: [BRAND_ALPHA.contact.email] },
    withdraw: null,
    busy: false,
    notice: null,
    link: null,
    now: NOW,
  },
  shares: { can: { manage: true }, read: { status: 'ready', data: SHARES }, invite: { draft: { ...newInviteDraft(SHARES, NOW), note: 'Please look at the sample photos.' }, problems: {}, problem: null }, change: null, revoke: null, busy: false, notice: null, link: null, now: NOW },
  followers: {
    count: 3,
    me: { following: true, muted: false },
    list: [
      { userId: id(11), name: 'Alex Demo', me: true, reason: 'CREATOR', muted: false, since: '2026-11-02T10:20:00.000Z', addedBy: null },
      { userId: id(12), name: 'Bea Esempio', me: false, reason: 'MENTIONED', muted: false, since: '2026-11-05T09:00:00.000Z', addedBy: null },
      { userId: id(13), name: 'Carlo Prova', me: false, reason: 'CHOSE', muted: true, since: '2026-11-06T12:00:00.000Z', addedBy: null },
    ],
    candidates: [{ id: id(14), name: 'Dora Campione' }],
    canAdd: true,
  },
}

const both = [438, 718] as const
const all = [438, 718, 375] as const
const c = (headModel: HeadModel, frames: HeadCaseModel['frames'] = all, open: HeadCaseModel['open'] = null): HeadCaseModel => ({ head: headModel, frames, dialogs: DIALOGS, open })

export const designScreen = defineDesignScreen<HeadCaseModel>({
  screen: 'SCR-006-head',
  title: 'Thread head with Activity’s doors (B-TH-209)',
  view: HeadCase,
  cases: [
    { id: 'waiting-on-us', label: 'Waiting on us · 4 h, at 438, 718 and 375 px', model: c(head()), note: 'The last shared message came from Brand Alpha (an office note never flips it). Hover or focus the pill: since when, in clock hours. At 438 px the count chips fold into the "⋯" (their counts on the doors’ lines); the phone head shows the record and the pill.' },
    { id: 'waiting-on-customer', label: 'Waiting on customer · 2 d', model: c(head({ answers: { on: 'party', since: '2026-11-15T09:00:00.000Z' }, counts: {} }), both), note: 'A person of ours wrote last; no count chip (all zero). The "⋯" still holds the five tools (R-ACT).' },
    { id: 'view-notes', label: 'View: Office notes (the chip)', model: c(head({ view: 'notes' }), both), note: 'A chip names the view when it is not All; its × shows everything again.' },
    { id: 'menu-held', label: 'A door held with its reason', model: c(head({}, { ...ALL, approve: false, share: false })), note: 'Open "⋯": Ask a partner to approve and Share with a partner are there, held with the right they need — never hidden.' },
    { id: 'no-party', label: 'A record without a customer', model: c(head({ answers: null }, ALL, false), both), note: 'No pill (nobody to wait on); Ask and Share held "This record has no customer or supplier".' },
    { id: 'admin', label: 'An administrator’s copy: Close thread…', model: c(head({}, { ...ALL, manage: true }), both), note: '"Close thread…" only with threads.manage; it opens "Close thread?" with the consequence in words.' },
    { id: 'closed', label: 'Closed thread', model: c(head({ closed: { by: 'Alex Demo', at: '2026-11-12T16:00:00.000Z' } }, { ...ALL, manage: true }), both), note: '"Closed by Alex Demo, 12 Nov" in place of the pill; Reopen for threads.manage; the doors stay open.' },
    { id: 'offline', label: 'Offline', model: c(head({ offline: { asOf: '2026-11-17T09:42:00.000Z' }, holds: doorHolds({ can: ALL, hasParty: true, offline: true, rights: RIGHTS }) }), both), note: '"Offline · as of 10:42"; every door held "You are offline".' },
    { id: 'reminder-set', label: 'My reminder is set; muted', model: c(head({ reminder: { at: '2026-11-20T07:00:00.000Z' }, follow: { following: true, muted: true } }), both), note: 'The "⋯" says "Reminder set for 20 Nov" and offers Unmute ("news stops; mentions still come").' },
    { id: 'portal-need-info', label: 'Portal: the plain line (Need info)', model: { ...c(head(), [718, 375]), portal: { needInfo: true, last: { from: 'us', at: '2026-11-16T15:10:00.000Z' }, factory: 'Factory Demo' } }, note: 'The customer reads one plain line from real states; no owner, no waiting time, no office count (W08, W34).' },
    { id: 'portal-last', label: 'Portal: the last message', model: { ...c(head(), [718, 375]), portal: { needInfo: false, last: { from: 'you', at: '2026-11-17T06:40:00.000Z' }, factory: 'Factory Demo' } } },
    { id: 'door-task', label: 'Add task → the existing New task dialog', model: c(head(), both, 'task') },
    { id: 'door-approve', label: 'Ask a partner to approve → the existing dialog', model: c(head(), both, 'approve') },
    { id: 'door-share', label: 'Share with a partner → the existing dialog', model: c(head(), both, 'share') },
    { id: 'door-followers', label: 'Followers → the existing popover', model: c(head(), both, 'followers') },
    { id: 'door-remind', label: 'Remind me → the existing dialog', model: c(head(), both, 'remind') },
  ],
})
