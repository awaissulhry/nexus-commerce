import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EbayDescriptionStudio } from './EbayDescriptionStudio'

describe('shared theme editor embedded in Product Presentation', () => {
  it('exposes shared saving and preview without listing-update controls', () => {
    const html = renderToStaticMarkup(createElement(EbayDescriptionStudio, { open: true, embedded: true, marketplace: 'IT', accountId: 'account-b', aliasKey: 'alternate', allowPublish: false, onClose: () => {} }))
    expect(html).toContain('Save changes edits this shared theme for every product that uses it')
    expect(html).toContain('Preview market')
    expect(html).not.toContain('Push to eBay')
    expect(html).not.toContain('description-push-button')
    expect(html).not.toContain('Checkboxes select families')
  })
})
