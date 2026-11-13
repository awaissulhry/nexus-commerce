import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { CheckAnswer, LineConfigurator, StyleConfigurator } from './api'
import { draftOf, type DraftPick } from './model'
import { ConfiguratorView, type ConfiguratorModel } from './view/ConfiguratorView'

/**
 * SCR-425 — the configurator on a quote or order line (B-W2b-340; SAL-133, SAL-136, SAL-139, SAL-140; the line drawer's
 * "Options" section and the order line's "Options" dialog), made-up data only: a touring jacket DEMO-JKT-05 in black for a
 * made-up brand, with a liner (+60.00), perforation (front +5 %, full +40.00 — full excludes the liner), a name on the chest
 * (+15.00, a typed text) and the armour (one, standard by default; without it the jacket is outside its certificate, -25.00).
 */

const w = (it: string, en: string) => ({ it, en })
const G = { liner: '11111111-0000-4000-8000-000000000001', perf: '11111111-0000-4000-8000-000000000002', name: '11111111-0000-4000-8000-000000000003', armour: '11111111-0000-4000-8000-000000000004' }
const V = {
  liner: '22222222-0000-4000-8000-000000000001',
  front: '22222222-0000-4000-8000-000000000002',
  full: '22222222-0000-4000-8000-000000000003',
  name: '22222222-0000-4000-8000-000000000004',
  std: '22222222-0000-4000-8000-000000000005',
  none: '22222222-0000-4000-8000-000000000006',
}
const value = (id: string, code: string, it: string, en: string, extra: Partial<LineConfigurator['groups'][number]['values'][number]> = {}) => ({
  id,
  code,
  name: en,
  nameI18n: { it, en },
  status: 'ACTIVE' as const,
  freeText: false,
  freeTextMaxLength: null,
  freeTextPattern: null,
  outsideCertificate: false,
  certificateNote: null,
  surcharge: null,
  ...extra,
})

