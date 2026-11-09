import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, type Role } from '../demo/fixtures'
import type { Accountants, Firm } from './api'
import { accountantRows, blankInvite, type InviteDraft } from './model'
import { AccountantAccessView, type AccountantAccessModel } from './view/AccountantAccessView'

/**
 * SCR-268-office — Finance › Close › Accounting export: Accountant access (B-W2b-201; design finance.accounting connection
 * "Portal › Accountant", FIN-158, PLT-022), with MADE-UP data only: an invented accounting firm (Studio Esempio
 * Commercialisti: Marta Esempio active, Luca Esempio invited, Sara Esempio whose access ended), an invented firm of every
 * company (Revisori Fittizi), the newest downloads. Cases: the list, access that ended shown, two chosen (End access 2), the
 * Give access pop-up (blank, filled, a firm of every company, refused), Change the end, End access, the authenticator code,
 * nobody yet, no adviser firm yet, a read-only role, loading, an error, a notice, the keys.
 */

const HOUR = 3_600_000
const NOW = Math.floor(Date.now() / HOUR) * HOUR
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()
const TODAY = at(0).slice(0, 10)
const id = (n: number) => `0190f0e2-2681-7000-8000-${String(n).padStart(12, '0')}`

const STUDIO: Firm = {
  party: { id: id(1), code: 'STUDIO-ESEMPIO', name: 'Studio Esempio Commercialisti', everyCompany: false },
  portalOn: true,
  people: [
    { id: id(11), displayName: 'Marta Esempio', email: 'marta@studio-esempio.example', status: 'ACTIVE', accessUntil: at(24 * 80), endsSoon: false, ended: false, lastSignInAt: at(-20), invitationExpiresAt: null, version: 4 },
    { id: id(12), displayName: 'Luca Esempio', email: 'luca@studio-esempio.example', status: 'INVITED', accessUntil: at(24 * 6), endsSoon: true, ended: false, lastSignInAt: null, invitationExpiresAt: at(24 * 3), version: 1 },
    { id: id(13), displayName: 'Sara Esempio', email: 'sara@studio-esempio.example', status: 'DEACTIVATED', accessUntil: at(-24 * 40), endsSoon: false, ended: true, lastSignInAt: at(-24 * 45), invitationExpiresAt: null, version: 6 },
  ],
}
const AUDITORS: Firm = { party: { id: id(2), code: 'REVISORI-FITTIZI', name: 'Revisori Fittizi S.r.l.', everyCompany: true }, portalOn: false, people: [] }

function answerOf(over: Partial<Accountants> = {}): Accountants {
  return {
    company: { id: id(3), code: 'DEMO', name: 'Officina Demo' },
    firms: [STUDIO, AUDITORS],
    downloads: [
      { at: at(-3), person: 'Marta Esempio', firm: 'Studio Esempio Commercialisti', what: 'ZIP', period: '2026-10', name: 'DEMO_2026-10_xml.zip', files: 7 },
      { at: at(-4), person: 'Marta Esempio', firm: 'Studio Esempio Commercialisti', what: 'FILE', period: '2026-10', name: 'DEMO_2026-10_sales-journal_0012.csv', files: 1 },
      { at: at(-24 * 9), person: 'Marta Esempio', firm: 'Studio Esempio Commercialisti', what: 'ZIP', period: '2026-Q3', name: 'DEMO_2026-Q3_all.zip', files: 18 },
    ],
    may: { manage: true },
    asOf: at(0),
    ...over,
  }
}

interface Case {
  role: Role
  model: AccountantAccessModel
}

function base(over: Partial<AccountantAccessModel> = {}, answer: Accountants = answerOf(), role: Role = 'finance'): Case {
  const showLeft = over.showLeft ?? false
  return {
    role,
    model: {
      state: 'ready',
      companyName: answer.company.name,
      firms: answer.firms,
      rows: accountantRows(answer, showLeft),
      showLeft,
      downloads: answer.downloads,
      may: answer.may.manage,
      selected: [],
      busy: null,
      notice: null,
      invite: null,
      change: null,
      end: null,
      stepUp: { open: false, busy: false, problem: null },
      ...over,
    },
  }
}

