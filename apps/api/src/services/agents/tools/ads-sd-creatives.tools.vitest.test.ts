/**
 * SD creatives (2026-10-20) — ad-creatives, ad-assets, set-ad-creative and upload-ad-asset, run for real through the door,
 * the approval gate and the change record (PGlite, production schema; the job queue a stub; the ads write gate the real
 * one, sandbox unless a test goes live). Amazon is a fake behind the Ads client's `liveCall`, answering in the SD 3.0 and
 * Creative assets 3.0 shapes (Creative, CreativeModeration, the 207 CreativeResponse, the preview, caAsset, the upload
 * location and the registration); the photo fetch and the storage PUT are stubbed. Fake ids, names and ASINs only.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { seedAdsFixture } from '../../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    readinessQueue: queue, agentPlanQueue: null, queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})

type Row = Record<string, any>
/** The fake Amazon: creatives, their moderation, ad groups' creative types and the asset library. */
const fake = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; body: any }>,
  creatives: new Map<string, Record<string, any>>(),
  moderation: new Map<string, Record<string, any>>(),
  groupTypes: new Map<string, string>(),
  assets: new Map<string, Record<string, any>>(),
  refuseNext: null as Record<string, unknown> | null,
  nextId: 400000000100,
  photos: new Map<string, { width: number; height: number }>(),
}))

