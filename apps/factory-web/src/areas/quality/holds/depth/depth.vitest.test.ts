import { describe, expect, it } from 'vitest'
import { TRACE_NODE_KINDS } from '@nexus/factory-domain/inventory/trace/rules'
import { HOLD_NEXT_STEPS } from '@nexus/factory-domain/quality/holds/depth'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { qualityCan } from '../../_shared/model'
import { canFor } from '../../_shared/fixtures'
import { AFFECTED, BOARD_HOLDS, detailOf, GENEALOGY, GENEALOGY_OTHER_SITE, HOLDS, IN_GROUP } from '../demo/fixtures'
import { holdsAddress, modeFromAddress, RECORD_TABS, tabFromAddress } from '../model'
import {
  askHeld,
  askProblems,
  BOARD_RELEASED,
  boardHeld,
  boardLanes,
  boardMoveHeld,
  confirmHeld,
  confirmProblems,
  extendStartOf,
  firstTicks,
  genealogyBody,
  genealogyFromAddress,
  genealogyProblems,
  GENEALOGY_DRAFT,
  impactTree,
  laneOfHold,
  onlyAffected,
  planOf,
  quarantineGaps,
  summaryWords,
  type TreeItem,
} from './model'

const en = createScopedTranslator('en', messagesFor('en', ['holds']), 'holds')
const it_ = createScopedTranslator('it', messagesFor('it', ['holds']), 'holds')
const params = (query: string) => new URLSearchParams(query)
const ids = (items: readonly TreeItem[]): string[] => items.flatMap((item) => [item.id, ...ids(item.children)])
const REASONS = [{ code: 'QUALITY_CHECK', needsDetail: false }, { code: 'OTHER', needsDetail: true }]

describe('the impact tree (B-W2b-114)', () => {
  it('one forest from the starts, each node once under the first that reaches it, by kind then code', () => {
    const tree = impactTree(GENEALOGY)
    expect(tree.map((item) => item.id)).toEqual([GENEALOGY.starts[0]!.key])
    const all = ids(tree)
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(GENEALOGY.nodes.length)
    const root = tree[0]!
    expect(root.children.map((item) => (item.type === 'node' ? item.node.kind : item.kind))).toEqual(['HIDE', 'HIDE', 'WORK_ORDER'])
    const shown = onlyAffected(tree)
    expect(ids(shown)).toContain(GENEALOGY.nodes.find((node) => node.kind === 'CUSTOMER' && node.received)!.key)
    expect(ids(shown)).not.toContain(GENEALOGY.nodes.find((node) => node.kind === 'CUSTOMER' && !node.received)!.key)
  })

  it('ticks every holdable branch first; never a held, gone, unholdable or other-site node and its branch', () => {
    const ticks = firstTicks(GENEALOGY)
    const keyOf = (code: string) => GENEALOGY.nodes.find((node) => node.code === code)!.key
    expect(ticks).toContain(keyOf('DEMO-LOT-0231'))
    expect(ticks).toContain(keyOf('DEMO-WO-0142'))
    expect(ticks).not.toContain(keyOf('DEMO-HIDE-0231-08'))
    expect(ticks).not.toContain(keyOf('DEMO-SH-0028'))
    expect(ticks).not.toContain(keyOf('DEMO-BN-0002'))
    expect(firstTicks(GENEALOGY_OTHER_SITE)).toEqual([])
  })
})

