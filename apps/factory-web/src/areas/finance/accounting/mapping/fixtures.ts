import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../_shared/hooks'
import { inShell, NOW, PREFIX, ROLES, type Role } from '../demo/fixtures'
import { JOURNALS_ON, LEATHER, MAPPING_ANSWER, MAPPING_READ_ONLY, MAPPING_TODAY, OLD_RATE, SALES_FREIGHT } from './demo/fixtures'
import type { MappingAnswer, MappingKey } from './api'
import { keyId, mappingAddressOf, mappingCanOf, type MappingAddress } from './model'
import type { BulkDialogModel, KeyDialogModel, MappingPageModel } from './view-model'
import { MappingView } from './view/MappingView'

/**
 * SCR-480 — Finance › Close › Accounting export › Account mapping (B-W2b-426; design finance.accounting h.more "Account
 * mapping (W2b)", conn "Finance › Settings — Account mapping"; FIN-151, FIN-152) with made-up data only: the keys Nexus
 * posts by kind with the account today, the next change and the earlier ones; the views (without an account, changing soon,
 * not posted by Nexus — kept apart); search; a key's dialog (in force, changing soon with Change and Remove, earlier, a new
 * row from a day — a first row may start earlier); Map N keys (held, refused key by key, made); Export N; the journals
 * switch (off while waiting for the accountant, on, the dialog, a fresh code first); and the states (loading with "Still
 * loading…", error, empty, offline, updates, no permission) and roles: Finance, Owner, Read only, Sales.
 */

interface Case {
  role: Role
  page: MappingPageModel
}

const ADDRESS = mappingAddressOf(null)
const at = (address: Partial<MappingAddress>): MappingAddress => ({ ...ADDRESS, ...address })

const dialog = (key: MappingKey, over: Partial<KeyDialogModel> = {}): KeyDialogModel => ({
  key,
  draft: { accountCode: '', validFrom: MAPPING_TODAY, note: '' },
  busy: false,
  problem: null,
  editing: null,
  rowBusy: null,
  rowProblem: null,
  done: null,
  ...over,
})

const page = (role: Role, over: Partial<MappingPageModel> = {}, answer: MappingAnswer | null = role === 'reader' ? MAPPING_READ_ONLY : MAPPING_ANSWER): Case => ({
  role,
  page: {
    prefix: PREFIX,
    can: mappingCanOf(ROLES[role], answer),
    today: MAPPING_TODAY,
    address: ADDRESS,
    live: 'live',
    answer,
    problem: null,
    slow: false,
    readAt: NOW - 60_000,
    updates: 0,
    notice: null,
    key: null,
    bulk: null,
    switching: null,
    stepUp: STEP_UP_CLOSED,
    ...over,
  },
})

const chosen = (ids: readonly string[]) => MAPPING_ANSWER.keys.filter((entry) => ids.includes(keyId(entry)))
const THREE = ['ITEM_GROUP/TEXTILE', 'ITEM_GROUP/LINING', 'ITEM_GROUP/HARDWARE']
const bulk = (over: Partial<BulkDialogModel> = {}): BulkDialogModel => ({ keys: chosen(THREE), draft: { accountCode: '6103', validFrom: '2026-11-01', note: 'Accessori su un solo conto, come chiesto dallo studio.' }, busy: false, sent: 0, done: null, ...over })
const JOURNALS_ON_ANSWER: MappingAnswer = { ...MAPPING_ANSWER, journals: JOURNALS_ON }

