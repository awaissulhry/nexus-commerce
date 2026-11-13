import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { BenchCheck, StyleConfigurator } from '../../quotes/record/configurator/api'
import { DEMO_STYLE } from '../../quotes/record/configurator/fixtures'
import type { DraftPick } from '../../quotes/record/configurator/model'
import { OptionsEntryView, type OptionsEntryModel } from './view/OptionsEntryView'

/**
 * SCR-433 — the options of a typed order line (B-W2b-374; XF3:02): the "Options" dialog of a new line on a New order or an
 * amendment, made-up data only (the demo touring jacket DEMO-JKT-05 of B-W2b-340's fixtures: a liner, perforation whose
 * panels take a colour of the library, a name typed on the chest whose thread takes a material, the protectors).
 */

const w = (it: string, en: string) => ({ it, en })
const [liner, perf, name, armour] = DEMO_STYLE.groups
const STYLE: StyleConfigurator = {
  ...DEMO_STYLE,
  groups: [liner!, { ...perf!, takes: 'COLOUR' }, { ...name!, takes: 'MATERIAL' }, armour!],
}
const pick = (valueId: string, groupId: string, extra: Partial<DraftPick> = {}): DraftPick => ({ valueId, groupId, text: '', byDefault: false, colourId: null, itemId: null, itemColourId: null, ...extra })
const PICKED: DraftPick[] = [
  pick(liner!.values[0]!.id, liner!.groupId),
  pick(perf!.values[0]!.id, perf!.groupId, { colourId: DEMO_STYLE.choices.colours[1]!.id }),
  pick(name!.values[0]!.id, name!.groupId, { text: 'BIANCHI', itemId: DEMO_STYLE.choices.leathers[0]!.id, itemColourId: DEMO_STYLE.choices.leathers[0]!.colours[1]!.id }),
]
const CHECK: BenchCheck = {
  ok: true,
  blocks: [],
  warnings: [],
  chosen: [],
  effects: { bom: [], operations: [], minutes: [], minutesAdded: '0', operationsAtStandard: 0, price: null, outsideCertificate: false, certificateNotes: [] },
  bom: null,
}
const LINE = { style: 'DEMO-JKT-05', colour: 'BLK · Black' }

const model = (extra: Partial<OptionsEntryModel> = {}): OptionsEntryModel => ({
  line: LINE,
  read: { status: 'ready' },
  style: STYLE,
  draft: PICKED,
  check: { status: 'ready', value: CHECK },
  useHeld: null,
  offline: false,
  ...extra,
})

export const designScreen = defineDesignScreen<OptionsEntryModel>({
  screen: 'SCR-433',
  title: 'The options of a typed order line (New order, an amendment\'s new line): the style\'s groups, texts, colours and materials as each group takes them, the rules checked',
  view: OptionsEntryView,
  cases: [
    { id: 'picked', label: 'Options chosen and allowed: the perforation takes a library colour, the name a thread material', model: model(), note: 'Only the picker each group takes is offered (B-W2b-363 OptionGroup.takes).' },
    { id: 'nothing', label: 'Nothing chosen yet (the style\'s defaults are taken)', model: model({ draft: [], check: { status: 'idle', value: null } }) },
    { id: 'checking', label: 'The combination being checked: Use held', model: model({ check: { status: 'checking', value: null }, useHeld: { key: 'entry.held.checking' } }) },
    {
      id: 'refused',
      label: 'Refused in the rule\'s words: Use held',
      model: model({
        draft: [pick(liner!.values[0]!.id, liner!.groupId), pick(perf!.values[1]!.id, perf!.groupId)],
        check: { status: 'ready', value: { ...CHECK, ok: false, blocks: [{ code: 'EXCLUDES', severity: 'BLOCK', path: 'rules/x', groupId: perf!.groupId, valueId: perf!.values[1]!.id, ruleId: perf!.rules[0]!.ruleId, message: perf!.rules[0]!.broken }] } },
        useHeld: { key: 'entry.held.refused' },
      }),
    },
    { id: 'text-missing', label: 'A typed text missing: Use held', model: model({ draft: [pick(name!.values[0]!.id, name!.groupId)], useHeld: { key: 'entry.held.text' } }) },
    {
      id: 'outside',
      label: 'Without protectors: outside the certificate (a warning)',
      model: model({ draft: [pick(armour!.values[1]!.id, armour!.groupId)], check: { status: 'ready', value: { ...CHECK, effects: { ...CHECK.effects, outsideCertificate: true } } } }),
    },
    { id: 'both-pickers', label: 'A group that takes either: both pickers (as before)', model: model({ style: DEMO_STYLE, draft: [pick(perf!.values[0]!.id, perf!.groupId)] }) },
    { id: 'no-options', label: 'A style without options', model: model({ style: { ...STYLE, groups: [] }, draft: [], check: { status: 'idle', value: null } }) },
    { id: 'loading', label: 'Loading', model: model({ read: { status: 'loading' }, style: null, draft: [], check: { status: 'idle', value: null } }) },
    { id: 'error', label: 'The options could not be read', model: model({ read: { status: 'error', problem: { key: 'entry.problem.load' } }, style: null, draft: [], check: { status: 'idle', value: null } }) },
    { id: 'no-permission', label: 'A person who may not read the style\'s options', model: model({ read: { status: 'error', problem: { key: 'entry.problem.hidden' } }, style: null, draft: [], check: { status: 'idle', value: null } }) },
    { id: 'offline', label: 'Offline: the check waits, Use held', model: model({ offline: true, check: { status: 'idle', value: null }, useHeld: { key: 'entry.held.offline' } }) },
    { id: 'rule-words', label: 'A warning in the rule\'s words', model: model({ check: { status: 'ready', value: { ...CHECK, warnings: [{ code: 'REQUIRES', severity: 'WARN', path: 'rules/y', groupId: liner!.groupId, valueId: liner!.values[0]!.id, ruleId: liner!.rules[0]!.ruleId, message: w("L'imbottitura richiede le protezioni standard.", 'The liner requires the standard protectors.') }] } } }) },
  ],
})