describe('the plan in our words', () => {
  it('says what is held and what has left, in both languages', () => {
    const plan = planOf(GENEALOGY, firstTicks(GENEALOGY))
    expect(plan.holds.map((hold) => hold.subjectType)).toEqual(['Lot', 'Hide', 'WorkOrder', 'Shipment'])
    expect(plan.covered.length).toBe(1)
    const words = summaryWords(plan.counts, en)
    expect(words.head).toBe('Hold 1 lot, 1 hide, 2 work orders, 1 shipment and 126 garments')
    expect(words.shipped).toBe('18 garments already shipped to 1 customer')
    expect(summaryWords(plan.counts, it_).head).toBe('Blocca 1 lotto, 1 pelle, 2 ordini di produzione, 1 spedizione e 126 capi')
    expect(summaryWords(planOf(GENEALOGY, []).counts, en)).toMatchObject({ nothing: true, head: 'Nothing ticked can be held' })
  })

  it('the dialog: problems before the click, the body only of trace keys, the sites where the move is not asked', () => {
    const ticks = firstTicks(GENEALOGY)
    expect(genealogyProblems(GENEALOGY_DRAFT, null, [], REASONS, '2026-10-29')).toEqual(['genealogy.problem.start', 'genealogy.problem.reason'])
    expect(genealogyProblems({ ...GENEALOGY_DRAFT, reasonCode: 'OTHER', expectedReleaseOn: '2026-10-01' }, GENEALOGY, ticks, REASONS, '2026-10-29')).toEqual(['genealogy.problem.reasonNote', 'genealogy.problem.date'])
    expect(genealogyProblems({ ...GENEALOGY_DRAFT, reasonCode: 'QUALITY_CHECK' }, GENEALOGY, ['group:x'], REASONS, '2026-10-29')).toEqual(['genealogy.problem.nothing'])
    const body = genealogyBody(GENEALOGY, [...ticks, 'LOT:x>group:HIDE'], { ...GENEALOGY_DRAFT, reasonCode: 'QUALITY_CHECK', note: '  ' }, null)
    expect(body.picks).toEqual(ticks)
    expect(body).toMatchObject({ type: 'Lot', id: GENEALOGY.start.id, note: null, askQuarantine: true, holdId: null })
    expect(quarantineGaps(GENEALOGY, ticks)).toEqual([])
    expect(quarantineGaps({ ...GENEALOGY, sites: [{ ...GENEALOGY.sites[0]!, quarantinePlaces: [] }] }, ticks)).toEqual([{ code: 'DEMO-A1', places: 0 }])
  })

  it('opens from an address and extends from a hold (its group, else its lot or hide)', () => {
    const lot = GENEALOGY.start.id
    expect(genealogyFromAddress(params(`genealogy=1&type=Lot&id=${lot}&hold=${HOLDS[0]!.id}`))).toEqual({ start: { type: 'Lot', id: lot }, holdId: HOLDS[0]!.id })
    expect(genealogyFromAddress(params('genealogy=1&type=WorkOrder&id=x'))).toEqual({ start: null, holdId: null })
    expect(genealogyFromAddress(params('view=open'))).toBeNull()
    const owner = canFor('owner')
    expect(extendStartOf(IN_GROUP, owner)).toEqual({ start: { type: 'Lot', id: lot, code: 'DEMO-LOT-0231' }, held: null })
    expect(extendStartOf(HOLDS[1]!, owner)).toEqual({ start: null, held: 'genealogy.extendKind' })
    expect(extendStartOf(HOLDS[0]!, canFor('warehouse')).held).toBe('held.noPlace')
  })
})

