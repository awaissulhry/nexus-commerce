import { readFileSync, readdirSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BoardView } from './BoardView'
import {
  BOARD_VIEW_WORDS as W,
  boardTabStop,
  cardName,
  cardsByLane,
  countWords,
  fillWords,
  laneCount,
  laneStep,
  moveHeldReason,
  moveMenu,
  nextCardFocus,
  pickHeldReason,
  targetWords,
  type BoardCard,
  type BoardLane,
} from './boardViewModel'

const lanes: BoardLane[] = [
  { id: 'open', label: 'Open', total: 5, detail: 'Oldest 12 days' },
  { id: 'contained', label: 'Contained', tone: 'warning' },
  { id: 'decided', label: 'Decided' },
  { id: 'closed', label: 'Closed', held: 'Only quality managers close a nonconformance', tone: 'success' },
]
const cards: BoardCard[] = [
  { id: 'n1', laneId: 'open', label: 'NCR-0012', title: 'Seam opens at the armour pocket', fields: [{ label: 'Severity', value: 'Major' }], marks: [{ label: 'Customer', tone: 'danger' }] },
  { id: 'n2', laneId: 'open', label: 'NCR-0013', title: 'Wrong zip colour' },
  { id: 'n3', laneId: 'contained', label: 'NCR-0010', title: 'Hide with holes', href: '/quality/ncr/n3' },
  { id: 'n4', laneId: 'decided', label: 'NCR-0008', held: 'Waiting for the closing signature' },
  { id: 'x', laneId: 'elsewhere', label: 'NCR-0001' },
]
const card = (id: string) => cards.find((item) => item.id === id)!
const byLane = cardsByLane(cards, lanes)

