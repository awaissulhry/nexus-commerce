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

/** A 64×64 PNG split in two halves (left/right or top/bottom), so the two pictures differ by their perceptual hashes too. */
async function halves(split: 'vertical' | 'horizontal') {
  const raw = Buffer.alloc(64 * 64 * 3)
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) raw.fill((split === 'vertical' ? x < 32 : y < 32) ? 20 : 235, (y * 64 + x) * 3, (y * 64 + x) * 3 + 3)
  return sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer()
}
const plant = (path: string, body: Buffer, type = 'image/png') => state.pages.set(`https://photos.example.test${path}`, { status: 200, headers: { 'content-type': type }, body })

const ids: Record<string, string> = {}
const png: Record<string, Buffer> = {}

beforeAll(async () => {
  png.a = await halves('vertical')
  png.b = await halves('horizontal')
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

describe('remove-unused-photo', () => {
  it('refuses a photo something uses, and one from another product', async () => {
    expect((await dryRun('remove-unused-photo', { productId: ids.root, photoId: ids.front })).error).toContain('photo plan places it')
    const other = await inside(() => db().productImage.create({ data: { productId: ids.off, url: 'https://images.example.test/l11/other.jpg', type: 'ALT' } }))
    expect((await dryRun('remove-unused-photo', { productId: ids.root, photoId: other.id })).error).toContain('not one of this product\'s photos')
  })
})
