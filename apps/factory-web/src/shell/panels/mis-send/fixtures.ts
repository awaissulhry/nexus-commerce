import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { MisSendCheck, MisSendModel } from './model'
import { MisSendDialog } from './view/MisSendDialog'

/**
 * SCR-437 — "Send to <party>?", the mis-send guard (B-W2b-397; COL-004; design shell.panels pop:mis-send) — made-up data
 * only (PLAN §3.1): invented organisations and people at example.invalid addresses. Each case is one answer of the check:
 * every warning at once, nothing to say, an attachment the party may not see, still checking, the check refused or failed,
 * sending.
 */

const PISTA = { id: '0190f0e2-4370-7000-8000-000000000001', name: 'Pista Esempio' }
const CLUB = { id: '0190f0e2-4370-7000-8000-000000000002', name: 'Club Inventato S.p.A.' }
const CONCERIA = { id: '0190f0e2-4370-7000-8000-000000000003', name: 'Conceria Immaginaria S.r.l.' }

const DRAFT = {
  to: ['anna@pista.example.invalid', 'bruno@club.example.invalid', 'marco.colombo@fabbrica.example.invalid', 'nuovo@conceria.example.invalid', 'chiunque@posta.example.invalid'],
  subject: 'Taglie e margine',
  body: 'Buongiorno, come per Club Inventato il costo resta. @Marco ci pensi tu?',
  attachments: ['0190f0e2-4370-7000-8000-100000000001', '0190f0e2-4370-7000-8000-100000000002'],
}

const EVERYTHING: MisSendCheck = {
  party: PISTA,
  recipients: [
    { address: 'anna@pista.example.invalid', kind: 'PARTY', source: 'CONTACT', organisation: PISTA, personName: 'Anna Esempio' },
    { address: 'bruno@club.example.invalid', kind: 'OTHER_PARTY', source: 'CONTACT', organisation: CLUB, personName: 'Bruno Inventato' },
    { address: 'marco.colombo@fabbrica.example.invalid', kind: 'OURS', source: 'COLLEAGUE', organisation: null, personName: null },
    { address: 'nuovo@conceria.example.invalid', kind: 'OTHER_PARTY', source: 'DOMAIN', organisation: CONCERIA, personName: null },
    { address: 'chiunque@posta.example.invalid', kind: 'UNKNOWN', source: null, organisation: null, personName: null },
  ],
  warnings: [
    { code: 'OTHER_ORGANISATION', items: [CLUB.name, CONCERIA.name] },
    { code: 'UNKNOWN_RECIPIENT', items: ['chiunque@posta.example.invalid'] },
    { code: 'MENTIONS_COST', items: ['costo', 'margine'] },
    { code: 'NAMES_OTHER_CUSTOMER', items: [CLUB.name] },
    { code: 'INTERNAL_MENTION', items: ['Marco Colombo'] },
  ],
  attachments: [{ id: '0190f0e2-4370-7000-8000-100000000001', name: 'Scheda taglie.pdf', sizeBytes: 182_400, audience: 'PARTY' }],
}

const CLEAN: MisSendCheck = {
  party: PISTA,
  recipients: [{ address: 'anna@pista.example.invalid', kind: 'PARTY', source: 'CONTACT', organisation: PISTA, personName: 'Anna Esempio' }],
  warnings: [],
  attachments: [{ id: '0190f0e2-4370-7000-8000-100000000001', name: 'Scheda taglie.pdf', sizeBytes: 182_400, audience: 'PARTY' }],
}

const OFFICE_FILE: MisSendCheck = {
  ...CLEAN,
  warnings: [{ code: 'OFFICE_FILE', items: ['Calcolo interno.pdf'] }],
  attachments: [...CLEAN.attachments, { id: '0190f0e2-4370-7000-8000-100000000002', name: 'Calcolo interno.pdf', sizeBytes: 2_400_000, audience: 'OFFICE' }],
}

const base: MisSendModel = { state: { status: 'ready', check: EVERYTHING }, draft: DRAFT, partyName: PISTA.name, sending: false }
const plain = { ...DRAFT, to: ['anna@pista.example.invalid'], subject: 'Conferma taglie', body: 'Buongiorno, le taglie sono confermate.' }

export const designScreen = defineDesignScreen<MisSendModel>({
  screen: 'SCR-437',
  title: 'Send to the party? (mis-send guard)',
  view: MisSendDialog,
  cases: [
    { id: 'warnings', label: 'Every warning', model: base, note: 'Another organisation among the recipients (danger: Send is red), an unknown address, cost words, another customer named, a colleague @mentioned. Send is held until the tick.' },
    { id: 'acknowledged', label: 'Warnings read', model: { ...base, acknowledged: true }, note: 'The tick is on: Send message may go (Enter).' },
    { id: 'clean', label: 'Nothing to say', model: { ...base, draft: plain, state: { status: 'ready', check: CLEAN } }, note: 'The customer’s own contact, a shared file: Send may go at once.' },
    { id: 'office-file', label: 'An office-only attachment', model: { ...base, draft: plain, state: { status: 'ready', check: OFFICE_FILE } }, note: 'The send would refuse it: held until the file is taken off (back to edit).' },
    { id: 'checking', label: 'Checking', model: { ...base, state: { status: 'checking' } } },
    { id: 'failed', label: 'The check failed', model: { ...base, state: { status: 'error', problem: 'misSend.problem.unavailable', retry: true } }, note: 'Try again; Send stays held.' },
    { id: 'no-permission', label: 'No right to send mail', model: { ...base, state: { status: 'error', problem: 'misSend.problem.forbidden', retry: false } }, note: 'The person may not send mail for this record: nothing to retry.' },
    { id: 'sending', label: 'Sending', model: { ...base, draft: plain, state: { status: 'ready', check: CLEAN }, sending: true } },
  ],
})
