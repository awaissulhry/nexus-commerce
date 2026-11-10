import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { NOW, PREFIX, uid } from '../../library/demo'
import { ACTIVE_ROWS, canOf, EFFECTS, GROUP, LINER_VALUES, OFFERS, VALUES, withoutPrices } from '../demo'
import { effectDraftFrom, effectDraftOf, groupDraftOf, newRuleItem, ruleItemsOf, valueDraftOf, type GroupRecord } from '../model'
import type { GroupRecordModel, RecordDialog } from '../view-model'
import { GroupRecordView } from './view/GroupRecordView'

/**
 * SCR-114-record — an option group (B-W2b-242; design products.options rec "Option group": Options, Rules, Price & BOM
 * effects, Styles) — made-up data only (PLAN §3.1): the invented group DEMO-PERF, its options, rules, effects and the demo
 * styles that offer it. Role cases: the Owner, a product developer (keeps the library, no price grain), sales (prices,
 * reads), quality (reads).
 */

const ready = (value: GroupRecord = GROUP) => ({ status: 'ready' as const, value })

const SCALE = { id: uid('4254', 1), companyId: null, code: 'DEMO-EU', name: 'Taglie EU Demo', codes: ['46', '48', '50', '52', '54'], status: 'ACTIVE' as const, version: 1, styleCount: 3, updatedAt: NOW }

const base: GroupRecordModel = {
  prefix: PREFIX,
  can: canOf('owner'),
  tab: 'options',
  group: ready(),
  locale: 'it-IT',
  save: { state: 'idle', at: NOW },
  cells: {},
  busy: false,
  notice: null,
  refused: null,
  changed: null,
  offline: false,
  rules: { items: null, busy: false, problem: null, messages: [], groups: ACTIVE_ROWS, values: { [ACTIVE_ROWS[2]!.id]: LINER_VALUES } },
  scales: { items: [SCALE], chosen: SCALE.id },
  dialog: null,
  companyName: null,
}

const on = (tab: GroupRecordModel['tab'], extra: Partial<GroupRecordModel> = {}): GroupRecordModel => ({ ...base, tab, ...extra })
const developer = (tab: GroupRecordModel['tab']) => on(tab, { can: canOf('developer'), group: ready(withoutPrices(GROUP)) })
const sales = (tab: GroupRecordModel['tab']) => on(tab, { can: canOf('sales'), group: ready({ ...GROUP, may: { manage: false, price: true } }) })
const quality = (tab: GroupRecordModel['tab']) => on(tab, { can: canOf('quality'), group: ready({ ...withoutPrices(GROUP), may: { manage: false, price: false } }) })
const archived: GroupRecord = { ...GROUP, status: 'ARCHIVED', may: { manage: false, price: false } }

const dirtyRules = [
  ...ruleItemsOf(GROUP).map((item, index) => (index === 1 ? { ...item, severity: 'BLOCK' as const } : item)),
  { ...newRuleItem('new-1', GROUP.id), when: { combinator: 'and' as const, rows: [{ id: 'subject', field: 'option', operator: 'eq' as const, value: VALUES[1]!.id }] }, kind: 'REQUIRES' as const, otherGroupId: ACTIVE_ROWS[2]!.id, otherValueId: LINER_VALUES[1]!.id, severity: 'WARN' as const, messageIt: 'Con i pannelli forati consigliamo la fodera estiva.', messageEn: 'With perforated panels we advise the summer liner.' },
]
const badRules = [...ruleItemsOf(GROUP), newRuleItem('new-1', GROUP.id), { ...ruleItemsOf(GROUP)[0]!, key: 'new-2', id: null }]

const dialog = (value: RecordDialog, tab: GroupRecordModel['tab'] = 'options', extra: Partial<GroupRecordModel> = {}): GroupRecordModel => on(tab, { dialog: value, ...extra })
const picker = { q: '', results: null }
const effectDialog = (extra: Partial<Extract<RecordDialog, { kind: 'effect' }>> = {}): RecordDialog => ({ kind: 'effect', mode: 'new', effectId: null, draft: effectDraftOf(VALUES[2]!.id), material: picker, target: picker, operation: picker, busy: false, problem: null, refused: [], messages: [], ...extra })
const MATERIALS = [
  { id: uid('4244', 1), code: 'DEMO-MESH-01', name: 'Rete traspirante 3D' },
  { id: uid('4244', 4), code: 'DEMO-MESH-02', name: 'Rete leggera' },
]

