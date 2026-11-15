import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { PushModel, PushState } from './model'
import { PushCase } from './view/PushCase'

/**
 * SCR-547 — Home › Notifications › Get urgent items on this phone (B-W2b-388; design home.notifications popup push-enrol; PLT-140).
 * Made-up data only (no real device or push address).
 */

const id = (n: number) => `0190f0e2-dddd-7000-8000-${String(n).padStart(12, '0')}`

const STATE: PushState = {
  available: true,
  unavailable: null,
  publicKey: 'BMadeUpKeyForTheDesignReviewOnly0000000000000000000000000000000000000000000000000000000',
  devices: [{ id: id(1), label: 'Chrome · Windows', service: 'fcm.googleapis.com', lastUsedAt: '2026-11-12T16:05:00.000Z', createdAt: '2026-11-02T08:00:00.000Z' }],
  maxDevices: 10,
  urgent: ['MENTIONED', 'APPROVAL_WAITING', 'AREA_ALERT'],
}

const ready = (state: PushState = STATE): PushModel['push'] => ({ status: 'ready', data: state })
const base: PushModel = { push: ready(), browser: 'ready', thisDevice: null, step: 'urgent', label: 'Safari · iPhone', busy: false, offline: false, notice: null, tested: {} }
const ON: PushState = { ...STATE, devices: [...STATE.devices, { id: id(2), label: 'Safari · iPhone', service: 'web.push.apple.com', lastUsedAt: null, createdAt: '2026-11-13T08:31:00.000Z' }] }

export const designScreen = defineDesignScreen<PushModel>({
  screen: 'SCR-547',
  title: 'Get urgent items on this phone (B-W2b-388)',
  view: PushCase,
  part: true,
  cases: [
    { id: 'urgent', label: 'What counts as urgent', model: base, note: 'The kinds my Push column brings now (approvals, alerts — an andon escalation is one —, mentions), never a price I may not see; a link to change them.' },
    { id: 'install', label: 'iPhone: add to the home screen', model: { ...base, browser: 'ios-install', step: 'install' }, note: 'On an iPhone or iPad tab: Share › Add to Home Screen, then turn push on in the app (iOS 16.4+).' },
    { id: 'turn-on', label: 'Turn on push', model: { ...base, step: 'turnOn' }, note: 'This device’s name, then Turn on push: the browser asks its permission.' },
    { id: 'turn-on-ios-tab', label: 'Turn on, held in an iPhone tab', model: { ...base, browser: 'ios-install', step: 'turnOn' }, note: 'Held: "On an iPhone or iPad add the app to the home screen first."' },
    { id: 'test', label: 'Test push sent', model: { ...base, push: ready(ON), thisDevice: id(2), step: 'test', tested: { [id(1)]: 'SENT', [id(2)]: 'SENT' }, notice: { key: 'push.notice.tested', tone: 'success', params: { count: 2 } } }, note: 'Each device’s outcome; This device marked; Turn off per device.' },
    { id: 'unavailable', label: 'Push not connected here', model: { ...base, push: ready({ ...STATE, available: false, unavailable: 'Push is not connected yet.', publicKey: null }), step: 'turnOn' }, note: 'Staging or production before the push service is connected: Turn on held with the reason; choices are kept.' },
    { id: 'unsupported', label: 'Browser without push', model: { ...base, browser: 'unsupported', step: 'turnOn' } },
    { id: 'offline', label: 'Offline', model: { ...base, offline: true, step: 'turnOn' } },
    { id: 'loading', label: 'Loading', model: { ...base, push: { status: 'loading' } } },
    { id: 'error', label: 'Could not load', model: { ...base, push: { status: 'error', problem: 'push.problem.failed' } } },
  ],
})
