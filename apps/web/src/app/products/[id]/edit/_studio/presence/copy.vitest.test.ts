import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ListingsPane } from '../drawer/panes/ListingsPane'
import type { SheetRow } from '../drawer/types'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bandTitle } from '../sheet/channel/AliasBandCell'
import { reviewCopy } from '../sheet/channel/reviewCopy'
import { readinessMeta } from '@/design-system/grid/renderers/readiness'

describe('W0 honest absence and review vocabulary', () => {
  it('an absent alias status cannot become NOT LISTED or throw in its title', () => {
    const title = bandTitle(undefined, 'GALE-JACKET', null, undefined, null)
    expect(title).toContain('Listing status not reported')
    expect(title).not.toMatch(/not listed/i)
    expect(bandTitle(undefined, 'GALE-JACKET', 'ACTIVE', undefined, null)).toContain('Listing active')
  })
  it('readiness says Listed without claiming channel verification', () => {
    expect(readinessMeta('live', 'row')).toMatchObject({ label: 'Listed', tone: 'info', hint: 'Our record holds a channel reference. Whether it is selling is on the presence line.' })
    expect(readinessMeta('unlisted', 'row')).toMatchObject({ label: 'No listing here', hint: 'We hold no listing record for this coordinate. Nothing has been checked against the channel.' })
  })
  it('review copy follows the actual mode', () => {
    expect(reviewCopy('check')).toEqual({ menu: 'Check before sending', title: 'Check before sending', subtitle: 'Nothing is sent from here.' })
    expect(reviewCopy('synchronize')).toMatchObject({ menu: 'Review and synchronize…', title: 'Review and synchronize' })
    const source = readFileSync(new URL('../sheet/channel/useChannelSheetAdapter.tsx', import.meta.url), 'utf8')
    expect(source).toContain("reviewCopy(reviewPath != null ? 'synchronize' : 'check')")
    expect(source).toContain("reviewCopy(accountId && rows.some(row => row.aliasId === a.id && row.shopify) ? 'synchronize' : 'check')")
  })
  it('all saved-value checks use the same words', () => {
    for (const file of ['../variants/channel/ChannelProjection.tsx', '../variants/channel/ProjectionPreflight.tsx', '../sheet/channel/AliasPublishControl.tsx']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain('Saved values checked')
    }
  })
})


describe('ListingsPane stored status and local offer mark', () => {
  it('renders shared status vocabulary and states the local-only effect', () => {
    const row = { listing: { listingStatus: 'ACTIVE', isPublished: true, offerActive: false,
      offerActiveHonoured: false, channelFactDetail: { shopifyStatus: 'DRAFT' }, externalListingId: null,
      price: null, quantity: null }, readiness: null } as unknown as SheetRow
    const markup = renderToStaticMarkup(createElement(ListingsPane, { row, scope: { kind: 'channel', channel: 'SHOPIFY', marketplace: 'GLOBAL' } }))
    expect(markup).toContain('Listed')
    expect(markup).toContain('Draft')
    expect(markup).toContain('Offer (Nexus mark)')
    expect(markup).toContain('not read it')
    expect(markup).toContain('marked paused')
    expect(markup).toContain('This channel does not act on the Nexus offer mark.')
    expect(markup).not.toContain('>ACTIVE<')
    expect(markup).not.toContain('>selling<')
  })
})
