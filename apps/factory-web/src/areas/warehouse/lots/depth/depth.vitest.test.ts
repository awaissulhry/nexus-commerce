import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ATTRIBUTE_KEYS } from '@nexus/factory-domain/inventory/lots-depth/attributes'
import { LIFECYCLE_CAUSES, LOT_LIFECYCLES } from '@nexus/factory-domain/inventory/lots-depth/lifecycle'
import { INCOMING_STATES, SEPARATION_STATES } from '@nexus/factory-domain/inventory/lots-depth/page'
import { familyRefusal, hideMoveRefusal, proposalFromInspection, type HideMoveFacts } from '@nexus/factory-domain/inventory/lots-depth/split'
import { TRACE_REPORT_AUDIENCES, TRACE_REPORT_FORMATS } from '@nexus/factory-domain/inventory/lots-depth/trace-report'
import { TRACE_DIRECTIONS } from '@nexus/factory-domain/inventory/trace/rules'
import { TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as lotsScreen } from '../list/fixtures'
import { designScreen as lotScreen } from '../record/fixtures'
import { lotViewOf, lotQuery } from '../model'
import { canFor, ROLE_PERMISSIONS } from '../../../_shared/stock/fixtures'
import { FAMILY_READ, nappaDepth, SPLIT_READ, splitDraftFor } from './demo/fixtures'
import {
  attributeChanges,
  attributeProblems,
  blankReport,
  DEPTH_NAMESPACE,
  depthCan,
  depthViewQuery,
  draftOf,
  filledGroups,
  hideRefusalKey,
  historyWords,
  isDepthView,
  lifecycleBehind,
  parseGradeMix,
  proposalLabel,
  regroupBodyOf,
  reportBodyOf,
  reportHeld,
  reportProblems,
  splitBodyOf,
  splitHeld,
  splitHeldKey,
} from './model'

/**
 * B-W2b-320 — the W2b parts of Warehouse › Lots & traceability: the views, every English sentence of B-W2b-313 said in our
 * words (each domain sentence run here, so a changed sentence fails in this test, never on screen), the split and regroup
 * drafts and why they wait, the attributes form (the domain's own check), the trace report's request, and every W2b design
 * case drawn in Italian and English with no key left.
 */

const params = (query: string) => new URLSearchParams(query)
const hideFacts = (over: Partial<HideMoveFacts>): HideMoveFacts => ({ code: 'HD-1', state: 'FULL', onHand: '10', reserved: false, held: false, openInspection: null, openCount: null, openTask: false, openTransfer: false, openClaim: false, plannedKit: false, ...over })

describe('lots depth: views and abilities', () => {
  it('reads the W2b views from the address and maps them to B-W2b-313’s list', () => {
    expect(lotViewOf(params('view=depleted'), canFor('warehouse'))).toBe('depleted')
    expect(lotViewOf(params('view=expiring'), canFor('warehouse'))).toBe('expiring')
    expect(isDepthView('depleted')).toBe(true)
    expect(isDepthView('waiting')).toBe(false)
    expect(depthViewQuery('depleted')).toEqual({ view: 'DEPLETED' })
    expect(depthViewQuery('expiring')).toEqual({ view: 'ALL', documentsExpiring: true })
    // A W1 view keeps its own filter (the W2b columns come by id).
    expect(lotQuery('inStock', '', null)).toMatchObject({ inStock: true })
  })

  it('gives sorting hides to the warehouse and quality, the trace report to quality only', () => {
    expect(depthCan(ROLE_PERMISSIONS.warehouse)).toMatchObject({ manage: true, report: false })
    expect(depthCan(ROLE_PERMISSIONS.quality)).toMatchObject({ manage: true, report: true })
    expect(depthCan(ROLE_PERMISSIONS.readOnly)).toMatchObject({ manage: false, report: false })
    expect(depthCan([])).toEqual({ manage: false, report: false, files: false })
  })
})

