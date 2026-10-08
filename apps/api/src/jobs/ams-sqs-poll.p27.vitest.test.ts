/**
 * P2.7 — AMS messages are deduped, because the hourly write INCREMENTS.
 *
 * `ingestMarketingStream` upserts with an `update` that ADDS: Amazon sends corrections
 * as deltas, so that is correct for corrections and lethal for redeliveries. SQS is
 * at-least-once, the visibility timeout is 30 seconds, and a batch routes every record
 * to its own business profile — so a slow batch comes back while the first pass is
 * still applying, and the second pass adds the same spend, clicks and impressions
 * again. Nothing errors. The numbers are simply bigger.
 *
 * `pollAmsRaw` was discarding SQS's MessageId, which is the only thing that can tell a
 * redelivery from a new message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const recorded: any[] = []
const completed: any[] = []
const ingested: any[] = []
const deletedHandles: string[] = []
let queue: Array<{ receiptHandle: string; body: string; messageId: string; sentAt?: Date | null }> = []
const arrivals: Array<Date | undefined> = []
let nextWrite: any = { id: 'row-1', duplicate: false }

vi.mock('../services/ams-sqs.service.js', () => ({
  isAmsSqsConfigured: () => true,
  pollAmsRaw: async () => { const out = queue; queue = []; return out },
  deleteAmsMessage: async (h: string) => { deletedHandles.push(h) },
  parseAmsBody: (body: string) => JSON.parse(body),
}))
vi.mock('../services/cx/ingress/ledger.js', () => ({
  recordInbound: async (rec: any) => { recorded.push(rec); return nextWrite },
  completeInbound: async (id: any, ok: boolean, error?: string) => { completed.push({ id, ok, error }) },
  inboundNotRecorded: (result: { conflict?: string }) => result.conflict === 'identity_mismatch' ? 'the delivery ID is already bound to another account, event type or trust verdict' : 'the inbound ledger is unavailable',
}))
vi.mock('../lib/workspace-ingress.js', () => ({
  legacyIngress: (work: any) => work(),
  withIngressWorkspace: (_id: string, work: any) => work(),
  verifiedChannelWorkspace: async () => ({ workspaceId: 'ws-1', connectionId: 'conn-1' }),
}))
vi.mock('../services/advertising/ads-marketing-stream.service.js', () => ({
  ingestMarketingStream: async (rows: any[], opts: { arrivedAt?: Date } = {}) => { ingested.push(...rows); arrivals.push(opts.arrivedAt); return { received: rows.length, upserted: rows.length, skipped: 0 } },
}))
vi.mock('../services/advertising/ads-stream-change.service.js', () => ({
  ingestEntityChanges: async () => ({ campaigns: 0, adGroups: 0, targets: 0, unmatched: 0 }),
  ingestBudgetUsage: async () => ({ exhausted: 0, warning: 0 }),
}))
vi.mock('../services/ads-core/ams-dataset.js', () => ({
  amsRecordAdvertiser: (r: any) => String(r.profileId ?? ''),
  routeRecords: (records: any[]) => ({ performance: records, change: [], budget: [], unknown: [] }),
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_n: string, f: any) => f() }))

const { runAmsSqsPoll } = await import('./ams-sqs-poll.job.js')

const message = (id: string) => ({
  receiptHandle: `rh-${id}`, messageId: id,
  body: JSON.stringify([{ profileId: '111', dataset_id: 'sp-traffic', campaign_id: 'c1', impressions: 10, time_window_start: '2026-09-20T10:00:00Z' }]),
})

beforeEach(() => {
  recorded.length = 0; completed.length = 0; ingested.length = 0; deletedHandles.length = 0; arrivals.length = 0
  queue = []
  nextWrite = { id: 'row-1', duplicate: false }
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
})

describe('a message that has already been applied', () => {
  it('is acked and NOT ingested again', async () => {
    nextWrite = { id: 'row-1', duplicate: true, existingStatus: 'done' }
    queue = [message('m-1')]
    await runAmsSqsPoll()
    // The double-count this whole block exists to prevent. The write increments, so
    // ingesting a second time adds the same impressions again, silently.
    expect(ingested).toHaveLength(0)
    // Still acked, or it comes back forever.
    expect(deletedHandles).toEqual(['rh-m-1'])
  })

  it('IS ingested when the previous attempt failed — that is a retry, not a duplicate', async () => {
    nextWrite = { id: 'row-1', duplicate: true, existingStatus: 'failed' }
    queue = [message('m-2')]
    await runAmsSqsPoll()
    expect(ingested).toHaveLength(1)
  })
})

describe('a new message', () => {
  it('is recorded on the SQS message id, ingested, then closed out and acked', async () => {
    queue = [message('m-3')]
    await runAmsSqsPoll()
    expect(recorded[0]).toMatchObject({ channel: 'AMAZON_ADS', externalId: 'm-3', verifiedBy: 'sqs_iam', signatureOk: null })
    expect(ingested).toHaveLength(1)
    expect(completed[0]).toMatchObject({ id: 'row-1', ok: true })
    expect(deletedHandles).toEqual(['rh-m-3'])
  })

  it('BB-16 follow-up — hands the message\'s SQS SentTimestamp to the ingest as the arrival time; without one, none', async () => {
    const sentAt = new Date('2026-09-20T11:05:00Z')
    queue = [{ ...message('m-5'), sentAt }, { ...message('m-6'), sentAt: null }]
    await runAmsSqsPoll()
    expect(arrivals).toEqual([sentAt, undefined])
  })

  it('is NOT ingested and NOT acked when the ledger is unavailable', async () => {
    nextWrite = { id: null, duplicate: false }
    queue = [message('m-4')]
    await runAmsSqsPoll()
    // Without a row we cannot tell a redelivery from a new message, and with an
    // incrementing write that is the one place guessing is expensive. Leave it queued.
    expect(ingested).toHaveLength(0)
    expect(deletedHandles).toEqual([])
  })
})