/** A PNG header Amazon and image-size read: the signature and an IHDR chunk with the size. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.writeUInt8(8, 8); ihdr.writeUInt8(6, 9)
  const length = Buffer.alloc(4); length.writeUInt32BE(13, 0)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), length, Buffer.from('IHDR'), ihdr, Buffer.alloc(4), Buffer.alloc(64)])
}

vi.mock('../../images/photo-from-url.service.js', async (original) => ({
  ...(await original<object>()),
  fetchPhoto: async (link: string) => {
    const size = fake.photos.get(link)
    if (!size) throw new Error('The link answered HTTP 404.')
    const buffer = png(size.width, size.height)
    return { buffer, mimeType: 'image/png', bytes: buffer.byteLength, contentHash: createHash('sha256').update(buffer).digest('hex'), host: 'photos.example.test', url: link }
  },
}))

vi.mock('../../advertising/ads-api-client.js', async (original) => {
  const actual = await original<typeof import('../../advertising/ads-api-client.js')>()
  const refusal = () => { const r = fake.refuseNext; fake.refuseNext = null; return r }
  return {
    ...actual,
    liveCall: async (opts: { method: string; path: string; body?: any }) => {
      fake.calls.push({ method: opts.method, path: opts.path, body: opts.body })
      const url = new URL(`https://ads.test${opts.path}`)
      const ids = (name: string) => (url.searchParams.get(name) ?? '').split(',').filter(Boolean)
      const named = (c: Row) => ids('adGroupIdFilter').includes(String(c.adGroupId)) || ids('creativeIdFilter').includes(String(c.creativeId))
      const route = `${opts.method} ${url.pathname}`
      if (route === 'GET /sd/creatives') return [...fake.creatives.values()].filter(named).map((c) => structuredClone(c))
      if (route === 'GET /sd/moderation/creatives') return [...fake.creatives.values()].filter(named).map((c) => ({ creativeType: c.creativeType, moderationStatus: c.moderationStatus, policyViolations: [], ...(fake.moderation.get(String(c.creativeId)) ?? {}), creativeId: c.creativeId }))
      if (route === 'GET /sd/adGroups') return ids('adGroupIdFilter').map((id) => ({ adGroupId: Number(id), creativeType: fake.groupTypes.get(id) }))
      if (route === 'POST /sd/creatives') {
        const refused = refusal()
        if (refused) return [refused]
        const item = opts.body[0]
        const creativeId = fake.nextId++
        fake.creatives.set(String(creativeId), { creativeId, adGroupId: item.adGroupId, creativeType: item.creativeType, properties: item.properties, moderationStatus: 'PENDING_REVIEW' })
        return [{ code: 'SUCCESS', creativeId }]
      }
      if (route === 'PUT /sd/creatives') {
        const refused = refusal()
        if (refused) return [{ ...refused, creativeId: opts.body[0].creativeId }]
        const item = opts.body[0]
        Object.assign(fake.creatives.get(String(item.creativeId))!, { properties: item.properties, moderationStatus: 'PENDING_REVIEW' })
        return [{ code: 'SUCCESS', creativeId: item.creativeId }]
      }
      if (route === 'POST /sd/creatives/preview') return { previewHtml: '&lt;div class="ad"&gt;preview&lt;/div&gt;' }
      if (route === 'GET /assets') {
        const a = fake.assets.get(url.searchParams.get('assetId')!)
        if (!a) throw Object.assign(new Error('[ADS-LIVE] GET /assets → 400: {"message":"Asset not found"}'), { statusCode: 400, body: '{"message":"Asset not found"}' })
        return { assetGlobal: { assetId: a.assetId, assetType: a.assetType }, assetVersionList: a.versions.map((v: Row, i: number) => ({ assetIdentifier: { assetId: a.assetId, version: v.version }, creationTime: 1_760_000_000_000 + i, assetStatus: 'ACTIVE', fileMetadata: v.file })) }
      }
      if (route === 'POST /assets/search') return { totalRecords: fake.assets.size, assetList: [...fake.assets.values()].map((a) => ({ assetId: a.assetId, assetType: a.assetType, assetSubTypes: a.subTypes, status: 'ACTIVE', name: a.name, version: a.versions.at(-1).version, fileMetadata: a.versions.at(-1).file })), token: null }
      if (route === 'POST /assets/upload') return { url: 'https://test-bucket.s3.amazonaws.com/upload.png?X-Amz-Signature=fake' }
      if (route === 'POST /assets/register') return { assetId: 'amzn1.assetlibrary.asset1.testupload01', versionId: 'version_v1' }
      throw new Error(`the fake Amazon has no ${route}`)
    },
  }
})

import { callTool, type UserPrincipal } from '../call-tool.js'
import { decideApproval, runOrQueueTool } from '../approval-gate.service.js'
import { undoRequestFor } from '../change-record.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = (userId: string, via: 'claude' | 'app'): UserPrincipal => ({
  kind: 'user', userId, label: `Person ${userId}`, via, workspace: business, permissions: { isOwner: false, permissions: EVERYTHING },
})
const claude = person('u-asker', 'claude')
const approver = person('u-approver', 'app')
const preview = async (tool: string, args: Record<string, unknown>) => (await inside(() => callTool(claude, tool, args))).raw as Row
async function ask(tool: string, args: Record<string, unknown>) {
  return inside(async () => {
    const run = await database.client.agentRun.create({ data: { agentKey: 'mcp', trigger: 'manual', status: 'done', via: 'claude', userId: claude.userId } })
    return runOrQueueTool(tool, args, claude, run.id, { forceAsk: true })
  }) as Promise<Row>
}
const approve = (approvalId: string) => inside(() => decideApproval(approvalId, 'approve', approver)) as Promise<Row>
const sql = <T = Row>(text: string, params: unknown[] = []) => inside(async () => (await database.client.$queryRawUnsafe(text, ...params)) as T[])
const live = () => vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
const writes = () => fake.calls.filter((c) => c.method !== 'GET' && !c.path.endsWith('/preview') && !c.path.endsWith('/search'))

const LOGO_ID = 'amzn1.assetlibrary.asset1.testlogo0001'
const SMALL_LOGO_ID = 'amzn1.assetlibrary.asset1.testlogo0002'
const IMAGE_ID = 'amzn1.assetlibrary.asset1.testimage001'
const VIDEO_ID = 'amzn1.assetlibrary.asset1.testvideo001'
const LOGO = { assetId: LOGO_ID, assetVersion: 'version_v1' }

/** Amazon's state before each test: g-sd (IMAGE) has an approved creative; g-sdv is VIDEO; g-sd2 has none. */
function amazonAsBefore() {
  fake.calls = []; fake.refuseNext = null; fake.creatives.clear(); fake.moderation.clear(); fake.assets.clear(); fake.photos.clear()
  fake.creatives.set('400000000001', { creativeId: 400000000001, adGroupId: 300000000101, creativeType: 'IMAGE', properties: { headline: 'Ride dry', originalHeadline: 'Ride dry', brandLogo: LOGO }, moderationStatus: 'APPROVED' })
  fake.groupTypes.set('300000000101', 'IMAGE'); fake.groupTypes.set('300000000102', 'VIDEO'); fake.groupTypes.set('300000000103', 'IMAGE')
  const asset = (assetId: string, assetType: string, subTypes: string[], versions: Array<{ version: string; file: Row }>) => fake.assets.set(assetId, { assetId, assetType, subTypes, name: `asset ${assetId.slice(-4)}`, versions })
  asset(LOGO_ID, 'IMAGE', ['LOGO'], [{ version: 'version_v1', file: { width: 1200, height: 200, fileSize: 50_000, contentType: 'image/png' } }])
  asset(SMALL_LOGO_ID, 'IMAGE', ['LOGO'], [{ version: 'version_v1', file: { width: 500, height: 100, fileSize: 20_000, contentType: 'image/png' } }])
  asset(IMAGE_ID, 'IMAGE', ['LIFESTYLE_IMAGE'], [
    { version: 'version_v1', file: { width: 1200, height: 628, fileSize: 400_000, contentType: 'image/jpeg' } },
    { version: 'version_v3', file: { width: 2400, height: 1600, fileSize: 900_000, contentType: 'image/jpeg' } },
  ])
  asset(VIDEO_ID, 'VIDEO', ['BACKGROUND_VIDEO'], [{ version: 'version_v1', file: { width: 1920, height: 1080, contentType: 'mp4' } }])
}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await seedAdsFixture(db)
    // A Sponsored Display campaign (born paused, off the live-write allowlist) with three ad groups; SD 3.0 takes ids as numbers.
    await db.campaign.create({
      data: { id: 'c-sd', name: 'Test display', type: 'SD', adProduct: 'SPONSORED_DISPLAY', marketplace: 'IT', externalCampaignId: '100000000301', dailyBudget: '10.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: false, costType: 'cpc', status: 'PAUSED' } as never,
    })
    await db.adGroup.create({ data: { id: 'g-sd', campaignId: 'c-sd', name: 'Display group', externalAdGroupId: '300000000101', creativeType: 'IMAGE' } })
    await db.adGroup.create({ data: { id: 'g-sdv', campaignId: 'c-sd', name: 'Display video group', externalAdGroupId: '300000000102', creativeType: 'VIDEO' } })
    await db.adGroup.create({ data: { id: 'g-sd2', campaignId: 'c-sd', name: 'Display new group', externalAdGroupId: '300000000103' } })
    await db.adProductAd.create({ data: { adGroupId: 'g-sd', asin: 'B0FXTEST01', sku: 'TEST-SKU-1' } })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await database?.close() }, 30_000)
beforeEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); amazonAsBefore() })

describe('ad-creatives', () => {
  it('sandbox reads nothing from Amazon; a campaign that is not Sponsored Display is refused by name', async () => {
    const r = await preview('ad-creatives', { campaignId: 'c-sd' })
    expect(r).toMatchObject({ ok: true, data: { items: [], note: expect.stringMatching(/sandbox/) } })
    expect((await preview('ad-creatives', { campaignId: 'c-it' })).error).toMatch(/^Italy exact is a Sponsored Products campaign\. Creatives here are Sponsored Display's/)
    expect((await preview('ad-creatives', {})).error).toMatch(/Name the campaignId/)
    expect(fake.calls).toEqual([])
  })

  it('live: each ad group\'s creative with its parts, its type and Amazon\'s moderation in words', async () => {
    live()
    fake.creatives.get('400000000001')!.moderationStatus = 'REJECTED'
    fake.moderation.set('400000000001', { moderationStatus: 'REJECTED', policyViolations: [{ policyDescription: 'Superlative claims', violatingHeadlineContents: [{ reviewedText: 'Ride dry', textEvidence: [{ violatingText: 'dry' }] }] }] })
    const r = await preview('ad-creatives', { campaignId: 'c-sd' })
    expect(r.ok, r.error).toBe(true)
    const byGroup = Object.fromEntries((r.data.items as Row[]).map((i) => [i.adGroupId, i]))
    expect(byGroup['g-sd']).toMatchObject({
      creativeType: 'IMAGE',
      creative: {
        creativeId: '400000000001', headline: 'Ride dry', brandLogo: `asset ${LOGO_ID} (version_v1)`,
        moderation: { status: 'REJECTED', words: expect.stringMatching(/^rejected by Amazon/), reasons: ['Superlative claims — headline "Ride dry": "dry"'] },
        properties: { headline: 'Ride dry', brandLogo: LOGO },
      },
    })
    expect(byGroup['g-sdv']).toMatchObject({ creativeType: 'VIDEO', creative: null, note: expect.stringMatching(/^No custom creative/) })
    expect(r.data.counts).toEqual({ adGroups: 3, withCreative: 1, approved: 0, inReview: 0, rejected: 1 })
    const moderation = fake.calls.find((c) => c.path.startsWith('/sd/moderation/creatives'))!
    expect(new URL(`https://x${moderation.path}`).searchParams.get('language')).toBe('en-IT')
  })

  it('live: view preview renders the creative for the ad group\'s product, and gives the HTML unescaped', async () => {
    live()
    const r = await preview('ad-creatives', { adGroupId: 'g-sd', view: 'preview', size: '728x90' })
    expect(r.data).toMatchObject({ asin: 'B0FXTEST01', html: '<div class="ad">preview</div>', previewOf: 'creative 400000000001 as it is at Amazon' })
    expect(fake.calls.find((c) => c.path === '/sd/creatives/preview')!.body).toEqual({
      creative: { creativeType: 'IMAGE', properties: { headline: 'Ride dry', brandLogo: LOGO } },
      previewConfiguration: { size: { width: 728, height: 90 }, products: [{ asin: 'B0FXTEST01' }], isMobile: false, isOnAmazon: true },
    })
  })
})

describe('set-ad-creative', () => {
  it('sandbox: a new creative is previewed and recorded in Nexus only; refusals are not queued', async () => {
    const r = await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', headline: 'Ride dry', brandLogo: { assetId: LOGO_ID, assetVersion: 'version_v1' } })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      op: 'create', reach: { reach: 'sandbox' }, creativeId: null,
      send: { creativeType: 'IMAGE', creativeId: null, properties: { headline: 'Ride dry', brandLogo: { assetId: LOGO_ID, assetVersion: 'version_v1' } } },
      changes: { headline: { from: null, to: '"Ride dry"' } },
    })
    expect(r.preview.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/assets were not read/)]))
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-c-it', headline: 'Ride dry' })).error).toMatch(/^Italy exact is a Sponsored Products campaign/)
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', headline: 'x'.repeat(51) })).error).toBe('Not queued: the headline is 51 characters; Amazon takes at most 50.')
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', brandLogo: { assetId: LOGO_ID } })).error).toMatch(/give assetVersion/)
    expect((await preview('set-ad-creative', { op: 'update', adGroupId: 'g-sd', headline: 'x' })).error).toMatch(/op create only/)
    const refused = await ask('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', headline: 'Ride dry!' })
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/"!"/) })
    expect(refused.approvalId).toBeUndefined()

    const asked = await ask('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', headline: 'Ride dry' })
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { mode: 'sandbox', creativeId: expect.stringMatching(/^sandbox-creative-/) } })
    expect(fake.calls).toEqual([])
  })

  it('live: a headline change shows from → to, sends the whole creative as Amazon\'s PUT, records it, and undo puts the old one back', async () => {
    live()
    expect((await preview('set-ad-creative', { op: 'update', adGroupId: 'g-sd', headline: 'Ride dry' })).error).toBe('Nothing would change: creative 400000000001 already shows exactly this.')
    const args = { op: 'update', adGroupId: 'g-sd', headline: 'Stay dry all winter', why: 'test' }
    const r = await preview('set-ad-creative', args)
    expect(r.ok, r.error).toBe(true)
    expect(r.preview).toMatchObject({
      creativeId: '400000000001', reach: { reach: 'live', profileId: 'P-IT-TEST' }, moderationNow: expect.stringMatching(/^approved/),
      changes: { headline: { from: '"Ride dry"', to: '"Stay dry all winter"' } },
      summary: expect.stringMatching(/^Changes creative 400000000001 of ad group "Display group" of Sponsored Display campaign "Test display" \(IT\): headline "Ride dry" → "Stay dry all winter"\.$/),
    })
    expect(r.preview.effect).toMatch(/changes no bid, budget or on\/off state/)
    expect(r.preview.effect).not.toMatch(/SPENDS MONEY/)
    const asked = await ask('set-ad-creative', args)
    fake.calls = []
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { op: 'update', creativeId: '400000000001', mode: 'live' } })
    expect(writes()).toEqual([{ method: 'PUT', path: '/sd/creatives', body: [{ creativeId: 400000000001, creativeType: 'IMAGE', properties: { headline: 'Stay dry all winter', brandLogo: LOGO } }] }])
    const [audit] = await sql(`SELECT "actionType", "entityType", "entityId", "userId", "amazonResponseStatus" FROM "AdvertisingActionLog" WHERE "executionId" = $1`, [asked.approvalId])
    expect(audit).toEqual({ actionType: 'update_sd_creative', entityType: 'AD_GROUP', entityId: 'g-sd', userId: 'user:u-approver', amazonResponseStatus: 'SUCCESS' })
    const undo = await inside(() => undoRequestFor({ approvalId: asked.approvalId })) as Row
    expect(undo.request).toEqual({ tool: 'set-ad-creative', args: { op: 'update', adGroupId: 'g-sd', properties: { headline: 'Ride dry', brandLogo: LOGO }, why: 'Undo: puts back the creative as it was before the change.' }, undoes: expect.any(String) })
    // Amazon now reviews it: a creative in review is not changed, and the request is not queued.
    expect((await preview('set-ad-creative', { op: 'update', adGroupId: 'g-sd', headline: 'Another one' })).error).toMatch(/^Amazon is reviewing creative 400000000001 \(in review at Amazon/)
  })

  it('live: undo is refused once the creative moved at Amazon; a new creative is not undone (Amazon has no delete)', async () => {
    live()
    const asked = await ask('set-ad-creative', { op: 'update', adGroupId: 'g-sd', headline: 'Stay dry' })
    await approve(asked.approvalId)
    fake.creatives.get('400000000001')!.properties.headline = 'Changed in the console'
    expect(((await inside(() => undoRequestFor({ approvalId: asked.approvalId }))) as Row).error).toMatch(/^Not undone: it has changed since this change ran/)

    const made = await ask('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', headline: 'Ride dry' })
    expect(await approve(made.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { op: 'create', creativeId: '400000000100' } })
    expect(writes().at(-1)).toEqual({ method: 'POST', path: '/sd/creatives', body: [{ adGroupId: 300000000103, creativeType: 'IMAGE', properties: { headline: 'Ride dry' } }] })
    expect(((await inside(() => undoRequestFor({ approvalId: made.approvalId }))) as Row).error).toMatch(/Amazon has no way to delete a creative/)
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', headline: 'Again' })).error).toMatch(/already has creative 400000000100 .*ask with op update/)
  })

  it('live: the ad group\'s creative type decides — no video in IMAGE, a video in VIDEO (of a VIDEO asset)', async () => {
    live()
    expect((await preview('set-ad-creative', { op: 'update', adGroupId: 'g-sd', video: { assetId: VIDEO_ID } })).error).toMatch(/creative type is IMAGE/)
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sdv', headline: 'Ride dry' })).error).toMatch(/creative type is VIDEO: Amazon needs a video/)
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sdv', video: { assetId: LOGO_ID } })).error).toBe(`Not queued: video: asset ${LOGO_ID} is an image, not a video.`)
    const ok = await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sdv', video: { assetId: VIDEO_ID } })
    expect(ok.preview).toMatchObject({ send: { creativeType: 'VIDEO', properties: { video: { assetId: VIDEO_ID, assetVersion: 'version_v1' } } } })
  })

  it('live: assets are read and held to Amazon\'s rules; a custom image gets its newest version and the largest centred crops', async () => {
    live()
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', brandLogo: { assetId: SMALL_LOGO_ID } })).error).toBe(`Not queued: brandLogo: asset ${SMALL_LOGO_ID} is 500 × 100 pixels; a brand logo must be at least 600 × 100.`)
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', brandLogo: { assetId: 'amzn1.assetlibrary.asset1.testmissing1' } })).error).toMatch(/Nexus could not read it from Amazon: Amazon answered HTTP 400: Asset not found/)
    const r = await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', headline: 'Ride dry', customImage: { assetId: IMAGE_ID } })
    expect(r.ok, r.error).toBe(true)
    expect(r.preview.send.properties).toEqual({
      headline: 'Ride dry',
      rectCustomImage: { assetId: IMAGE_ID, assetVersion: 'version_v3', croppingCoordinates: { left: 0, top: 172, width: 2400, height: 1256 } },
      squareCustomImage: { assetId: IMAGE_ID, assetVersion: 'version_v3', croppingCoordinates: { left: 400, top: 0, width: 1600, height: 1600 } },
    })
    expect((await preview('set-ad-creative', { op: 'create', adGroupId: 'g-sd2', customImage: { assetId: IMAGE_ID, squareCrop: { left: 0, top: 0, width: 600, height: 600 } } })).error).toMatch(/squareCustomImage: the squareCustomImage crop is 600 × 600; Amazon needs at least 628 × 628/)
  })

  it('live: Amazon\'s refusal reaches the person in its words; the request waits again and the audit says FAILED', async () => {
    live()
    const asked = await ask('set-ad-creative', { op: 'update', adGroupId: 'g-sd', headline: 'Stay dry' })
    fake.refuseNext = { code: 'INVALID_ARGUMENT', description: 'Headline violates the brand guidelines' }
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, status: 'pending', error: 'Not run: Amazon refused it — amazon_rejected: INVALID_ARGUMENT — Headline violates the brand guidelines. Nothing changed at Amazon.' })
    const [audit] = await sql(`SELECT "amazonResponseStatus" FROM "AdvertisingActionLog" WHERE "executionId" = $1`, [asked.approvalId])
    expect(audit.amazonResponseStatus).toBe('FAILED')
  })

  it('live: what was approved moved at Amazon → not run; writes not enabled for the profile → not queued', async () => {
    live()
    const asked = await ask('set-ad-creative', { op: 'update', adGroupId: 'g-sd', headline: 'Stay dry' })
    fake.creatives.get('400000000001')!.properties.brandLogo = { assetId: SMALL_LOGO_ID, assetVersion: 'version_v1' }
    fake.calls = []
    expect(await approve(asked.approvalId)).toMatchObject({ ok: false, status: 'pending', error: expect.stringMatching(/^Not run: what you approved has moved since — basis, send changed/) })
    expect(writes()).toEqual([])

    await inside(() => database.client.amazonAdsConnection.updateMany({ where: { marketplace: 'IT' }, data: { writesEnabledAt: null } }))
    try {
      expect((await preview('set-ad-creative', { op: 'update', adGroupId: 'g-sd', headline: 'Stay dry' })).error).toMatch(/^Not queued: Amazon's write gate refuses it — writes are not enabled for this Amazon Ads profile/)
    } finally {
      await inside(() => database.client.amazonAdsConnection.updateMany({ where: { marketplace: 'IT' }, data: { writesEnabledAt: new Date() } }))
    }
  })
})