describe('lots depth: B-W2b-313’s English said in our words', () => {
  it('names every hide refusal of the domain by its own key (never "other")', () => {
    const cases: Partial<HideMoveFacts>[] = [{ state: 'PARTLY_CUT' }, { onHand: '0' }, { reserved: true }, { held: true }, { openInspection: 'IC-1' }, { openCount: 'CNT-1' }, { openTask: true }, { openTransfer: true }, { openClaim: true }, { plannedKit: true }]
    const keys = cases.map((over) => hideRefusalKey(hideMoveRefusal(hideFacts(over)))!.key)
    expect(keys).toEqual(['notWhole', 'nothing', 'reserved', 'held', 'inspection', 'count', 'task', 'transfer', 'claim', 'kit'].map((key) => `ld.split.hide.${key}`))
    expect(hideRefusalKey(hideMoveRefusal(hideFacts({ openInspection: 'IC-D-9' })))!.params).toEqual({ ref: 'IC-D-9' })
    expect(hideRefusalKey(null)).toBeNull()
    expect(hideRefusalKey('Something new.')!.key).toBe('ld.split.hide.other')
  })

  it('holds the split exactly when the domain refuses the family, then by the person’s right', () => {
    for (const tracking of ['HIDE', 'LOT']) {
      for (const qualityStatus of ['QUARANTINE', 'RELEASED', 'BLOCKED', 'REJECTED']) {
        expect(splitHeldKey({ tracking, qualityStatus }, { manage: true }) === null, `${tracking} ${qualityStatus}`).toBe(familyRefusal({ code: 'L', tracking, qualityStatus }) === null)
      }
    }
    expect(splitHeldKey({ tracking: 'HIDE', qualityStatus: 'RELEASED' }, { manage: false })!.key).toBe('ld.split.held.noRight')
  })

  it('says the groups an inspection kept apart in our words', () => {
    const groups = proposalFromInspection([
      { hideId: 'a', shadeGroupId: null, shadeLabel: null, decision: 'REJECTED' },
      { hideId: 'b', shadeGroupId: null, shadeLabel: null, decision: 'TO_SORT' },
      { hideId: 'c', shadeGroupId: 'g1', shadeLabel: '1', decision: 'ACCEPTED' },
    ])
    expect(groups.map((group) => proposalLabel(group)?.key ?? null)).toEqual(['ld.split.apart.REJECTED', 'ld.split.apart.TO_SORT', null])
  })

  it('says each history row from its kind, cause and action', () => {
    expect(historyWords({ at: '', kind: 'LIFECYCLE', from: 'RELEASED', to: 'IN_USE', cause: 'FIRST_ISSUE', action: 'inventory.lotLifecycle' }).key).toBe('ld.cause.FIRST_ISSUE')
    expect(historyWords({ at: '', kind: 'QUALITY', from: null, to: 'RELEASED', cause: 'RELEASE', action: 'quality.lots.unblock' }).key).toBe('ld.decision.unblock')
    expect(historyWords({ at: '', kind: 'SPLIT', from: null, to: null, cause: null, action: 'inventory.regroupLot' }).key).toBe('ld.split.historyRegroup')
    expect(lifecycleBehind(nappaDepth())).toBe(false)
    expect(lifecycleBehind(nappaDepth({ lifecycle: { ...nappaDepth().lifecycle, expected: 'DEPLETED' } }))).toBe(true)
  })
})

