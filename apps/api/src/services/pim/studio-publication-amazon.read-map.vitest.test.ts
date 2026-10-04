import { describe, expect, it } from 'vitest'

/**
 * Sheet publish parity, step 6 — a publication that shares its Amazon feed with other families reads ONLY its own part
 * of the processing report: its own messages' issues, plus issues about the whole feed. Pending until the report covers
 * every message of the feed. A publication sent alone (no map) is read as messages 1..n, exactly as before.
 */
import { amazonReportResults, sharedFeedReport } from './studio-publication-amazon.js'
import { amazonFeedPlacement } from './studio-publication-settle.js'

const report = (issues: unknown[], summary: Record<string, unknown>) => JSON.stringify({ issues, summary })

describe('a shared Amazon feed', () => {
  // Feed of 5 messages: family A = messages 1-2, family B = messages 3-5.
  const A = { skus: ['A1', 'A2'], messages: [{ messageId: 1, sku: 'A1' }, { messageId: 2, sku: 'A2' }] }
  const B = { skus: ['B1', 'B2', 'B3'], messages: [{ messageId: 3, sku: 'B1' }, { messageId: 4, sku: 'B2' }, { messageId: 5, sku: 'B3' }] }
  const done = report([{ messageId: 4, code: '90220', severity: 'ERROR', message: 'Invalid size', attributeNames: ['size'] }],
    { messagesProcessed: 5, messagesAccepted: 4, messagesInvalid: 1, errors: 1, warnings: 0 })

  it('settles each family from its own messages', async () => {
    expect(await amazonReportResults(done, A.skus, { messages: A.messages, feedTotal: 5 })).toEqual([
      { sku: 'A1', failed: false, issues: [], message: 'Amazon processed this product.' },
      { sku: 'A2', failed: false, issues: [], message: 'Amazon processed this product.' },
    ])
    expect(await amazonReportResults(done, B.skus, { messages: B.messages, feedTotal: 5 })).toEqual([
      { sku: 'B1', failed: false, issues: [], message: 'Amazon processed this product.' },
      { sku: 'B2', failed: true, issues: [{ code: '90220', severity: 'error', message: 'Invalid size', attributeNames: ['size'] }], message: 'Invalid size' },
      { sku: 'B3', failed: false, issues: [], message: 'Amazon processed this product.' },
    ])
  })

  it('stays pending until the report covers every message of the feed', async () => {
    const partial = report([], { messagesProcessed: 3, messagesAccepted: 3, messagesInvalid: 0 })
    expect(await amazonReportResults(partial, A.skus, { messages: A.messages, feedTotal: 5 })).toBeNull()
  })

  it('a feed Amazon refused as a whole fails every family', async () => {
    const refused = report([{ code: 'FEED', severity: 'ERROR', message: 'Invalid feed header' }], { messagesProcessed: 5, messagesAccepted: 0, messagesInvalid: 5 })
    expect(sharedFeedReport(refused, A.skus, A.messages, 5)?.everyInvalid).toBe(true)
    const results = await amazonReportResults(refused, A.skus, { messages: A.messages, feedTotal: 5 })
    expect(results?.map(r => [r.sku, r.failed, r.message])).toEqual([['A1', true, 'Invalid feed header'], ['A2', true, 'Invalid feed header']])
  })

  it('a feed of one publication reads exactly as before (messages 1..n)', async () => {
    const alone = report([{ messageId: 2, code: '90220', severity: 'ERROR', message: 'Invalid size' }], { messagesProcessed: 2, messagesAccepted: 1, messagesInvalid: 1 })
    expect((await amazonReportResults(alone, ['P', 'C']))?.map(r => [r.sku, r.failed])).toEqual([['P', false], ['C', true]])
  })
})

describe('amazonFeedPlacement', () => {
  it('reads a publication\'s own place in a shared feed, and nothing for a publication sent alone', () => {
    expect(amazonFeedPlacement({ feedMessages: [{ messageId: 3, sku: 'B1' }], feedTotal: 5 })).toEqual({ messages: [{ messageId: 3, sku: 'B1' }], feedTotal: 5 })
    expect(amazonFeedPlacement({})).toEqual({})
    expect(amazonFeedPlacement({ feedMessages: [{ messageId: 0, sku: 'B1' }], feedTotal: 5 })).toEqual({})
    expect(amazonFeedPlacement({ feedMessages: [{ messageId: 3, sku: 'B1' }], feedTotal: 0 })).toEqual({})
  })
})