describe('the hold board (QHS-077)', () => {
  it('lanes by next step with counts and the oldest age; Released opens the release; drops held with the reason', () => {
    const lanes = boardLanes(BOARD_HOLDS, canFor('owner'), en)
    expect(lanes.map((lane) => lane.id)).toEqual([...HOLD_NEXT_STEPS, BOARD_RELEASED])
    expect(lanes.reduce((sum, lane) => sum + (lane.id === BOARD_RELEASED ? 0 : lane.total), 0)).toBe(BOARD_HOLDS.length)
    expect(lanes[0]!.detail).toMatch(/^Oldest \d+ days?$|^Nothing here$/)
    expect(boardLanes(BOARD_HOLDS, canFor('warehouse'), en).every((lane) => lane.held === null)).toBe(true)
    expect(boardHeld(canFor('warehouse'), en)).toMatch(/You read this board/)
    expect(boardHeld(canFor('owner'), en)).toBeNull()
    expect(boardLanes(BOARD_HOLDS, canFor('supervisor'), en).find((lane) => lane.id === BOARD_RELEASED)!.held).not.toBeNull()
    const hold = BOARD_HOLDS[0]!
    expect(laneOfHold(hold)).toBe(hold.nextStep)
    expect(laneOfHold({ ...hold, status: 'RELEASED' })).toBe(BOARD_RELEASED)
    expect(boardMoveHeld(hold, 'INVESTIGATING', canFor('owner'))).toBeNull()
    expect(boardMoveHeld(hold, hold.nextStep, canFor('owner'))).toEqual({ key: 'board.held.same' })
    expect(boardMoveHeld(hold, BOARD_RELEASED, canFor('supervisor'))).toEqual({ key: 'held.noRelease' })
    expect(boardMoveHeld({ ...hold, status: 'CLOSED' }, 'NEW', canFor('owner'))).toEqual({ key: 'board.held.notActive' })
  })

  it('keeps the mode and the Affected tab in the address', () => {
    expect(holdsAddress({ view: 'open', mode: 'board' })).toBe('?mode=board')
    expect(modeFromAddress(params('mode=board'))).toBe('board')
    expect(modeFromAddress(params('mode=calendar'))).toBe('table')
    expect(RECORD_TABS).toContain('affected')
    expect(tabFromAddress(params('tab=affected'))).toBe('affected')
  })
})

describe('the quarantine move (QHS-078)', () => {
  it('asked for stock only; confirmed only with inventory.transfer, a code, and a quarantine place of the site', () => {
    const lot = HOLDS[0]!
    expect(askHeld(lot, canFor('owner'))).toBeNull()
    expect(askHeld(HOLDS[1]!, canFor('owner'))).toBe('qmove.held.notStock')
    expect(askHeld({ ...lot, quarantine: 'MOVED' }, canFor('owner'))).toBe('qmove.held.moved')
    expect(askHeld(lot, qualityCan(['quality.holds.view']))).toBe('held.noPlace')
    expect(confirmHeld(lot, true)).toBeNull()
    expect(confirmHeld(lot, false)).toBe('qmove.held.noTransfer')
    expect(confirmHeld({ ...lot, quarantine: 'NOT_NEEDED' }, true)).toBe('qmove.held.notAsked')
    const detail = detailOf(lot)
    expect(confirmProblems({ locationId: null, code: ' ' }, detail)).toEqual(['qmove.problem.code'])
    expect(confirmProblems({ locationId: null, code: 'demo q-01' }, detail)).toEqual([])
    expect(confirmProblems({ locationId: null, code: 'DEMO-A1-RACK-03' }, detail)).toEqual(['qmove.problem.notPlace'])
    expect(askProblems({ locationId: null, code: '' }, detail)).toEqual(['qmove.problem.place'])
    expect(askProblems({ locationId: detail.stock!.places[0]!.id, code: '' }, detail)).toEqual([])
    expect(askProblems({ locationId: null, code: '' }, null)).toEqual(['qmove.problem.reading'])
  })
})

describe('the words of holds in depth', () => {
  it('a word for every node kind, lane and next step, in both languages', () => {
    for (const kind of TRACE_NODE_KINDS) {
      expect(en(`node.kind.${kind}`)).not.toBe(`node.kind.${kind}`)
      expect(it_(`node.count.${kind}`, { count: 2 })).not.toMatch(/node\./)
    }
    for (const lane of [...HOLD_NEXT_STEPS, BOARD_RELEASED]) expect(it_(`board.lane.${lane}`)).not.toMatch(/board\./)
    expect(it_('detail.tab.affected')).toBe('Coinvolti')
    expect(Object.keys(CATALOGUE.it.holds ?? {}).filter((key) => /^(genealogy|affected|node|gap|board|qmove)\./.test(key)).sort()).toEqual(Object.keys(CATALOGUE.en.holds ?? {}).filter((key) => /^(genealogy|affected|node|gap|board|qmove)\./.test(key)).sort())
    expect(AFFECTED.group?.holds.length).toBe(3)
  })
})
