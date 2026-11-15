import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { inShell } from '../../../shared/fixtures'
import type { TestAnswer } from '../api'
import { ConnectionTest, type ConnectionTestModel } from '../view/ConnectionTest'

/**
 * A connection's Test and Reconnect for the design review (B-W2b-415, SCR-602; design admin.connections pop:test): made-up
 * answers and times. The buttons as the connection record's header shows them; a case with an answer opens it in its small
 * dialog. Design-only.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 9, minute)).toISOString()
const ACCOUNT: ConnectionTestModel['account'] = { id: '0190f0e2-acc0-7000-8000-000000000001', status: 'ACTIVE', mode: 'FAKE', provider: 'SDI' }

const answer = (over: Partial<TestAnswer>): TestAnswer => ({
  accountId: ACCOUNT.id,
  outcome: 'OK',
  reason: null,
  message: null,
  httpStatus: 200,
  durationMs: 14,
  fake: true,
  reconnected: false,
  circuitBefore: { failures: 0, openUntil: null },
  testedAt: at(41),
  ...over,
})

const model = (over: Partial<ConnectionTestModel> = {}): ConnectionTestModel => ({ account: ACCOUNT, canManage: true, open: false, running: null, answer: null, problem: null, ...over })

function TestDesign({ model: c }: { model: ConnectionTestModel }) {
  return inShell('/admin/connections', createElement('div', { className: 'fw-adm' }, createElement('div', { className: 'fw-adm-actions' }, createElement(ConnectionTest, { model: c }))))
}

export const designScreen = defineDesignScreen<ConnectionTestModel>({
  screen: 'SCR-602',
  title: 'Connection › Test and Reconnect',
  view: TestDesign,
  cases: [
    { id: 'ready', label: 'Test and Reconnect ready', model: model() },
    { id: 'testing', label: 'Testing: one harmless call', model: model({ open: true, running: 'test' }) },
    { id: 'ok-fake', label: 'The fake answered', model: model({ open: true, answer: answer({}) }), note: 'Locally every service is FAKE: nothing leaves the factory.' },
    { id: 'ok-live', label: 'A live service answered (ECB)', model: model({ account: { ...ACCOUNT, mode: 'LIVE', provider: 'ECB' }, open: true, answer: answer({ fake: false, durationMs: 230 }) }) },
    { id: 'refused-paused', label: 'Refused: the connection is paused', model: model({ account: { ...ACCOUNT, status: 'PAUSED' }, open: true, answer: answer({ outcome: 'REFUSED', reason: 'account_paused', httpStatus: null, message: 'This account is paused: no call is sent until it is switched on again.' }) }), note: 'Reconnect is held: Resume first.' },
    { id: 'refused-circuit', label: 'Refused: the circuit is open', model: model({ open: true, answer: answer({ outcome: 'REFUSED', reason: 'circuit_open', httpStatus: null, circuitBefore: { failures: 5, openUntil: at(43) } }) }) },
    { id: 'failed-timeout', label: 'Failed: no answer in time', model: model({ open: true, answer: answer({ outcome: 'FAILED', reason: 'timeout', httpStatus: null, durationMs: 10000, message: 'connection.test failed after 1 attempt(s): no answer within 10000 ms' }) }) },
    { id: 'reconnecting', label: 'Reconnect: closing the circuit', model: model({ open: true, running: 'reconnect' }) },
    { id: 'reconnected', label: 'Reconnected: 5 failures forgotten, then OK', model: model({ open: true, answer: answer({ reconnected: true, circuitBefore: { failures: 5, openUntil: at(43) } }) }) },
    { id: 'problem', label: 'The request itself was refused', model: model({ open: true, problem: 'problem.forbidden' }) },
    { id: 'held-right', label: 'Held: no right to test', model: model({ canManage: false }) },
    { id: 'held-no-probe', label: 'Held: a live service without a test call', model: model({ account: { ...ACCOUNT, mode: 'LIVE', provider: 'SENDCLOUD' } }) },
    { id: 'held-disabled', label: 'Held: disabled', model: model({ account: { ...ACCOUNT, status: 'DISABLED' } }) },
  ],
})
