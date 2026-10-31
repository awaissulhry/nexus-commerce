import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FloorNamePicker } from './FloorNamePicker'
import { gridMove, letterStrip, nameGroups, nameLetter, type FloorPerson, type TileRect } from './floorNamePickerModel'

/** B-W2b-28 — FloorNamePicker: name tiles, a letter strip, recent people first, no keyboard. Made-up names. */
const PEOPLE: FloorPerson[] = [
  { id: 'p1', name: 'Marta Demo' },
  { id: 'p2', name: 'élodie Prova', detail: 'Cucitura' },
  { id: 'p3', name: 'Luca Esempio' },
  { id: 'p4', name: 'Anna Campione' },
  { id: 'p5', name: 'Mario Test', heldReason: 'Not on this site today' },
  { id: 'p6', name: 'Զարա Օրինակ' },
]

describe('nameLetter and nameGroups', () => {
  it('files a name under its first letter without the accent; another script keeps its letter; the rest is #', () => {
    expect(nameLetter('Élodie')).toBe('E')
    expect(nameLetter('élodie')).toBe('E')
    expect(nameLetter('Զարա')).toBe('Զ')
    expect(nameLetter('3 Demo')).toBe('#')
    expect(nameLetter('   ')).toBe('#')
  })
  it('puts the recent people first in their order, then everyone A–Z by the page language', () => {
    const g = nameGroups(PEOPLE, ['p3', 'nobody', 'p1', 'p3'], 'it')
    expect(g.recent.map((p) => p.id)).toEqual(['p3', 'p1'])
    expect(g.letters.map((l) => l.letter)).toEqual(['A', 'E', 'L', 'M', 'Զ'])
    expect(g.letters.find((l) => l.letter === 'M')!.people.map((p) => p.id)).toEqual(['p5', 'p1'])
  })
  it('sorts by sortName when given', () => {
    const g = nameGroups([{ id: 'a', name: 'Anna Zeta', sortName: 'Zeta Anna' }, { id: 'b', name: 'Bruno Alfa', sortName: 'Alfa Bruno' }])
    expect(g.letters.map((l) => [l.letter, l.people[0].id])).toEqual([['A', 'b'], ['Z', 'a']])
  })
  it('the strip always shows A–Z (letters with no names say 0) plus other scripts', () => {
    const strip = letterStrip(nameGroups(PEOPLE))
    expect(strip).toHaveLength(27)
    expect(strip[0]).toEqual({ letter: 'A', count: 1 })
    expect(strip.find((s) => s.letter === 'Q')).toEqual({ letter: 'Q', count: 0 })
    expect(strip.at(-1)).toEqual({ letter: 'Զ', count: 1 })
  })
})

describe('gridMove', () => {
  // Three tiles a row: (0 1 2) (3 4 5) (6)
  const rects: TileRect[] = Array.from({ length: 7 }, (_, i) => ({ left: (i % 3) * 100, top: Math.floor(i / 3) * 80 + (i === 4 ? 2 : 0), width: 90, height: 70 }))
  it('moves left and right by one, up and down to the nearest tile in the next row, Home and End', () => {
    expect(gridMove(rects, 4, 'ArrowLeft')).toBe(3)
    expect(gridMove(rects, 4, 'ArrowRight')).toBe(5)
    expect(gridMove(rects, 4, 'ArrowUp')).toBe(1)
    expect(gridMove(rects, 4, 'ArrowDown')).toBe(6)
    expect(gridMove(rects, 1, 'ArrowUp')).toBe(1)
    expect(gridMove(rects, 0, 'ArrowLeft')).toBe(0)
    expect(gridMove(rects, 3, 'End')).toBe(6)
    expect(gridMove(rects, 3, 'Home')).toBe(0)
    expect(gridMove([], 0, 'Home')).toBe(-1)
  })
})

describe('FloorNamePicker', () => {
  it('draws the recent group, the letter headings, initials, and a held letter that says so', () => {
    const html = render(h(FloorNamePicker, { label: 'Pick your name', people: PEOPLE, recentIds: ['p3'], onPick: () => {} }))
    expect(html).toContain('Worked here recently')
    expect(html).toContain('>LE<')
    expect(html).toContain('aria-label="Names starting with M"')
    expect(html).toContain('aria-description="No names start with Q"')
    expect(html).toContain('Not on this site today')
    expect(html.match(/data-name-tile/g)).toHaveLength(7)
  })
  it('held as a whole: the reason on screen and every tile held; empty says who to ask', () => {
    const held = render(h(FloorNamePicker, { label: 'Pick your name', people: PEOPLE, onPick: () => {}, heldReason: 'Name and PIN need the network.' }))
    expect(held).toContain('role="status"')
    expect(held.match(/data-name-tile="" aria-disabled="true"/g)).toHaveLength(6)
    expect(render(h(FloorNamePicker, { label: 'Pick', people: [], onPick: () => {} }))).toContain('No one is set up here yet')
  })
  it('speaks the host’s language', () => {
    const html = render(h(FloorNamePicker, { label: 'Scegli', people: PEOPLE, recentIds: ['p1'], onPick: () => {}, labels: { recent: 'Recenti', jumpTo: (l: string) => `Nomi con ${l}` } }))
    expect(html).toContain('Recenti')
    expect(html).toContain('Nomi con M')
  })
})
