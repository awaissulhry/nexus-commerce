import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { FLOOR_NAMESPACES } from '../routes'
import { designScreen } from './fixtures'

/** SCR-095's screens say what they do: the one-tap make, the two ticks, what waits for the network, never a fake print. */

const render = (id: string, locale: 'it' | 'en' = 'en') => {
  const item = designScreen.cases.find((entry) => entry.id === id)
  if (!item) throw new Error(id)
  const View = designScreen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(View, { model: item.model })))
}

describe('SCR-095 Bundles & tickets', () => {
  it('proposes bundles per size and makes them in one tap', () => {
    const html = render('proposal')
    expect(html).toContain('NERO 50: 2 bundles (10 + 6)')
    expect(html).toContain('Make 3 bundles · print 3 tickets')
    expect(render('proposal', 'it')).toContain('Crea 3 fasci · stampa 3 cartellini')
  })

  it('shows each ticket\'s two ticks and its print job; offline the tablet\'s own codes, one tick', () => {
    const online = render('made-online')
    expect(online).toContain('Recorded by the office')
    expect(online).toContain('In the print queue')
    const offline = render('made-offline')
    expect(offline).toContain('Saved on this tablet')
    expect(offline).toContain('their tickets print on the station')
    expect(render('numbered-by-office')).toContain('Numbered by the office when it arrives')
  })

  it('says plainly when nothing prints, never a made-up print state', () => {
    const html = render('no-printer')
    expect(html).toContain('No label printer at this site')
    expect(html).not.toContain('In the print queue')
    expect(html).not.toContain('Printed<')
  })

  it('a replaced ticket names the new code; reprint and void wait for the network offline', () => {
    expect(render('replaced-scanned')).toMatch(/was replaced by BN-/)
    expect(render('held-offline')).toContain('Reprint and void need the network')
    expect(render('refused')).toContain('a bundle is voided only before any scan')
  })

  it('a role without bundles sees why', () => {
    expect(render('no-permission')).toContain('Bundles are not for your role')
  })
})
