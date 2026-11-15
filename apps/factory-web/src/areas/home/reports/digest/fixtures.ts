import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Digest, DigestPreview } from './api'
import { draftOf } from './model'
import { DigestPanel, type DigestPanelModel } from './view/DigestPanel'

/**
 * SCR-640 — the owner digest (design home.reports `digest`, ANA-032; Today ⋯ "Daily digest by e-mail" opens the same panel), with
 * made-up data only: never saved (off, the company's morning e-mail off), on and going out, the owner with the switches and who
 * gets it, the preview in English, editing (and held: no weekday), saving, a refused save, sections left out for a reader
 * without the lists, the preview loading or failing, the panel loading or failing, offline, and the dialog of Today. Nothing here
 * is a real company, person or number.
 */

const COMPANY_A = DEMO_COMPANIES[0]!
const COMPANY_B = DEMO_COMPANIES[1]!
const ZONE = 'Europe/Rome'

/** The Office shell around a page at this address (the owner's navigation, or a planner's). */
export function inShell(path: string, page: ReactNode, role: 'owner' | 'planner' = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(rolePermissions(role))),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const setting = (change: Partial<Digest['setting']> = {}): Digest['setting'] => ({
  saved: true,
  enabled: true,
  enabledAt: '2026-11-10T08:00:00.000Z',
  companyId: null,
  sendTime: '07:30',
  timeZone: ZONE,
  weekdays: [1, 2, 3, 4, 5],
  locale: 'it',
  sections: ['SHIPPED', 'LATE', 'NEW_ORDERS', 'WIP_STUCK', 'ALERTS', 'APPROVALS'],
  lastSentAt: '2026-11-13T06:30:00.000Z',
  version: 3,
  ...change,
})

const company = (base: { id: string; code: string; name: string }, change: Partial<Digest['companies'][number]> = {}): Digest['companies'][number] => ({
  id: base.id,
  code: base.code,
  name: base.name,
  timeZone: ZONE,
  mailOn: true,
  mailOnAt: '2026-11-09T09:00:00.000Z',
  maySwitch: false,
  switchVersion: 1,
  recipients: null,
  ...change,
})

const OWNER_DIGEST: Digest = {
  asOf: '2026-11-14T09:20:00.000Z',
  setting: setting(),
  email: DEMO_USER.email,
  held: null,
  nextAt: '2026-11-16T06:30:00.000Z',
  companies: [
    company(COMPANY_A, {
      maySwitch: true,
      recipients: [
        { id: DEMO_USER.id, name: DEMO_USER.displayName, me: true, group: true, sendTime: '07:30', timeZone: ZONE, locale: 'it' },
        { id: '0190f0e2-3333-7000-8000-000000000002', name: 'Sam Esempio', me: false, group: false, sendTime: '07:00', timeZone: ZONE, locale: 'en' },
      ],
    }),
    company(COMPANY_B, { mailOn: false, mailOnAt: null, maySwitch: true, switchVersion: 0, recipients: [{ id: DEMO_USER.id, name: DEMO_USER.displayName, me: true, group: true, sendTime: '07:30', timeZone: ZONE, locale: 'it' }] }),
  ],
}

const NEVER_SAVED: Digest = {
  ...OWNER_DIGEST,
  setting: setting({ saved: false, enabled: false, enabledAt: null, companyId: COMPANY_A.id, lastSentAt: null, version: 0 }),
  held: 'OFF',
  nextAt: null,
  companies: [company(COMPANY_A, { mailOn: false, mailOnAt: null, switchVersion: 0 })],
}

const ON_DIGEST: Digest = { ...OWNER_DIGEST, setting: setting({ companyId: COMPANY_A.id }), companies: [company(COMPANY_A), company(COMPANY_B, { mailOn: false, mailOnAt: null })] }

