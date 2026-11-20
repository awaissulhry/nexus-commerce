import { describe, expect, it } from 'vitest'
import { LINE_BLK, LINE_RED, order } from '../_demo/fixtures'
import type { Order } from '../api'
import {
  addLines,
  addSize,
  askDefaultOf,
  bodyLinesOf,
  changeCountOf,
  clashKey,
  draftHoldsOf,
  draftKeyOf,
  EMPTY_HISTORY,
  holdPhrase,
  isEmptyDraft,
  newLineKey,
  piecesBeforeAfter,
  putBack,
  reasonOf,
  rebaseDraft,
  removeLine,
  reviewEntriesOf,
  setCell,
  setNewLine,
  setPrice,
  setText,
  takeTheirs,
  undoLast,
  withoutClash,
  type NewLine,
} from './lines-draft'

/**
 * F-OL-01 (a, b) (Order LINES lane): the Lines tab's draft holds MY changes only — always there, one undo step per box, a cell typed
 * back to its value leaves it; the save sends `{ id }` for a line I did not touch, so a rebase after another person's save keeps my
 * cells and never puts theirs back; a cell both changed asks Keep mine / Take theirs. Every name and number is made up.
 */

const production = order('IN_PRODUCTION')
const blackOf = (value: Order) => value.lines.find((line) => line.id === LINE_BLK)!
const redOf = (value: Order) => value.lines.find((line) => line.id === LINE_RED)!
const brown = (over: Partial<NewLine> = {}): NewLine => ({ key: newLineKey(production.lines[0]!.styleId, 'cw-brown'), styleId: production.lines[0]!.styleId, colourwayId: 'cw-brown', colour: 'BRN · Marrone', style: { code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }, sizes: {}, price: '', description: '', note: '', ...over })

describe('F-OL-01 (a): the draft is my changes only, always there (empty), one undo step per box', () => {
  it('starts empty: nothing to save, nothing to undo, every line sent as it is ({ id })', () => {
    expect(isEmptyDraft(EMPTY_HISTORY.draft)).toBe(true)
    expect(changeCountOf(EMPTY_HISTORY.draft)).toBe(0)
    expect(undoLast(EMPTY_HISTORY)).toBe(EMPTY_HISTORY)
    expect(bodyLinesOf(EMPTY_HISTORY.draft, production)).toEqual([{ id: LINE_BLK }, { id: LINE_RED }])
  })

  it('a typed cell is a change of its line; typed back to its value it leaves the draft', () => {
    const typed = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3)
    expect(typed.draft.lines[LINE_BLK]).toEqual({ sizes: { '50': 3 } })
    expect(changeCountOf(typed.draft)).toBe(1)
    const back = setCell(typed, production, LINE_BLK, '50', 2)
    expect(back.draft.lines[LINE_BLK]).toBeUndefined()
    expect(isEmptyDraft(back.draft)).toBe(true)
  })

  it('typing in one box is ONE step; another box is another step; Undo last edit takes them back in turn (no redo)', () => {
    let history = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3)
    history = setCell(history, production, LINE_BLK, '50', 4) // the same box: one step
    history = setPrice(history, production, LINE_RED, '450')
    expect(history.undo).toHaveLength(2)
    const once = undoLast(history)
    expect(once.draft.lines[LINE_RED]).toBeUndefined()
    expect(once.draft.lines[LINE_BLK]).toEqual({ sizes: { '50': 4 } })
    const twice = undoLast(once)
    expect(isEmptyDraft(twice.draft)).toBe(true)
    expect(undoLast(twice)).toBe(twice)
  })

  it('a price typed as it is accepted is no change; a note; Remove and Put back; a new row taken out by Remove', () => {
    expect(setPrice(EMPTY_HISTORY, production, LINE_BLK, '450,00').draft.lines[LINE_BLK]).toBeUndefined()
    expect(setText(EMPTY_HISTORY, production, LINE_BLK, 'note', 'Doppia cucitura ai polsi').draft.lines[LINE_BLK]).toEqual({ note: 'Doppia cucitura ai polsi' })
    const removed = removeLine(setCell(EMPTY_HISTORY, production, LINE_RED, '52', 5), production, LINE_RED)
    expect(removed.draft.lines[LINE_RED]).toEqual({ sizes: { '52': 5 }, removed: true })
    expect(putBack(removed, production, LINE_RED).draft.lines[LINE_RED]).toEqual({ sizes: { '52': 5 } })
    const added = addLines(EMPTY_HISTORY, production, [brown()])
    expect(added.draft.added).toHaveLength(1)
    expect(removeLine(added, production, brown().key).draft.added).toHaveLength(0)
  })

  it('a colour already on the order (or in the draft) is never added twice; "+ Size" adds a column once', () => {
    const again = addLines(EMPTY_HISTORY, production, [brown({ colourwayId: blackOf(production).colourwayId, key: 'x' })])
    expect(again).toBe(EMPTY_HISTORY)
    const once = addLines(EMPTY_HISTORY, production, [brown()])
    expect(addLines(once, production, [brown()])).toBe(once)
    const sized = addSize(EMPTY_HISTORY, production.lines[0]!.styleId, '56')
    expect(sized.draft.sizes[production.lines[0]!.styleId]).toEqual(['56'])
    expect(addSize(sized, production.lines[0]!.styleId, '56')).toBe(sized)
  })
})