export const DEMO_STYLE: StyleConfigurator = {
  style: { id: '33333333-0000-4000-8000-000000000001', code: 'DEMO-JKT-05', name: 'Demo touring jacket', companyId: null, status: 'RELEASED' },
  colourway: { id: '33333333-0000-4000-8000-000000000002', code: 'BLK', name: 'Black' },
  picture: null,
  groups: [
    {
      groupId: G.liner,
      code: 'DEMO-LINER',
      name: 'Thermal liner',
      nameI18n: { it: 'Imbottitura termica', en: 'Thermal liner' },
      kind: 'SINGLE',
      minPicks: 0,
      maxPicks: 1,
      picks: w('0–1', '0–1'),
      defaultValueId: null,
      values: [value(V.liner, 'YES', 'Imbottitura removibile', 'Removable thermal liner', { surcharge: { delta: '60', currency: 'EUR', percent: null } })],
      rules: [{ ruleId: '44444444-0000-4000-8000-000000000001', valueId: V.liner, kind: 'REQUIRES', otherValueId: V.std, severity: 'WARN', words: w("L'imbottitura richiede le protezioni standard (avviso)", 'The liner requires the standard protectors (warning)'), broken: w("L'imbottitura richiede le protezioni standard.", 'The liner requires the standard protectors.') }],
    },
    {
      groupId: G.perf,
      code: 'DEMO-PERF',
      name: 'Perforation',
      nameI18n: { it: 'Foratura', en: 'Perforation' },
      kind: 'SINGLE',
      minPicks: 0,
      maxPicks: 1,
      picks: w('0–1', '0–1'),
      defaultValueId: null,
      values: [
        value(V.front, 'FRONT', 'Pannelli anteriori forati', 'Front panels perforated', { surcharge: { delta: null, currency: null, percent: '5' } }),
        value(V.full, 'FULL', 'Foratura completa', 'Full perforation', { surcharge: { delta: '40', currency: 'EUR', percent: null } }),
      ],
      rules: [{ ruleId: '44444444-0000-4000-8000-000000000002', valueId: V.full, kind: 'EXCLUDES', otherValueId: V.liner, severity: 'BLOCK', words: w("La foratura completa esclude l'imbottitura (blocca)", 'Full perforation excludes the thermal liner (blocks)'), broken: w("La foratura completa non va con l'imbottitura termica.", 'Full perforation does not go with the thermal liner.') }],
    },
    {
      groupId: G.name,
      code: 'DEMO-NAME',
      name: 'Name on the chest',
      nameI18n: { it: 'Nome sul petto', en: 'Name on the chest' },
      kind: 'FREE_TEXT',
      minPicks: 0,
      maxPicks: 1,
      picks: w('0–1', '0–1'),
      defaultValueId: null,
      values: [value(V.name, 'NAME', 'Nome ricamato', 'Embroidered name', { freeText: true, freeTextMaxLength: 12, surcharge: { delta: '15', currency: 'EUR', percent: null } })],
      rules: [],
    },
    {
      groupId: G.armour,
      code: 'DEMO-ARMOUR',
      name: 'Shoulder protectors',
      nameI18n: { it: 'Protezioni spalle', en: 'Shoulder protectors' },
      kind: 'SINGLE',
      minPicks: 1,
      maxPicks: 1,
      picks: w('1–1', '1–1'),
      defaultValueId: V.std,
      values: [
        value(V.std, 'STD', 'Protezioni standard', 'Standard protectors'),
        value(V.none, 'NONE', 'Senza protezioni', 'Without protectors', { outsideCertificate: true, certificateNote: 'Without its protectors the jacket is not the certified class AA garment.', surcharge: { delta: '-25', currency: 'EUR', percent: null } }),
      ],
      rules: [],
    },
  ],
  choices: {
    colours: [
      { id: '55555555-0000-4000-8000-000000000001', code: 'DEMO-BLK', name: 'Demo black', nameI18n: { it: 'Nero demo', en: 'Demo black' }, hex: '#1A1A1A' },
      { id: '55555555-0000-4000-8000-000000000002', code: 'DEMO-FLUO', name: 'Demo fluo yellow', nameI18n: { it: 'Giallo fluo demo', en: 'Demo fluo yellow' }, hex: '#D4E000' },
    ],
    leathers: [{ id: '66666666-0000-4000-8000-000000000001', code: 'DEMO-LEA-100', name: 'Demo cowhide 1.2 mm', colours: [{ id: '66666666-0000-4000-8000-000000000002', code: 'BLK', name: 'Black', hex: '#111111' }, { id: '66666666-0000-4000-8000-000000000003', code: 'RED', name: 'Red', hex: '#A0102A' }] }],
  },
}

const chosen = (valueId: string, groupId: string, extra: Partial<LineConfigurator['chosen'][number]> = {}) => ({ id: `77777777-0000-4000-8000-${valueId.slice(-12)}`, groupId, valueId, text: null, byDefault: false, colourId: null, itemId: null, itemColourId: null, surchargeAmount: null, surchargePct: null, ...extra })

export const DEMO_LINE: LineConfigurator = {
  ...DEMO_STYLE,
  document: { kind: 'QUOTE', id: '88888888-0000-4000-8000-000000000001', number: 'Q-2026-0143', version: 7, status: 'DRAFT', revision: 2, currency: 'EUR', priceBasis: 'NET' },
  line: { id: '99999999-0000-4000-8000-000000000001', seq: 10, kind: 'SIZE_GRID', quantity: 8, unitPrice: '470', listUnitPrice: null, unitCost: '310', marginPct: '34.04', optionsTotal: '95' },
  chosen: [chosen(V.std, G.armour, { byDefault: true }), chosen(V.liner, G.liner, { surchargeAmount: '60' }), chosen(V.front, G.perf, { surchargeAmount: '20', surchargePct: '5', colourId: '55555555-0000-4000-8000-000000000002' }), chosen(V.name, G.name, { text: 'ROSSI', surchargeAmount: '15' })],
  check: { ok: true, blocks: [], warnings: [], outsideCertificate: false, certificateNotes: [] },
  pricing: { holdsOptions: true, held: null, manualKept: true },
  artwork: [{ fileId: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'brand-logo.pdf', contentType: 'application/pdf', sizeBytes: 182_400, status: 'AVAILABLE', createdAt: '2026-11-10T09:12:00.000Z', from: 'LINE' }],
  may: { configure: true, held: null, artwork: true },
}

