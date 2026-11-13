import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { BenchCheck } from '../../../sales/quotes/record/configurator/api'
import { DEMO_STYLE } from '../../../sales/quotes/record/configurator/fixtures'
import { ConfiguratorView, type ConfiguratorModel } from '../../../sales/quotes/record/configurator/view/ConfiguratorView'
import { benchModelOf } from './model'

/**
 * SCR-426 — Products, Options & rules: Test a combination (B-W2b-340; SAL-249; design products.options pop "Configurator
 * preview"), made-up data only: the demo touring jacket's groups, a combination checked (the surcharges added up, what
 * changes in the making, the notes on the revision), a refused one in the rule's words, before a style is chosen, loading,
 * an error. Nothing is saved.
 */

const w = (it: string, en: string) => ({ it, en })
const STYLES = [
  { value: DEMO_STYLE.style.id, label: `${DEMO_STYLE.style.code} · ${DEMO_STYLE.style.name}` },
  { value: '33333333-0000-4000-8000-0000000000aa', label: 'DEMO-JKT-01 · Demo racing jacket' },
]
const [liner, perf, name] = DEMO_STYLE.groups
const draft = [
  { valueId: liner!.values[0]!.id, groupId: liner!.groupId, text: '', byDefault: false, colourId: null, itemId: null, itemColourId: null },
  { valueId: perf!.values[0]!.id, groupId: perf!.groupId, text: '', byDefault: false, colourId: null, itemId: null, itemColourId: null },
  { valueId: name!.values[0]!.id, groupId: name!.groupId, text: 'ROSSI', byDefault: false, colourId: null, itemId: null, itemColourId: null },
]
const CHECK: BenchCheck = {
  ok: true,
  blocks: [],
  warnings: [],
  chosen: [{ valueId: DEMO_STYLE.groups[3]!.values[0]!.id, groupId: DEMO_STYLE.groups[3]!.groupId, code: 'STD', groupCode: 'DEMO-ARMOUR', text: null, byDefault: true }],
  effects: {
    bom: [{ effectId: 'bbbbbbbb-0000-4000-8000-000000000001', valueId: name!.values[0]!.id, kind: 'BOM_ADD', words: w('Aggiunge DEMO-THR-530 0,02 M', 'Adds DEMO-THR-530 0.02 M') }],
    operations: [],
    minutes: [{ effectId: 'bbbbbbbb-0000-4000-8000-000000000002', valueId: perf!.values[0]!.id, kind: 'MINUTES', words: w('Aggiunge 6 minuti', 'Adds 6 minutes') }],
    minutesAdded: '10',
    operationsAtStandard: 0,
    price: { byCurrency: [{ currency: 'EUR', delta: '75' }], percent: '5' },
    outsideCertificate: false,
    certificateNotes: [],
  },
  bom: { revision: { id: 'cccccccc-0000-4000-8000-000000000001', revision: 1, status: 'RELEASED' }, notes: [w('DEMO-LIN-210 è sia una riga per l’opzione sia un effetto della libreria: messo due volte.', 'DEMO-LIN-210 is both an option line and a library effect: put in twice.')] },
}
const grains = { price: true, cost: false, margin: true }
const model = (extra: Partial<Parameters<typeof benchModelOf>[0]> = {}): ConfiguratorModel =>
  benchModelOf({ styles: STYLES, styleId: DEMO_STYLE.style.id, style: DEMO_STYLE, read: { status: 'ready' }, draft, check: { status: 'ready', value: CHECK }, grains, ...extra })

export const designScreen = defineDesignScreen<ConfiguratorModel>({
  screen: 'SCR-426',
  title: 'Products, Options & rules: Test a combination (rules, surcharges, what changes in the making; nothing saved)',
  view: ConfiguratorView,
  cases: [
    { id: 'checked', label: 'A combination checked: surcharges, materials and minutes, a note on the revision', model: model(), note: 'The style\'s default (standard protectors) is shown chosen beside the picks.' },
    {
      id: 'refused',
      label: 'Refused in the rule\'s words',
      model: model({
        draft: [draft[0]!, { ...draft[1]!, valueId: perf!.values[1]!.id }],
        check: { status: 'ready', value: { ...CHECK, ok: false, blocks: [{ code: 'EXCLUDES', severity: 'BLOCK', path: 'rules/x', groupId: perf!.groupId, valueId: perf!.values[1]!.id, ruleId: perf!.rules[0]!.ruleId, message: perf!.rules[0]!.broken }] } },
      }),
    },
    { id: 'checking', label: 'Checking', model: model({ check: { status: 'checking', value: null } }) },
    { id: 'no-price', label: 'A role without prices', model: model({ grains: { price: false, cost: false, margin: false } }) },
    { id: 'pick', label: 'Before a style is chosen', model: model({ styleId: '', style: null, draft: [], check: { status: 'idle', value: null } }) },
    { id: 'loading', label: 'Loading the style', model: model({ read: { status: 'loading' }, style: null }) },
    { id: 'error', label: 'The style could not be read', model: model({ read: { status: 'error', problem: { key: 'problem.read' } }, style: null }) },
  ],
})
