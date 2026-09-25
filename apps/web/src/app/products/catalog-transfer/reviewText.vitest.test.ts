import { describe, expect, it } from 'vitest'
import { blankSentence, invalidBody, marketLabel, outcomeSummary, readsFileMarket, recheckLabel, uploadMarket } from './reviewText'
import type { TransferJob, TransferOutcome } from './sourceMapping'
import styles from './transfer.module.css'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PolicyNote, ReviewConfirmations, reviewMetrics } from './TransferReview'
import { NO_CONFIRMATIONS } from './reviewConfirmations'

const counts = (over: Partial<TransferJob['counts']> = {}): TransferJob['counts'] => ({ productsCreated: 0, listingsCreated: 0, changed: 0, unchanged: 0, refused: 0, ...over })
const options = { markets: [{ channel: 'AMAZON', code: 'DE', name: 'Amazon Germany' }, { channel: 'EBAY', code: 'IT', name: 'Italy' }], accounts: [{ id: 'a', channelType: 'AMAZON', marketplace: null, displayName: 'Main shop' }], listings: [] }

describe('review sentences that must be true for this file', () => {
  it('says a full-update blank removes a value only when the file had such blanks', () => {
    expect(blankSentence(counts())).toBe('Blank and omitted values are preserved.')
    for (const key of ['cleared', 'alreadyEmpty', 'clearUnchecked'] as const) {
      const text = blankSentence(counts({ [key]: 2 }))
      expect(text).toContain('a blank cell removes that value')
      expect(text).not.toBe('Blank and omitted values are preserved.')
    }
  })
  it('does not call a review blocked when its ready records can be saved', () => {
    const fallback = 'Validation failures block this review.'
    const ready = { state: 'INVALID', counts: counts({ changed: 40, refused: 3 }) }
    expect(invalidBody(ready, fallback, true)).toContain('The 3 issues listed below need correction')
    expect(invalidBody(ready, fallback, true)).toContain('save the ready records now')
    expect(invalidBody(ready, fallback, false)).toBe(fallback)
    expect(invalidBody({ state: 'INVALID', counts: counts({ refused: 3 }) }, fallback, true)).toBe(fallback)
  })
  it('words the check-again button by what it confirms', () => {
    expect(recheckLabel(1, 0, 2, 0)).toBe('Check the file again with these links')
    expect(recheckLabel(0, 0, 0, 3)).toBe('Check the file again with these ended listings')
    expect(recheckLabel(0, 1, 2, 3)).toBe('Check the file again with these ended listings')
    expect(recheckLabel(1, 1, 2, 3)).toBe('Check the file again with these links and ended listings')
    expect(recheckLabel(0, 0, 2, 3)).toBe('Check the file again with these links and ended listings')
  })
})

describe('outcome labels', () => {
  it('never repeats the channel name before a market name that already carries it', () => {
    expect(marketLabel(options, 'AMAZON', 'DE')).toBe('Amazon Germany')
    expect(marketLabel(options, 'EBAY', 'IT')).toBe('eBay Italy')
    expect(marketLabel(options, 'AMAZON', 'FR')).toBe('Amazon FR')
  })
  it('names an issue-only record by its issues, never with an empty scope', () => {
    const row: TransferOutcome = { id: '1', index: 4, status: 'INVALID', identity: { sku: 'GALE-JACKET', field: 'Item ID', row: 5 } as never, cells: [], issues: [{ row: 5, sku: 'GALE-JACKET', field: 'Item ID', message: 'x' }], exclusions: [] }
    const text = outcomeSummary(row, options, 'Needs correction', 0)
    expect(text).toBe('GALE-JACKET · 1 file issue · Item ID · Needs correction')
    expect(text).not.toContain('·  ·')
    const listing: TransferOutcome = { id: '2', index: 5, status: 'REVIEWED', identity: { entity: 'Overrides', sku: 'X', channel: 'AMAZON', accountId: 'a', marketplace: 'DE', aliasKey: '', locale: '', field: 'color', action: 'SET', row: 7 }, cells: [], issues: [], exclusions: [] }
    expect(outcomeSummary(listing, options, 'Ready to save', 12)).toBe('X · Amazon Germany · Main shop · Primary listing · Ready to save · 12 attributes')
  })
})

describe('the marketplace an upload sends', () => {
  it('uses the file’s own marketplace for an Amazon template unless the Owner chose one', () => {
    expect(uploadMarket('amazon', 'GALE DE.xlsm', 'IT', '')).toBe('')
    expect(uploadMarket('amazon', 'GALE DE.xlsm', 'IT', 'DE')).toBe('DE')
    expect(uploadMarket('catalog', 'GALE DE.xlsm', 'IT', '')).toBe('')
    expect(uploadMarket('catalog', 'nexus.xlsx', 'IT', '')).toBe('IT')
    expect(uploadMarket('source', 'supplier.xlsx', 'IT', '')).toBe('IT')
    expect(readsFileMarket('catalog', 'nexus.xlsx')).toBe(false)
  })
})

describe('confirmation rows use the full-width layout', () => {
  it('puts link and delete rows in the choice layout, not the narrow table cell', () => {
    const html = renderToStaticMarkup(createElement(ReviewConfirmations, {
      job: { jobId: 'j', state: 'INVALID', processed: 0, total: 1, mode: 'upsert', filename: 'f', expiresAt: '', warnings: [], counts: counts(),
        links: [{ fileSku: 'MOSS-JACKET', proposedSku: 'IT-MOSS-JACKET', reason: 'r' }],
        deletes: [{ fileSku: 'D-1', sku: 'D-1', channel: 'AMAZON', marketplace: 'DE', accountId: 'a', confirmed: false }] },
      busy: false, canRecheck: true, confirmed: NO_CONFIRMATIONS, selectedLinks: {}, onLinks: () => {}, endSkus: [], onEndSkus: () => {}, onRecheck: () => {},
    }))
    expect(styles.choice).toBeTruthy()
    expect(html.split(`class="${styles.choice}"`).length - 1).toBe(2)
    expect(html).not.toContain(`class="${styles.cell}"`)
  })
})

describe('the review screen uses them', () => {
  it('states the full-update blank rule in the policy note of a channel-file review', () => {
    const policy = { shared: 'replace' as const, overrides: 'replace' as const }
    expect(renderToStaticMarkup(createElement(PolicyNote, { job: { policy, counts: counts({ cleared: 5 }) } }))).toContain('a blank cell removes that value')
    expect(renderToStaticMarkup(createElement(PolicyNote, { job: { policy, counts: counts() } }))).toContain('Blank and omitted values are preserved.')
  })
  it('formats metric numbers with the locale separator', () => {
    const values = reviewMetrics(counts({ changed: 1160, refused: 2 })).map(m => m.value)
    expect(values).toContain((1160).toLocaleString())
    expect(values.every(v => typeof v === 'string')).toBe(true)
  })
})