const GRAINS = { price: true, cost: false, margin: true }
const preview = (extra: Partial<CheckAnswer> = {}, pricing: Partial<CheckAnswer['pricing']> = {}): CheckAnswer => ({
  ok: true,
  blocks: [],
  warnings: [],
  outsideCertificate: false,
  certificateNotes: [],
  chosen: [],
  pricing: { repriced: true, held: null, manualKept: true, unitPrice: '413', before: '470', optionsTotal: '35', change: null, steps: null, marginPct: '24.94', marginBefore: '34.04', ...pricing },
  problem: null,
  ...extra,
})
const withoutLiner: DraftPick[] = draftOf(DEMO_LINE.chosen).filter((pick) => pick.valueId !== V.liner)

const model = (extra: Partial<ConfiguratorModel> = {}): ConfiguratorModel => ({
  mode: 'QUOTE',
  read: { status: 'ready' },
  style: DEMO_LINE,
  line: DEMO_LINE,
  draft: draftOf(DEMO_LINE.chosen),
  preview: { status: 'idle', value: null },
  grains: GRAINS,
  changed: false,
  saveHeld: { key: 'save.held.unchanged' },
  saving: false,
  keepPrice: false,
  notice: null,
  artwork: { uploading: [], problem: null },
  pictureUrl: null,
  ...extra,
})

const blockedDraft: DraftPick[] = [...draftOf(DEMO_LINE.chosen).filter((pick) => pick.groupId !== G.perf), { valueId: V.full, groupId: G.perf, text: '', byDefault: false, colourId: null, itemId: null, itemColourId: null }]
const orderLine: LineConfigurator = { ...DEMO_LINE, document: { ...DEMO_LINE.document, kind: 'ORDER', number: 'SO-2026-0031', status: 'CONFIRMED', revision: null }, artwork: [{ ...DEMO_LINE.artwork[0]!, from: 'QUOTE_LINE' }] }