const SECTIONS: DigestPreview['sections'] = [
  { section: 'SHIPPED', state: 'READY', count: 4, extra: null, percent: '75.0', priceValue: null, costValue: null, currency: null, items: [{ label: 'DEMO-SH-0141', days: null, place: null, record: null }, { label: 'DEMO-SH-0142', days: null, place: null, record: null }] },
  { section: 'LATE', state: 'READY', count: 2, extra: null, percent: null, priceValue: null, costValue: null, currency: null, items: [{ label: 'DEMO-SO-0012', days: 3, place: null, record: null }, { label: 'DEMO-SO-0019', days: 1, place: null, record: null }] },
  { section: 'NEW_ORDERS', state: 'READY', count: 5, extra: null, percent: null, priceValue: 1240000, costValue: null, currency: 'EUR', items: [{ label: 'DEMO-SO-0031', days: null, place: null, record: null }] },
  { section: 'WIP_STUCK', state: 'READY', count: 3, extra: 46, percent: null, priceValue: null, costValue: 528000, currency: 'EUR', items: [{ label: 'DEMO-WO-0098', days: 5, place: 'L1', record: null }] },
  { section: 'ALERTS', state: 'READY', count: 6, extra: 2, percent: null, priceValue: null, costValue: null, currency: null, items: [{ label: 'DEMO-SO-0012', days: null, place: null, record: null }] },
  { section: 'APPROVALS', state: 'READY', count: 2, extra: null, percent: null, priceValue: null, costValue: null, currency: null, items: [{ label: 'DEMO-Q-0142', days: null, place: null, record: null }] },
]

const LINES = {
  it: [
    'Ieri, venerdì 13 novembre · Officina Demo S.r.l., Pelletteria Esempio S.p.A..',
    '',
    '• Spedito ieri: 4 spedizioni (75,0 % in tempo): DEMO-SH-0141, DEMO-SH-0142 e altri 2.',
    '• In ritardo: 2 ordini oltre la data promessa: DEMO-SO-0012 (3 giorni), DEMO-SO-0019 (1 giorno).',
    '• Nuovi ordini ieri: 5 ordini, per € 12.400,00: DEMO-SO-0031 e altri 4.',
    '• Lavorazioni ferme da più di 2 giorni: 3 ordini di lavoro, 46 capi in attesa, € 5.280,00 al costo: DEMO-WO-0098 (L1, 5 giorni) e altri 2.',
    '• Avvisi aperti: 6 (2 urgenti): DEMO-SO-0012 e altri 5.',
    '• Approvazioni che aspettano te: 2: DEMO-Q-0142 e altri 1.',
    '',
    'Numeri per azienda, linea e ordine, mai per persona.',
    'Apri Oggi: https://factory.example.com/w/DEMO/home/today',
    'Cambia o ferma questa e-mail: https://factory.example.com/w/DEMO/home/reports#digest',
  ],
  en: [
    'Yesterday, Friday 13 November · Officina Demo S.r.l., Pelletteria Esempio S.p.A..',
    '',
    '• Shipped yesterday: 4 shipments (75.0 % on time): DEMO-SH-0141, DEMO-SH-0142 and 2 more.',
    '• Late: 2 orders past the promise date: DEMO-SO-0012 (3 days), DEMO-SO-0019 (1 day).',
    '• New orders yesterday: 5 orders, worth €12,400.00: DEMO-SO-0031 and 4 more.',
    '• Work stuck for more than 2 days: 3 work orders, 46 garments waiting, €5,280.00 at cost: DEMO-WO-0098 (L1, 5 days) and 2 more.',
    '• Open alerts: 6 (2 urgent): DEMO-SO-0012 and 5 more.',
    '• Approvals waiting for you: 2: DEMO-Q-0142 and 1 more.',
    '',
    'Figures per company, line and order, never per person.',
    'Open Today: https://factory.example.com/w/DEMO/home/today',
    'Change or stop this e-mail: https://factory.example.com/w/DEMO/home/reports#digest',
  ],
}

const preview = (locale: 'it' | 'en', change: Partial<DigestPreview> = {}): DigestPreview => ({
  asOf: '2026-11-14T09:20:00.000Z',
  locale,
  companyId: null,
  day: '2026-11-13',
  today: '2026-11-14',
  companies: [COMPANY_A.name, COMPANY_B.name],
  wouldSend: true,
  sections: SECTIONS,
  mail: { subject: locale === 'it' ? 'Il riepilogo del mattino · sabato 14 novembre' : 'Your morning summary · Saturday 14 November', lines: LINES[locale], to: DEMO_USER.email },
  ...change,
})

