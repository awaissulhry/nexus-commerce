import { describe, expect, it } from 'vitest'
import {
  exchangeHeld,
  exchangeSizeProblems,
  exchangeSizesOf,
  finishOptions,
  finishProblems,
  finishStateHeld,
  finishWordsOf,
  FINISH_REASONS,
  fitProblems,
  missingPiecesOf,
  remakeHeld,
  remakeReasonNote,
  remakeReasonOf,
  remakeSentWords,
  restOf,
  sendBackHeld,
  sendBackLinesOf,
  splitHeld,
  splitSeqOf,
  suggestedFinish,
  type FinishFacts,
  type FinishLine,
  type SendBackLine,
} from './rules'

const line = (over: Partial<FinishLine> = {}): FinishLine => ({ seq: 10, quantity: 1, received: 1, disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', creditWithoutReturn: false, creditAmount: 1000, ...over })
const facts = (lines: FinishLine[], over: Partial<FinishFacts> = {}): FinishFacts => ({ status: 'INSPECTED', goodsDueBy: null, today: '2026-11-12', lines, ...over })

describe('split lines on a partial receipt (SAL-350)', () => {
  it('splits only a line of which part arrived, once goods are here', () => {
    expect(splitHeld({ status: 'RECEIVED', seq: 10, quantity: 3, received: 1, creditWithoutReturn: false })).toBeNull()
    expect(splitHeld({ status: 'INSPECTED', seq: 10, quantity: 3, received: 2, creditWithoutReturn: false })).toBeNull()
    expect(splitHeld({ status: 'AUTHORISED', seq: 10, quantity: 3, received: 0, creditWithoutReturn: false })).toMatch(/^Nothing arrived yet/)
    expect(splitHeld({ status: 'RECEIVED', seq: 20, quantity: 3, received: 0, creditWithoutReturn: false })).toBe('Nothing of line 20 arrived yet: it waits for its goods as it is.')
    expect(splitHeld({ status: 'RECEIVED', seq: 20, quantity: 3, received: 3, creditWithoutReturn: false })).toMatch(/^Every piece of line 20 arrived/)
    expect(splitHeld({ status: 'RECEIVED', seq: 20, quantity: 3, received: 0, creditWithoutReturn: true })).toMatch(/credited without the goods/)
    expect(splitHeld({ status: 'CLOSED', seq: 20, quantity: 3, received: 1, creditWithoutReturn: false })).toMatch(/closed/)
    expect(restOf({ quantity: 5, received: 2 })).toBe(3)
  })

  it('puts the new line right after its parent, else after the last line', () => {
    expect(splitSeqOf([10, 20], 10)).toBe(11)
    expect(splitSeqOf([10, 11, 20], 10)).toBe(12)
    expect(splitSeqOf([10, 11, 20], 11)).toBe(12)
    expect(splitSeqOf([10, 20], 20)).toBe(21)
    expect(splitSeqOf([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 10)).toBe(30)
    expect(splitSeqOf([10, 20, 30], 29)).toBe(40)
  })
})

describe('a size exchange (SAL-351)', () => {
  const styled = { seq: 10, size: '52', sizes: ['50', '52', '54'] }
  it('offers the style’s other sizes and refuses the same, an unknown or a missing one', () => {
    expect(exchangeSizesOf(styled)).toEqual(['50', '54'])
    expect(exchangeSizeProblems(styled, '54', 'body/lines/0/exchangeSize')).toEqual([])
    expect(exchangeSizeProblems(styled, '52', 'p')[0]?.message).toBe('Another size than the one that came back (52).')
    expect(exchangeSizeProblems(styled, '58', 'p')[0]?.message).toBe("Size 58 is not one of the style's sizes (50, 52, 54).")
    expect(exchangeSizeProblems(styled, '  ', 'p')[0]?.message).toBe('Name the size the customer gets instead of 52.')
    expect(exchangeHeld({ seq: 20, size: null, sizes: null })).toBe('Line 20 names no style and size: replace it instead.')
    expect(exchangeHeld({ seq: 20, size: '52', sizes: ['52'] })).toMatch(/no other size than 52/)
  })
})

describe('back unchanged after inspection (SAL-355)', () => {
  const back = (over: Partial<SendBackLine> = {}): SendBackLine => ({ id: 'a', seq: 10, received: 1, graded: true, disposition: null, goodsOutcome: null, safety: false, onDdt: null, ...over })
  it('sends back what arrived and was inspected, never a protective garment returned for a defect', () => {
    expect(sendBackHeld(back())).toBeNull()
    expect(sendBackHeld(back({ disposition: 'RETURN_UNCHANGED', goodsOutcome: 'BACK_TO_CUSTOMER' }))).toBeNull()
    expect(sendBackHeld(back({ graded: false }))).toBe('Line 10 is not inspected yet: grade it first.')
    expect(sendBackHeld(back({ received: 0 }))).toMatch(/^Nothing of line 10 arrived/)
    expect(sendBackHeld(back({ disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK' }))).toBe('Line 10 is decided otherwise.')
    expect(sendBackHeld(back({ onDdt: 'DDT-1' }))).toBe('Line 10 travels back with DDT DDT-1 already.')
    expect(sendBackHeld(back({ safety: true }))).toMatch(/safety check/)
    expect(sendBackLinesOf([back(), back({ id: 'b', seq: 20, received: 0 })]).map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('close with a finish reason (SAL-360)', () => {
  it('holds the close while a received line waits for its decision, and before the authorisation', () => {
    expect(finishStateHeld(facts([line({ disposition: null, goodsOutcome: null })]))).toBe('Decide every received line first (line 10).')
    expect(finishStateHeld(facts([line()], { status: 'REQUESTED' }))).toBe('Authorise or reject the request first.')
    expect(finishStateHeld(facts([line()], { status: 'CLOSED' }))).toBe('The return is closed already.')
    expect(finishOptions(facts([line()], { status: 'CLOSED' })).every((option) => !option.allowed)).toBe(true)
  })

  it('offers each reason only where the facts carry it, and suggests one', () => {
    const credited = facts([line({ received: 0, goodsOutcome: null, creditWithoutReturn: true })])
    expect(suggestedFinish(credited)).toBe('CREDITED_WITHOUT_RETURN')
    expect(finishOptions(credited).filter((option) => option.allowed).map((option) => option.reason)).toEqual(['COMPLETED', 'CREDITED_WITHOUT_RETURN', 'OTHER'])
    const unchanged = facts([line({ disposition: 'RETURN_UNCHANGED', goodsOutcome: 'BACK_TO_CUSTOMER', creditAmount: 0 })])
    expect(suggestedFinish(unchanged)).toBe('RETURNED_UNCHANGED')
    expect(finishOptions(unchanged).find((option) => option.reason === 'CUSTOMER_WITHDREW')?.allowed).toBe(true)
    const nothing = facts([line({ received: 0, disposition: null, goodsOutcome: null, creditAmount: null })], { status: 'AUTHORISED', goodsDueBy: '2026-11-01' })
    expect(suggestedFinish(nothing)).toBe('GOODS_NOT_RECEIVED')
    expect(missingPiecesOf(nothing.lines)).toBe(1)
    expect(finishOptions(nothing).find((option) => option.reason === 'COMPLETED')?.held).toBe('No line is decided: nothing was done to complete.')
    const mixed = facts([line(), line({ seq: 20, disposition: 'RETURN_UNCHANGED', goodsOutcome: 'BACK_TO_CUSTOMER', creditAmount: 0 })])
    expect(suggestedFinish(mixed)).toBe('COMPLETED')
    expect(finishOptions(mixed).find((option) => option.reason === 'CUSTOMER_WITHDREW')?.held).toMatch(/A credit was given/)
    expect(FINISH_REASONS).toHaveLength(6)
  })

  it('needs words for Other and keeps the reason’s words when none are typed', () => {
    expect(finishProblems('OTHER', ' ', facts([line()]))).toEqual([{ path: 'body/reason', message: 'Other: say why the return is closed.' }])
    expect(finishProblems('GOODS_NOT_RECEIVED', null, facts([line()]))).toEqual([{ path: 'body/finishReason', message: 'Every piece expected arrived (or was credited without the goods).' }])
    expect(finishWordsOf('COMPLETED', '')).toBe('Completed: every line decided and done')
    expect(finishWordsOf('OTHER', ' kept as a sample ')).toBe('kept as a sample')
  })
})

describe('a remake asked with photos (SAL-298)', () => {
  it('needs the fit in words, takes the size reason else other, and says the end in both languages', () => {
    expect(fitProblems('', 'body/fit')).toEqual([{ path: 'body/fit', message: 'Say what is wrong with the fit.' }])
    expect(fitProblems('x'.repeat(2001), 'body/fit')[0]?.message).toBe('At most 2000 characters.')
    expect(remakeReasonNote('  The sleeves\n are  long ')).toBe('The sleeves are long')
    expect(remakeReasonOf(new Set(['DEFECT', 'OTHER']))).toBe('OTHER')
    expect(remakeReasonOf(new Set(['WRONG_SIZE', 'OTHER']))).toBe('WRONG_SIZE')
    expect(remakeReasonOf(new Set(['DEFECT']))).toBeNull()
    expect(remakeSentWords('RMA-2026-0007', '2026-11-16')).toEqual({ en: 'Remake request RMA-2026-0007 opened. We answer by 2026-11-16.', it: 'Richiesta di rifacimento RMA-2026-0007 aperta. Rispondiamo entro il 16/11/2026.' })
    expect(remakeHeld({ status: 'INSPECTED', asked: false })).toMatch(/before its lines are decided/)
    expect(remakeHeld({ status: 'AUTHORISED', asked: true })).toBe('A remake was asked on this return already.')
    expect(remakeHeld({ status: 'RECEIVED', asked: false })).toBeNull()
  })
})