describe('lots depth: split and regroup', () => {
  it('starts from the inspection’s groups, leaves a hide that cannot move out, and sends one group per child lot', () => {
    const draft = splitDraftFor(SPLIT_READ)
    expect(draft.groups.map((group) => group.shadeGroupId ?? group.label)).toEqual([SPLIT_READ.shadeGroups[0]!.id, SPLIT_READ.shadeGroups[1]!.id, 'Scartate dal controllo'])
    expect(Object.keys(draft.assign)).toHaveLength(6)
    expect(draft.assign[SPLIT_READ.hides[6]!.id]).toBeUndefined()
    expect(draft.inspectionId).toBe(SPLIT_READ.proposal.inspection!.id)
    expect(splitHeld(SPLIT_READ, draft, { manage: true }, false)).toBeNull()
    const body = splitBodyOf(SPLIT_READ, draft)
    expect(body.version).toBe(6)
    expect(body.groups).toHaveLength(3)
    expect(body.groups[0]).toEqual({ shadeGroupId: SPLIT_READ.shadeGroups[0]!.id, hideIds: SPLIT_READ.hides.slice(0, 3).map((hide) => hide.id) })
    expect(body.groups[2]).toEqual({ label: 'Scartate dal controllo', hideIds: [SPLIT_READ.hides[5]!.id] })
  })

  it('holds the button with why: no right, a refused hide picked, nothing in a group, a group without a name', () => {
    const draft = draftOf(SPLIT_READ)
    expect(splitHeld(SPLIT_READ, draft, { manage: false }, false)!.key).toBe('ld.split.held.noRight')
    expect(splitHeld(SPLIT_READ, { ...draft, assign: { ...draft.assign, [SPLIT_READ.hides[6]!.id]: 'g1' } }, { manage: true }, false)!.key).toBe('ld.split.held.refusedHide')
    expect(splitHeld(SPLIT_READ, { ...draft, assign: {} }, { manage: true }, false)!.key).toBe('ld.split.held.noHides')
    expect(splitHeld(SPLIT_READ, { ...draft, groups: [{ key: 'g1', shadeGroupId: null, label: ' ' }], assign: { [SPLIT_READ.hides[0]!.id]: 'g1' } }, { manage: true }, false)!.key).toBe('ld.split.held.noLabel')
    expect(filledGroups(SPLIT_READ, { ...draft, assign: { [SPLIT_READ.hides[0]!.id]: 'g2' } }).map((group) => group.key)).toEqual(['g2'])
  })

  it('regroups only hides that go to another lot of the family', () => {
    const into = FAMILY_READ.lots[1]!.id
    const draft = { mode: 'regroup' as const, groups: [], assign: { [FAMILY_READ.hides[0]!.id]: into, [FAMILY_READ.hides[3]!.id]: FAMILY_READ.hides[3]!.lot.id }, inspectionId: null, note: '' }
    expect(regroupBodyOf(FAMILY_READ, draft)).toEqual({ version: FAMILY_READ.parent.version, moves: [{ hideId: FAMILY_READ.hides[0]!.id, toLotId: into }] })
    expect(splitHeld(FAMILY_READ, { ...draft, assign: {} }, { manage: true }, false)!.key).toBe('ld.split.held.noMove')
  })
})

describe('lots depth: attributes and the trace report', () => {
  it('reads a grade mix and either decimal mark; an emptied field removes its value; the domain refuses in our words', () => {
    expect(parseGradeMix('A 75, B 25')).toEqual({ A: '75', B: '25' })
    expect(parseGradeMix('A:60; B=40 %')).toEqual({ A: '60', B: '40' })
    expect(parseGradeMix('A')).toBeNull()
    const depth = nappaDepth()
    const keys = depth.attributes.keys
    const { changes } = attributeChanges(depth.attributes.values, keys, { thicknessMinMm: '1,0', thicknessMaxMm: '1.3', finish: '', tannage: 'CHROME', gradeMix: 'A 75, B 25', origin: 'Italia' })
    expect(changes).toEqual({ thicknessMinMm: '1.0', finish: null })
    const over = attributeChanges(depth.attributes.values, keys, { thicknessMinMm: '1.1', thicknessMaxMm: '1.3', finish: 'Pieno fiore', tannage: 'CHROME', gradeMix: 'A 75, B 40', origin: 'Italia' })
    expect(attributeProblems('LEATHER', depth.attributes.values, over.changes, over.badMix)).toEqual({ gradeMix: { key: 'ld.attr.problem.gradeMix' } })
    const thick = attributeChanges(depth.attributes.values, keys, { thicknessMinMm: '1.5', thicknessMaxMm: '1.3', finish: 'Pieno fiore', tannage: 'CHROME', gradeMix: 'A 75, B 25', origin: 'Italia' })
    expect(Object.keys(attributeProblems('LEATHER', depth.attributes.values, thick.changes, thick.badMix))).toEqual(['thicknessMinMm'])
    expect(attributeChanges({}, keys, { gradeMix: 'nonsense' }).badMix).toBe(true)
  })

  it('asks who asked and a day not after today, holds without the right, sends the lot as the start', () => {
    const today = '2026-10-30'
    const blank = blankReport(today, 'en')
    expect(Object.keys(reportProblems(blank, today))).toEqual(['recipient'])
    expect(reportProblems({ ...blank, recipient: 'X', asOf: '2026-11-02' }, today).asOf!.key).toBe('ld.report.problem.asOf')
    expect(reportHeld({ ...blank, recipient: 'X' }, today, { report: true }, false)).toBeNull()
    expect(reportHeld({ ...blank, recipient: 'X' }, today, { report: false }, false)!.key).toBe('ld.report.held.noRight')
    expect(reportBodyOf('lot-1', { ...blank, recipient: ' Autorità ', reference: '', note: '' })).toEqual({ kind: 'LOT', id: 'lot-1', direction: 'BOTH', audience: 'CUSTOMER', recipient: 'Autorità', reference: null, requestedOn: today, asOf: today, format: 'PDF', language: 'en', note: null })
  })
})

