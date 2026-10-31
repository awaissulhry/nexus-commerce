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

  it('a replaced ticket names the new code; reprint, void and split wait for the network offline', () => {
    expect(render('replaced-scanned')).toMatch(/was replaced by BN-/)
    expect(render('held-offline')).toContain('Reprint, void and split need the network')
    expect(render('refused')).toContain('a bundle is voided only before any scan')
  })

  it('B-W2a-75: splits garments off with the pad and a reason tile, then shows the new ticket and what stays', () => {
    const split = render('split')
    expect(split).toContain('10 garments are in this bundle')
    expect(split).toContain('Split off 3 · print ticket')
    for (const word of ['Rework', 'Recut', 'Hold']) expect(split).toContain(word)
    expect(render('split', 'it')).toContain('Dividi 3 · stampa cartellino')
    expect(render('split-empty')).toContain('Type how many come off: 1 to 9')
    expect(render('split-one')).toContain('Only one garment is in it: nothing can come off.')
    const done = render('split-done')
    expect(done).toMatch(/3 garments split off BN-[^ ]+ into new bundle BN-[^ ]+ \(Rework\)\. 7 stay in BN-/)
    expect(done).toContain('Sent to the printer')
    expect(render('split-refused')).toContain('The work order is on hold')
    // B-W2a-F6: why is the floor's one reason picker — what it is about, the choice, the three tiles with their hints.
    expect(split).toContain('Split the bundle')
    expect(split).toContain('Why do they come off?')
    expect(split).toContain('Chosen: Rework')
    expect(split).toContain('Back to be fixed')
    expect(render('split', 'it')).toContain('Scelto: Rilavorazione')
    expect(render('split-why')).toContain('No reason chosen yet')
    expect(render('split-why')).toContain('Choose a reason first')
    expect(render('split-offline')).toContain('Chosen: Recut')
    expect(render('split-offline').match(/Reprint, void and split need the network/g)?.length ?? 0).toBeGreaterThan(3)
    // The card's bar: Back, Split, Reprint (main); Void sits in the card.
    expect(render('bundle-card')).toMatch(/Split<\/span><\/button><button[^>]*is-main[^>]*>.*Reprint/)
  })

  it('a role without bundles sees why', () => {
    expect(render('no-permission')).toContain('Bundles are not for your role')
  })
})
