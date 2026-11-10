import { describe, expect, it } from 'vitest'
import { planVariants, variantWords } from '../routing-depth/rules'
import {
  ANY_OPTION,
  bomChanges,
  brokenWords,
  checkConfiguration,
  effectProblems,
  effectWords,
  freeTextProblem,
  freeTextRuleProblems,
  groupPicksProblems,
  kindChangeProblem,
  offerPicksProblems,
  patternProblem,
  priceDeltaOf,
  ruleDraftOf,
  rulesProblems,
  ruleWords,
  subjectOfDraft,
  summariseEffects,
  type CheckOffer,
  type EffectFacts,
  type RuleFacts,
  type ValueNameFacts,
} from './rules'

/** B-W2b-229 — options and configuration rules, pure. Every code, name and id is made up. */

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`
const G = { perf: id(1), liner: id(2), name: id(3), armour: id(4) }
const V = { front: id(11), full: id(12), linerYes: id(21), name: id(31), std: id(41), none: id(42) }

const value = (valueId: string, code: string, name: string, extra: Partial<CheckOffer['values'][number]> = {}) => ({
  id: valueId,
  code,
  name,
  nameI18n: null,
  status: 'ACTIVE' as const,
  freeText: false,
  freeTextMaxLength: null,
  freeTextPattern: null,
  ...extra,
})
const OFFERS: CheckOffer[] = [
  { groupId: G.perf, code: 'PERF', name: 'Perforation', nameI18n: { it: 'Perforazione' }, kind: 'SINGLE', picks: { minPicks: 0, maxPicks: 1 }, defaultValueId: null, values: [value(V.front, 'FRONT', 'Front perforation'), value(V.full, 'FULL', 'Full perforation', { nameI18n: { it: 'Perforazione totale' } })] },
  { groupId: G.liner, code: 'LINER', name: 'Thermal liner', nameI18n: null, kind: 'SINGLE', picks: { minPicks: 0, maxPicks: 1 }, defaultValueId: null, values: [value(V.linerYes, 'YES', 'Thermal liner')] },
  { groupId: G.name, code: 'NAME', name: 'Name embroidery', nameI18n: null, kind: 'FREE_TEXT', picks: { minPicks: 0, maxPicks: 1 }, defaultValueId: null, values: [value(V.name, 'NAME', 'Name', { freeText: true, freeTextMaxLength: 12, freeTextPattern: "^[A-Za-z .'-]+$" })] },
  { groupId: G.armour, code: 'ARMOUR', name: 'Armour', nameI18n: null, kind: 'SINGLE', picks: { minPicks: 1, maxPicks: 1 }, defaultValueId: V.std, values: [value(V.std, 'STD', 'Standard armour'), value(V.none, 'NONE', 'No armour')] },
]
const RULES: RuleFacts[] = [
  { id: id(91), groupId: G.perf, valueId: V.full, kind: 'EXCLUDES', otherValueId: V.linerYes, severity: 'BLOCK', messageI18n: { it: 'Niente fodera con la perforazione totale.', en: 'No liner with full perforation.' } },
  { id: id(92), groupId: G.liner, valueId: V.linerYes, kind: 'REQUIRES', otherValueId: V.std, severity: 'WARN', messageI18n: null },
]
const names = new Map<string, ValueNameFacts>(
  OFFERS.flatMap((offer) => offer.values.map((entry) => [entry.id, { id: entry.id, code: entry.code, name: entry.name, nameI18n: entry.nameI18n, groupId: offer.groupId, group: { code: offer.code, name: offer.name, nameI18n: offer.nameI18n } }] as const)),
)
const groupOf = (groupId: string) => OFFERS.find((offer) => offer.groupId === groupId)

describe('groups, offers and values', () => {
  it('says the picks of a group and of a style in words', () => {
    expect(groupPicksProblems('MULTI', { minPicks: 0, maxPicks: null })).toEqual([])
    expect(groupPicksProblems('SINGLE', { minPicks: 0, maxPicks: 2 }).map((issue) => issue.path)).toEqual(['maxPicks'])
    expect(groupPicksProblems('MULTI', { minPicks: 3, maxPicks: 2 })[0]).toMatchObject({ path: 'maxPicks', message: 'At most (2) is not below at least (3).' })
    expect(offerPicksProblems('MULTI', { minPicks: 0, maxPicks: 3 }, { minPicks: 1, maxPicks: null })).toEqual([])
    expect(offerPicksProblems('MULTI', { minPicks: 0, maxPicks: 3 }, { minPicks: 5, maxPicks: null })[0]).toMatchObject({ path: 'minPicks', message: 'The style would ask at least 5 and at most 3 values of the group.' })
    expect(offerPicksProblems('SINGLE', { minPicks: 0, maxPicks: 1 }, { minPicks: null, maxPicks: 2 }).map((issue) => issue.path)).toEqual(['maxPicks'])
    expect(kindChangeProblem('FREE_TEXT', { valuesWithoutText: 2, offersAskingMore: [] })).toContain('2 value(s)')
    expect(kindChangeProblem('SINGLE', { valuesWithoutText: 0, offersAskingMore: ['JKT-1'] })).toContain('JKT-1')
  })

  it('checks a free-text rule, its pattern (the same in every check) and a typed text', () => {
    expect(freeTextRuleProblems({ freeText: false, freeTextMaxLength: null, freeTextPattern: null }, 'FREE_TEXT').map((issue) => issue.path)).toEqual(['freeText'])
    expect(freeTextRuleProblems({ freeText: true, freeTextMaxLength: null, freeTextPattern: null }, 'MULTI').map((issue) => issue.path)).toEqual(['freeTextMaxLength'])
    expect(freeTextRuleProblems({ freeText: false, freeTextMaxLength: 5, freeTextPattern: '^a$' }, 'MULTI').map((issue) => issue.path)).toEqual(['freeTextMaxLength', 'freeTextPattern'])
    expect(patternProblem("^[A-Za-z .'-]+$")).toBeNull()
    expect(patternProblem('^[[:alpha:]]+$')).toContain('[[:alpha:]]')
    expect(patternProblem('\\p{L}+')).toContain('\\p{')
    expect(patternProblem('([a-z]')).toContain('not a regular expression')
    const rule = { code: 'NAME', freeText: true, freeTextMaxLength: 12, freeTextPattern: "^[A-Za-z .'-]+$" }
    expect(freeTextProblem(rule, "O'Neil")).toBeNull()
    expect(freeTextProblem(rule, '   ')?.en).toBe('Option NAME needs a typed text.')
    expect(freeTextProblem(rule, 'A very long name here')?.en).toBe('The text of NAME is 21 characters: 12 at most.')
    expect(freeTextProblem(rule, 'R2-D2')?.en).toContain('not in the form')
    expect(freeTextProblem({ ...rule, freeText: false, freeTextMaxLength: null, freeTextPattern: null }, 'x')?.en).toBe('Option NAME takes no typed text.')
    // Lengths count characters, not UTF-16 units.
    expect(freeTextProblem({ code: 'N', freeText: true, freeTextMaxLength: 2, freeTextPattern: null }, '😀😀')).toBeNull()
  })
})

describe('rules, shaped for the RuleBuilder (PRD-207)', () => {
  it('reads and draws the subject as one condition row', () => {
    expect(ruleDraftOf(V.full)).toEqual({ combinator: 'and', rows: [{ id: 'subject', field: 'option', operator: 'eq', value: V.full }] })
    expect(subjectOfDraft(ruleDraftOf(null))).toEqual({ ok: true, valueId: null })
    expect(subjectOfDraft({ combinator: 'and', rows: [{ id: 'a', field: 'option', operator: 'in', value: [V.full] }] })).toMatchObject({ ok: false, issue: { path: 'when/rows/0/operator' } })
    expect(subjectOfDraft({ combinator: 'and', rows: [] })).toMatchObject({ ok: false, issue: { path: 'when/rows' } })
  })

  it('previews a rule and says it when broken', () => {
    expect(ruleWords(RULES[0]!, (valueId) => names.get(valueId), groupOf)).toEqual({ it: 'Perforazione totale esclude Thermal liner — blocca', en: 'Full perforation excludes Thermal liner — block' })
    expect(ruleWords({ ...RULES[0]!, valueId: null }, (valueId) => names.get(valueId), groupOf).en).toBe('Any option of Perforation excludes Thermal liner — block')
    expect(brokenWords(RULES[0]!, (valueId) => names.get(valueId), groupOf).en).toBe('No liner with full perforation.')
    expect(brokenWords(RULES[1]!, (valueId) => names.get(valueId), groupOf).en).toBe('Thermal liner needs Standard armour too: choose it.')
  })

  it('refuses a rule set the database or the configurator could not keep, in words', () => {
    const facts = new Map([
      [V.front, { id: V.front, code: 'FRONT', groupId: G.perf, status: 'ACTIVE' as const, companyId: null }],
      [V.full, { id: V.full, code: 'FULL', groupId: G.perf, status: 'ACTIVE' as const, companyId: null }],
      [V.linerYes, { id: V.linerYes, code: 'YES', groupId: G.liner, status: 'ACTIVE' as const, companyId: null }],
      [V.std, { id: V.std, code: 'STD', groupId: G.armour, status: 'ARCHIVED' as const, companyId: null }],
      [V.none, { id: V.none, code: 'NONE', groupId: G.armour, status: 'ACTIVE' as const, companyId: id(99) }],
    ])
    const group = { id: G.perf, companyId: null }
    const ok = rulesProblems(group, [{ id: null, valueId: V.full, kind: 'EXCLUDES', otherValueId: V.linerYes, severity: 'BLOCK' }], (valueId) => facts.get(valueId), new Map())
    expect(ok).toEqual([])
    const refused = rulesProblems(
      group,
      [
        { id: null, valueId: V.full, kind: 'EXCLUDES', otherValueId: V.linerYes, severity: 'BLOCK' },
        { id: null, valueId: V.full, kind: 'EXCLUDES', otherValueId: V.linerYes, severity: 'WARN' },
        { id: null, valueId: V.full, kind: 'REQUIRES', otherValueId: V.linerYes, severity: 'WARN' },
        { id: null, valueId: null, kind: 'EXCLUDES', otherValueId: V.front, severity: 'BLOCK' },
        { id: null, valueId: V.linerYes, kind: 'REQUIRES', otherValueId: V.std, severity: 'BLOCK' },
        { id: null, valueId: V.front, kind: 'REQUIRES', otherValueId: V.none, severity: 'BLOCK' },
        { id: id(77), valueId: V.front, kind: 'EXCLUDES', otherValueId: V.front, severity: 'BLOCK' },
      ],
      (valueId) => facts.get(valueId),
      new Map(),
    )
    expect(refused.map((issue) => issue.path)).toEqual([
      'rules/1/otherValueId',
      'rules/2/kind',
      'rules/3/otherValueId',
      'rules/4/when/rows/0/value',
      'rules/4/otherValueId',
      'rules/5/otherValueId',
      'rules/6/id',
      'rules/6/otherValueId',
    ])
    // A rule kept as it was may still name a value archived since.
    const kept = rulesProblems(group, [{ id: id(78), valueId: V.full, kind: 'REQUIRES', otherValueId: V.std, severity: 'WARN' }], (valueId) => facts.get(valueId), new Map([[id(78), { valueId: V.full, otherValueId: V.std }]]))
    expect(kept).toEqual([])
  })
})

describe('THE check of a configuration', () => {
  it('takes the defaults, checks picks, texts and rules: a BLOCK refuses, a WARN is read', () => {
    const plain = checkConfiguration({ offers: OFFERS, rules: RULES, picks: [] })
    expect(plain).toMatchObject({ ok: true, blocks: [], warnings: [] })
    expect(plain.chosen).toEqual([{ valueId: V.std, groupId: G.armour, text: null, byDefault: true }])

    const blocked = checkConfiguration({ offers: OFFERS, rules: RULES, picks: [{ valueId: V.full }, { valueId: V.linerYes }, { valueId: V.none }] })
    expect(blocked.ok).toBe(false)
    expect(blocked.blocks.map((finding) => [finding.code, finding.ruleId])).toEqual([['EXCLUDES', id(91)]])
    expect(blocked.blocks[0]!.message.en).toBe('No liner with full perforation.')
    expect(blocked.warnings.map((finding) => [finding.code, finding.message.en])).toEqual([['REQUIRES', 'Thermal liner needs Standard armour too: choose it.']])

    const wrong = checkConfiguration({ offers: OFFERS, rules: [], picks: [{ valueId: V.front }, { valueId: V.full }, { valueId: V.name, text: 'R2-D2' }, { valueId: id(500) }, { valueId: V.front }], useDefaults: false })
    expect(wrong.blocks.map((finding) => [finding.code, finding.path])).toEqual([
      ['TEXT', 'picks/2'],
      ['NOT_OFFERED', 'picks/3'],
      ['TWICE', 'picks/4'],
      ['TOO_MANY', `groups/${G.perf}`],
      ['TOO_FEW', `groups/${G.armour}`],
    ])
    const archived = checkConfiguration({ offers: [{ ...OFFERS[3]!, values: [value(V.std, 'STD', 'Standard', { status: 'ARCHIVED' }), value(V.none, 'NONE', 'None')] }], rules: [], picks: [{ valueId: V.std }] })
    expect(archived.blocks.map((finding) => finding.code)).toEqual(['ARCHIVED', 'TOO_FEW'])
    // A rule about any option of a group fires on any of its options.
    const any = checkConfiguration({ offers: OFFERS, rules: [{ ...RULES[0]!, valueId: null }], picks: [{ valueId: V.front }, { valueId: V.linerYes }] })
    expect(any.blocks.map((finding) => finding.code)).toEqual(['EXCLUDES'])
    expect(ANY_OPTION).toBe('*')
  })
})

const effect = (n: number, valueId: string, fields: Partial<EffectFacts> & Pick<EffectFacts, 'kind'>): EffectFacts => ({
  id: id(n),
  valueId,
  itemId: null,
  itemColourId: null,
  targetItemId: null,
  qty: null,
  uom: null,
  sizeQuantities: null,
  section: null,
  operationId: null,
  minutes: null,
  priceDelta: null,
  currency: null,
  pricePct: null,
  note: null,
  ...fields,
})

describe('effects (PRD-208, PRD-081)', () => {
  const ITEM = { shell: id(201), lining: id(202), mesh: id(203), thread: id(204), protector: id(205) }
  const EFFECTS = [
    effect(301, V.full, { kind: 'BOM_REPLACE', itemId: ITEM.mesh, targetItemId: ITEM.lining }),
    effect(302, V.full, { kind: 'OPERATION_ADD', operationId: id(401) }),
    effect(303, V.full, { kind: 'PRICE', priceDelta: '40', currency: 'EUR' }),
    effect(304, V.front, { kind: 'PRICE', pricePct: '5' }),
    effect(305, V.front, { kind: 'MINUTES', minutes: '6', operationId: id(402) }),
    effect(306, V.name, { kind: 'BOM_ADD', itemId: ITEM.thread, qty: '5', uom: 'M', sizeQuantities: { '50': '4.5' }, section: 'THREAD' }),
    effect(307, V.name, { kind: 'PRICE', pricePct: '10' }),
    effect(308, V.none, { kind: 'CERTIFICATE', note: 'Without armour the jacket is not the certified one.' }),
    effect(309, V.none, { kind: 'BOM_REMOVE', targetItemId: ITEM.protector }),
  ]

  it('says what each kind fills, in words', () => {
    expect(effectProblems({ ...EFFECTS[0]! })).toEqual([])
    expect(effectProblems({ ...effect(1, V.full, { kind: 'BOM_ADD', itemId: ITEM.thread, uom: 'M' }) }).map((issue) => issue.path)).toEqual(['qty'])
    expect(effectProblems({ ...effect(1, V.full, { kind: 'BOM_REMOVE', targetItemId: ITEM.lining, minutes: '3' }) }).map((issue) => issue.path)).toEqual(['minutes'])
    expect(effectProblems({ ...effect(1, V.full, { kind: 'MINUTES', minutes: '0' }) }).map((issue) => issue.path)).toEqual(['minutes'])
    expect(effectProblems({ ...effect(1, V.full, { kind: 'PRICE', priceDelta: '5', pricePct: '3', currency: 'EUR' }) }).map((issue) => issue.path)).toEqual(['priceDelta'])
    expect(effectProblems({ ...effect(1, V.full, { kind: 'PRICE', pricePct: '1001' }) }).map((issue) => issue.path)).toEqual(['pricePct'])
    expect(effectProblems({ ...effect(1, V.full, { kind: 'CERTIFICATE' }) }).map((issue) => issue.path)).toEqual(['note'])
    expect(effectProblems({ ...EFFECTS[5]! }, ['50', '52']).map((issue) => issue.path)).toEqual([])
    expect(effectProblems({ ...EFFECTS[5]! }, ['52', '54'])[0]).toMatchObject({ path: 'sizeQuantities/50', message: expect.stringContaining('not in the style') })
    expect(effectWords(EFFECTS[5]!, { item: 'THR-1' }).en).toBe('Adds THR-1 5 M (for 1 sizes) · THREAD')
    // A price effect says no amount in words (money only in its marked field).
    expect(effectWords(EFFECTS[2]!, {}).en).toBe('Moves the price')
  })

  it('adds up minutes and prices (percents never compound), flags the certificate and clashes', () => {
    const summary = summariseEffects(new Set([V.full, V.front, V.name, V.none]), EFFECTS)
    expect(summary.minutesAdded).toBe('6')
    expect(summary.operationsAtStandard).toBe(1)
    expect(summary.price).toEqual({ byCurrency: [{ currency: 'EUR', delta: '40' }], percent: '15' })
    expect(summary.outsideCertificate).toBe(true)
    expect(summary.clashes).toEqual([])
    expect(priceDeltaOf('200', 'EUR', summary.price)).toEqual({ ok: true, delta: '70' })
    expect(priceDeltaOf('200', 'USD', summary.price)).toMatchObject({ ok: false })
    const clash = summariseEffects(new Set([V.full, V.std]), [EFFECTS[0]!, effect(310, V.std, { kind: 'BOM_REMOVE', targetItemId: ITEM.lining })])
    expect(clash.clashes).toEqual([{ targetItemId: ITEM.lining, effectIds: [id(301), id(310)] }])
  })

  it("applies the chosen values to a revision's lines: option lines, removed, replaced, added, defined twice", () => {
    const lines = [
      { id: id(601), seq: 10, itemId: ITEM.shell, optionValueId: null },
      { id: id(602), seq: 20, itemId: ITEM.lining, optionValueId: null },
      { id: id(603), seq: 30, itemId: ITEM.protector, optionValueId: null },
      { id: id(604), seq: 40, itemId: ITEM.thread, optionValueId: V.name },
      { id: id(605), seq: 50, itemId: ITEM.mesh, optionValueId: V.linerYes },
    ]
    const changes = bomChanges(lines, new Set([V.full, V.none, V.name]), EFFECTS)
    expect(changes.optionLinesTaken).toEqual([id(604)])
    expect(changes.optionLinesLeftOut).toEqual([id(605)])
    expect(changes.removed).toEqual([{ lineId: id(603), seq: 30, effectId: id(309) }])
    expect(changes.replaced).toEqual([{ lineId: id(602), seq: 20, effectId: id(301), itemId: ITEM.mesh }])
    expect(changes.added.map((entry) => entry.id)).toEqual([id(306)])
    expect(changes.definedTwice).toEqual([{ effectId: id(306), lineId: id(604), itemId: ITEM.thread }])
    expect(bomChanges(lines.slice(0, 1), new Set([V.none]), EFFECTS).targetsMissing).toEqual([{ effectId: id(309), targetItemId: ITEM.protector }])
  })
})

describe("B-W2b-225's steps only for options, wired (planVariants)", () => {
  const style = { sizes: ['50', '52'], colourwayIds: [id(701)], optionValueIds: [V.front, V.full] }
  it('takes options the style offers, in its order; refuses others in words', () => {
    expect(planVariants({ sizes: [], colourwayIds: [], optionValueIds: [V.full, V.front] }, style)).toEqual({ ok: true, variants: { sizes: [], colourwayIds: [], optionValueIds: [V.front, V.full] } })
    const refused = planVariants({ sizes: [], colourwayIds: [], optionValueIds: [V.linerYes, V.front, V.front] }, style)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.issues.map((issue) => issue.path)).toEqual(['optionValueIds/2', 'optionValueIds/0'])
    const none = planVariants({ sizes: [], colourwayIds: [], optionValueIds: [V.front] }, { ...style, optionValueIds: [] })
    expect(none.ok ? [] : none.issues).toEqual([expect.objectContaining({ path: 'optionValueIds', message: expect.stringContaining('offers no options') })])
    expect(variantWords({ sizes: [], colourwayIds: [], optionValueIds: [V.front] }, () => '?', () => 'PERF: FRONT')?.en).toBe('Only for option PERF: FRONT')
  })
})
