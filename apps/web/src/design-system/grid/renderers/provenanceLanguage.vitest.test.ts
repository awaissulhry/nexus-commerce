import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { classifyProvenance, describeCellSource, provenanceClassRules, type ProvenanceLike } from './provenance'
import { ProvenanceMark } from './provenanceMark'

describe('LX.10 shared language provenance', () => {
  it('uses the required precedence when several facts coexist', () => {
    const cell: ProvenanceLike = { refusedReason: 'German title is too long.', aiDrafted: true, aiStale: true,
      translation: { outdated: true }, formula: true, mapped: { status: 'mapped' }, inherited: true, pinned: true }
    for (const [expected, remove] of [
      ['refused', 'refusedReason'], ['aiStale', 'aiDrafted'], ['outdated', 'translation'],
      ['formula', 'formula'], ['mapped', 'mapped'], ['inherited', 'inherited'], ['pinned', 'pinned'], ['own', null],
    ] as const) {
      expect(classifyProvenance(cell)).toBe(expected)
      if (remove) delete cell[remove]
    }
  })
  it('names the answering tier and keeps a refusal sentence verbatim', () => {
    for (const from of ['German · shared', 'Italian · source']) {
      const result = describeCellSource({ provenance: { member: 'inherited', from } })
      expect(result.from).toBe(from); expect(result.tooltip).toContain(from)
    }
    const sentence = 'German title exceeds 200 bytes for Amazon · DE.'
    expect(describeCellSource({ formula: true, refusedReason: sentence }).tooltip).toBe(sentence)
  })
  it('never turns a following snapshot into an operator pin', () => {
    expect(describeCellSource({ provenance: { member: 'pinned', from: 'German · shared' }, follows: true }).member).toBe('inherited')
  })
  it('renders a distinct glyph, class and next action for human outdated text', () => {
    const source = describeCellSource({ provenance: { member: 'outdated', from: 'Italian · source' } })
    expect(source.tooltip).toContain('Compare with the source; translate again or mark reviewed.')
    const markup = renderToStaticMarkup(createElement(ProvenanceMark, { provenance: source.member, from: source.from }))
    expect(markup).toContain('nds-cell-prov-outdated'); expect(markup).toContain('lucide-history')
    expect(markup).not.toContain('tabindex')
    const rules = provenanceClassRules(() => source.member)
    expect(rules['nds-cell-is-outdated']({ data: {}, colDef: { colId: 'name' } })).toBe(true)
    expect(rules['nds-cell-is-ai-draft']({ data: {}, colDef: { colId: 'name' } })).toBe(false)
  })
})

it('does not turn an inherited language read into a rule just because diagnostics are present', () => {
  const cell: ProvenanceLike = { provenance: { member: 'inherited', from: 'German · shared' }, mapped: { status: 'mapped', provenance: 'catalogRule', derived: false } }
  expect(describeCellSource(cell, { layer: 'channel', from: 'an internal row id' })).toMatchObject({ member: 'inherited', from: 'German · shared' })
  expect(describeCellSource({ ...cell, mapped: { ...cell.mapped, derived: true } }).member).toBe('mapped')
})

it('keeps machine review ahead of computed provenance and human outdated text', () => {
  const computed: ProvenanceLike = { provenance:{member:'mapped',from:'German · shared'}, formula:true,
    translation:{source:'ai',reviewedAt:null,outdated:true} }
  expect(describeCellSource(computed).member).toBe('aiStale')
  expect(describeCellSource({...computed,translation:{...computed.translation!,outdated:false}}).member).toBe('ai')
  expect(describeCellSource({...computed,translation:{...computed.translation!,reviewedAt:'2026-09-12'}}).member).toBe('outdated')
  expect(describeCellSource({...computed,refusedReason:'Name cannot exceed 200 characters.'}).tooltip).toBe('Name cannot exceed 200 characters.')
})

it('names the answering pin tier without claiming that the listing follows that same pin', () => {
  const source = describeCellSource({tier:'pin',follows:false,provenance:{member:'pinned',from:'Dutch · Amazon · BE · pin'}})
  expect(source.tooltip).toBe('Pinned at Dutch · Amazon · BE · pin — changes to the shared language text do not replace this value.')
  const html = renderToStaticMarkup(createElement(ProvenanceMark,{provenance:source.member,from:source.from,tooltip:source.tooltip}))
  expect(html).toContain(source.tooltip)
})