describe('F-OL-01 (b): the save sends only what I changed', () => {
  it('a line I did not touch is { id }; a changed one its whole grid (the order\'s cells now + mine), its price, its notes', () => {
    let history = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3)
    history = setPrice(history, production, LINE_BLK, '460')
    history = setText(history, production, LINE_BLK, 'description', '  Logo sul petto  ')
    expect(bodyLinesOf(history.draft, production)).toEqual([
      { id: LINE_BLK, sizes: [{ size: '48', quantity: 2 }, { size: '50', quantity: 3 }, { size: '52', quantity: 2 }, { size: '54', quantity: 2 }], unitPrice: '460', description: 'Logo sul petto' },
      { id: LINE_RED },
    ])
  })

  it('a removed line is left out; a line typed down to 0 pieces too; a new row goes with its pieces, empty: not sent', () => {
    const removed = removeLine(EMPTY_HISTORY, production, LINE_RED)
    expect(bodyLinesOf(removed.draft, production)).toEqual([{ id: LINE_BLK }])
    let zero = EMPTY_HISTORY
    for (const size of ['50', '52', '54']) zero = setCell(zero, production, LINE_RED, size, 0)
    expect(bodyLinesOf(zero.draft, production)).toEqual([{ id: LINE_BLK }])
    const added = addLines(EMPTY_HISTORY, production, [brown()])
    expect(bodyLinesOf(added.draft, production)).toHaveLength(2)
    const typed = setNewLine(added, brown().key, { size: '52', pieces: 4 })
    expect(bodyLinesOf(typed.draft, production)[2]).toEqual({ styleId: brown().styleId, colourwayId: 'cw-brown', sizes: [{ size: '52', quantity: 4 }] })
  })

  it('the preview key moves with the draft, the version and the tick', () => {
    const typed = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3).draft
    expect(draftKeyOf(typed, production)).not.toBe(draftKeyOf(EMPTY_HISTORY.draft, production))
    expect(draftKeyOf(typed, { ...production, version: production.version + 1 })).not.toBe(draftKeyOf(typed, production))
    expect(draftKeyOf(typed, production, true)).not.toBe(draftKeyOf(typed, production, false))
  })
})

describe('F-OL-01 (b): rebaseDraft — after another person\'s save my cells stay, the rest is the fresh order', () => {
  /** The order after a colleague changed black 52 to 5 and red's price to 445. */
  const theirs: Order = {
    ...production,
    version: production.version + 1,
    lines: production.lines.map((line) => (line.id === LINE_BLK ? { ...line, sizes: line.sizes.map((size) => (size.size === '52' ? { ...size, quantity: 5 } : size)), quantity: line.quantity + 3 } : line.id === LINE_RED ? { ...line, unitPrice: '445' } : line)),
  }

  it('my cell on another size stays; the lines they changed are listed as moved; the body keeps their 52 (never put back)', () => {
    const mine = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3).draft
    const rebased = rebaseDraft(production, theirs, mine)
    expect(rebased.draft.lines[LINE_BLK]).toEqual({ sizes: { '50': 3 } })
    expect(rebased.moved).toEqual([LINE_BLK, LINE_RED])
    expect(rebased.clashes).toEqual([])
    expect(bodyLinesOf(rebased.draft, theirs)[0]).toEqual({ id: LINE_BLK, sizes: [{ size: '48', quantity: 2 }, { size: '50', quantity: 3 }, { size: '52', quantity: 5 }, { size: '54', quantity: 2 }] })
    // The red line they changed and I did not: sent as { id } — their new price stays.
    expect(bodyLinesOf(rebased.draft, theirs)[1]).toEqual({ id: LINE_RED })
  })

  it('a cell both changed is a clash (mine kept until chosen); Take theirs drops mine; Keep mine just clears the clash', () => {
    const mine = setPrice(setCell(EMPTY_HISTORY, production, LINE_BLK, '52', 4), production, LINE_RED, '430').draft
    const rebased = rebaseDraft(production, theirs, mine)
    expect(rebased.clashes.map(clashKey)).toEqual([`${LINE_BLK}:size:52`, `${LINE_RED}:price`])
    expect(rebased.clashes[0]).toMatchObject({ mine: '4', theirs: '5' })
    const history = { ...EMPTY_HISTORY, draft: rebased.draft }
    const taken = takeTheirs(history, theirs, rebased.clashes[0]!)
    expect(taken.draft.lines[LINE_BLK]).toBeUndefined()
    expect(withoutClash(rebased.clashes, rebased.clashes[1]!)).toEqual([rebased.clashes[0]])
  })

  it('the same value typed by both is no change of mine any more; a line they removed drops my changes on it', () => {
    const same = rebaseDraft(production, theirs, setCell(EMPTY_HISTORY, production, LINE_BLK, '52', 5).draft)
    expect(same.draft.lines[LINE_BLK]).toBeUndefined()
    expect(same.clashes).toEqual([])
    const gone = rebaseDraft(production, { ...theirs, lines: theirs.lines.filter((line) => line.id !== LINE_RED) }, setCell(EMPTY_HISTORY, production, LINE_RED, '52', 3).draft)
    expect(gone.gone).toEqual([LINE_RED])
    expect(gone.draft.lines[LINE_RED]).toBeUndefined()
  })
})

