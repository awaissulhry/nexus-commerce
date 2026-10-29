import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { LOCALES } from '../../../lib/i18n/locales'
import { I18nProvider } from '../../../lib/i18n/provider'
import { canFor } from '../../quality/_shared/fixtures'
import { LIST_MAX, type Lot } from '../../quality/_shared/lots'
import { demoChecklist, demoDetail, designScreen as listScreen, lotByCode, LOTS } from './fixtures'
import {
  blankDocument,
  blankResult,
  codeMatches,
  decisionHeld,
  decisionsFor,
  documentProblems,
  hasMore,
  liveVerdict,
  loosens,
  lotsCsvRows,
  mgKg,
  primaryDecision,
  recordResultHeld,
  resultProblems,
  tileCounts,
  viewFromAddress,
  viewQuery,
  viewRows,
} from './model'
import { designScreen as lotScreen } from './record/fixtures'

const address = (query: string) => new URLSearchParams(query)

describe('views and tiles: one filter model (a tile is a view; the count and the list agree)', () => {
  it('reads the view from the address, and the API filters a link from Today carries', () => {
    expect(viewFromAddress(address('view=failed'))).toBe('failed')
    expect(viewFromAddress(address('onHold=true'))).toBe('onHold')
    expect(viewFromAddress(address('status=RELEASED'))).toBe('released')
    expect(viewFromAddress(address('status=QUARANTINE'))).toBe('quarantine')
    expect(viewFromAddress(address('view=nonsense'))).toBe('all')
    expect(viewFromAddress(null)).toBe('all')
  })

  it('asks the API for each view; waiting and failed are filtered here from the lots on hold (read in full)', () => {
    expect(viewQuery('all', ' 023 ', 50)).toEqual({ q: '023', limit: 50 })
    expect(viewQuery('onHold', '', 100)).toEqual({ onHold: true, q: null, limit: 100 })
    expect(viewQuery('waiting', '', 50)).toEqual({ onHold: true, q: null, limit: LIST_MAX })
    expect(viewQuery('rejected', '', 50)).toEqual({ status: 'REJECTED', q: null, limit: 50 })
    const held = LOTS.filter((lot) => lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED')
    expect(viewRows('waiting', held).map((lot) => lot.code)).toEqual(['DEMO-L-0231', 'DEMO-L-0234'])
    expect(viewRows('failed', held).map((lot) => lot.code)).toEqual(['DEMO-L-0233', 'DEMO-L-0215'])
    expect(hasMore('all', 50, 50)).toBe(true)
    expect(hasMore('all', 50, LIST_MAX)).toBe(false)
    expect(hasMore('waiting', 200, LIST_MAX)).toBe(false)
  })

  it('counts the tiles from the lots on hold and the released lots; a failed read is unknown, a cut read "at least"', () => {
    const held = LOTS.filter((lot) => lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED')
    const released = LOTS.filter((lot) => lot.qualityStatus === 'RELEASED')
    expect(tileCounts(held, released)).toEqual({
      onHold: { count: 6, atLeast: false },
      waiting: { count: 2, atLeast: false },
      failed: { count: 2, atLeast: false },
      released: { count: 3, atLeast: false },
    })
    expect(tileCounts(null, released).onHold.count).toBeNull()
    const many = Array.from({ length: LIST_MAX }, () => LOTS[0]!)
    expect(tileCounts(many, []).waiting).toEqual({ count: LIST_MAX, atLeast: true })
  })
})

describe('the Cr VI verdict while typing is the domain rule (REACH Annex XVII entry 47), never typed', () => {
  it('below the limit passes, at or above fails; a comma decimal is read', () => {
    expect(liveVerdict({ valueMgKg: '1,2', belowDetectionLimit: false, detectionLimitMgKg: '' }, '3.000')).toEqual({ kind: 'pass', value: '1.200', limit: '3.000' })
    expect(liveVerdict({ valueMgKg: '3', belowDetectionLimit: false, detectionLimitMgKg: '' }, '3.000').kind).toBe('fail')
    expect(liveVerdict({ valueMgKg: '3.4', belowDetectionLimit: false, detectionLimitMgKg: '' }, null).kind).toBe('fail')
    expect(liveVerdict({ valueMgKg: '', belowDetectionLimit: false, detectionLimitMgKg: '' }, '3.000').kind).toBe('none')
    expect(liveVerdict({ valueMgKg: '1.2345', belowDetectionLimit: false, detectionLimitMgKg: '' }, '3.000')).toMatchObject({ kind: 'problem', key: 'result.verdict.valueInvalid' })
  })

  it('"not detected" passes only under a detection limit at most the lot\'s limit', () => {
    expect(liveVerdict({ valueMgKg: '', belowDetectionLimit: true, detectionLimitMgKg: '0,5' }, '3.000')).toEqual({ kind: 'notDetected', lod: '0.500', limit: '3.000' })
    expect(liveVerdict({ valueMgKg: '', belowDetectionLimit: true, detectionLimitMgKg: '4' }, '3.000')).toMatchObject({ kind: 'problem', key: 'result.verdict.lodAbove' })
    expect(liveVerdict({ valueMgKg: '', belowDetectionLimit: true, detectionLimitMgKg: '0' }, '3.000')).toMatchObject({ kind: 'problem', key: 'result.verdict.lodInvalid' })
  })

  it('shows mg/kg in the person\'s language without trailing zeros', () => {
    expect(mgKg('1.200', 'en')).toBe('1.2')
    expect(mgKg('1.200', 'it')).toBe('1,2')
    expect(mgKg(null, 'en')).toBe('—')
  })
})

describe('held reasons: every action says why before the click', () => {
  const owner = canFor('owner')
  const ready = demoDetail(lotByCode('DEMO-L-0232'))
  const open = demoDetail(lotByCode('DEMO-L-0231'), { checklist: demoChecklist(lotByCode('DEMO-L-0231'), ['CR_VI']) })

  it('release: the right, the state, never the receiver, every check passed', () => {
    expect(decisionHeld('release', ready, owner, 'someone-else')).toBeNull()
    expect(decisionHeld('release', ready, canFor('readOnly'), null)).toEqual({ key: 'held.release' })
    expect(decisionHeld('release', ready, owner, ready.lot.receivedById)).toEqual({ key: 'held.receiver' })
    expect(decisionHeld('release', open, owner, null)).toEqual({ key: 'held.checksOpen', params: { count: 1 } })
    expect(decisionHeld('release', demoDetail(lotByCode('DEMO-L-0219')), owner, null)).toEqual({ key: 'held.notQuarantine' })
  })

  it('reject, block, release again, clear the hold: each in its state', () => {
    expect(decisionHeld('reject', demoDetail(lotByCode('DEMO-L-0219')), owner, null)).toEqual({ key: 'held.rejectState' })
    expect(decisionHeld('block', ready, owner, null)).toEqual({ key: 'held.blockState' })
    expect(decisionHeld('block', demoDetail(lotByCode('DEMO-L-0219')), owner, null)).toBeNull()
    const held = demoDetail(lotByCode('DEMO-L-0234'))
    expect(decisionHeld('clearHold', held, owner, null)).toBeNull()
    expect(decisionHeld('clearHold', held, owner, held.lot.receivedById)).toEqual({ key: 'held.holdOwn' })
    expect(decisionHeld('clearHold', ready, owner, null)).toEqual({ key: 'held.noHold' })
  })

  it('the decisions and the primary follow the lot state', () => {
    expect(decisionsFor(lotByCode('DEMO-L-0234'))).toEqual(['release', 'clearHold', 'reject'])
    expect(decisionsFor(lotByCode('DEMO-L-0215'))).toEqual(['unblock', 'reject'])
    expect(decisionsFor(lotByCode('DEMO-L-0219'))).toEqual(['block'])
    expect(decisionsFor(lotByCode('DEMO-L-0210'))).toEqual([])
    expect(primaryDecision(lotByCode('DEMO-L-0215'))).toBe('unblock')
    expect(primaryDecision(lotByCode('DEMO-L-0210'))).toBeNull()
  })

  it('a result: the right, a material that needs the test, never on a rejected lot or after a fail (final)', () => {
    expect(recordResultHeld(lotByCode('DEMO-L-0231'), owner)).toBeNull()
    expect(recordResultHeld(lotByCode('DEMO-L-0231'), canFor('readOnly'))).toBe('held.test')
    expect(recordResultHeld(lotByCode('DEMO-P-0099'), owner)).toBe('held.noTest')
    expect(recordResultHeld(lotByCode('DEMO-L-0233'), owner)).toBe('held.failFinal')
    expect(recordResultHeld(lotByCode('DEMO-L-0210'), owner)).toBe('held.rejected')
  })

  it('the typed code: spaces and letter case do not matter (the API\'s rule)', () => {
    expect(codeMatches(' demo-l-0232 ', 'DEMO-L-0232')).toBe(true)
    expect(codeMatches('DEMO-L-023', 'DEMO-L-0232')).toBe(false)
  })

  it('loosening is a lab report for every lot → a supplier report', () => {
    expect(loosens('LOT_REPORT_REQUIRED', 'SUPPLIER_REPORT_ACCEPTED')).toBe(true)
    expect(loosens('SUPPLIER_REPORT_ACCEPTED', 'LOT_REPORT_REQUIRED')).toBe(false)
  })
})

describe('drafts: every problem at once, in our words', () => {
  const today = '2026-10-29'
  it('a result needs its value, laboratory, day and file; a supplier report its article and period', () => {
    expect(Object.keys(resultProblems(blankResult(today), today, 'SUPPLIER_REPORT_ACCEPTED', '3.000')).sort()).toEqual(['file', 'lab', 'valueMgKg'])
    const supplier = { ...blankResult(today), valueMgKg: '1', lab: 'Lab', fileName: 'r.pdf', evidence: 'SUPPLIER_REPORT' as const, periodFrom: '2026-12-01', periodTo: '2026-11-01' }
    expect(resultProblems(supplier, today, 'SUPPLIER_REPORT_ACCEPTED', '3.000')).toEqual({ article: 'result.problem.article', periodTo: 'result.problem.periodOrder' })
    expect(resultProblems({ ...supplier, article: 'A', periodTo: '2026-12-31' }, today, 'LOT_REPORT_REQUIRED', '3.000')).toEqual({ evidence: 'result.problem.ruleLotReport' })
    expect(resultProblems({ ...supplier, evidence: 'LOT_REPORT', testedOn: '2026-11-02' }, today, null, '3.000')).toEqual({ testedOn: 'result.problem.testedOnFuture' })
  })

  it('a document: OTHER says what it is, never already expired, a file', () => {
    expect(documentProblems({ ...blankDocument(), kind: 'OTHER', fileName: 'x.pdf' }, today)).toEqual({ note: 'document.problem.note' })
    expect(documentProblems({ ...blankDocument(), validTo: '2026-10-01', fileName: 'x.pdf' }, today)).toEqual({ validTo: 'document.problem.expired' })
    expect(documentProblems(blankDocument(), today)).toEqual({ file: 'document.problem.file' })
  })
})

describe('the CSV of a view', () => {
  it('one line per lot with codes and values as the API gave them', () => {
    const lot: Lot = lotByCode('DEMO-L-0232')
    const rows = lotsCsvRows([lot], ['Lot', 'Code'], { status: () => 'In quarantine', crVi: () => 'Pass', evidence: () => 'Lab report' })
    expect(rows[0]).toEqual(['Lot', 'Code'])
    expect(rows[1]).toEqual(['DEMO-L-0232', 'DEMO-PELLE-NERA', 'Demo cowhide black 1.2 mm', 'In quarantine', 'Pass', '1.200', '3.000', 'Lab report', '2026-10-26', lot.receivedAt!.slice(0, 10), null])
  })
})

describe('every design case draws in both languages with no key left on screen', () => {
  const keys = new Set<string>()
  for (const namespace of ['lab', 'quality']) for (const key of Object.keys(CATALOGUE.en[namespace] ?? {})) keys.add(key.replace(/_(one|other)$/, ''))
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  const leftKey = (html: string): string | null => {
    for (const key of keys) {
      const at = html.indexOf(key)
      if (at < 0) continue
      const before = html[at - 1] ?? ' '
      const after = html[at + key.length] ?? ' '
      if (!/[\w.-]/.test(before) && !/[\w.]/.test(after)) return key
    }
    return null
  }
  for (const screen of [listScreen, lotScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
          expect(html.length, item.id).toBeGreaterThan(500)
          expect(leftKey(html), `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the production manager and sales see no lot: the permission is named', () => {
    const html = render(listScreen as DesignScreen<unknown>, listScreen.cases.find((item) => item.id === 'no-permission')!.model, 'en')
    expect(html).toContain('quality.lots.view')
    expect(html).not.toContain('DEMO-L-0231')
  })

  it('no money anywhere on these screens', () => {
    for (const screen of [listScreen, lotScreen] as DesignScreen<unknown>[]) {
      for (const item of screen.cases) expect(render(screen, item.model, 'en'), item.id).not.toMatch(/€|EUR\b/)
    }
  })
})
