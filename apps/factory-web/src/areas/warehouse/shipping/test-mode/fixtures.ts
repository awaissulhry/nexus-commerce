import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { TestModeSite } from './api'
import { STEP_UP_SHUT } from './settings-card'
import type { TestModeModel } from './model'
import { TestModeView } from './view/TestModeView'

/**
 * SCR-656 — Carriers & shipping › Test mode (B-W2b-412 on B-W2b-390; design warehouse.shipping sec sp-test, pop sp-golive
 * "Switch to live labels"). Made-up data only (sites "A1 Stabilimento Demo", "B2 Magazzino Demo").
 */

const uid = (n: number) => `0190f0e2-7420-7000-8000-${String(n).padStart(12, '0')}`

const site = (over: Partial<TestModeSite> = {}): TestModeSite => ({ siteId: uid(1), companyId: uid(9), code: 'A1', name: 'Stabilimento Demo', hasSettings: true, version: 4, testMode: true, liveSince: null, goLive: { ready: true, refusal: null, testLabelsToClear: 3 }, ...over })
const OTHER = site({ siteId: uid(2), code: 'B2', name: 'Magazzino Demo' })

const model = (sites: readonly TestModeSite[] | null, over: Partial<TestModeModel> = {}): TestModeModel => ({ sites: sites ? { state: 'ready', value: sites } : { state: 'loading' }, siteId: uid(1), can: { settingsManage: true }, confirm: null, busy: false, problem: null, done: null, stepUp: STEP_UP_SHUT, ...over })

export const designScreen = defineDesignScreen<TestModeModel>({
  screen: 'SCR-656',
  title: 'Carriers & shipping › Test mode: what it does, Switch to live labels (a fresh code), back to test',
  view: TestModeView,
  cases: [
    { id: 'test', label: 'In test mode: TEST labels, nothing sent or charged; 3 TEST labels to clear; B2 in test mode too', model: model([site(), OTHER]) },
    { id: 'go-live', label: 'Switch to live labels: labels bought and charged from now on, 3 TEST labels cleared', model: model([site()], { confirm: 'live' }) },
    { id: 'step-up', label: 'The fresh code asked', model: model([site()], { confirm: 'live', busy: true, stepUp: { open: true, busy: false, sentence: 'test.stepUp', problem: null } }) },
    { id: 'not-ready', label: 'Cannot go live: no usable carrier connection (held with why)', model: model([site({ goLive: { ready: false, refusal: { code: 'NO_CARRIER_ACCOUNT' }, testLabelsToClear: 0 } })], { confirm: 'live' }) },
    { id: 'no-settings', label: 'The site has no shipping settings yet', model: model([site({ hasSettings: false, version: null, goLive: { ready: false, refusal: { code: 'NO_SETTINGS' }, testLabelsToClear: 0 } })]) },
    { id: 'live', label: 'Live since a day and time', model: model([site({ testMode: false, liveSince: '2026-11-12T08:30:00.000Z' })], { done: { key: 'test.done.live', params: { site: 'A1', count: 3 } } }) },
    { id: 'back-to-test', label: 'Back to test mode: the labels bought stay', model: model([site({ testMode: false, liveSince: '2026-11-12T08:30:00.000Z' })], { confirm: 'test' }) },
    { id: 'read-only', label: 'Without shipping.settings.manage: the state and its words only', model: model([site()], { can: { settingsManage: false } }) },
    { id: 'loading', label: 'Reading', model: model(null) },
    { id: 'error', label: 'Could not be read: Try again', model: model(null, { sites: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
