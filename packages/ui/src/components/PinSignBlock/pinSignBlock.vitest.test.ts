import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PinSignBlock } from './PinSignBlock'
import { pinSignView } from './pinSignBlockModel'

/** B-W2b-28 (D22) — the PIN variant of SignBlock. Made-up person. */
describe('pinSignView', () => {
  it('draws the pad until done; held or locked holds every key; busy holds them while checking', () => {
    expect(pinSignView({})).toEqual({ showPad: true, padLocked: false, padBusy: false, heldReason: null })
    expect(pinSignView({ heldReason: 'Signing needs the network.' })).toMatchObject({ padLocked: true, heldReason: 'Signing needs the network.' })
    expect(pinSignView({ heldReason: '   ' })).toMatchObject({ padLocked: false, heldReason: null })
    expect(pinSignView({ locked: true })).toMatchObject({ padLocked: true, heldReason: null })
    expect(pinSignView({ state: 'busy' })).toMatchObject({ padBusy: true })
    expect(pinSignView({ state: 'done', locked: true })).toEqual({ showPad: false, padLocked: false, padBusy: false, heldReason: null })
  })
})

describe('PinSignBlock', () => {
  const base = {
    title: 'Sign the final check',
    summary: h('p', null, '32 of 32 garments checked'),
    meaning: 'By signing you confirm you checked every garment.',
    signer: { name: 'Marta Demo', detail: 'Final inspection' },
    onSign: () => {},
    onNotYou: () => {},
  }
  it('orders what is signed, its meaning, who signs and what is recorded before the pad; no digit anywhere', () => {
    const html = render(h(PinSignBlock, base))
    const at = (s: string) => html.indexOf(s)
    expect(at('32 of 32')).toBeLessThan(at('What signing means'))
    expect(at('What signing means')).toBeLessThan(at('Signing as Marta Demo'))
    expect(at('Signing as Marta Demo')).toBeLessThan(at('are recorded'))
    expect(at('are recorded')).toBeLessThan(at('Sign with your PIN'))
    expect(html).toContain('>MD<')
    expect(html).toContain('Not you?')
    expect(html).toContain('0 of 6')
    expect(html).not.toMatch(/<input/)
  })
  it('a held block says why on screen and holds every key; done replaces the pad', () => {
    const held = render(h(PinSignBlock, { ...base, heldReason: 'Signing needs the network.' }))
    expect(held).toContain('role="status">Signing needs the network.')
    expect(held).toContain('data-locked="true"')
    const done = render(h(PinSignBlock, { ...base, state: 'done', done: h('p', null, 'Signed at 10:42.') }))
    expect(done).toContain('Signed at 10:42.')
    expect(done).not.toContain('Sign with your PIN')
  })
  it('speaks the host’s language', () => {
    const html = render(h(PinSignBlock, { ...base, labels: { signingAs: (n: string) => `Firma come ${n}`, pin: 'Firma con il PIN', entered: (e: number, t: number) => `${e} di ${t}` } }))
    expect(html).toContain('Firma come Marta Demo')
    expect(html).toContain('Firma con il PIN')
    expect(html).toContain('0 di 6')
  })
})
