/**
 * MCP full control L11 (decision d6) — add-photo-from-url and its way back, remove-unused-photo, through the one door
 * (call-tool.ts), against a real PostgreSQL with the production schema and business-isolation policies (PGlite).
 *
 * Proven here: the dry run fetches and checks the link but stores nothing; the run stores the approved bytes (Cloudinary)
 * and appends the photo where an upload goes — the family root's library on the media plan, else the product's own
 * gallery — as the approver; bytes that changed since the approval, a photo already there, an http link, a private host
 * and a missing photo store are refused; the undo removes the photo again (only while nothing uses it), and the removal's
 * undo adds it back from its stored file.
 *
 * No real network or Cloudinary: DNS answers and pages are planted (example.test hosts), the store is faked.
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const state = vi.hoisted(() => ({
  db: null as any,
  dns: new Map<string, string[]>(),
  pages: new Map<string, { status: number; headers?: Record<string, string>; body?: Buffer }>(),
  uploads: [] as Array<{ folder: string; bytes: number }>,
  stored: true,
}))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...(await original<object>()), default: state.db.client }
})
vi.mock('../../listing-events.service.js', () => ({ publishListingEvent: () => undefined }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: async () => undefined, emitTx: async () => undefined } }))
vi.mock('../../cloudinary.service.js', () => ({
  isCloudinaryConfigured: () => state.stored,
  uploadBufferToCloudinary: async (buffer: Buffer, options: { folder: string }) => {
    state.uploads.push({ folder: options.folder, bytes: buffer.byteLength })
    const n = state.uploads.length
    return { url: `https://res.cloudinary.example.test/${options.folder}/${n}.png`, publicId: `${options.folder}/${n}`, width: 64, height: 64, format: 'png', bytes: buffer.byteLength }
  },
  deleteFromCloudinary: async () => true,
}))
function fakeGet(url: URL, options: { lookup?: (...args: any[]) => void }, callback: (response: any) => void) {
  const request = Object.assign(new EventEmitter(), { destroy(error?: Error) { if (error) queueMicrotask(() => request.emit('error', error)) } })
  options.lookup?.(url.hostname, {}, () => undefined)
  queueMicrotask(() => {
    const p = state.pages.get(url.toString()) ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') }
    callback(Object.assign(Readable.from(p.body ? [p.body] : []), { statusCode: p.status, headers: p.headers ?? {} }))
  })
  return request
}
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>()
  const lookup = async (hostname: string) => {
    const answers = state.dns.get(hostname) ?? (/^[\d.]+$|:/.test(hostname) ? [hostname] : undefined)
    if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  return { ...real, default: { ...real, lookup }, lookup }
})
vi.mock('node:https', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:https')>()
  return { ...real, default: { ...real, get: fakeGet }, get: fakeGet }
})

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import { movedFieldNames } from '../../agent-fleet/approval-inbox.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({
  kind: 'user', userId, label: userId,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business, via: 'claude',
})
const claude = person('u-l11-asker')
const approver = person('u-l11-approver')
type Json = Record<string, any>
const db = () => state.db.client

const dryRun = async (tool: string, args: Json) => (await inside(() => callTool(claude, tool, args))).raw as Json
const run = async (tool: string, args: Json, preview: Json) => (await inside(() => executeTool(approver, tool, args, { approvedPreview: JSON.parse(JSON.stringify(preview)), via: 'claude' }))).raw as Json
const photos = (productId: string) => inside(() => db().productImage.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' } }))

/**
 * A 64×64 PNG split in two halves (left/right or top/bottom), so the two pictures differ by their perceptual hashes too.
 * `edited`: a small corner patch lighter — other bytes, the same picture by both perceptual hashes (a near duplicate).
 */
async function halves(split: 'vertical' | 'horizontal', edited = false) {
  const raw = Buffer.alloc(64 * 64 * 3)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const value = edited && x < 4 && y < 4 ? 60 : (split === 'vertical' ? x < 32 : y < 32) ? 20 : 235
    raw.fill(value, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3)
  }
  return sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer()
}
const plant = (path: string, body: Buffer, type = 'image/png') => state.pages.set(`https://photos.example.test${path}`, { status: 200, headers: { 'content-type': type }, body })

const ids: Record<string, string> = {}
const png: Record<string, Buffer> = {}