describe('board view rules (D19)', () => {
  it('groups the cards by lane in the order given; a card whose lane is not on the board is not drawn', () => {
    expect(byLane.get('open')!.map((item) => item.id)).toEqual(['n1', 'n2'])
    expect(byLane.get('closed')).toEqual([])
    expect([...byLane.values()].flat().some((item) => item.id === 'x')).toBe(false)
  })

  it('a lane counts the server total when known, else what is drawn', () => {
    expect(laneCount(lanes[0]!, 2)).toBe(5)
    expect(laneCount(lanes[1]!, 1)).toBe(1)
    expect(laneCount({ id: 'z', label: 'Z', total: 1 }, 3)).toBe(3)
    expect(countWords(1, W)).toBe('1 card')
    expect(countWords(12345, W, 'it-IT')).toBe('12.345 cards')
  })

  it('refuses in order: the board, the card, the same lane, the lane, the app rule', () => {
    const base = { lanes, words: W }
    expect(moveHeldReason({ ...base, card: card('n1'), to: 'contained', heldReason: 'Offline', appHeld: 'App' })).toBe('Offline')
    expect(moveHeldReason({ ...base, card: card('n4'), to: 'closed', appHeld: 'App' })).toBe('Waiting for the closing signature')
    expect(moveHeldReason({ ...base, card: card('n1'), to: 'open' })).toBe(W.sameLane)
    expect(moveHeldReason({ ...base, card: card('n3'), to: 'closed', appHeld: 'App' })).toBe('Only quality managers close a nonconformance')
    expect(moveHeldReason({ ...base, card: card('n1'), to: 'decided', appHeld: '3 of 40 garments not decided' })).toBe('3 of 40 garments not decided')
    expect(moveHeldReason({ ...base, card: card('n1'), to: 'contained' })).toBeNull()
    expect(moveHeldReason({ ...base, card: card('n1'), to: 'nowhere' })).toBe(W.sameLane)
    expect(pickHeldReason(card('n4'))).toBe('Waiting for the closing signature')
    expect(pickHeldReason(card('n1'), 'Read-only')).toBe('Read-only')
    expect(pickHeldReason(card('n1'))).toBeNull()
  })

  it('a keyboard move steps lane by lane, says up and down are not used, stops at the ends, mirrors right to left', () => {
    expect(laneStep(lanes, 'open', 'ArrowRight')).toEqual({ to: 'contained', edge: false })
    expect(laneStep(lanes, 'open', 'ArrowLeft')).toEqual({ edge: true, why: 'edge' })
    expect(laneStep(lanes, 'decided', 'ArrowRight')).toEqual({ to: 'closed', edge: false })
    expect(laneStep(lanes, 'closed', 'ArrowRight')).toEqual({ edge: true, why: 'edge' })
    expect(laneStep(lanes, 'open', 'ArrowDown')).toEqual({ edge: true, why: 'upDown' })
    expect(laneStep(lanes, 'decided', 'Home')).toEqual({ to: 'open', edge: false })
    expect(laneStep(lanes, 'open', 'End')).toEqual({ to: 'closed', edge: false })
    expect(laneStep(lanes, 'contained', 'ArrowLeft', 'rtl')).toEqual({ to: 'decided', edge: false })
  })

  it('moves the focus between cards: up and down in a lane, across to the next lane with cards', () => {
    expect(nextCardFocus(byLane, lanes, 'n1', 'ArrowDown')).toBe('n2')
    expect(nextCardFocus(byLane, lanes, 'n2', 'ArrowDown')).toBeNull()
    expect(nextCardFocus(byLane, lanes, 'n2', 'ArrowRight')).toBe('n3')
    expect(nextCardFocus(byLane, lanes, 'n3', 'ArrowLeft')).toBe('n1')
    expect(nextCardFocus(byLane, lanes, 'n4', 'ArrowRight')).toBeNull()
    expect(nextCardFocus(byLane, lanes, 'n2', 'Home')).toBe('n1')
    expect(boardTabStop(byLane, lanes, null)).toBe('n1')
    expect(boardTabStop(byLane, lanes, 'n3')).toBe('n3')
    expect(boardTabStop(byLane, lanes, 'gone')).toBe('n1')
  })

  it('names a card with its lane, title, fields, marks and why it is held; says each target', () => {
    expect(cardName(card('n1'), lanes[0], W)).toBe('NCR-0012 in Open. Seam opens at the armour pocket. Severity: Major. Customer')
    expect(cardName(card('n4'), lanes[2], W)).toBe('NCR-0008 in Decided. Held: Waiting for the closing signature')
    const check = { card: card('n1'), lanes, words: W }
    expect(targetWords({ ...check, to: 'open' }, lanes[0], W)).toBe('Open: where it is now.')
    expect(targetWords({ ...check, to: 'contained' }, lanes[1], W)).toBe('Contained. Enter drops it here.')
    expect(targetWords({ ...check, to: 'closed' }, lanes[3], W)).toBe('Closed: held. Only quality managers close a nonconformance')
  })

  it('the Move to… menu lists every other lane, each held one with its reason', () => {
    const menu = moveMenu(card('n1'), lanes, W, null, (laneId) => (laneId === 'decided' ? '3 of 40 garments not decided' : null))
    expect(menu).toEqual([
      { laneId: 'contained', label: 'Contained', held: null },
      { laneId: 'decided', label: 'Decided', held: '3 of 40 garments not decided' },
      { laneId: 'closed', label: 'Closed', held: 'Only quality managers close a nonconformance' },
    ])
    expect(fillWords('{a} {b}', { a: 1 })).toBe('1 {b}')
  })
})

