import { describe, expect, it } from 'vitest'

/**
 * Sheet publish parity, step 6 — many families to one Amazon account and market share feeds.
 *
 * `planAmazonFeeds` (pure): whole publications per feed, message ids renumbered 1..n per feed, a split at the cap, a
 * seller SKU in two families refused for both. `sendAmazonMergedGroup` with every call replaced: a family whose message
 * Amazon's dry run refuses is FAILED and sends nothing while the others go on; every family's journal is written
 * before its feed exists; each family keeps its own place in the shared feed; a refusal before createFeed is FAILED and
 * a createFeed failure is UNVERIFIED.
 */
import type { StudioPublishResult } from '@nexus/shared/studio-publication'
import { AMAZON_FEED_MESSAGE_CAP, planAmazonFeeds, sendAmazonMergedGroup, type AmazonBatchDeps } from './studio-publication-amazon-batch.js'
import type { AmazonPublication } from './studio-publication-amazon.js'
import type { ClaimedPublication } from './studio-publication.service.js'

const message = (sku: string, messageId = 1) => ({ messageId, sku, operationType: 'PATCH', productType: 'COAT', patches: [{ op: 'replace', path: '/attributes/item_name', value: [] }] })
const part = (id: string, skus: string[], header: Record<string, unknown> = { sellerId: 'S', version: '2.0' }) =>
  ({ id, header, messages: skus.map((sku, index) => message(sku, index + 1)) })

describe('planAmazonFeeds', () => {
  it('keeps whole families in one feed and renumbers their messages 1..n', () => {
    const plan = planAmazonFeeds([part('a', ['A1', 'A2']), part('b', ['B1']), part('c', ['C1', 'C2', 'C3'])])
    expect(plan.refused).toEqual([])
    expect(plan.chunks).toHaveLength(1)
    expect(plan.chunks[0].feed.messages.map(m => [m.messageId, m.sku])).toEqual([[1, 'A1'], [2, 'A2'], [3, 'B1'], [4, 'C1'], [5, 'C2'], [6, 'C3']])
    expect(plan.chunks[0].parts).toEqual([
      { id: 'a', messages: [{ messageId: 1, sku: 'A1' }, { messageId: 2, sku: 'A2' }] },
      { id: 'b', messages: [{ messageId: 3, sku: 'B1' }] },
      { id: 'c', messages: [{ messageId: 4, sku: 'C1' }, { messageId: 5, sku: 'C2' }, { messageId: 6, sku: 'C3' }] },
    ])
  })

  it('starts a new feed before a family would cross the cap, and never splits a family', () => {
    const plan = planAmazonFeeds([part('a', ['A1', 'A2']), part('b', ['B1', 'B2']), part('c', ['C1'])], 3)
    expect(plan.chunks.map(chunk => chunk.parts.map(p => p.id))).toEqual([['a'], ['b', 'c']])
    expect(plan.chunks[1].feed.messages.map(m => m.messageId)).toEqual([1, 2, 3])
  })

  it('splits at 2,000 messages, the cap the old flat-file submit has used in production', () => {
    const big = (id: string, n: number) => part(id, Array.from({ length: n }, (_, i) => `${id}-${i}`))
    const plan = planAmazonFeeds([big('a', 1500), big('b', 1000), big('c', 500)])
    expect(AMAZON_FEED_MESSAGE_CAP).toBe(2000)
    expect(plan.chunks.map(chunk => [chunk.parts.map(p => p.id), chunk.feed.messages.length])).toEqual([[['a'], 1500], [['b', 'c'], 1500]])
  })

  it('refuses both families when they carry the same seller SKU', () => {
    const plan = planAmazonFeeds([part('a', ['SHARED', 'A2']), part('b', ['SHARED']), part('c', ['C1'])])
    expect(plan.refused.map(r => r.id)).toEqual(['a', 'b'])
    expect(plan.refused[0].reason).toContain('SHARED')
    expect(plan.chunks.map(chunk => chunk.parts.map(p => p.id))).toEqual([['c']])
  })

  it('refuses a family bigger than one feed and keeps different headers apart', () => {
    const plan = planAmazonFeeds([part('a', ['A1', 'A2', 'A3', 'A4']), part('b', ['B1'], { sellerId: 'OTHER' }), part('c', ['C1'])], 3)
    expect(plan.refused.map(r => r.id)).toEqual(['a'])
    expect(plan.chunks.map(chunk => chunk.parts.map(p => p.id))).toEqual([['b'], ['c']])
  })
})