beforeAll(async () => {
  png.a = await halves('vertical')
  png.b = await halves('horizontal')
  png.edited = await halves('vertical', true)
  await inside(async () => {
    ids.root = (await db().product.create({ data: { sku: 'TEST-SKU-L11', name: 'L11 jacket', basePrice: 10, isParent: true } })).id
    ids.child = (await db().product.create({ data: { sku: 'TEST-SKU-L11-S', name: 'L11 jacket S', basePrice: 10, parentId: ids.root } })).id
    ids.off = (await db().product.create({ data: { sku: 'TEST-SKU-L11-OFF', name: 'L11 other', basePrice: 10 } })).id
    ids.front = (await db().productImage.create({ data: { productId: ids.root, url: 'https://images.example.test/l11/front.jpg', alt: 'front', type: 'MAIN', sortOrder: 0, width: 1600, height: 1600 } })).id
    await db().productMediaPlan.create({ data: { productId: ids.root, layer: 'SHARED', plan: { version: 1, sets: { common: [{ assetId: ids.front }] } } } })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => {
  state.pages.clear(); state.uploads.length = 0; state.stored = true
  state.dns.set('photos.example.test', ['93.184.216.34'])
  state.dns.set('intranet.example.test', ['10.0.0.5'])
})

describe('add-photo-from-url', () => {
  it('previews by fetching and checking the link, storing nothing; runs as approved, into the family library; its undo removes it', async () => {
    plant('/a.png', png.a)
    const args = { productId: ids.child, url: 'https://photos.example.test/a.png', label: 'Jacket, back' }
    const preview = await dryRun('add-photo-from-url', args)
    expect(preview.preview).toMatchObject({ family: { productId: ids.root, sku: 'TEST-SKU-L11' }, place: 'library', host: 'photos.example.test',
      mimeType: 'image/png', bytes: png.a.byteLength, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(state.uploads).toEqual([])
    expect(await photos(ids.root)).toHaveLength(1)

    const ran = await run('add-photo-from-url', args, preview.preview)
    expect(ran.ok, ran.error).toBe(true)
    expect(state.uploads).toEqual([{ folder: `product-images/${ids.root}`, bytes: png.a.byteLength }])
    const added = (await photos(ids.root)).find((p: Json) => p.id === ran.data.photoId)
    expect(added).toMatchObject({ alt: 'Jacket, back', type: 'ALT', sortOrder: 1, mimeType: 'image/png', contentHash: preview.preview.contentHash })
    expect(added.perceptualHash).toBeTruthy()

    const tool = getTool('add-photo-from-url')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    const undo = tool.undo!.request(ran.change) as Json
    expect(undo).toEqual({ tool: 'remove-unused-photo', args: { productId: ids.root, photoId: ran.data.photoId } })
    const removal = await dryRun('remove-unused-photo', undo.args)
    expect(removal.preview).toMatchObject({ photo: { photoId: ran.data.photoId, label: 'Jacket, back' } })
    const removed = await run('remove-unused-photo', undo.args, removal.preview)
    expect(removed.ok, removed.error).toBe(true)
    expect((await photos(ids.root)).map((p: Json) => p.id)).toEqual([ids.front])
    const remover = getTool('remove-unused-photo')!
    expect(await inside(() => remover.undo!.current(removed.change))).toEqual(removed.change.after)
    expect(remover.undo!.request(removed.change)).toEqual({ tool: 'add-photo-from-url', args: { productId: ids.root, url: added.url, label: 'Jacket, back' } })
  })

  it('refuses bytes that changed since the approval, and a photo already there (naming it)', async () => {
    plant('/b.png', png.b)
    const args = { productId: ids.root, url: 'https://photos.example.test/b.png' }
    const preview = await dryRun('add-photo-from-url', args)
    plant('/b.png', png.a)
    expect(await run('add-photo-from-url', args, preview.preview)).toMatchObject({ ok: false, error: expect.stringContaining('changed since') })
    expect(state.uploads).toEqual([])

    plant('/b.png', png.b)
    const ran = await run('add-photo-from-url', args, (await dryRun('add-photo-from-url', args)).preview)
    expect(ran.ok, ran.error).toBe(true)
    plant('/again.png', png.b)
    expect((await dryRun('add-photo-from-url', { productId: ids.child, url: 'https://photos.example.test/again.png' })).error).toContain(ran.data.photoId)
  })

  it('refuses an http link, a private host and a missing photo store before anything is stored', async () => {
    plant('/a.png', png.a)
    expect((await dryRun('add-photo-from-url', { productId: ids.root, url: 'http://photos.example.test/a.png' })).error).toContain('https://')
    expect((await dryRun('add-photo-from-url', { productId: ids.root, url: 'https://intranet.example.test/a.png' })).error).toContain('public internet address')
    state.stored = false
    expect((await dryRun('add-photo-from-url', { productId: ids.root, url: 'https://photos.example.test/a.png' })).error).toContain('Cloudinary')
    expect(state.uploads).toEqual([])
  })

  it('a product off the media plan gets the photo in its own gallery', async () => {
    plant('/off.png', png.a)
    const args = { productId: ids.off, url: 'https://photos.example.test/off.png' }
    const preview = await dryRun('add-photo-from-url', args)
    expect(preview.preview).toMatchObject({ family: { productId: ids.off, sku: 'TEST-SKU-L11-OFF' }, place: 'gallery' })
    const ran = await run('add-photo-from-url', args, preview.preview)
    expect(ran.ok, ran.error).toBe(true)
    expect((await photos(ids.off)).map((p: Json) => p.id)).toEqual([ran.data.photoId])
  })
})

describe('add-photo-from-url — a near duplicate (an edited version) on purpose: allowNearDuplicate', () => {
  const near = (name: string, extra: Json = {}) => ({ productId: ids.near, url: `https://photos.example.test/near/${name}.png`, ...extra })
  const original: Json = {}
  /** Previews asked before the original was there: nothing looked like them yet. */
  const asked: Json = {}
  beforeAll(async () => {
    ids.near = (await inside(() => db().product.create({ data: { sku: 'TEST-SKU-L11-NEAR', name: 'L11 near', basePrice: 10 } }))).id
  })
  beforeEach(() => { plant('/near/original.png', png.a); plant('/near/edited.png', png.edited); plant('/near/copy.png', png.a) })

  it('without it a near duplicate is refused, naming the photo it looks like and how to add it on purpose', async () => {
    asked.edited = (await dryRun('add-photo-from-url', near('edited', { allowNearDuplicate: true }))).preview
    asked.copy = (await dryRun('add-photo-from-url', near('copy', { allowNearDuplicate: true }))).preview
    expect(asked.edited).toMatchObject({ similar: null })
    expect(asked.edited.note).not.toContain('Looks like')
    const args = near('original', { label: 'Jacket, with hood' })
    const preview = (await dryRun('add-photo-from-url', args)).preview
    expect(preview).not.toHaveProperty('similar')
    const added = await run('add-photo-from-url', args, preview)
    expect(added.ok, added.error).toBe(true)
    Object.assign(original, added.data)

    const refused = await dryRun('add-photo-from-url', near('edited'))
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining(`already there (photo ${original.photoId}, a near duplicate). Nothing was queued.`) })
    expect(refused.error).toContain('allowNearDuplicate: true')
    expect(await run('add-photo-from-url', near('edited'), asked.edited)).toMatchObject({ ok: false, error: expect.stringContaining(`photo ${original.photoId}`) })
    expect(state.uploads).toHaveLength(1)
    expect(await photos(ids.near)).toHaveLength(1)
  })

  it('with it the preview names the photo it looks like, and the run adds it as a separate photo', async () => {
    const args = near('edited', { allowNearDuplicate: true })
    const preview = (await dryRun('add-photo-from-url', args)).preview
    expect(preview).toMatchObject({ similar: { photoId: original.photoId, url: original.url, label: 'Jacket, with hood' }, contentHash: asked.edited.contentHash })
    expect(preview.note).toContain(`Looks like photo ${original.photoId} already there ("Jacket, with hood", ${original.url}); it is added as a separate photo`)

    // A request approved before the original was there did not say what it looks like: the approval gate hands it back
    // (the similarity is material), and the run refuses it too.
    expect(movedFieldNames('add-photo-from-url', asked.edited, preview)).toEqual(['similar'])
    expect(await run('add-photo-from-url', args, asked.edited)).toMatchObject({ ok: false,
      error: expect.stringContaining(`now looks like photo ${original.photoId}, which the approved request did not say`) })
    expect(state.uploads).toEqual([])

    const ran = await run('add-photo-from-url', args, preview)
    expect(ran.ok, ran.error).toBe(true)
    expect(ran.data.photoId).not.toBe(original.photoId)
    expect(state.uploads).toHaveLength(1)
    expect((await photos(ids.near)).map((p: Json) => [p.id, p.contentHash])).toEqual([[original.photoId, asked.copy.contentHash], [ran.data.photoId, preview.contentHash]])
  })

  it('the same file is still refused with it, in the preview and in the run', async () => {
    const args = near('copy', { allowNearDuplicate: true })
    expect(await dryRun('add-photo-from-url', args)).toMatchObject({ ok: false, error: expect.stringContaining(`already there (photo ${original.photoId}, the same file: it is never added twice)`) })
    expect(await run('add-photo-from-url', args, asked.copy)).toMatchObject({ ok: false, error: expect.stringContaining(`already there (photo ${original.photoId})`) })
    expect(state.uploads).toEqual([])
    expect(await photos(ids.near)).toHaveLength(2)
  })
})

describe('remove-unused-photo', () => {
  it('refuses a photo something uses, and one from another product', async () => {
    expect((await dryRun('remove-unused-photo', { productId: ids.root, photoId: ids.front })).error).toContain('photo plan places it')
    const other = await inside(() => db().productImage.create({ data: { productId: ids.off, url: 'https://images.example.test/l11/other.jpg', type: 'ALT' } }))
    expect((await dryRun('remove-unused-photo', { productId: ids.root, photoId: other.id })).error).toContain('not one of this product\'s photos')
  })
})