describe('board view markup (D19)', () => {
  const board = (extra: Record<string, unknown> = {}) => render(h(BoardView, { label: 'Nonconformances', lanes, cards, onMove: () => undefined, ...extra }))

  it('draws a region with one section per lane, its count in words, detail and held reason', () => {
    const out = board()
    expect(out).toMatch(/role="region"[^>]*aria-label="Nonconformances"/)
    expect(out.match(/<section[^>]*class="nds-bv-lane/g)).toHaveLength(4)
    expect(out).toContain('<span class="nds-vh">5 cards</span>')
    expect(out).toContain('Oldest 12 days')
    expect(out).toContain('Only quality managers close a nonconformance')
    expect(out).toMatch(/data-tone="warning"/)
    expect(out).toContain('Showing 2 of 5')
    expect(out).toContain(W.laneEmpty)
  })

  it('one Tab stop: the first card; each card a button named in words with the instructions; Move to… per card', () => {
    const out = board()
    expect(out.match(/data-bv-card="[^"]+"[^>]*/g)!.length).toBe(4)
    expect(out.match(/role="button" tabindex="0"/g)).toHaveLength(1)
    expect(out).toMatch(/aria-label="NCR-0012 in Open\. Seam opens at the armour pocket\. Severity: Major\. Customer"/)
    expect(out).toMatch(/aria-describedby="[^"]+"/)
    expect(out).toContain(W.instructions)
    expect(out).toContain('aria-label="Move NCR-0013 to…"')
    expect(out).toMatch(/aria-haspopup="menu"/)
    // A card with an address has a real link to open it.
    expect(out).toMatch(/<a[^>]*href="\/quality\/ncr\/n3"[^>]*>Open<\/a>/)
  })

  it('a held card says why on the card and its Move to… is held (focusable, never disabled)', () => {
    const out = board()
    expect(out).toContain('Waiting for the closing signature')
    expect(out).toMatch(/aria-disabled="true"[^>]*aria-description="Waiting for the closing signature"[^>]*aria-label="Move NCR-0008 to…"|aria-label="Move NCR-0008 to…"[^>]*aria-disabled="true"/)
    expect(out).not.toMatch(/\sdisabled=""/)
  })

  it('a keyboard move under way: the target lane outlined and a ghost with words; held targets say why', () => {
    const moving = board({ defaultMove: { cardId: 'n1', to: 'contained' } })
    expect(moving).toMatch(/class="nds-bv-lane is-target"/)
    expect(moving).toMatch(/data-bv-ghost=""/)
    expect(moving).toContain(W.dropHere)
    const held = board({ defaultMove: { cardId: 'n1', to: 'closed' } })
    expect(held).toMatch(/class="nds-bv-lane is-held is-held-target"/)
    expect(held).toContain('Cannot drop here: Only quality managers close a nonconformance')
  })

  it('without onMove (or with a held reason) it is read-only and says so at rest', () => {
    expect(render(h(BoardView, { label: 'B', lanes, cards }))).toContain(W.readOnly)
    expect(board({ heldReason: 'Offline: changes wait to be sent' })).toContain('Offline: changes wait to be sent')
  })

  it('loading draws the lane heads and skeleton cards; the list layout stacks the lanes', () => {
    const loading = board({ loading: true })
    expect(loading).toMatch(/aria-busy="true"/)
    expect(loading).toContain('Contained')
    expect(loading).not.toContain('NCR-0012')
    expect(board({ layout: 'list' })).toMatch(/class="nds-bv is-list"/)
  })

  it('takes every word from the app', () => {
    const out = board({ words: { laneEmpty: 'Niente qui', moveTo: 'Sposta in…', moveToCard: 'Sposta {card} in…', countOther: '{count} schede' } })
    expect(out).toContain('Niente qui')
    expect(out).toContain('Sposta in…')
    expect(out).toContain('>5 schede<')
    expect(out).not.toContain(W.laneEmpty)
  })
})

describe('board view packaging (D19)', () => {
  const css = readFileSync(new URL('./board-view.css', import.meta.url), 'utf8')

  it('semantic tokens only: no raw colour, no numbered ramp', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/var\(--nds-(grey|gray|blue|green|red|amber|purple|cyan)-\d+\)/)
    expect(css).not.toMatch(/rgba?\(/)
  })

  it('the grid barrel does not re-export this folder, and no AG Grid code is in it', () => {
    const barrel = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8')
    const code = barrel.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/views\/board/)
    for (const file of readdirSync(new URL('.', import.meta.url))) {
      if (!/\.tsx?$/.test(file) || file.endsWith('.vitest.test.ts')) continue
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), file).not.toMatch(/from 'ag-grid/)
    }
  })

  it('no shared stylesheet carries its rules', () => {
    for (const sheet of ['primitives.css', 'components.css', 'patterns.css', 'a11y.css']) {
      const text = readFileSync(new URL(`../../../styles/${sheet}`, import.meta.url), 'utf8')
      expect(text, sheet).not.toMatch(/board-view|nds-bv-/)
    }
  })
})
