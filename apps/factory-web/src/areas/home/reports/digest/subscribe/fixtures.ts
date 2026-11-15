import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_SITES } from '../../../../../shell/design-data'
import type { ReportFilter } from '../../api'
import { inShell } from '../fixtures'
import type { ReportSubscription } from './api'
import { draftOfSubscription, newDraft } from './model'
import { EmailMePanel, type EmailMeModel } from './view/EmailMePanel'

/**
 * SCR-641 — "E-mail me this" for any report (B-W2b-435; follow-up DG1:01), on a report's Schedule tab (Home › Reports › Receipts
 * due), with made-up data only: none yet (from the page's filters), on, paused, nothing changed (Save held), saving, refused,
 * offline, loading and failing.
 */

const FILTERS: readonly ReportFilter[] = [
  { key: 'site', label: 'Site', kind: 'site', default: null, choices: DEMO_SITES.map((site) => ({ value: site.id, label: site.name })) },
  { key: 'state', label: 'When', kind: 'choice', default: null, choices: [{ value: 'LATE', label: 'Late' }, { value: 'THIS_WEEK', label: 'This week' }, { value: 'LATER', label: 'Later' }] },
]

const MINE: ReportSubscription = {
  id: '0190f0e2-5555-7000-8000-000000000001',
  reportKey: 'purchasing.receipts-due',
  filters: { site: DEMO_SITES[0]!.id, state: 'LATE' },
  siteId: DEMO_SITES[0]!.id,
  sendTime: '07:00',
  timeZone: 'Europe/Rome',
  weekdays: [1, 3, 5],
  locale: 'it',
  active: true,
  lastSentAt: '2026-11-13T06:00:00.000Z',
  nextAt: '2026-11-16T06:00:00.000Z',
  version: 2,
}

const base: EmailMeModel = { reportKey: 'purchasing.receipts-due', filters: FILTERS, mine: { status: 'ready', data: MINE }, draft: draftOfSubscription(FILTERS, MINE), busy: null, offline: false, notice: null }

function EmailMeDesign({ model }: { model: EmailMeModel }) {
  return inShell('/home/reports/[key]', createElement(EmailMePanel, { model }), 'owner')
}

export const designScreen = defineDesignScreen<EmailMeModel>({
  screen: 'SCR-641',
  title: '“E-mail me this” for any report (a report’s Schedule tab)',
  view: EmailMeDesign,
  cases: [
    { id: 'none-yet', label: 'Not e-mailed yet', model: { ...base, mine: { status: 'ready', data: null }, draft: newDraft(FILTERS, { state: 'THIS_WEEK' }, 'en') }, note: 'The form starts from the filters the page shows; 07:00 on working days; my language.' },
    { id: 'on', label: 'E-mailed to me', model: base, note: 'Save changes held: nothing changed yet.' },
    { id: 'changed', label: 'Changed, not saved', model: { ...base, draft: { ...base.draft!, sendTime: '08:00', weekdays: [1, 2, 3, 4, 5] } } },
    { id: 'paused', label: 'Paused', model: { ...base, mine: { status: 'ready', data: { ...MINE, active: false, nextAt: null } } } },
    { id: 'saving', label: 'Saving', model: { ...base, draft: { ...base.draft!, sendTime: '08:00' }, busy: 'save' } },
    { id: 'subscribed', label: 'Done', model: { ...base, notice: { key: 'emailMe.done.subscribed', tone: 'success' } } },
    { id: 'refused', label: 'Refused (changed in another window)', model: { ...base, notice: { key: 'emailMe.error.stale', tone: 'danger' } } },
    { id: 'offline', label: 'Offline — held with why', model: { ...base, offline: true } },
    { id: 'loading', label: 'Loading', model: { ...base, mine: { status: 'loading' }, draft: null } },
    { id: 'error', label: 'Error', model: { ...base, mine: { status: 'error', problem: 'emailMe.error.read' }, draft: null } },
  ],
})
