import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NoMarketView, type NoMarketViewProps } from './NoMarketState'

/** A-53 — every state of the "no market" view, as rendered HTML (node SSR; precedent `presence/discovery-render`). */
const base: NoMarketViewProps = { gate: 'none', retrying: false, canSetUp: true, settingUp: false, refusal: null, onRetry: () => {}, onSetUp: () => {} }
const html = (props: Partial<NoMarketViewProps>) => renderToStaticMarkup(createElement(NoMarketView, { ...base, ...props }))
const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(match => match[1])

describe('NoMarketView', () => {
  it('none, with channels.sync: says there are no markets and offers "Set up markets"', () => {
    const markup = html({})
    expect(markup).toContain('This business has no markets yet')
    expect(markup).toContain('Only channels you have connected appear in the scope bar.')
    expect(buttons(markup)).toEqual(['Set up markets'])
    expect(markup).not.toContain('Ask an owner')
  })

  it('none, without channels.sync: no button, and says who can set them up', () => {
    const markup = html({ canSetUp: false })
    expect(buttons(markup)).toEqual([])
    expect(markup).toContain('Ask an owner of this business to set up markets.')
  })

  it('none, while setting up or re-reading: the button says so and cannot be pressed twice', () => {
    for (const markup of [html({ settingUp: true }), html({ retrying: true })]) {
      expect(buttons(markup)).toEqual(['Setting up…'])
      expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Setting up…/)
    }
  })

  it('none, after a refusal: the server\'s sentence is shown and the button stays', () => {
    const markup = html({ refusal: 'You do not have permission to set up markets for this business.' })
    expect(markup).toContain('You do not have permission to set up markets for this business.')
    expect(buttons(markup)).toEqual(['Set up markets'])
  })

  it('failed: says the markets could not be loaded and offers "Try again", then "Trying again…"', () => {
    const markup = html({ gate: 'failed' })
    expect(markup).toContain('Markets could not be loaded')
    expect(markup).not.toContain('no markets yet')
    expect(buttons(markup)).toEqual(['Try again'])
    expect(buttons(html({ gate: 'failed', retrying: true }))).toEqual(['Trying again…'])
  })

  it('outside a studio frame (no re-read): no button in either state', () => {
    expect(buttons(html({ gate: 'failed', onRetry: undefined }))).toEqual([])
    expect(buttons(html({ onSetUp: undefined }))).toEqual([])
  })

  it('ready: renders nothing', () => {
    expect(html({ gate: 'ready' })).toBe('')
  })
})