describe('ad-assets and upload-ad-asset', () => {
  it('live: lists the library with what each asset fits', async () => {
    live()
    const r = await preview('ad-assets', { market: 'IT', kind: 'logo' })
    expect(fake.calls[0]).toMatchObject({ method: 'POST', path: '/assets/search', body: { filterCriteria: { valueFilters: [{ valueField: 'ASSET_TYPE', values: ['IMAGE'] }, { valueField: 'ASSET_SUB_TYPE', values: ['LOGO'] }] }, pageCriteria: { size: 25 } } })
    const fits = Object.fromEntries((r.data.items as Row[]).map((a) => [a.assetId, a.fits]))
    expect(fits).toMatchObject({ [LOGO_ID]: ['brandLogo'], [SMALL_LOGO_ID]: [], [IMAGE_ID]: ['brandLogo', 'customImage'], [VIDEO_ID]: ['video'] })
    expect((await preview('ad-assets', { market: 'XX' })).error).toMatch(/No Amazon Ads profile serves XX/)
  })

  it('live: an upload is checked now, and on approval sends exactly those bytes: upload location, storage, registration', async () => {
    live()
    fake.photos.set('https://photos.example.test/logo.png', { width: 1200, height: 200 })
    fake.photos.set('https://photos.example.test/small.png', { width: 500, height: 100 })
    expect((await preview('upload-ad-asset', { market: 'IT', use: 'brandLogo', url: 'https://photos.example.test/small.png' })).error).toBe('Not queued: the photo is 500 × 100 pixels; a brand logo must be at least 600 × 100.')
    expect((await preview('upload-ad-asset', { market: 'IT', use: 'customImage', subType: 'LOGO', url: 'https://photos.example.test/logo.png' })).error).toMatch(/use brandLogo for a logo/)
    const r = await preview('upload-ad-asset', { market: 'IT', use: 'brandLogo', url: 'https://photos.example.test/logo.png' })
    expect(r.preview).toMatchObject({ reach: { reach: 'live', profileId: 'P-IT-TEST' }, file: { width: 1200, height: 200, mimeType: 'image/png' }, send: { subType: 'LOGO', fileName: expect.stringMatching(/^nexus_logo_[0-9a-f]{10}\.png$/) } })
    expect(r.preview.warnings[0]).toMatch(/cannot be undone/)

    const put = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', put)
    const asked = await ask('upload-ad-asset', { market: 'IT', use: 'brandLogo', url: 'https://photos.example.test/logo.png' })
    fake.calls = []
    expect(await approve(asked.approvalId)).toMatchObject({ ok: true, status: 'executed', result: { assetId: 'amzn1.assetlibrary.asset1.testupload01', versionId: 'version_v1', mode: 'live' } })
    expect(fake.calls.map((c) => c.path)).toEqual(['/assets/upload', '/assets/register'])
    expect(fake.calls[1].body).toMatchObject({ assetType: 'IMAGE', assetSubTypeList: ['LOGO'], skipAssetSubTypesDetection: true, name: r.preview.send.name })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0]).toBe('https://test-bucket.s3.amazonaws.com/upload.png?X-Amz-Signature=fake')
    expect(((await inside(() => undoRequestFor({ approvalId: asked.approvalId }))) as Row).error).toMatch(/cannot be undone/)
  })
})