const invite = (draft: Partial<InviteDraft> = {}, problem: string | null = null) => ({ draft: { ...blankInvite([STUDIO], TODAY), ...draft }, problems: {}, problem, busy: false, today: TODAY })
const FILLED: Partial<InviteDraft> = { partyId: STUDIO.party.id, displayName: 'Giorgio Esempio', email: 'giorgio@studio-esempio.example' }
const rowsOf = (answer: Accountants = answerOf()) => accountantRows(answer, false)

function AccessDesign({ model }: { model: Case }) {
  return inShell('/finance/accounting', createElement(AccountantAccessView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-268-office',
  title: 'Accountant access on Finance › Close (finance.accounting › Portal › Accountant)',
  view: AccessDesign,
  cases: [
    { id: 'normal', label: 'Who has access, and the newest downloads', model: base(), note: 'Under the exports: each accountant (firm, invited / active, when access ends, last sign-in), ⋯ Change the end… / End access…; Give access…; the newest downloads (who, when, what, the period). Access that ended is hidden until asked.' },
    { id: 'show-left', label: 'Access that ended shown', model: base({ showLeft: true }), note: 'An ended row cannot be chosen (it says why).' },
    { id: 'selected', label: 'Two chosen · End access (2)', model: base({ selected: rowsOf().map((row) => row.id) }) },
    { id: 'invite', label: 'Pop-up: Give access (blank)', model: base({ invite: { ...invite(), problems: { partyId: 'office.invite.problem.firm', displayName: 'office.invite.problem.name', email: 'office.invite.problem.email' } } }), note: 'Give access waits with the first missing field in words; access lasts three months by default and always ends.' },
    { id: 'invite-filled', label: 'Pop-up: Give access (filled)', model: base({ invite: invite(FILLED) }) },
    { id: 'invite-every-company', label: 'Pop-up: a firm of every company', model: base({ invite: invite({ ...FILLED, partyId: AUDITORS.party.id }) }), note: 'The warning says the person can open any company whose portal they sign in to.' },
    { id: 'invite-refused', label: 'Pop-up: refused (the address is someone else’s)', model: base({ invite: invite(FILLED, 'office.problem.email') }) },
    { id: 'change', label: 'Pop-up: Change the end', model: base({ change: { row: rowsOf()[0]!, until: at(24 * 80).slice(0, 10), problem: null, busy: false, today: TODAY } }) },
    { id: 'end', label: 'Pop-up: End access', model: base({ end: { rows: [rowsOf()[0]!], reason: '', problem: null, busy: false } }), note: 'Their sessions end at once; an open invitation stops.' },
    { id: 'step-up', label: 'The authenticator code', model: base({ invite: invite(FILLED), stepUp: { open: true, busy: false, problem: null } }), note: 'Giving, changing or ending access opens or closes the books to an outside firm: a fresh code first.' },
    { id: 'done', label: 'Access given', model: base({ notice: { key: 'office.done.invitedOn', params: { name: 'Giorgio Esempio', email: 'giorgio@studio-esempio.example' }, tone: 'success' } }) },
    { id: 'empty', label: 'Nobody has access yet', model: base({}, answerOf({ firms: [{ ...STUDIO, portalOn: false, people: [] }], downloads: [] })) },
    { id: 'no-firm', label: 'No adviser firm yet', model: base({}, answerOf({ firms: [], downloads: [] })), note: 'Give access waits: add the firm with the Consultant role first.' },
    { id: 'read-only', label: 'Read only · sees, changes nothing', model: base({}, answerOf({ may: { manage: false } }), 'reader'), note: 'Give access, Change and End are held with who may.' },
    { id: 'loading', label: 'Loading', model: base({ state: 'loading', rows: null, downloads: null }) },
    { id: 'error', label: 'Could not be read', model: base({ state: 'error', rows: null, downloads: null }) },
    { id: 'keys', label: 'Keys in the footer info icon', model: base({ keysOpen: true }) },
  ],
})
