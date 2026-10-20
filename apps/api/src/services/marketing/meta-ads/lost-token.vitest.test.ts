/**
 * Meta step 2, review A2 and B4 — what a failed read means.
 *   - Only a token that is gone is "auth lost": a held call because Nexus could not read the stored token, the app secret
 *     or its KMS key is Nexus's own problem, never "a new token is needed".
 *   - A good token (credentials replaced, or "Check now" valid) ends a read that lost the token: its status is cleared and
 *     a read is queued at once (TOKEN), outside the hourly limit of "Read now".
 *   - Meta's "too much at once" codes ask for fewer days; 100/3191001 is a permission refusal.
 * The database, the targets and the read are stubbed; made-up ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  accounts: [] as Array<{ adAccountId: string; connectionId: string; lastSyncStatus: string | null }>,
  updates: [] as Array<Record<string, unknown>>,
  reads: [] as Array<{ adAccountId: string; kind: string }>,
}))
vi.mock('../../../db.js', () => ({
  default: {
    metaAdAccount: {
      findMany: vi.fn(async ({ where }: { where: { connectionId: string; lastSyncStatus: string } }) => h.accounts.filter((a) => a.connectionId === where.connectionId && a.lastSyncStatus === where.lastSyncStatus)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.updates.push(data); return {} }),
      findUnique: vi.fn(async () => null),
    },
  },
}))
vi.mock('./targets.js', () => ({ listMetaReadTargets: vi.fn(async () => h.accounts.map((a) => ({ connectionId: a.connectionId, adAccountId: a.adAccountId }))) }))
vi.mock('./sync.service.js', () => ({ syncMetaAdAccountById: vi.fn(async (adAccountId: string, kind: string) => { h.reads.push({ adAccountId, kind }); return {} }) }))

import { GatewayRefusal } from '../../gateway/gateway.js'
import { failureOfAnswer, failureOfThrow } from './errors.js'
import { metaAdsSyncJobId, metaReadAfterGoodToken } from './enqueue.js'

beforeEach(() => { h.accounts = []; h.updates = []; h.reads = [] })

describe('auth lost is a token that is gone, nothing else', () => {
  it('a held call for a KMS, stored-token or app-secret read failure is not auth lost; a sign-in needed is', () => {
    const held = (code: string, message: string) => failureOfThrow(new GatewayRefusal('held', code, message, 409))!
    expect(held('META_TOKEN_UNAVAILABLE', 'Held, nothing sent: the stored Meta token of this account could not be read (KMS decrypt failed).').authLost).toBe(false)
    expect(held('META_APP_SECRET_UNAVAILABLE', 'Held, nothing sent: the Meta app secret could not be read.').authLost).toBe(false)
    expect(held('TOKEN_UNAVAILABLE', 'Held, nothing sent: no Meta token for this account (CredentialsDecryptError: KMS unavailable).').authLost).toBe(false)
    expect(held('TOKEN_UNAVAILABLE', 'Held, nothing sent: no Meta token for this account (connection needs_reauth).').authLost).toBe(true)
    expect(held('ACCOUNT_NEEDS_SIGNIN', 'Held, nothing sent: the Meta account needs to be reconnected.').authLost).toBe(true)
    // Either way the run stops: the gateway refused, nothing can work this run.
    expect(held('META_TOKEN_UNAVAILABLE', 'x').origin).toBe('gateway')
  })
})

describe('review B4 — Meta\'s codes the read acts on', () => {
  it('an insights timeout or data limit asks for fewer days; 100/3191001 is a permission refusal', () => {
    for (const code of ['100/1504018', '2/1504038', '100/1487534']) {
      expect(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: code, channelMessage: 'x' } as never })).toMatchObject({ shrink: true, permissionDenied: false })
    }
    expect(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: '100/3191001', channelMessage: 'x' } as never })).toMatchObject({ permissionDenied: true })
    expect(failureOfAnswer({ status: 400, verdict: { errorClass: 'validation', channelCode: '100', channelMessage: 'x' } as never }).shrink).toBeUndefined()
  })
})

describe('review A2 — a good token ends a read that lost the token', () => {
  it('clears AUTH_LOST and reads at once (TOKEN), only for that connection\'s account', async () => {
    h.accounts = [
      { adAccountId: '1234567890', connectionId: 'conn-1', lastSyncStatus: 'AUTH_LOST' },
      { adAccountId: '1234567891', connectionId: 'conn-2', lastSyncStatus: 'AUTH_LOST' },
    ]
    await metaReadAfterGoodToken('conn-1')
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.updates).toEqual([{ lastSyncStatus: null, lastSyncError: null }])
    expect(h.reads).toEqual([{ adAccountId: '1234567890', kind: 'TOKEN' }])
  })
  it('nothing to do when the last read did not lose the token; never throws', async () => {
    h.accounts = [{ adAccountId: '1234567890', connectionId: 'conn-1', lastSyncStatus: 'SUCCESS' }]
    await expect(metaReadAfterGoodToken('conn-1')).resolves.toBeUndefined()
    expect(h.updates).toEqual([])
  })
  it('a TOKEN read has its own job id per minute (outside the hourly "Read now" id)', () => {
    const at = new Date('2026-10-20T10:15:30Z')
    expect(metaAdsSyncJobId('TOKEN', '1234567890', at)).not.toBe(metaAdsSyncJobId('MANUAL', '1234567890', at))
    expect(metaAdsSyncJobId('TOKEN', '1234567890', at)).toContain('2026-10-20T10-15')
  })
})