export const designScreen = defineDesignScreen<GroupRecordModel>({
  screen: 'SCR-114-record',
  title: 'Option group',
  view: GroupRecordView,
  cases: [
    { id: 'options', label: 'Options (Owner)', model: base, note: 'Autosave per cell: code, name, the price surcharge (+15,00 EUR, +10 %), typed text with its length and pattern, outside the certificate; ⋯ moves, archives, copies. The archived option is last.' },
    { id: 'options-saving', label: 'Options: a cell saving, one refused', model: on('options', { save: { state: 'saving', at: NOW }, cells: { [`${VALUES[1]!.id}/name`]: { state: 'saving' }, [`${VALUES[2]!.id}/price`]: { state: 'refused', problem: 'price.problem.form' } }, notice: { key: 'price.problem.form', tone: 'warning' } }) },
    { id: 'options-developer', label: 'Options: product developer (no price grain)', model: developer('options'), note: 'No price column; a line says the surcharge needs the price grain.' },
    { id: 'options-sales', label: 'Options: sales (prices, reads the rest)', model: sales('options'), note: 'The price cells edit; every other cell is text with the reason.' },
    { id: 'options-quality', label: 'Options: quality (reads)', model: quality('options') },
    { id: 'options-empty', label: 'Options: none yet', model: on('options', { group: ready({ ...GROUP, values: [], effects: [], rules: [], subjectOptions: GROUP.subjectOptions.slice(0, 1), counts: { ...GROUP.counts, values: 0 } }) }) },
    { id: 'add-option', label: 'Add option', model: dialog({ kind: 'addValue', draft: valueDraftOf('SINGLE'), busy: false, problem: null, refused: [], messages: [] }) },
    { id: 'add-option-text', label: 'Add option: a typed text with a pattern to fix', model: dialog({ kind: 'addValue', draft: { code: 'PERF-NAME', name: 'Nome sui fori', freeText: true, maxLength: '600', pattern: '[[:alpha:]]+' }, busy: false, problem: null, refused: [], messages: [] }), note: 'The length is 1 to 500; a POSIX class is refused in words (it would read differently in the database).' },
    { id: 'certificate', label: 'Outside the certificate: say what it no longer covers', model: dialog({ kind: 'certificate', valueId: VALUES[1]!.id, note: '', busy: false, problem: null }) },
    { id: 'archive-option', label: 'Archive an option used by BOM lines', model: dialog({ kind: 'archiveValue', valueId: VALUES[2]!.id }) },
    { id: 'rules', label: 'Rules (Owner)', model: on('rules'), note: 'Each rule: the RuleBuilder\'s condition ("the option is …"), then requires / excludes, the other option (its group first), block / warning, the message; the preview in words.' },
    { id: 'rules-dirty', label: 'Rules: changes not saved', model: on('rules', { rules: { ...base.rules, items: dirtyRules } }), note: 'The EditModeBar counts 2 changes; ⌘S saves the set at the group\'s version.' },
    { id: 'rules-problems', label: 'Rules: what to fix', model: on('rules', { rules: { ...base.rules, items: badRules } }), note: 'A new rule without its option; a rule twice; Save held with the count.' },
    { id: 'rules-refused', label: 'Rules: refused (changed meanwhile)', model: on('rules', { rules: { ...base.rules, items: dirtyRules, problem: 'problem.write.moved' } }) },
    { id: 'rules-read', label: 'Rules: read only (sales)', model: sales('rules'), note: 'The rules as words with what the customer reads when one is broken; no inputs.' },
    { id: 'rules-empty', label: 'Rules: none yet', model: on('rules', { group: ready({ ...GROUP, rules: [] }) }) },
    { id: 'effects', label: 'Price & BOM effects (Owner)', model: on('effects'), note: 'Per option: an operation and its minutes, mesh added per size (SizeColumns over DEMO-EU), a material left out, outside the certificate, the surcharges; the cost column waits for costing.' },
    { id: 'effects-developer', label: 'Effects: product developer (no price grain)', model: developer('effects'), note: 'The price rows say "Moves the price" without the amount; no price column.' },
    { id: 'effects-no-scale', label: 'Effects: no size scale picked', model: on('effects', { scales: { items: base.scales.items, chosen: null } }) },
    { id: 'effects-empty', label: 'Effects: none yet', model: on('effects', { group: ready({ ...GROUP, effects: [] }) }) },
    { id: 'add-effect', label: 'Add effect: a material per garment', model: dialog(effectDialog({ material: { q: 'mesh', results: MATERIALS } }), 'effects') },
    { id: 'add-effect-problems', label: 'Add effect: what to fix', model: dialog(effectDialog({ draft: { ...effectDraftOf(VALUES[2]!.id, 'BOM_REPLACE'), qty: '0', item: MATERIALS[0]!, target: MATERIALS[0]! } }), 'effects') },
    { id: 'edit-effect', label: 'Edit an effect', model: dialog(effectDialog({ mode: 'edit', effectId: EFFECTS[2]!.id, draft: effectDraftFrom(EFFECTS[2]!) }), 'effects') },
    { id: 'remove-effect', label: 'Remove an effect', model: dialog({ kind: 'removeEffect', effectId: EFFECTS[4]!.id }, 'effects') },
    { id: 'styles', label: 'Styles (Owner)', model: on('styles'), note: 'Each style\'s own minimum and maximum (empty: the group\'s), what it asks, withdraw; a withdrawn offer stays listed.' },
    { id: 'styles-developer', label: 'Styles: product developer', model: developer('styles') },
    { id: 'styles-quality', label: 'Styles: quality (reads)', model: quality('styles') },
    { id: 'styles-empty', label: 'Styles: offered on none', model: on('styles', { group: ready({ ...GROUP, styles: [] }) }) },
    {
      id: 'add-styles',
      label: 'Add styles',
      model: dialog(
        {
          kind: 'styles',
          q: 'demo',
          results: OFFERS.slice(0, 2)
            .map((offer) => offer.style)
            .concat([{ id: uid('4249', 7), code: 'DEMO-JKT-07', name: 'Giacca estiva Demo', companyId: null, status: 'ACTIVE' }])
            .map((style) => ({ id: style.id, code: style.code, name: style.name, status: style.status })),
          picked: [uid('4249', 7)],
          busy: false,
          outcome: null,
        },
        'styles',
      ),
    },
    { id: 'add-styles-outcome', label: 'Add styles: one added, one refused', model: dialog({ kind: 'styles', q: 'demo', results: [], picked: [], busy: false, outcome: { added: ['DEMO-JKT-07'], refused: [{ code: 'DEMO-JKT-01', key: 'problem.write.state', message: 'Style DEMO-JKT-01 is released: start a new revision first.' }] } }, 'styles') },
    { id: 'withdraw', label: 'Withdraw from a style', model: dialog({ kind: 'withdraw', offerId: OFFERS[0]!.id }, 'styles') },
    { id: 'edit-group', label: 'Edit group', model: dialog({ kind: 'edit', form: { mode: 'edit', draft: groupDraftOf(GROUP, null), companies: [], everyCompany: false, busy: false, problem: null, refused: [], messages: [] } }) },
    { id: 'archive-group', label: 'Archive the group', model: dialog({ kind: 'archive' }) },
    { id: 'archived', label: 'Archived group', model: on('options', { group: ready(archived) }), note: 'Every tab reads as text; Restore in ⋯.' },
    { id: 'changed', label: 'Changed meanwhile', model: on('options', { changed: { at: NOW } }) },
    { id: 'offline', label: 'Offline', model: on('options', { offline: true }), note: 'Cells, rules and dialogs held: "Offline — changes wait until the connection is back".' },
    { id: 'loading', label: 'Loading', model: on('options', { group: { status: 'loading' } }) },
    { id: 'not-found', label: 'Not found', model: on('options', { group: { status: 'notFound' } }) },
    { id: 'error', label: 'Could not load', model: on('options', { group: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'no-permission', label: 'No access', model: on('options', { group: { status: 'forbidden' } }) },
  ],
})
