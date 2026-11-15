import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_SHUT } from '../test-mode/settings-card'
import type { CustomsSettings } from './api'
import type { EoriModel } from './model'
import { EoriView } from './view/EoriView'

/**
 * SCR-658 — Carriers & shipping › EORI (B-W2b-412 on B-W2b-409; design warehouse.shipping sec sp-eori) and the site's
 * broker-pack switch. Made-up data only (company "Officina Demo S.r.l.", EORI IT00000000001).
 */

const uid = (n: number) => `0190f0e2-7421-7000-8000-${String(n).padStart(12, '0')}`

const settings = (over: Partial<CustomsSettings['company']> = {}, site: Partial<CustomsSettings['sites'][number]> = {}): CustomsSettings => ({
  company: { id: uid(9), name: 'Officina Demo S.r.l.', eori: 'IT00000000001', version: 3, mayManage: true, ...over },
  sites: [{ siteId: uid(1), code: 'A1', name: 'Stabilimento Demo', hasSettings: true, brokerPackOn: false, version: 4, mayManage: true, ...site }],
})

const model = (value: CustomsSettings | null, over: Partial<EoriModel> = {}): EoriModel => ({ settings: value ? { state: 'ready', value } : { state: 'loading' }, siteId: uid(1), typed: null, can: { settingsManage: true }, confirm: null, busy: false, problem: null, done: null, stepUp: STEP_UP_SHUT, ...over })

export const designScreen = defineDesignScreen<EoriModel>({
  screen: 'SCR-658',
  title: 'Carriers & shipping › EORI: the company\'s EORI and the site\'s broker-pack switch',
  view: EoriView,
  cases: [
    { id: 'set', label: 'The company\'s EORI; the broker pack by link off (downloads only)', model: model(settings()) },
    { id: 'missing', label: 'No EORI yet: no customs paper is made until it is given', model: model(settings({ eori: null })) },
    { id: 'typing', label: 'Typed with spaces and dashes: kept in capitals without them', model: model(settings({ eori: null }), { typed: 'IT 0000-0000 002' }) },
    { id: 'wrong', label: 'Not an EORI: said beside the field, Save held', model: model(settings(), { typed: 'X!' }) },
    { id: 'pack-on', label: 'Switching the broker pack on: papers go to a third party (a fresh code)', model: model(settings(), { confirm: 'on' }) },
    { id: 'pack-is-on', label: 'The broker pack by link on', model: model(settings({}, { brokerPackOn: true }), { done: { key: 'eori.done.packOn', params: { site: 'A1' } } }) },
    { id: 'read-only', label: 'Without shipping.settings.manage: read only', model: model(settings({ mayManage: false }, { mayManage: false }), { can: { settingsManage: false } }) },
    { id: 'loading', label: 'Reading', model: model(null) },
    { id: 'error', label: 'Could not be read: Try again', model: model(null, { settings: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
