import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '../../../lib/record-thread/parts/testing'
import { BAND_SLOTS, bandSlotsOf } from './model'
import { RecordFrame, type RecordBand } from './RecordFrame'

/**
 * owb-b5 (w5.2; design plan § 5i "ONE frame for every record page": back · picture · title · ONE pill · tags · Chat · People · ONE main
 * button) — the band's three slots. A slot the page leaves empty draws nothing: the band is today's, node for node. A filled slot
 * stands in its place: the picture before the title, the Chat door in the Thread button's place (only with a thread), People after it.
 */

const band = { back: createElement('a', { href: '/w/demo/sales/orders' }, 'Orders'), title: 'SO-2026-0101 · Brand Alpha', status: createElement('span', null, 'In production'), primary: createElement('button', { type: 'button' }, 'Ship…') }
const thread = createElement('div', { className: 'stand-in-thread' }, 'messages')
const page = (over: Pick<RecordBand, 'picture' | 'chat' | 'people'>, withThread = true) =>
  render(createElement(RecordFrame, { recordType: 'SalesOrder', personId: 'u1', band: { ...band, ...over }, thread: withThread ? thread : null, threadLabel: 'The order’s thread', children: createElement('p', null, 'The body') }))

describe('owb-b5 w5.2: the band slots — the model', () => {
  it('three slots in the order the band draws them', () => {
    expect(BAND_SLOTS).toEqual(['picture', 'chat', 'people'])
  })

  it('absent, null, a boolean or empty words is an empty slot; a part fills it', () => {
    expect(bandSlotsOf({})).toEqual([])
    expect(bandSlotsOf({ picture: null, chat: undefined, people: false })).toEqual([])
    expect(bandSlotsOf({ picture: '', people: true })).toEqual([])
    const part = createElement('span', null, 'x')
    expect(bandSlotsOf({ people: part, picture: part })).toEqual(['picture', 'people'])
    expect(bandSlotsOf({ chat: part, people: part, picture: part })).toEqual(['picture', 'chat', 'people'])
  })
})

describe('owb-b5 w5.2: the band slots — the frame', () => {
  it('empty slots = today\'s DOM (with and without a thread)', () => {
    const today = page({})
    expect(page({ picture: undefined, chat: undefined, people: undefined })).toBe(today)
    expect(page({ picture: null, chat: null, people: null })).toBe(today)
    expect(page({ picture: false, chat: false, people: false })).toBe(today)
    expect(page({ picture: null, chat: null, people: null }, false)).toBe(page({}, false))
    for (const part of ['fw-rcf-pic', 'fw-rcf-chat', 'fw-rcf-people']) expect(today, part).not.toContain(part)
    // Today's Thread button is there.
    expect(today).toContain('aria-keyshortcuts="Meta+J Control+J"')
  })

  it('the picture stands before the title, inside the title group', () => {
    const html = page({ picture: createElement('img', { src: '/picture.png', alt: '', className: 'stand-in-picture' }) })
    expect(html).toContain('<span class="fw-rcf-pic"><img src="/picture.png" alt="" class="stand-in-picture"/></span>')
    const title = html.indexOf('nds-detailhdr-title')
    expect(html.indexOf('fw-rcf-pic')).toBeGreaterThan(title)
    expect(html.indexOf('fw-rcf-pic')).toBeLessThan(html.indexOf('<h1'))
  })

  it('the Chat door takes the Thread button\'s place (one chat door); People follows it; the primary keeps its place first', () => {
    const html = page({ chat: createElement('button', { type: 'button', className: 'stand-in-chat' }, 'Chat · 2 new'), people: createElement('button', { type: 'button', className: 'stand-in-people' }, '3 people') })
    expect(html).toContain('<span class="fw-rcf-chat"><button type="button" class="stand-in-chat">Chat · 2 new</button></span>')
    expect(html).not.toContain('aria-keyshortcuts="Meta+J Control+J"')
    const primary = html.indexOf('fw-rcf-primary')
    const chat = html.indexOf('fw-rcf-chat')
    const people = html.indexOf('fw-rcf-people')
    expect(primary).toBeGreaterThan(-1)
    expect(chat).toBeGreaterThan(primary)
    expect(people).toBeGreaterThan(chat)
  })

  it('no thread for this person: no Chat door either (a door that cannot open is not drawn); People still shows', () => {
    const html = page({ chat: createElement('button', { type: 'button', className: 'stand-in-chat' }, 'Chat'), people: createElement('span', null, '3 people') }, false)
    expect(html).not.toContain('stand-in-chat')
    expect(html).toContain('fw-rcf-people')
  })

  it('the slots are parts, never words (no text prop); the phone hides People with the step while the conversation is full screen', () => {
    const frame = readFileSync(new URL('./RecordFrame.tsx', import.meta.url), 'utf8')
    for (const slot of ['readonly picture?: ReactNode', 'readonly chat?: ReactNode', 'readonly people?: ReactNode']) expect(frame, slot).toContain(slot)
    const css = readFileSync(new URL('./record-frame.css', import.meta.url), 'utf8')
    expect(css).toContain('.fw-rcf-hdr.is-thread .fw-rcf-people {')
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })
})