describe('F-OL-01: what holds the bar, what Review lists, the Why and the one tick', () => {
  const name = (key: string) => (key === LINE_BLK ? 'BLK · Nero' : key === LINE_RED ? 'RED · Rosso' : 'BRN · Marrone')

  it('the holds in order: clashes, under shipped, a price that is not one, no price where none lists it, a new row with no pieces, nothing left', () => {
    const floors = { [LINE_BLK]: { '50': { cut: 2, shipped: 1 } } }
    let history = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 0)
    history = setPrice(history, production, LINE_RED, '4,5,0')
    history = addLines(history, production, [brown()])
    const holds = draftHoldsOf(history.draft, production, { floors, clashes: 1, unlisted: new Set(['cw-brown']) })
    expect(holds.map((hold) => hold.kind)).toEqual(['clash', 'shipped', 'price', 'needsPrice', 'noPieces'])
    expect(holdPhrase(holds[1]!, name)).toEqual({ key: 'save.held.shipped', params: { colour: 'BLK · Nero', size: '50', count: 1 } })
    const none = removeLine(removeLine(EMPTY_HISTORY, production, LINE_BLK), production, LINE_RED)
    expect(draftHoldsOf(none.draft, production).map((hold) => hold.kind)).toEqual(['empty'])
    expect(draftHoldsOf(EMPTY_HISTORY.draft, production)).toEqual([])
  })

  it('Review lists each line that changes: sizes before → after, the price only for price readers, removed (closes with fewer pieces when made), new', () => {
    let history = setCell(EMPTY_HISTORY, production, LINE_BLK, '50', 3)
    history = setPrice(history, production, LINE_BLK, '460')
    history = removeLine(history, production, LINE_RED)
    history = setNewLine(addLines(history, production, [brown()]), brown().key, { size: '52', pieces: 2 })
    const owner = reviewEntriesOf(history.draft, production, { seesPrices: true })
    expect(owner[0]).toEqual({ kind: 'changed', key: LINE_BLK, seq: 10, sizes: [{ size: '50', before: 2, after: 3 }], piecesBefore: 8, piecesAfter: 9, price: { before: '450', after: '460' }, notes: false })
    expect(owner[1]).toMatchObject({ kind: 'removed', key: LINE_RED, closesShort: true })
    expect(owner[2]).toEqual({ kind: 'added', key: brown().key, pieces: 2 })
    const sales = reviewEntriesOf(history.draft, production, { seesPrices: false })
    expect(sales[0]).toMatchObject({ price: null })
    expect(JSON.stringify(sales)).not.toMatch(/460|450/)
    expect(piecesBeforeAfter(history.draft, production)).toEqual({ before: 14, after: 11 })
  })

  it('Why (optional): the pick\'s words and the typed words; nothing → no reason (the server writes its automatic words)', () => {
    const say = (pick: string) => ({ customer: "L'ha chiesto il cliente", mistake: 'Errore nostro', production: 'Produzione', other: 'Altro' })[pick]!
    expect(reasonOf(null, '   ', say)).toBeUndefined()
    expect(reasonOf('customer', '', say)).toBe("L'ha chiesto il cliente")
    expect(reasonOf('customer', 'due in più nella 52', say)).toBe("L'ha chiesto il cliente: due in più nella 52")
    expect(reasonOf('other', 'Un ritocco', say)).toBe('Un ritocco')
  })

  it('the ONE tick: a price reader — on only when the total goes up; Sales — whenever the amount changes (never which way)', () => {
    expect(askDefaultOf({ totalUp: true, amountChanges: true }, true)).toBe(true)
    expect(askDefaultOf({ totalUp: false, amountChanges: true }, true)).toBe(false)
    expect(askDefaultOf({ amountChanges: true }, false)).toBe(true)
    expect(askDefaultOf({ amountChanges: false }, false)).toBe(false)
    // Only the preview's own answers decide (the net changing — reacceptanceNeeded — is never the default); no preview: unticked.
    expect(askDefaultOf({}, true)).toBe(false)
    expect(askDefaultOf({ totalUp: true }, false)).toBe(false)
    expect(askDefaultOf(null, true)).toBe(false)
  })

  it('fixtures stay as they are (the rebase reads, never writes, the orders it is given)', () => {
    expect(redOf(production).unitPrice).toBe('440')
  })
})