function MappingDesign({ model }: { model: Case }) {
  return inShell('/finance/accounting/mapping', createElement(MappingView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-480',
  title: 'Account mapping: what Nexus posts → the accountant’s accounts, from a day, and the journals switch',
  view: MappingDesign,
  cases: [
    { id: 'finance', label: 'Finance · every key Nexus posts: account today, next change, earlier; the journals off (waits for the accountant)', model: page('finance'), note: '23 keys, 4 without an account; leather moves from 6101 to 6105 on 1 December; the key "22" is kept apart (not posted).' },
    { id: 'owner', label: 'Owner · the same page', model: page('owner') },
    { id: 'read-only', label: 'Read only · Switch on…, Map N keys and the dialog’s form held with the permission in words', model: page('reader') },
    { id: 'unmapped', label: 'View · Without an account (4)', model: page('finance', { address: at({ view: 'unmapped' }) }) },
    { id: 'upcoming', label: 'View · Changing soon (leather from 1 December, WIP from 1 January)', model: page('finance', { address: at({ view: 'upcoming' }) }) },
    { id: 'other', label: 'View · Not posted by Nexus: the row kept for the key "22", apart', model: page('finance', { address: at({ view: 'other' }) }) },
    { id: 'kind-search', label: 'Kind · Tax codes, search "iva"', model: page('finance', { address: at({ kind: 'TAX_CODE', q: 'iva' }) }) },
    { id: 'no-match', label: 'No key matches the search · Show every key', model: page('finance', { address: at({ q: 'zzz' }) }) },
    { id: 'selected', label: 'Three keys chosen · Map 3 keys…, Export 3 (CSV)', model: page('finance', { selected: THREE }) },
    { id: 'keys', label: 'Keys in the footer info icon', model: page('finance', { keysOpen: true, focusRow: 4 }) },
    { id: 'dialog', label: 'Leather bought · 6101 since 1 April, 6105 from 1 December (Change, Remove), 6100 earlier', model: page('finance', { address: at({ open: keyId(LEATHER) }), key: dialog(LEATHER) }) },
    { id: 'dialog-first', label: 'Transport charged to customers · no account: its first row may start earlier', model: page('finance', { address: at({ open: keyId(SALES_FREIGHT) }), key: dialog(SALES_FREIGHT, { draft: { accountCode: '4005', validFrom: '2026-01-01', note: '' } }) }) },
    { id: 'dialog-edit', label: 'Leather · changing the row from 1 December before its day', model: page('finance', { address: at({ open: keyId(LEATHER) }), key: dialog(LEATHER, { editing: { rowId: LEATHER.upcoming[0]!.id, accountCode: '6106', note: 'Nuovo sottoconto chiesto dallo studio.' } }) }) },
    { id: 'dialog-held', label: 'Leather · a change dated before today: Map held "a change starts today or later"', model: page('finance', { address: at({ open: keyId(LEATHER) }), key: dialog(LEATHER, { draft: { accountCode: '6107', validFrom: '2026-10-01', note: '' } }) }) },
    { id: 'dialog-refused', label: 'Leather · refused by the API: a row from that day exists (in words)', model: page('finance', { address: at({ open: keyId(LEATHER) }), key: dialog(LEATHER, { draft: { accountCode: '6107', validFrom: '2026-12-01', note: '' }, problem: { key: 'mapping.refusal.SAME_DAY', reload: true } }) }) },
    { id: 'dialog-done', label: 'Leather · just added: 6105 applies from 1 December (notice)', model: page('finance', { address: at({ open: keyId(LEATHER) }), key: dialog(LEATHER, { done: { key: 'mapping.done.added', params: { account: '6105', day: '2026-12-01' } } }) }) },
    { id: 'dialog-other', label: 'The key "22" · Nexus posts no such key: no new row', model: page('finance', { address: at({ view: 'other', open: keyId(OLD_RATE) }), key: dialog(OLD_RATE) }) },
    { id: 'dialog-read-only', label: 'Read only · the key’s rows, Change and Remove held, no form', model: page('reader', { address: at({ open: keyId(LEATHER) }), key: dialog(LEATHER) }) },
    { id: 'bulk', label: 'Map 3 keys to 6103 from 1 November', model: page('finance', { selected: THREE, bulk: bulk() }) },
    { id: 'bulk-held', label: 'Map 3 keys · dated before today: held "3 keys are mapped already"', model: page('finance', { selected: THREE, bulk: bulk({ draft: { accountCode: '6103', validFrom: '2026-10-01', note: '' } }) }) },
    { id: 'bulk-running', label: 'Map 3 keys · running (2 of 3)', model: page('finance', { selected: THREE, bulk: bulk({ busy: true, sent: 2 }) }) },
    { id: 'bulk-done', label: 'Map 3 keys · 2 mapped, 1 refused in words', model: page('finance', { selected: THREE, bulk: bulk({ done: { made: THREE.slice(0, 2), refused: [{ id: THREE[2]!, problem: { key: 'mapping.refusal.SAME_DAY' } }] } }) }) },
    { id: 'switch-on', label: 'Switch the journals’ entries on? · what changes, 4 keys without an account, the reason, then a code', model: page('finance', { switching: { reason: 'Mappatura confermata dallo studio il 29 ottobre.', busy: false, problem: null } }) },
    { id: 'step-up', label: 'Switching asks a fresh code first', model: page('finance', { switching: { reason: 'Mappatura confermata dallo studio il 29 ottobre.', busy: true, problem: null }, stepUp: { open: true, busy: false, sentence: 'journals.stepUp', problem: null } }) },
    { id: 'journals-on', label: 'The journals on (set for this company) · Switch off…', model: page('finance', { notice: { key: 'journals.done.on' } }, JOURNALS_ON_ANSWER) },
    { id: 'switch-off', label: 'Switch the journals’ entries off? · batches made before keep their files', model: page('finance', { switching: { reason: '', busy: false, problem: null } }, JOURNALS_ON_ANSWER) },
    { id: 'updates', label: 'Live · a row changed elsewhere: 2 updates · Show', model: page('finance', { updates: 2 }) },
    { id: 'offline', label: 'Offline · reading again when back', model: page('finance', { live: 'offline' }) },
    { id: 'empty', label: 'No key to map (a company Nexus posts nothing for yet)', model: page('finance', {}, { ...MAPPING_ANSWER, keys: [], unmapped: 0 }) },
    { id: 'loading', label: 'Loading · "Still loading…" after a second', model: page('finance', { readAt: null, slow: true }, null) },
    { id: 'error', label: "Error · couldn't load the mapping, Try again", model: page('finance', { readAt: null, problem: 'problem.read.unavailable' }, null) },
    { id: 'no-permission', label: 'Sales · no accounting permission', model: page('sales', { readAt: null }, null) },
  ],
})