const LEFT_KEY = /\b(?:ld|cd|sb|lt|hd)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs inventory.lots.manage"): not keys. */
const PERMISSIONS = /\b(?:inventory\.[a-z]+\.[a-z]+|inventory\.issue|files\.read|quality\.[a-z]+\.[a-z]+)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'stock', 'lists', 'records', 'warehouse-lots', DEPTH_NAMESPACE]) }, createElement(View, { model })))
}

describe('lots depth: every W2b design case draws in both languages with no key left', () => {
  for (const screen of [lotsScreen, lotScreen] as unknown as DesignScreen<unknown>[]) {
    const cases = screen.cases.filter((item) => item.id.startsWith('w2b-'))
    it(`${screen.screen}: ${cases.length} W2b cases × it, en`, () => {
      expect(cases.length).toBeGreaterThan(3)
      for (const item of cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(PERMISSIONS, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('every lifecycle, cause, state, audience, direction, format, tannage, attribute and unit has words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, [DEPTH_NAMESPACE])[DEPTH_NAMESPACE]!)
      const has = (key: string, params?: Record<string, string | number>) => expect(t(key, params), `${locale}: ${key}`).not.toBe(key)
      for (const state of LOT_LIFECYCLES) {
        has(`ld.life.state.${state}`)
        has(`ld.life.means.${state}`)
      }
      for (const cause of LIFECYCLE_CAUSES) has(`ld.cause.${cause}`)
      for (const state of INCOMING_STATES) has(`ld.incoming.state.${state}`)
      for (const state of SEPARATION_STATES) {
        has(`ld.sep.state.${state}`)
        has(`ld.sep.means.${state}`)
      }
      for (const audience of TRACE_REPORT_AUDIENCES) has(`ld.report.audiences.${audience}`)
      for (const direction of TRACE_DIRECTIONS) has(`ld.report.directions.${direction}`)
      for (const format of TRACE_REPORT_FORMATS) has(`ld.report.formats.${format}`)
      for (const tannage of TANNAGES) has(`ld.attr.tannages.${tannage}`)
      for (const key of ATTRIBUTE_KEYS) {
        has(`ld.attr.${key}`)
        has(`ld.attr.problem.${key}`)
      }
      for (const uom of UOMS) has(`ld.uom.${uom}`)
      for (const field of ['recipient', 'reference', 'requestedOn', 'asOf', 'note']) has(`ld.report.problem.${field}`, { today: '2026-10-30' })
      for (const decision of ['release', 'unblock', 'reject', 'block', 'other']) has(`ld.decision.${decision}`)
      for (const view of ['depleted', 'expiring']) has(`ld.view.${view}`)
    }
  })
})
