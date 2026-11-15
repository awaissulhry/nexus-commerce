import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { useLocale } from '../../../lib/i18n/provider'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView } from '../../../shell/office/view/OfficeShellView'
import type { MyProfileViewModel } from '../me-model'
import { MyProfileView } from '../view/MyProfileView'
import type { MyData, MyRequest } from './api'
import type { MyDataModel } from './model'
import { MyDataView } from './view/MyDataView'

/**
 * SCR-663 My profile › Download my data with made-up data: the demo person (example.com), invented requests and an invented
 * package name. The button sits in My profile's head (SCR-007); the dialog opens over the page.
 */

const uid = (n: number) => `0190f0e2-4242-7000-8000-${String(n).padStart(12, '0')}`
const [demo] = DEMO_COMPANIES as unknown as [{ id: string; code: string; name: string }]
const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour - 1, 0)).toISOString()

const PROFILE: MyProfileViewModel = {
  person: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
  tenant: 'Officina Demo',
  locale: 'en',
  theme: 'system',
  timeZone: 'Europe/Rome',
  password: { state: 'closed' },
  authenticator: { state: 'on', required: false, recoveryCodesLeft: 8 },
  session: { createdAt: '2026-11-15T07:12:00.000Z', idleExpiresAt: '2026-11-15T17:40:00.000Z', absoluteExpiresAt: '2026-11-22T07:12:00.000Z' },
}

function mine(n: number, extra: Partial<MyRequest>): MyRequest {
  return { id: uid(n), company: demo, kind: 'ACCESS', status: 'IN_PROGRESS', receivedAt: at(15), dueAt: at(15), package: null, collect: { state: 'RUNNING', at: at(15) }, ...extra }
}

const COLLECTING = mine(1, {})
const READY = mine(2, { package: { fileId: uid(20), name: 'my-data-2026-11-15.zip', sizeBytes: 412_000, madeAt: at(15, 10) }, collect: { state: 'READY', at: at(15, 10) } })
const HANDED = mine(3, { status: 'DONE', receivedAt: at(2), package: { fileId: uid(30), name: 'my-data-2026-11-02.zip', sizeBytes: 398_000, madeAt: at(2, 10) }, collect: { state: 'READY', at: at(2, 10) } })
const FAILED = mine(4, { collect: { state: 'FAILED', at: at(15, 9) } })

const data = (requests: MyRequest[], extra: Partial<MyData> = {}): MyData => ({ requests, mayAsk: !requests.some((request) => request.status === 'RECEIVED' || request.status === 'IN_PROGRESS'), companyId: demo.id, ...extra })
const model = (read: MyDataModel['read'], extra: Partial<MyDataModel> = {}): MyDataModel => ({ open: true, read, busy: false, downloading: null, problem: null, done: null, timeZone: 'Europe/Rome', ...extra })

function MyDataDesign({ model: current }: { model: MyDataModel }) {
  const locale = useLocale()
  const shell = { nav: officeNavFor(permissionCheck(OWNER_PERMISSIONS)), path: '/me', switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/me' }, user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email }, tenantTag: DEMO_TAG, banners: [] }
  return createElement(OfficeShellView, { model: shell }, createElement(MyProfileView, { model: { ...PROFILE, locale }, myData: createElement(MyDataView, { model: current }) }))
}

export const designScreen = defineDesignScreen<MyDataModel>({
  screen: 'SCR-663',
  title: 'Download my data',
  view: MyDataDesign,
  cases: [
    { id: 'button', label: 'My profile: Download my data in the head', model: model({ value: null, problem: null }, { open: false }), note: 'The design\'s h.more item: one button in the page head, any office person.' },
    { id: 'none', label: 'Never asked', model: model({ value: data([]), problem: null }), note: 'What the copy holds; Ask for my data (the session proves who asks).' },
    { id: 'collecting', label: 'Being collected', model: model({ value: data([COLLECTING, HANDED]), problem: null }, { done: 'dp.my.asked' }), note: 'JobProgress; Ask is held: one at a time. The dialog reads again every few seconds.' },
    { id: 'ready', label: 'Ready to download', model: model({ value: data([READY, HANDED]), problem: null }), note: 'The first download hands it over (the request is done); the link works one minute.' },
    { id: 'handed', label: 'Downloaded', model: model({ value: data([HANDED]), problem: null }, { done: 'dp.my.downloaded' }) },
    { id: 'failed', label: 'Could not be collected', model: model({ value: data([FAILED]), problem: null }) },
    { id: 'no-company', label: 'No company picked', model: model({ value: data([], { mayAsk: false, companyId: null }), problem: null }), note: 'Ask held with why: the request is kept by the company in the top bar.' },
    { id: 'loading', label: 'Loading', model: model({ value: null, problem: null }) },
    { id: 'error', label: 'Did not load', model: model({ value: null, problem: 'dp.problem.unavailable' }) },
  ],
})