function claim(id: string, skus: string[]): ClaimedPublication {
  const prepared: AmazonPublication = { kind: 'amazon', sellerId: 'S', marketplaceId: 'IT-ID', feed: { header: { sellerId: 'S', version: '2.0' }, messages: skus.map((sku, i) => message(sku, i + 1)) },
    products: skus.map(sku => ({ productId: `p-${sku}`, sku })) }
  return { productId: `family-${id}`, id, userId: 'u', data: { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acct' } }, input: {},
    plan: { facts: { scope: { channel: 'AMAZON', marketplace: 'IT', accountId: 'acct' } }, prepared } as never,
    destinationRow: { kind: 'studio-publication', productId: `family-${id}`, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'acct', aliasKey: '', batchId: 'b' } }
}

function fakeDeps(options: { refuse?: string; submitError?: Error & { notSent?: boolean } } = {}) {
  const log: string[] = []
  const finished = new Map<string, StudioPublishResult>()
  const checkpoints = new Map<string, { result: StudioPublishResult; data: Record<string, any> }>()
  const deps: AmazonBatchDeps = {
    checkStillValid: async c => { log.push(`valid:${c.id}`) },
    ensureDrafts: async c => { log.push(`drafts:${c.id}`) },
    sendQuantities: async (plan, destination) => { log.push(`quantities:${destination.marketplace}`); return plan },
    validate: async (plan, _account) => {
      for (const m of plan.feed.messages) if (m.sku === options.refuse) throw Object.assign(new Error(`${m.sku}: refused by Amazon`), { notSent: true })
      log.push(`validated:${plan.feed.messages.map(m => m.sku).join(',')}`)
    },
    record: async (c, request, refs) => { log.push(`journal:${c.id}:${refs.map(r => `${r.messageId}=${r.sku}`).join(',')}:${request.feed.messages.length}`) },
    submitFeed: async (plan, _account, beforeSend) => {
      await beforeSend({ feedType: 'JSON_LISTINGS_FEED', marketplaceIds: [plan.marketplaceId], feed: plan.feed })
      if (options.submitError) throw options.submitError
      log.push(`createFeed:${plan.feed.messages.length}`)
      return `FEED-${log.filter(entry => entry.startsWith('createFeed')).length}`
    },
    checkpoint: async (c, result) => { checkpoints.set(c.id, { result, data: { ...c.data } }) },
    finish: async (c, delivered) => { finished.set(c.id, delivered.result); return delivered.result },
  }
  return { deps, log, finished, checkpoints }
}

describe('sendAmazonMergedGroup', () => {
  it('sends the families of one market in one feed, each keeping its own place; the journal comes before the feed', async () => {
    const { deps, log, finished, checkpoints } = fakeDeps()
    await sendAmazonMergedGroup([claim('a', ['A1', 'A2']), claim('b', ['B1'])], deps)
    expect(log.indexOf('journal:a:1=A1,2=A2:3')).toBeLessThan(log.indexOf('createFeed:3'))
    expect(log.indexOf('journal:b:3=B1:3')).toBeLessThan(log.indexOf('createFeed:3'))
    expect(log.filter(entry => entry.startsWith('createFeed'))).toEqual(['createFeed:3'])
    expect(checkpoints.get('a')?.data).toMatchObject({ feedMessages: [{ messageId: 1, sku: 'A1' }, { messageId: 2, sku: 'A2' }], feedTotal: 3 })
    expect(checkpoints.get('b')?.data).toMatchObject({ feedMessages: [{ messageId: 3, sku: 'B1' }], feedTotal: 3 })
    expect(finished.get('a')).toMatchObject({ status: 'SUBMITTED', results: [{ sku: 'A1', reference: 'FEED-1' }, { sku: 'A2', reference: 'FEED-1' }] })
    expect(finished.get('b')?.results).toEqual([{ sku: 'B1', status: 'SUBMITTED', reference: 'FEED-1', message: 'Awaiting Amazon processing' }])
  })

  it('a family whose message Amazon refuses sends nothing; the other families still go', async () => {
    const { deps, log, finished } = fakeDeps({ refuse: 'B1' })
    await sendAmazonMergedGroup([claim('a', ['A1']), claim('b', ['B1', 'B2']), claim('c', ['C1'])], deps)
    expect(finished.get('b')).toMatchObject({ status: 'FAILED', message: 'Nothing was submitted. B1: refused by Amazon', results: [] })
    expect(log.some(entry => entry.startsWith('journal:b'))).toBe(false)
    expect(log).toContain('createFeed:2')
    expect(finished.get('a')?.status).toBe('SUBMITTED')
    expect(finished.get('c')).toMatchObject({ status: 'SUBMITTED', results: [{ sku: 'C1' }] })
  })

  it('refuses both families that share a seller SKU, and the rest still go', async () => {
    const { deps, finished } = fakeDeps()
    await sendAmazonMergedGroup([claim('a', ['SAME']), claim('b', ['SAME', 'B2']), claim('c', ['C1'])], deps)
    expect(finished.get('a')).toMatchObject({ status: 'FAILED' })
    expect(finished.get('b')?.message).toContain('SAME')
    expect(finished.get('c')?.status).toBe('SUBMITTED')
  })

  it('an upload refused before createFeed is FAILED; a createFeed failure is UNVERIFIED (Amazon may have it)', async () => {
    const refused = fakeDeps({ submitError: Object.assign(new Error('Amazon feed upload failed (503).'), { notSent: true }) })
    await sendAmazonMergedGroup([claim('a', ['A1']), claim('b', ['B1'])], refused.deps)
    expect(refused.finished.get('a')).toMatchObject({ status: 'FAILED', message: 'Nothing was submitted. Amazon feed upload failed (503).' })
    const interrupted = fakeDeps({ submitError: new Error('Connection interrupted') })
    await sendAmazonMergedGroup([claim('a', ['A1']), claim('b', ['B1'])], interrupted.deps)
    expect(interrupted.finished.get('b')).toMatchObject({ status: 'UNVERIFIED' })
    expect(interrupted.checkpoints.size).toBe(0)
  })

  it('Amazon sheet gaps: each family goes with the stock job\'s quantity (the step runs before the dry run) and the feed carries what it returned', async () => {
    const { deps, log } = fakeDeps()
    let submitted: AmazonPublication['feed'] | null = null
    deps.sendQuantities = async (plan) => { log.push('quantities'); return { ...plan, feed: { ...plan.feed, messages: plan.feed.messages.map(m => ({ ...m,
      attributes: { ...(m.attributes ?? {}), fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }] } })) } } }
    const submit = deps.submitFeed
    deps.submitFeed = async (plan, account, beforeSend) => { submitted = plan.feed; return submit(plan, account, beforeSend) }
    await sendAmazonMergedGroup([claim('a', ['A1'])], deps)
    expect(log.indexOf('quantities')).toBeLessThan(log.findIndex(e => e.startsWith('validated:')))
    expect((submitted as unknown as AmazonPublication['feed']).messages[0].attributes?.fulfillment_availability).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }])
  })

  it('refuses claims of different markets in one merged send', async () => {
    const other = claim('b', ['B1'])
    ;(other.plan.facts.scope as any).marketplace = 'DE'
    await expect(sendAmazonMergedGroup([claim('a', ['A1']), other], fakeDeps().deps)).rejects.toThrow('one Amazon account and market')
  })
})
