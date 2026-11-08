import { describe, expect, it } from 'vitest'
import { homeTiles } from '../../../model'
import { QUEUE, ROWS } from './fixtures'
import { changedCount, codeOfRow, mayQueue, movesQueue, openHeld, queueChanged, queueFirst, rowCount, rowTone, taskOfKind, wordsIn } from './model'

/**
 * My work's inspector queue (B-W2b-109, QHS-068): who sees it and where it is the list, which bench a row opens and with which
 * code, why Inspect is held, the tone and the big number of a row, and the "List changed · Show" rule. Made-up rows.
 */

const INSPECTOR = ['floor.work', 'quality.inspections.view', 'quality.inspections.record', 'quality.inprocess.record', 'quality.incoming.view']

describe('who sees the inspector queue, and where it is My work\'s list', () => {
  it('any of the three inspection views shows it; at an inspection bench it is the list, elsewhere a tile', () => {
    expect(mayQueue(['floor.work'])).toBe(false)
    expect(mayQueue(['quality.inprocess.view'])).toBe(true)
    expect(queueFirst('inspection', INSPECTOR)).toBe(true)
    expect(queueFirst('sewing', INSPECTOR)).toBe(false)
    expect(queueFirst('inspection', ['floor.work'])).toBe(false)
  })
})

describe('a row opens the bench that records it', () => {
  it('final and garments that wait open the final bench; in-line kinds the in-line screen; incoming the incoming inspection (B-W2b-115)', () => {
    expect(taskOfKind('FINAL')).toBe('final')
    expect(taskOfKind('FINAL_DUE')).toBe('final')
    expect(taskOfKind('FIRST_PIECE')).toBe('inline')
    expect(taskOfKind('INCOMING')).toBe('incoming')
  })

  it('with the inspection\'s number, the work order that waits, or the bundle', () => {
    const [firstPiece, incoming, final, due] = ROWS
    expect(codeOfRow(final!)).toBe('INS-D-2026-0011')
    expect(codeOfRow(due!)).toBe('WO-DEMO-0044')
    expect(codeOfRow(firstPiece!)).toBe('B-DEMO-0131')
    expect(codeOfRow(incoming!)).toBe('IIN-D-2026-0004')
    expect(codeOfRow({ ...incoming!, number: null })).toBe('LOT-DEMO-LEA-07')
  })

  it('Inspect is held with the reason: no such tile here, not mine to record', () => {
    const bench = homeTiles('inspection', INSPECTOR, false)
    const sewing = homeTiles('sewing', INSPECTOR, false)
    const [firstPiece, incoming, final] = ROWS
    expect(openHeld(final!, bench)).toBeNull()
    // B-W2b-115: the Incoming inspection tile asks quality.incoming.record (this inspector only views incoming inspections).
    expect(openHeld(incoming!, bench)).toBe('noTile')
    expect(openHeld(incoming!, homeTiles('inspection', [...INSPECTOR, 'quality.incoming.record'], false))).toBeNull()
    expect(openHeld(final!, sewing)).toBe('noTile')
    expect(openHeld(firstPiece!, bench)).toBeNull()
    expect(openHeld({ ...final!, may: { record: false, start: false } }, bench)).toBe('notYours')
  })
})

describe('the rows on screen', () => {
  it('a held run is danger, work orders waiting or overdue a warning; the big number is what it holds up, else the sample left', () => {
    expect(ROWS.map(rowTone)).toEqual(['danger', 'warning', 'warning', 'info', 'neutral'])
    expect(rowCount(ROWS[1]!)).toEqual({ value: 2, what: 'blocks' })
    expect(rowCount({ blocks: { ...ROWS[4]!.blocks }, progress: { done: 3, of: 8, words: { it: '', en: '' } } })).toEqual({ value: 5, what: 'left' })
    expect(rowCount(ROWS[4]!)).toBeNull()
    expect(wordsIn(ROWS[0]!.kindWords, 'it')).toBe('Primo capo')
    expect(wordsIn(ROWS[0]!.kindWords, 'en')).toBe('First piece')
  })

  it('a fresher queue waits behind Show: changed rows are counted, the same queue is not a change', () => {
    expect(queueChanged(null, QUEUE)).toBe(false)
    expect(queueChanged(QUEUE, { ...QUEUE, asOf: 'later' })).toBe(false)
    const moved = { ...QUEUE, rows: QUEUE.rows.map((row, index) => (index === 2 ? { ...row, progress: { done: 6, of: 8, words: row.progress!.words } } : row)) }
    expect(queueChanged(QUEUE, moved)).toBe(true)
    expect(changedCount(QUEUE, moved)).toBe(1)
    expect(movesQueue('final_inspection.recorded')).toBe(true)
    expect(movesQueue('incoming_inspection.hide_recorded')).toBe(true)
    expect(movesQueue('production.scan_recorded')).toBe(false)
  })
})
