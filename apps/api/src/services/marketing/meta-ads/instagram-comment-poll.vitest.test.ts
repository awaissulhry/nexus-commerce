/**
 * Meta step 37 — the Instagram comment poll on a real PostgreSQL with the production schema and every business policy
 * (PGlite), business profiles ON. Meta is stubbed at metaCall (the gateway's read gate is proven in gateway/*).
 *
 * Proven here: the first poll of an account records where it stands and tells nobody; a media whose comment count went up
 * gets its comments read (ids and times only) until one no newer than the last seen, and ONE notice per media — the count,
 * the media id and its link, never a comment's words or a person's name, username or id (none is stored either); a media
 * posted since the last poll counts from it; a media no longer among the newest 25 loses its row; a refused or failed read
 * writes nothing and tells nobody; the brake switches it off; and one business never sees or drops another's rows.
 * Made-up ids and names (public repo).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { withWorkspace } from '../../../lib/workspace-context.js'

type Answer = { ok: boolean; status: number; body: unknown; verdict?: { errorClass: string; channelCode: string; channelMessage: string } }
const h = vi.hoisted(() => ({
  calls: [] as Array<{ operation: string; path: string; query: Record<string, unknown>; connectionId: string | null; triggeredBy?: string }>,
  media: {} as Record<string, Array<Record<string, unknown>>>,
  comments: {} as Record<string, Array<Record<string, unknown>>>,
  fail: null as null | ((path: string) => Answer | null),
}))

vi.mock('../../gateway/meta.js', async (importOriginal) => ({
  metaUrl: (await importOriginal<typeof import('../../gateway/meta.js')>()).metaUrl,
  metaCall: vi.fn(async (req: { operation: string; path: string; query?: Record<string, unknown>; connectionId: string | null; triggeredBy?: string }) => {
    h.calls.push({ operation: req.operation, path: req.path, query: req.query ?? {}, connectionId: req.connectionId, triggeredBy: req.triggeredBy })
    const failed = h.fail?.(req.path)
    const a: Answer = failed ?? (req.path.endsWith('/media')
      ? { ok: true, status: 200, body: { data: h.media[req.path.split('/')[0]] ?? [] } }
      : req.path.endsWith('/comments')
        ? { ok: true, status: 200, body: { data: h.comments[req.path.split('/')[0]] ?? [] } }
        : { ok: false, status: 404, body: {}, verdict: { errorClass: 'not_found', channelCode: '100/33', channelMessage: 'unknown in the stub' } })
    return { ok: a.ok, status: a.status, headers: new Headers(), verdict: a.ok ? null : a.verdict ?? null, url: req.path, json: () => a.body }
  }),
}))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))

import { igCommentPollSwitchedOff, IG_COMMENTS_HREF, IG_COMMENTS_NOTICE, metaTime, pollInstagramComments } from './instagram-comment-poll.js'

const A = 'ig_poll_alpha'
const B = 'ig_poll_bravo'
const C = 'ig_poll_charlie'
const IG_A = '170000000000010'
const IG_B = '170000000000020'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const notices: Array<Record<string, unknown>> = []
const notify = async (n: Record<string, unknown>) => { notices.push(n); return { created: 1 } }
const at = (iso: string) => () => new Date(iso)
const media = (id: string, count: number, timestamp = '2026-10-01T10:00:00+0000') => ({ id, timestamp, comments_count: count, permalink: `https://www.instagram.com/p/${id.slice(-6)}/` })
const comment = (id: string, timestamp: string) => ({ id, timestamp })
const rowsOf = (ws: string) => withWorkspace(scope(ws), () => db().metaInstagramCommentPoll.findMany({ orderBy: { mediaId: 'asc' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B, C]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
  await database.db.query(`INSERT INTO "UserProfile" (id, email, "updatedAt") VALUES ('u-poll-a', 'a@example.com', CURRENT_TIMESTAMP)`)
  await database.db.query(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", "updatedAt") VALUES ('m-poll-a', $1, 'u-poll-a', CURRENT_TIMESTAMP)`, [A])
  for (const [ws, ig] of [[A, IG_A], [B, IG_B]] as const) {
    await withWorkspace(scope(ws), async () => {
      const c = await db().channelConnection.create({ data: { channelType: 'META', isActive: true, authStatus: 'connected', managedBy: 'oauth', externalAccountId: `1200000000009${ws === A ? '1' : '2'}` } })
      await db().metaAccountLink.create({ data: { connectionId: c.id, product: 'INSTAGRAM', externalId: ig, label: ws === A ? 'Shop A' : 'Shop B', selectedByUserId: 'u-1' } })
    })
  }
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

beforeEach(() => { h.calls.length = 0; h.fail = null; notices.length = 0 })

describe('the Instagram comment poll', () => {
  it('the first poll records where the media stand and tells nobody (one read)', async () => {
    h.media[IG_A] = [media('180000000000001', 3), media('180000000000002', 0)]
    const result = await inA(() => pollInstagramComments({ now: at('2026-10-21T08:00:00Z'), notify }))
    expect(result).toMatchObject({ status: 'done', media: 2, newComments: 0, notified: 0, calls: 1 })
    expect(h.calls).toEqual([expect.objectContaining({ operation: 'instagram.commentPollMedia', path: `${IG_A}/media`, query: { fields: 'id,timestamp,comments_count,total_comments_count,permalink', limit: 25 }, triggeredBy: 'cron' })])
    expect((await rowsOf(A)).map((r) => [r.mediaId, r.commentsCount, r.newestCommentAt])).toEqual([['180000000000001', 3, null], ['180000000000002', 0, null]])
    expect(notices).toEqual([])
  })

  it('a count that went up: its comments (ids and times only) newer than the last poll, ONE notice — no words, no person', async () => {
    h.media[IG_A] = [media('180000000000001', 5), media('180000000000002', 0)]
    h.comments['180000000000001'] = [comment('190000000000005', '2026-10-21T08:10:00+0000'), comment('190000000000004', '2026-10-21T08:05:00+0000'), comment('190000000000003', '2026-10-21T07:00:00+0000')]
    const result = await inA(() => pollInstagramComments({ now: at('2026-10-21T08:15:00Z'), notify }))
    expect(result).toMatchObject({ status: 'done', newComments: 2, notified: 1, calls: 2 })
    expect(h.calls[1]).toMatchObject({ operation: 'instagram.commentPollComments', path: '180000000000001/comments', query: { fields: 'id,timestamp', limit: 50 } })
    expect(notices).toEqual([{
      type: IG_COMMENTS_NOTICE, severity: 'info', href: IG_COMMENTS_HREF,
      title: '2 new Instagram comments on a post of Shop A',
      body: expect.stringMatching(/^Instagram media 180000000000001 \(https:\/\/www\.instagram\.com\/p\/000001\/\): at least 2 new comments or replies since 2026-10-21 08:00 UTC\. .*Nexus keeps no comment's words or author\.$/),
      meta: { instagramId: IG_A, mediaId: '180000000000001', newComments: 2, permalink: 'https://www.instagram.com/p/000001/' },
    }])
    const rows = await rowsOf(A)
    expect(rows[0]).toMatchObject({ mediaId: '180000000000001', commentsCount: 5, newestCommentAt: new Date('2026-10-21T08:10:00Z'), polledAt: new Date('2026-10-21T08:15:00Z') })
    // Nothing of a person in any stored column.
    expect(Object.keys(rows[0]).sort()).toEqual(['commentsCount', 'connectionId', 'createdAt', 'id', 'instagramId', 'mediaId', 'newestCommentAt', 'polledAt', 'updatedAt', 'workspaceId'])
  })

  it('the next poll counts only what is newer than the newest seen; replies count by Meta\'s count; the same count tells nobody', async () => {
    h.media[IG_A] = [media('180000000000001', 7), media('180000000000002', 0)]
    // One new top-level comment and one new reply (Meta's count +2; the top-level read shows one).
    h.comments['180000000000001'] = [comment('190000000000006', '2026-10-21T08:20:00+0000'), comment('190000000000005', '2026-10-21T08:10:00+0000')]
    const result = await inA(() => pollInstagramComments({ now: at('2026-10-21T08:30:00Z'), notify }))
    expect(result).toMatchObject({ newComments: 2, notified: 1 })
    expect(notices[0]).toMatchObject({ title: '2 new Instagram comments on a post of Shop A', body: expect.stringContaining('since 2026-10-21 08:10 UTC') })
    notices.length = 0
    expect(await inA(() => pollInstagramComments({ now: at('2026-10-21T08:45:00Z'), notify }))).toMatchObject({ newComments: 0, notified: 0, calls: 1 })
    expect(notices).toEqual([])
  })

  it('a media posted since the last poll counts from it; a media no longer among the newest is dropped', async () => {
    h.media[IG_A] = [media('180000000000003', 1, '2026-10-21T08:50:00+0000'), media('180000000000001', 7)]
    h.comments['180000000000003'] = [comment('190000000000010', '2026-10-21T08:55:00+0000')]
    const result = await inA(() => pollInstagramComments({ now: at('2026-10-21T09:00:00Z'), notify }))
    expect(result).toMatchObject({ newComments: 1, notified: 1 })
    expect(notices[0]).toMatchObject({ title: '1 new Instagram comment on a post of Shop A', body: expect.stringContaining('a new comment or reply since 2026-10-21 08:45 UTC') })
    expect((await rowsOf(A)).map((r) => r.mediaId)).toEqual(['180000000000001', '180000000000003'])
  })

  it('a refused or failed read writes nothing and tells nobody (the media list, or one media\'s comments)', async () => {
    const before = JSON.stringify(await rowsOf(A))
    h.media[IG_A] = [media('180000000000003', 4, '2026-10-21T08:50:00+0000'), media('180000000000001', 9)]
    h.fail = (path) => (path.endsWith('/media') ? { ok: false, status: 400, body: {}, verdict: { errorClass: 'rate_limited', channelCode: '4', channelMessage: 'Application request limit reached' } } : null)
    expect(await inA(() => pollInstagramComments({ now: at('2026-10-21T09:15:00Z'), notify }))).toMatchObject({ status: 'failed', line: expect.stringMatching(/^not read, nothing written/) })
    h.fail = (path) => (path === '180000000000001/comments' ? { ok: false, status: 400, body: {}, verdict: { errorClass: 'auth', channelCode: '10', channelMessage: 'Application does not have permission' } } : null)
    h.comments['180000000000003'] = [comment('190000000000011', '2026-10-21T09:10:00+0000')]
    expect(await inA(() => pollInstagramComments({ now: at('2026-10-21T09:15:00Z'), notify }))).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(await rowsOf(A))).toBe(before)
    expect(notices).toEqual([])
  })

  it('review fixes B2 / A1 — no list, media without counts: failed, nothing written; an empty list writes nothing and drops no row', async () => {
    const before = JSON.stringify(await rowsOf(A))
    const answers: unknown[] = [{}, { data: null }, { data: [{ id: '180000000000001', timestamp: '2026-10-01T10:00:00+0000' }, { id: '180000000000003' }] }]
    for (const body of answers) {
      h.fail = (path) => (path.endsWith('/media') ? { ok: true, status: 200, body } : null)
      expect(await inA(() => pollInstagramComments({ now: at('2026-10-21T09:20:00Z'), notify })), JSON.stringify(body)).toMatchObject({ status: 'failed', line: expect.stringMatching(/^not read, nothing written/) })
    }
    h.fail = (path) => (path.endsWith('/media') ? { ok: true, status: 200, body: { data: [] } } : null)
    expect(await inA(() => pollInstagramComments({ now: at('2026-10-21T09:20:00Z'), notify }))).toMatchObject({ status: 'done', line: expect.stringMatching(/no media: nothing written/) })
    expect(JSON.stringify(await rowsOf(A))).toBe(before)
    expect(notices).toEqual([])
  })

  it('review fix B2 — the count of every surface (total_comments_count) first; comments_count where Meta gives no total; a media without a count keeps its row', async () => {
    const before = await rowsOf(A)
    const row1 = before.find((r) => r.mediaId === '180000000000001')!
    h.media[IG_A] = [
      // A boosted copy's comments count in the total: +2 on media 1 (its plain count did not move).
      { ...media('180000000000001', row1.commentsCount), total_comments_count: row1.commentsCount + 2 },
      // Media 3 listed without any count: its row stays as it was.
      { id: '180000000000003', timestamp: '2026-10-21T08:50:00+0000' },
    ]
    h.comments['180000000000001'] = []
    const result = await inA(() => pollInstagramComments({ now: at('2026-10-21T09:25:00Z'), notify }))
    expect(result).toMatchObject({ status: 'done', newComments: 2, notified: 1 })
    expect(h.calls[0].query).toMatchObject({ fields: 'id,timestamp,comments_count,total_comments_count,permalink' })
    const after = await rowsOf(A)
    expect(after.find((r) => r.mediaId === '180000000000001')!.commentsCount).toBe(row1.commentsCount + 2)
    expect(JSON.stringify(after.find((r) => r.mediaId === '180000000000003'))).toBe(JSON.stringify(before.find((r) => r.mediaId === '180000000000003')))
    notices.length = 0
    // Meta refuses the total field (100, a field not on this node): read once without it, compared on the plain count.
    h.calls.length = 0
    h.fail = (path) => (path.endsWith('/media') && h.calls.length === 1 ? { ok: false, status: 400, body: {}, verdict: { errorClass: 'invalid', channelCode: '100', channelMessage: 'Tried accessing nonexisting field (total_comments_count)' } } : null)
    h.media[IG_A] = [media('180000000000001', row1.commentsCount + 2), media('180000000000003', 1, '2026-10-21T08:50:00+0000')]
    expect(await inA(() => pollInstagramComments({ now: at('2026-10-21T09:30:00Z'), notify }))).toMatchObject({ status: 'done', newComments: 0 })
    expect(h.calls.map((c) => c.query.fields)).toEqual(['id,timestamp,comments_count,total_comments_count,permalink', 'id,timestamp,comments_count,permalink'])
  })

  it('one business never sees or drops another\'s rows; a business without an Instagram account makes no call', async () => {
    h.media[IG_B] = [media('180000000000101', 2)]
    expect(await inB(() => pollInstagramComments({ now: at('2026-10-21T09:30:00Z'), notify }))).toMatchObject({ status: 'done', media: 1 })
    expect((await rowsOf(B)).map((r) => r.mediaId)).toEqual(['180000000000101'])
    expect((await rowsOf(A)).map((r) => r.mediaId)).toEqual(['180000000000001', '180000000000003'])
    h.calls.length = 0
    expect(await withWorkspace(scope(C), () => pollInstagramComments({ notify }))).toMatchObject({ status: 'none' })
    expect(h.calls).toEqual([])
  })

  it('the existing notice writes the bell row of the business\'s active members — the count and the media, nothing of a person', async () => {
    h.media[IG_A] = [media('180000000000003', 2, '2026-10-21T08:50:00+0000'), media('180000000000001', 7)]
    h.comments['180000000000003'] = [comment('190000000000012', '2026-10-21T09:40:00+0000')]
    const result = await inA(() => pollInstagramComments({ now: at('2026-10-21T09:45:00Z') }))
    expect(result).toMatchObject({ newComments: 1, notified: 1 })
    const rows = await inA(() => db().notification.findMany({ where: { type: IG_COMMENTS_NOTICE } }))
    expect(rows).toEqual([expect.objectContaining({ userId: 'u-poll-a', severity: 'info', title: '1 new Instagram comment on a post of Shop A', href: IG_COMMENTS_HREF })])
    expect(await inB(() => db().notification.count({ where: { type: IG_COMMENTS_NOTICE } }))).toBe(0)
  })

  it('the brake: NEXUS_META_IG_COMMENT_POLL=off, or Meta\'s reads off — no call, nothing written', async () => {
    for (const [key, value] of [['NEXUS_META_IG_COMMENT_POLL', 'off'], ['NEXUS_META_IG_COMMENT_POLL', '0'], ['NEXUS_META_ADS_SYNC', 'off']] as const) {
      vi.stubEnv(key, value)
      expect(igCommentPollSwitchedOff()).toBe(true)
      expect(await inA(() => pollInstagramComments({ notify }))).toMatchObject({ status: 'off' })
      vi.stubEnv(key, '')
    }
    expect(igCommentPollSwitchedOff()).toBe(false)
    expect(h.calls).toEqual([])
    expect(metaTime('2026-10-21T09:15:02+0000')?.toISOString()).toBe('2026-10-21T09:15:02.000Z')
  })
})