const LEFT_OUT: DigestPreview = preview('en', {
  wouldSend: false,
  sections: [
    { section: 'SHIPPED', state: 'NO_ACCESS', count: 0, extra: null, percent: null, priceValue: null, costValue: null, currency: null, items: [] },
    { section: 'LATE', state: 'NO_ACCESS', count: 0, extra: null, percent: null, priceValue: null, costValue: null, currency: null, items: [] },
    { section: 'WIP_STUCK', state: 'READY', count: 1, extra: 12, percent: null, priceValue: null, costValue: null, currency: null, items: [{ label: 'DEMO-WO-0098', days: 5, place: 'L1', record: null }] },
    { section: 'ALERTS', state: 'READY', count: 0, extra: 0, percent: null, priceValue: null, costValue: null, currency: null, items: [] },
  ],
  mail: {
    subject: 'Your morning summary · Saturday 14 November',
    lines: [
      'Yesterday, Friday 13 November · Officina Demo S.r.l.',
      '',
      '• Work stuck for more than 2 days: 1 work order, 12 garments waiting: DEMO-WO-0098 (L1, 5 days).',
      '• Alerts: none open.',
      'Left out because of your rights: Shipped yesterday, Late orders.',
      '',
      'Figures per company, line and order, never per person.',
      'Open Today: https://factory.example.com/w/DEMO/home/today',
      'Change or stop this e-mail: https://factory.example.com/w/DEMO/home/reports#digest',
    ],
    to: DEMO_USER.email,
  },
})

const base: DigestPanelModel = { digest: { status: 'ready', data: ON_DIGEST }, preview: { status: 'ready', data: preview('it') }, previewLocale: 'it', draft: null, busy: null, offline: false, notice: null, frame: 'card' }

function DigestDesign({ model }: { model: DigestPanelModel }) {
  return inShell('/home/reports', createElement(DigestPanel, { model }), 'owner')
}

export const designScreen = defineDesignScreen<DigestPanelModel>({
  screen: 'SCR-640',
  title: 'Owner daily digest (Home › Reports; Today ⋯ Daily digest by e-mail)',
  view: DigestDesign,
  cases: [
    { id: 'on', label: 'On, going out at 07:30 site time', model: base, note: 'Mine is on for one company; its morning e-mail is switched on: next Monday 07:30, the preview in Italian.' },
    { id: 'owner', label: 'The owner: group digest, switches and who gets it', model: { ...base, digest: { status: 'ready', data: OWNER_DIGEST } }, note: 'Each company’s switch (B is OFF, the default); who gets it per company, names inside the settings only.' },
    { id: 'english', label: 'Preview in English', model: { ...base, previewLocale: 'en', preview: { status: 'ready', data: preview('en') } } },
    {
      id: 'never-saved',
      label: 'Never turned on (both switches OFF)',
      model: { ...base, digest: { status: 'ready', data: NEVER_SAVED }, preview: { status: 'ready', data: preview('it', { wouldSend: false, companies: [COMPANY_A.name] }) } },
      note: 'Off until the person turns it on; Send me a test held: the company’s morning e-mail is switched off.',
    },
    { id: 'editing', label: 'Editing (EditModeBar)', model: { ...base, draft: { ...draftOf(ON_DIGEST.setting), sendTime: '07:00', locale: 'en' } }, note: '2 changes not saved; ⌘S saves.' },
    { id: 'editing-held', label: 'Editing — Save held (no weekday)', model: { ...base, draft: { ...draftOf(ON_DIGEST.setting), weekdays: [] } } },
    { id: 'saving', label: 'Saving', model: { ...base, draft: { ...draftOf(ON_DIGEST.setting), enabled: false }, busy: 'save' } },
    { id: 'refused', label: 'Refused (changed in another window)', model: { ...base, notice: { key: 'digest.error.stale', tone: 'danger' } } },
    { id: 'test-sent', label: 'Test sent', model: { ...base, notice: { key: 'digest.done.test', tone: 'success', params: { to: DEMO_USER.email } } } },
    { id: 'left-out', label: 'Sections left out by the reader’s rights', model: { ...base, previewLocale: 'en', preview: { status: 'ready', data: LEFT_OUT } } },
    { id: 'preview-loading', label: 'Preview loading', model: { ...base, preview: { status: 'loading' } } },
    { id: 'preview-error', label: 'Preview failed', model: { ...base, preview: { status: 'error', problem: 'digest.error.read' } } },
    { id: 'offline', label: 'Offline — Edit, test and switches held', model: { ...base, digest: { status: 'ready', data: OWNER_DIGEST }, offline: true } },
    { id: 'loading', label: 'Loading', model: { ...base, digest: { status: 'loading' }, preview: { status: 'loading' } } },
    { id: 'error', label: 'Error', model: { ...base, digest: { status: 'error', problem: 'digest.error.read' } } },
    { id: 'dialog', label: 'Inside Today’s dialog (plain frame)', model: { ...base, frame: 'plain' } },
  ],
})
