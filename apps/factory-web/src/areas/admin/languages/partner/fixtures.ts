import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell } from '../../shared/fixtures'
import type { ContactLanguage } from './api'
import type { PartnerModel } from './model'
import { PartnerLanguagesView } from './view/PartnerLanguagesView'

/**
 * SCR-634 — Admin › Languages & formats › per partner contact (B-W2b-432; design admin.languages/sec:documents "per
 * partner contact (W2b)", PLT-131) with made-up contacts of made-up customers and suppliers: their own language or their
 * organisation's, one who reads German (English goes out, said so), ticked contacts with Italiano / English / their
 * organisation's for N, a write in progress, the notice after a partial run, read only (parties.view without
 * parties.manage), without parties.view (the part says what it needs: the administrator template does not hold it),
 * nothing found, no contacts yet, more below, reading and failed.
 */

const cid = (n: number) => `0190f0e2-7c30-7000-8000-${String(n).padStart(12, '0')}`
const party = (n: number, name: string, language: string) => ({ id: `0190f0e2-7c31-7000-8000-${String(n).padStart(12, '0')}`, code: `PRT-${String(n).padStart(4, '0')}`, name, language })
const MODA = party(1, 'Moda Demo S.r.l.', 'it')
const RACING = party(2, 'Pista Racing Example Ltd', 'en')
const CONCERIA = party(3, 'Conceria Esempio S.p.A.', 'it')
const BERLIN = party(4, 'Beispiel Leder GmbH', 'de')

const contact = (n: number, name: string, email: string | null, of: ReturnType<typeof party>, own: string | null, out: Pick<ContactLanguage, 'language' | 'source' | 'notOffered'>): ContactLanguage => ({ contactId: cid(n), name, email, own, party: of, version: 2, ...out })
const CONTACTS: ContactLanguage[] = [
  contact(1, 'Anna Esempio', 'anna@moda-demo.example.com', MODA, null, { language: 'it', source: 'PARTY', notOffered: null }),
  contact(2, 'Luca Fittizio', 'luca@moda-demo.example.com', MODA, 'en', { language: 'en', source: 'CONTACT', notOffered: null }),
  contact(3, 'Ann Example', 'ann@pista-racing.example.com', RACING, null, { language: 'en', source: 'PARTY', notOffered: null }),
  contact(4, 'Marco Prova', null, CONCERIA, null, { language: 'it', source: 'PARTY', notOffered: null }),
  contact(5, 'Greta Beispiel', 'greta@beispiel-leder.example.com', BERLIN, null, { language: 'en', source: 'PARTY', notOffered: 'de' }),
  contact(6, 'Paolo Campione', 'paolo@pista-racing.example.com', RACING, 'it', { language: 'it', source: 'CONTACT', notOffered: null }),
]

const base = (over: Partial<PartnerModel> = {}): PartnerModel => ({
  prefix: '/w/DEMO',
  canView: true,
  canManage: true,
  read: { status: 'ready', contacts: CONTACTS, nextCursor: null, more: false },
  query: '',
  selected: [],
  saving: [],
  notice: null,
  loadingMore: false,
  ...over,
})

/** The part as it sits on the Languages page: a card across the page's grid. */
function PartnerDesign({ model }: { model: PartnerModel }) {
  const page = createElement('div', { className: 'fw-adm fw-adm-langs' }, createElement('div', { className: 'fw-adm-langs-grid' }, createElement(PartnerLanguagesView, { model })))
  return inShell('/admin/languages', page, model.canManage ? undefined : model.canView ? ['home.view', 'companies.view', 'parties.view'] : ['home.view', 'companies.view'])
}

export const designScreen = defineDesignScreen<PartnerModel>({
  screen: 'SCR-634',
  title: 'Languages & formats › per partner contact',
  view: PartnerDesign,
  cases: [
    { id: 'contacts', label: 'Partner contacts with the language their documents and mails go out in', model: base(), note: 'Their own language changed in the row (saved at once); one who reads German gets English, said so.' },
    { id: 'selected', label: 'Three contacts ticked: Italiano for 2, English for 2, their organisation’s for 2', model: base({ selected: [cid(1), cid(2), cid(6)] }) },
    { id: 'saving', label: 'A language being written', model: base({ saving: [cid(2)] }) },
    { id: 'partial', label: 'After a run for several: one refused (changed by someone else)', model: base({ notice: { key: 'tpl.partner.done.partial', tone: 'warning', params: { count: 2, refused: 1 }, refused: [{ id: cid(6), said: { key: 'tpl.partner.stale' } }] } }) },
    { id: 'done', label: 'One contact changed', model: base({ notice: { key: 'tpl.partner.done.one', tone: 'success', params: { count: 1, name: 'Luca Fittizio' } } }) },
    { id: 'more', label: 'More contacts below: Show more', model: base({ read: { status: 'ready', contacts: CONTACTS, nextCursor: 'next', more: true } }) },
    { id: 'read-only', label: 'Read only: parties.view without parties.manage', model: base({ canManage: false }), note: 'The languages read as words; the rows cannot be ticked (their box says why).' },
    { id: 'no-right', label: 'Without parties.view (a plain administrator): held with why', model: base({ canView: false, canManage: false }) },
    { id: 'no-match', label: 'Nothing found for the search', model: base({ query: 'zeta', read: { status: 'ready', contacts: [], nextCursor: null, more: false } }) },
    { id: 'empty', label: 'No partner contacts yet', model: base({ read: { status: 'ready', contacts: [], nextCursor: null, more: false } }) },
    { id: 'loading', label: 'Reading the contacts', model: base({ read: { status: 'loading' } }) },
    { id: 'failed', label: 'The contacts could not be read', model: base({ read: { status: 'failed', problem: 'problem.unavailable' } }) },
  ],
})