export const designScreen = defineDesignScreen<ConfiguratorModel>({
  screen: 'SCR-425',
  title: 'The configurator on a quote or order line: options with their rules, surcharges, panel colours and leather, artwork, price, margin and picture',
  view: ConfiguratorView,
  cases: [
    { id: 'quote-saved', label: 'Quote line · the options as saved', model: model(), note: 'The line drawer\'s Options section (order 20): each value with its surcharge in the options area\'s words, the default, the rules in their words.' },
    { id: 'quote-picking', label: 'Quote line · a pick checked: the price and margin as the API plans them', model: model({ draft: withoutLiner, changed: true, saveHeld: null, preview: { status: 'ready', value: preview() } }) },
    { id: 'quote-checking', label: 'Quote line · the combination being checked', model: model({ draft: withoutLiner, changed: true, saveHeld: { key: 'save.held.checking' }, preview: { status: 'checking', value: null } }) },
    {
      id: 'quote-blocked',
      label: 'Quote line · refused in the rule\'s words: Save held',
      model: model({ draft: blockedDraft, changed: true, saveHeld: { key: 'save.held.blocked' }, preview: { status: 'ready', value: preview({ ok: false, blocks: [{ code: 'EXCLUDES', severity: 'BLOCK', path: 'rules/x', groupId: G.perf, valueId: V.full, ruleId: '44444444-0000-4000-8000-000000000002', message: w("La foratura completa non va con l'imbottitura termica.", 'Full perforation does not go with the thermal liner.') }] }, { repriced: false }) } }),
    },
    {
      id: 'quote-outside',
      label: 'Quote line · without protectors: outside the certificate (warning)',
      model: model({
        draft: [...draftOf(DEMO_LINE.chosen).filter((pick) => pick.groupId !== G.armour), { valueId: V.none, groupId: G.armour, text: '', byDefault: false, colourId: null, itemId: null, itemColourId: null }],
        changed: true,
        saveHeld: null,
        preview: { status: 'ready', value: preview({ outsideCertificate: true, certificateNotes: [{ valueId: V.none, note: 'Without its protectors the jacket is not the certified class AA garment.' }] }, { unitPrice: '446.25', optionsTotal: '70' }) },
      }),
    },
    { id: 'quote-leather', label: 'Quote line · a leather article and its colour on a choice', model: model({ draft: draftOf(DEMO_LINE.chosen).map((pick) => (pick.valueId === V.name ? { ...pick, itemId: '66666666-0000-4000-8000-000000000001', itemColourId: '66666666-0000-4000-8000-000000000003' } : pick)), changed: true, saveHeld: null, preview: { status: 'ready', value: preview({}, { unitPrice: '470' }) } }) },
    { id: 'quote-text-missing', label: 'Quote line · a typed text missing', model: model({ draft: draftOf(DEMO_LINE.chosen).map((pick) => (pick.valueId === V.name ? { ...pick, text: '' } : pick)), changed: true, saveHeld: { key: 'groups.textMissing' } }) },
    { id: 'quote-no-start', label: 'Quote line · priced by hand: the options wait for a start', model: model({ line: { ...DEMO_LINE, pricing: { holdsOptions: false, held: 'NO_START', manualKept: false } }, style: DEMO_LINE }) },
    { id: 'quote-done', label: 'Quote line · saved and priced again', model: model({ notice: { tone: 'success', words: { key: 'save.doneRepriced' } } }) },
    { id: 'quote-sent', label: 'Quote line · a sent version: read only, with the reason', model: model({ line: { ...DEMO_LINE, may: { configure: false, artwork: false, held: w('Il preventivo non è una bozza: le opzioni cambiano solo in bozza (fai una nuova versione).', 'The quote is not a draft: options change only while it is a draft (make a new version).') } }, saveHeld: { words: w('Il preventivo non è una bozza.', 'The quote is not a draft.') } }) },
    { id: 'quote-no-price', label: 'Quote line · a role without prices', model: model({ grains: { price: false, cost: false, margin: false } }) },
    { id: 'artwork-uploading', label: 'Artwork · a file being sent, one refused', model: model({ artwork: { uploading: ['back-print.png'], problem: { key: 'artwork.problem.type' } } }) },
    { id: 'order-change', label: 'Order line · options that add more than accepted: keep the price or amend', model: model({ mode: 'ORDER', line: orderLine, style: orderLine, draft: draftOf(orderLine.chosen).filter((pick) => pick.valueId !== V.liner), changed: true, saveHeld: { key: 'save.held.keepPrice' }, preview: { status: 'ready', value: preview({}, { repriced: false, change: '-60', unitPrice: '470', before: '470' }) } }) },
    { id: 'order-frozen', label: 'Order line · work orders made: options frozen', model: model({ mode: 'ORDER', line: { ...orderLine, may: { configure: false, artwork: true, held: w("Gli ordini di lavoro di questa riga sono già fatti con le sue opzioni: cambiale con una modifica dell'ordine e rifai gli ordini di lavoro.", 'Work orders already make this line with its options: change them through an order change and make the work orders again.') } }, style: orderLine }) },
    // B-W2b-374 (XF3:05): a group that takes a colour of the library offers only the colour picker; (XF3:04) an order line's
    // artwork shown in the customer's portal.
    {
      id: 'w2b-374-takes-colour',
      label: 'The perforation group takes a library colour, the name a material: only that picker each',
      model: model({ style: { ...DEMO_LINE, groups: DEMO_LINE.groups.map((group) => (group.groupId === G.perf ? { ...group, takes: 'COLOUR' as const } : group.groupId === G.name ? { ...group, takes: 'MATERIAL' as const } : group)) } }),
    },
    {
      id: 'w2b-374-order-portal',
      label: 'Order line · its artwork shown in the customer\'s portal',
      model: model({ mode: 'ORDER', line: { ...orderLine, artwork: [{ ...orderLine.artwork[0]!, portal: true }, { ...DEMO_LINE.artwork[0]!, fileId: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'back-print.png', contentType: 'image/png', from: 'LINE', portal: false }], may: { ...orderLine.may, share: true } }, style: orderLine, notice: { tone: 'success', words: { key: 'artwork.portal.shown' } } }),
    },
    { id: 'loading', label: 'Loading', model: model({ read: { status: 'loading' }, style: null, line: null }) },
    { id: 'error', label: 'The options could not be read', model: model({ read: { status: 'error', problem: { key: 'problem.read' } }, style: null, line: null }) },
    { id: 'no-options', label: 'A style without options', model: model({ style: { ...DEMO_LINE, groups: [] }, line: { ...DEMO_LINE, groups: [], chosen: [] }, draft: [] }) },
  ],
})
