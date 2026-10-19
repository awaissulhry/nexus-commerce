/**
 * Amazon A+ content (2026-10-19) — the change tools as the approval gate uses them. Amazon and the photos are stand-ins
 * (aplus-client and aplus-images mocked: documents, ASIN relations and publish records kept in maps); the module rules,
 * documentHash and summarizeModules are the real ones (aplus-modules is pure).
 *
 * Held here: the preview of each op (its material fields, its basis, the Amazon behaviours it warns about, at most 20
 * lines); a change Amazon would refuse is never queued; the gate's re-check reads again without asking Amazon to check
 * twice; a run happens only as an approved request, only while Amazon publishing is live, and only when nothing it stands
 * on moved, in Amazon's order (upload → check → create → ASINs → read back); undo reads what is there now and asks for
 * the request that puts it back; nothing throws.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Doc { name: string; contentType: string; locale: string; contentModuleList: Array<Record<string, unknown>> }
interface Meta { name: string; marketplaceId: string; status: string; badgeSet: string[]; updateTime: string }
interface Rel { asin: string; badgeSet: string[]; parent: null; title: null; imageUrl: null; contentReferenceKeySet: string[] }

const h = vi.hoisted(() => {
  class AplusError extends Error {
    constructor(readonly code: string, message: string, readonly status = 400, readonly operation = 'aplus.test', readonly amazon: unknown[] = []) {
      super(message)
      this.name = 'AplusError'
    }
  }
  class AplusImageError extends Error {
    constructor(message: string, readonly key: string | null = null) {
      super(message)
      this.name = 'AplusImageError'
    }
  }
  return {
    AplusError,
    AplusImageError,
    mode: 'live',
    calls: [] as string[],
    docs: new Map<string, { document: Doc; meta: Meta }>(),
    relations: new Map<string, Rel[]>(),
    complete: true,
    records: new Map<string, Array<Record<string, unknown>>>(),
    resolve: vi.fn(),
    validate: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    postAsins: vi.fn(),
    submit: vi.fn(),
    suspend: vi.fn(),
    inspect: vi.fn(),
    upload: vi.fn(),
  }
})

const at = (t: { marketplaceId: string }, key: string) => `${t.marketplaceId}|${key}`

// The tool registry is imported (approval-inbox's MATERIAL_PREVIEW_FIELDS); no queue connection is opened for it.
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, agentPlanQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
vi.mock('../../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => h.mode }))
vi.mock('../../aplus/aplus-client.js', () => ({
  AplusError: h.AplusError,
  aplusErrorSentence: (error: unknown) => {
    if (!(error instanceof h.AplusError)) return 'Nexus could not reach Amazon.'
    return error.code === 'no_answer'
      ? 'Amazon did not answer; it may or may not have applied it — read it with aplus-content before asking again.'
      : `Amazon refused it: ${error.message}.`
  },
  resolveAplusMarket: h.resolve,
  getContentDocument: vi.fn(async (t: { marketplaceId: string }, key: string, data = 'CONTENTS,METADATA') => {
    h.calls.push(`get:${key}`)
    const doc = h.docs.get(at(t, key))
    if (!doc) throw new h.AplusError('not_found', 'Amazon has no such A+ document in this market', 404, 'aplus.getContentDocument')
    return { record: { contentReferenceKey: key, contentMetadata: structuredClone(doc.meta), contentDocument: data === 'METADATA' ? null : structuredClone(doc.document) }, warnings: [] }
  }),
  listAllAsinRelations: vi.fn(async (t: { marketplaceId: string }, key: string) => {
    h.calls.push(`asins:${key}`)
    return { asins: structuredClone(h.relations.get(at(t, key)) ?? []), complete: h.complete, warnings: [] }
  }),
  searchContentPublishRecords: vi.fn(async (_t: unknown, asin: string) => {
    h.calls.push(`records:${asin}`)
    return { records: structuredClone(h.records.get(asin) ?? []), nextPageToken: null, warnings: [] }
  }),
  aplusLiveState: vi.fn(async (t: { marketplaceId: string }, key: string) => {
    const doc = h.docs.get(at(t, key))
    const rel = h.relations.get(at(t, key)) ?? []
    return {
      status: doc?.meta.status ?? null, updateTime: doc?.meta.updateTime ?? null, asins: rel.map((r) => r.asin),
      publishedAsins: rel.filter((r) => r.badgeSet.includes('CONTENT_PUBLISHED')).map((r) => r.asin), complete: true,
    }
  }),
  validateContentDocumentAsinRelations: h.validate,
  createContentDocument: h.create,
  updateContentDocument: h.update,
  postContentDocumentAsinRelations: h.postAsins,
  postContentDocumentApprovalSubmission: h.submit,
  postContentDocumentSuspendSubmission: h.suspend,
  // The read tool's own calls (registered beside these tools): never reached here.
  searchContentDocuments: vi.fn(),
  listContentDocumentAsinRelations: vi.fn(),
}))

/** The photos' stand-in: inspected and uploaded by hash; the document gets each upload's id where its image was. */
vi.mock('../../aplus/aplus-images.js', async () => {
  const { factHash } = await import('../tool-types.js')
  const setAt = (root: Record<string, unknown>, path: string, value: unknown) => {
    const parts = path.match(/[^.[\]]+/g)!
    let node = root as Record<string, unknown>
    for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>
    node[parts[parts.length - 1]] = value
  }
  return {
    APLUS_MAX_NEW_IMAGES: 40,
    AplusImageError: h.AplusImageError,
    inspectAplusImages: h.inspect,
    uploadAplusImages: h.upload,
    finalizeAplusDocument: (doc: { name: string; contentType: string; locale: string; modules: Array<Record<string, unknown>>; images: Array<{ key: string; module: number; path: string; altText: string }> },
      images: Array<{ key: string; contentHash: string; crop: { width: number; height: number } }>, uploaded: Record<string, string>) => {
      const modules = structuredClone(doc.modules)
      for (const image of images) {
        const use = doc.images.find((u) => u.key === image.key)!
        const payloadKey = Object.keys(modules[use.module]).find((k) => k !== 'contentModuleType')!
        setAt(modules[use.module][payloadKey] as Record<string, unknown>, use.path, {
          uploadDestinationId: uploaded[image.contentHash], imageCropSpecification: { size: { width: { value: image.crop.width, units: 'pixels' }, height: { value: image.crop.height, units: 'pixels' } } }, altText: use.altText,
        })
      }
      return { name: doc.name, contentType: doc.contentType, locale: doc.locale, contentModuleList: modules }
    },
    planHashOf: (doc: { modules: unknown }, images: Array<{ contentHash: string; crop: unknown }>) => factHash({ modules: doc.modules, images: images.map((i) => ({ contentHash: i.contentHash, crop: i.crop })) }),
    imagesPreview: (images: Array<{ key: string; label: string; mimeType: string; bytes: number; width: number; height: number; crop: unknown; contentHash: string }>) =>
      images.map((i) => ({ key: i.key, source: i.label, mimeType: i.mimeType, bytes: i.bytes, width: i.width, height: i.height, crop: i.crop, contentHash: i.contentHash })),
  }
})

import { FEATURES as F } from '@nexus/shared/permissions'
import { documentHash, normalizeAmazonDocument } from '../../aplus/aplus-modules.js'
import { MATERIAL_PREVIEW_FIELDS } from '../../agent-fleet/approval-inbox.service.js'
import { factHash, type ToolContext } from '../tool-types.js'
import { APLUS_CHANGE_TOOLS } from './aplus-change.tools.js'

const tool = (name: string) => APLUS_CHANGE_TOOLS.find((t) => t.name === name)!
const asker: ToolContext = { can: () => true, via: 'claude', userId: 'u1' }
const recheck: ToolContext = { can: () => true, via: 'system', approvalId: 'ap-1' }
/** The request a person approved: the preview comes back as the approval stores it (jsonb). */
const approved = (preview: unknown): ToolContext => ({
  can: () => true, via: 'claude', userId: 'u-owner', approvalId: 'ap-1', approvedByPerson: true, decidedVia: 'nexus', approvedPreview: JSON.parse(JSON.stringify(preview)),
})
const parsed = (name: string, args: Record<string, unknown>) => tool(name).input.parse(args) as Record<string, unknown>
const ask = (name: string, args: Record<string, unknown>, ctx: ToolContext = asker) => tool(name).handler(parsed(name, args), ctx)
const run = (name: string, args: Record<string, unknown>, ctx: ToolContext) => tool(name).execute!(parsed(name, args), ctx)
const preview = async (name: string, args: Record<string, unknown>) => {
  const out = await ask(name, args)
  expect(out.error).toBeUndefined()
  return out.preview as Record<string, any>
}
const pick = (p: unknown, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, (p as Record<string, unknown>)[k]]))
const writes = () => h.calls.filter((c) => ['upload', 'validate', 'create', 'update', 'post-asins', 'submit', 'suspend'].includes(c))

// ── Amazon as it is ─────────────────────────────────────────────────────────────────────────────────────────────

const IT = { accountId: 'acc-1', marketplaceId: 'APJ6JRA9NG5V4', market: 'IT', marketName: 'Amazon.it', language: 'it', locale: 'it-IT' }
const DE = { accountId: 'acc-1', marketplaceId: 'A1PA6795UKMFR9', market: 'DE', marketName: 'Amazon.de', language: 'de', locale: 'de-DE' }
const UK = { accountId: 'acc-1', marketplaceId: 'A1F83G8C2ARO7P', market: 'UK', marketName: 'Amazon.co.uk', language: 'en', locale: 'en-GB' }
const MARKETS: Record<string, typeof IT> = { IT, DE, UK }
const KEY = 'k-demo-it'
const OTHER = 'k-old-it'
const UPDATED = '2026-10-18T10:00:00Z'

const crop = (w: number, h: number) => ({ size: { width: { value: w, units: 'pixels' }, height: { value: h, units: 'pixels' } }, offset: { x: { value: 0, units: 'pixels' }, y: { value: 0, units: 'pixels' } } })
const atAmazon = (id: string, altText: string) => ({ uploadDestinationId: id, imageCropSpecification: crop(800, 600), altText })
const imageText = (headline: string, image: Record<string, unknown>) => ({
  contentModuleType: 'PREMIUM_IMAGE_TEXT',
  premiumImageText: { positionType: 'LEFT', headline: { value: headline }, bodyText: { textList: [{ value: 'Rete traspirante su tutto il busto.' }] }, image },
})
const premiumText = (headline: string) => ({ contentModuleType: 'PREMIUM_TEXT', premiumText: { headline: { value: headline }, description: { textList: [{ value: 'Protezioni CE di livello 2 su spalle e gomiti.' }] } } })
const standardText = (body: string) => ({ contentModuleType: 'STANDARD_TEXT', standardText: { body: { textList: [{ value: body }] } } })
const demoDoc = (): Doc => ({ name: 'Demo IT', contentType: 'EBC', locale: 'it-IT', contentModuleList: [imageText('Rete traspirante', atAmazon('aplus-media/sc/one.jpg', 'Giacca Demo')), premiumText('Protezioni')] })
const meta = (status: string, name = 'Demo IT', badgeSet = ['PREMIUM'], marketplaceId = IT.marketplaceId): Meta => ({ name, marketplaceId, status, badgeSet, updateTime: UPDATED })
const rel = (asin: string, badgeSet: string[] = []): Rel => ({ asin, badgeSet, parent: null, title: null, imageUrl: null, contentReferenceKeySet: [] })
const A1 = 'B0DEMO0001'
const A2 = 'B0DEMO0002'
const A3 = 'B0DEMO0003'

function seed(status = 'APPROVED') {
  h.docs.set(at(IT, KEY), { document: demoDoc(), meta: meta(status) })
  h.docs.set(at(IT, OTHER), { document: { ...demoDoc(), name: 'Demo old' }, meta: meta('APPROVED', 'Demo old') })
  h.relations.set(at(IT, KEY), [rel(A1, ['CONTENT_PUBLISHED']), rel(A2, ['CONTENT_NOT_PUBLISHED'])])
}

beforeEach(() => {
  h.mode = 'live'
  h.calls.length = 0
  h.docs.clear()
  h.relations.clear()
  h.records.clear()
  h.complete = true
  for (const fn of [h.resolve, h.validate, h.create, h.update, h.postAsins, h.submit, h.suspend, h.inspect, h.upload]) fn.mockReset()
  h.resolve.mockImplementation(async ({ market, language }: { market: string; language?: string }) => {
    h.calls.push(`resolve:${market}`)
    const m = MARKETS[market]
    if (!m) return { error: `The Amazon market ${market} is not found in this business (business-overview lists its markets).` }
    return { ...m, ...(language ? { language, locale: `${language}-${m.market === 'UK' ? 'GB' : m.market}` } : {}), publishMode: h.mode }
  })
  h.validate.mockImplementation(async () => { h.calls.push('validate'); return { errors: [], warnings: [] } })
  h.create.mockImplementation(async (t: { marketplaceId: string }, document: Doc) => {
    h.calls.push('create')
    h.docs.set(at(t, 'NEW-KEY'), { document: structuredClone(document), meta: meta('DRAFT', document.name, ['PREMIUM'], t.marketplaceId) })
    return { contentReferenceKey: 'NEW-KEY', warnings: [] }
  })
  h.update.mockImplementation(async (t: { marketplaceId: string }, key: string, document: Doc) => {
    h.calls.push('update')
    h.docs.set(at(t, key), { document: structuredClone(document), meta: { ...h.docs.get(at(t, key))!.meta, name: document.name, status: 'DRAFT', updateTime: '2026-10-19T09:00:00Z' } })
    return { contentReferenceKey: key, warnings: [] }
  })
  h.postAsins.mockImplementation(async (t: { marketplaceId: string }, key: string, asins: string[]) => {
    h.calls.push('post-asins')
    const before = h.relations.get(at(t, key)) ?? []
    h.relations.set(at(t, key), asins.map((asin) => before.find((r) => r.asin === asin) ?? rel(asin, ['CONTENT_NOT_PUBLISHED'])))
    return { warnings: [] }
  })
  h.submit.mockImplementation(async (t: { marketplaceId: string }, key: string) => {
    h.calls.push('submit')
    h.docs.get(at(t, key))!.meta.status = 'SUBMITTED'
    return { warnings: [] }
  })
  h.suspend.mockImplementation(async (t: { marketplaceId: string }, key: string) => {
    h.calls.push('suspend')
    h.relations.set(at(t, key), (h.relations.get(at(t, key)) ?? []).map((r) => ({ ...r, badgeSet: r.badgeSet.filter((b) => b !== 'CONTENT_PUBLISHED') })))
    return { warnings: [] }
  })
  h.inspect.mockImplementation(async (uses: Array<{ key: string; source: { kind: string; assetId?: string; url?: string } }>) => {
    h.calls.push('inspect')
    return {
      images: uses.map((use) => ({
        key: use.key, source: use.source, label: use.source.assetId ?? use.source.url, mimeType: 'image/jpeg', bytes: 2_400_000, width: 1600, height: 1200,
        contentHash: `hash-${use.source.assetId ?? use.source.url}`, crop: { width: 1600, height: 1200, x: 0, y: 0 },
        warning: `The photo ${use.source.assetId ?? use.source.url} is 2.3 MB: Amazon advises at most 2 MB.`,
      })),
      problems: [],
    }
  })
  h.upload.mockImplementation(async (_t: unknown, images: Array<{ contentHash: string }>) => {
    h.calls.push('upload')
    return Object.fromEntries(images.map((i) => [i.contentHash, `aplus-media/sc/${i.contentHash}.jpg`]))
  })
})

describe('the three A+ change tools', () => {
  it('are changes a person approves in Nexus: alwaysAsk, ask at most, reaching Amazon, partly undone, their re-check fields declared', () => {
    const flags = { readOnly: false, alwaysAsk: true, openWorld: true, reversibility: 'partial', maxClaudeTrust: 'ask', category: 'listings' }
    expect(tool('set-aplus-content')).toMatchObject({ ...flags, riskTier: 'medium', requires: [F.aplusManage], title: 'Make or change Amazon A+ content' })
    expect(tool('set-aplus-asins')).toMatchObject({ ...flags, riskTier: 'high', requires: [F.aplusManage, F.marketingPublish], title: 'Set the ASINs of Amazon A+ content' })
    expect(tool('submit-aplus-content')).toMatchObject({ ...flags, riskTier: 'high', requires: [F.aplusManage, F.marketingPublish], title: 'Submit or suspend Amazon A+ content' })
    expect(MATERIAL_PREVIEW_FIELDS['set-aplus-content']).toEqual(['op', 'target', 'basis', 'plan', 'images', 'asins'])
    expect(MATERIAL_PREVIEW_FIELDS['set-aplus-asins']).toEqual(['target', 'basis', 'plan'])
    expect(MATERIAL_PREVIEW_FIELDS['submit-aplus-content']).toEqual(['op', 'target', 'basis'])
    for (const t of APLUS_CHANGE_TOOLS) {
      expect(t.undo, t.name).toBeDefined()
      expect(t.description, t.name).toMatch(/A person approves it in Nexus\.$/)
    }
  })

  it('planEntities: the document and its ASIN set, as a change plan chains them', () => {
    const content = tool('set-aplus-content').planEntities!
    expect(content({ op: 'update', market: 'IT', contentReferenceKey: KEY }, {})).toEqual({ reads: [`aplus:IT:${KEY}`], writes: [`aplus:IT:${KEY}`] })
    expect(content({ op: 'copy', market: 'DE', fromMarket: 'IT', contentReferenceKey: KEY }, {})).toEqual({ reads: [`aplus:IT:${KEY}`], writes: [] })
    expect(content({ op: 'copy', market: 'DE', contentReferenceKey: KEY }, {})).toEqual({ reads: [`aplus:DE:${KEY}`], writes: [] })
    expect(content({ op: 'create', market: 'IT' }, {})).toEqual({ reads: [], writes: [] })
    expect(tool('set-aplus-asins').planEntities!({ market: 'IT', contentReferenceKey: KEY }, {})).toEqual({ reads: [`aplus:IT:${KEY}`, `aplus-asins:IT:${KEY}`], writes: [`aplus-asins:IT:${KEY}`, `aplus:IT:${KEY}`] })
    expect(tool('submit-aplus-content').planEntities!({ op: 'submit', market: 'IT', contentReferenceKey: KEY }, {})).toEqual({ reads: [`aplus:IT:${KEY}`, `aplus-asins:IT:${KEY}`], writes: [`aplus:IT:${KEY}`] })
  })
})

// ── set-aplus-content ───────────────────────────────────────────────────────────────────────────────────────────

describe('set-aplus-content', () => {
  const CREATE = {
    op: 'CREATE', market: 'it', name: 'Demo IT 2026', asins: [A2, 'b0demo0001'],
    modules: [imageText('Rete traspirante', atAmazon('aplus-media/sc/one.jpg', 'Giacca Demo')), premiumText('Protezioni')],
    summary: 'Breathable mesh all over the body; CE level 2 protectors on shoulders and elbows.',
  }
  const NEW_IMAGE = { ...CREATE, modules: [imageText('Rete traspirante', { assetId: 'da_new1', altText: 'Giacca Demo nuova' }), premiumText('Protezioni')] }

  it('create: Amazon checks it first (every image at Amazon); the preview is the person\'s, within 20 lines', async () => {
    seed()
    const p = await preview('set-aplus-content', CREATE)
    expect(h.calls).toEqual(['resolve:IT', 'validate'])
    expect(h.validate.mock.calls[0][0]).toEqual({ accountId: 'acc-1', marketplaceId: IT.marketplaceId })
    expect(h.validate.mock.calls[0][2]).toEqual([A1, A2])
    expect(p).toMatchObject({
      action: 'set-aplus-content',
      op: 'create',
      summary: `Creates a new Premium A+ draft "Demo IT 2026" (2 modules) in Amazon IT, applied to 2 ASINs; buyers see nothing until it is submitted (submit-aplus-content) and Amazon approves it.`,
      totals: { modules: 2, newImages: 0, imagesAtAmazon: 1, asins: 2 },
      destination: { channel: 'AMAZON', market: 'IT' },
      target: { market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1', contentReferenceKey: null, locale: 'it-IT', contentType: 'EBC' },
      asins: [A1, A2],
      basis: factHash({ marketplaceId: IT.marketplaceId, accountId: 'acc-1', locale: 'it-IT' }),
      images: [],
      amazonCheck: { ran: true, errors: [], warnings: [] },
      englishSummary: CREATE.summary,
      publishMode: 'live',
    })
    expect(p.changes).toMatchObject({
      name: { from: null, to: 'Demo IT 2026' },
      modules: { from: null, to: ['PREMIUM_IMAGE_TEXT', 'PREMIUM_TEXT'] },
      'module 1 (PREMIUM_IMAGE_TEXT)': { from: null, to: expect.stringMatching(/^PREMIUM_IMAGE_TEXT "Rete traspirante", 1 image, \d+ characters$/) },
      'module 2 (PREMIUM_TEXT)': { from: null, to: expect.stringMatching(/^PREMIUM_TEXT "Protezioni", 0 images/) },
      ASINs: { from: [], to: [A1, A2] },
    })
    expect(p.warnings).toEqual(['On its ASINs it shows nothing until submitted and approved; once approved it replaces the A+ published there now (submit-aplus-content names those documents).'])
    expect(p.modules.map((m: { type: string }) => m.type)).toEqual(['PREMIUM_IMAGE_TEXT', 'PREMIUM_TEXT'])
    expect(Object.keys(p.changes).length + (p.warnings?.length ?? 0)).toBeLessThanOrEqual(20)
  })

  it('create with a new photo: nothing uploaded, Amazon\'s check waits for the run, the photo\'s facts are in the preview', async () => {
    const p = await preview('set-aplus-content', NEW_IMAGE)
    expect(h.calls).toEqual(['resolve:IT', 'inspect'])
    expect(h.inspect.mock.calls[0][0]).toEqual([expect.objectContaining({ key: '0:image', source: { kind: 'asset', assetId: 'da_new1' }, altText: 'Giacca Demo nuova', crop: null })])
    expect(h.upload).not.toHaveBeenCalled()
    expect(p.amazonCheck).toEqual({ ran: false, errors: [], warnings: [] })
    expect(p.totals).toEqual({ modules: 2, newImages: 1, imagesAtAmazon: 0, asins: 2 })
    expect(p.images).toEqual([expect.objectContaining({ key: '0:image', contentHash: 'hash-da_new1', bytes: 2_400_000 })])
    expect(p.summary).toMatch(/\(2 modules, 1 new image\)/)
    expect(p.warnings).toContain('Amazon checks the document when it runs, after the new images are uploaded; if it refuses, nothing is created (the uploaded images stay unused in Amazon\'s media library).')
    expect(p.warnings).toContain('The photo da_new1 is 2.3 MB: Amazon advises at most 2 MB.')
  })

  it('a document Amazon would refuse is never queued, and nothing is read before the account resolves', async () => {
    h.validate.mockResolvedValueOnce({ errors: [{ code: 'CONTENT_FAILED_VALIDATION', message: 'We can\'t read one of the images that you uploaded.', details: '' }], warnings: [] })
    const refused = await ask('set-aplus-content', CREATE)
    expect(refused).toEqual({ ok: false, error: 'Amazon\'s check refused it: We can\'t read one of the images that you uploaded. Nothing was queued.' })
    h.calls.length = 0
    const nowhere = await ask('set-aplus-content', { ...CREATE, market: 'FR' })
    expect(nowhere).toEqual({ ok: false, error: 'The Amazon market FR is not found in this business (business-overview lists its markets). Nothing was queued.' })
    expect(h.calls).toEqual(['resolve:FR'])
    expect(h.inspect).not.toHaveBeenCalled()
  })

  it('an ASIN Amazon would not show it on is named, and nothing is queued', async () => {
    h.validate.mockResolvedValueOnce({ errors: [], warnings: [{ code: 'ASIN_FAILED_VALIDATION', message: 'You are unable to add content to this ASIN because our system does not recognize this ASIN as part of your brand.', details: A2 }] })
    expect((await ask('set-aplus-content', CREATE)).error).toBe(`Amazon would not show this A+ on ${A2}: leave it out of asins. Nothing was queued.`)
  })

  it('refuses in words what needs no Amazon read: before the market is even resolved', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ op: 'create', market: 'IT', modules: CREATE.modules, summary: 'x' }, /op create needs a name/],
      [{ op: 'create', market: 'IT', name: 'X', summary: 'x' }, /op create needs modules/],
      [{ op: 'update', market: 'IT', name: 'X', summary: 'x' }, /op update needs contentReferenceKey/],
      [{ op: 'update', market: 'IT', contentReferenceKey: KEY }, /Name what op update changes/],
      [{ op: 'update', market: 'IT', contentReferenceKey: KEY, name: 'X', asins: [A1], summary: 'x' }, /change with set-aplus-asins/],
      [{ op: 'copy', market: 'DE', contentReferenceKey: KEY, modules: CREATE.modules }, /op copy takes the source's modules/],
      [{ op: 'update', market: 'IT', contentReferenceKey: KEY, name: 'X', kind: 'brand-story', summary: 'x' }, /keeps the kind/],
    ]
    for (const [args, error] of cases) {
      const out = await ask('set-aplus-content', args)
      expect(out.ok, JSON.stringify(args)).toBe(false)
      expect(out.error).toMatch(error)
      expect(out.error).toMatch(/Nothing was queued\.$/)
    }
    expect(h.resolve).not.toHaveBeenCalled()
  })

  it('text in a language other than English needs its English summary; English does not', async () => {
    const { summary: _summary, ...withoutSummary } = CREATE
    expect((await ask('set-aplus-content', withoutSummary)).error).toBe('Give summary: what the text says in English, for the person who approves it (the document is in it). Nothing was queued.')
    const english = await ask('set-aplus-content', { ...withoutSummary, market: 'UK', asins: undefined })
    expect(english.ok).toBe(true)
    expect((english.preview as { target: { locale: string } }).target.locale).toBe('en-GB')
  })

  it('a document that breaks Amazon\'s A+ rules is refused with the rule, before any photo is fetched', async () => {
    const out = await ask('set-aplus-content', { ...CREATE, modules: [standardText('Testo'), premiumText('Protezioni')] })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/^The document does not keep Amazon's A\+ rules: A document is all Standard or all Premium/)
    expect(h.inspect).not.toHaveBeenCalled()
    expect(h.validate).not.toHaveBeenCalled()
  })

  it('the gate\'s re-check reads again without asking Amazon to check twice; the material fields compare equal', async () => {
    seed()
    const first = await preview('set-aplus-content', CREATE)
    h.calls.length = 0
    const again = await ask('set-aplus-content', CREATE, recheck)
    expect(h.validate).toHaveBeenCalledTimes(1)
    expect(again.ok).toBe(true)
    expect(pick(again.preview, MATERIAL_PREVIEW_FIELDS['set-aplus-content'])).toEqual(pick(first, MATERIAL_PREVIEW_FIELDS['set-aplus-content']))
  })

  describe('update', () => {
    const UPDATE = {
      op: 'update', market: 'IT', contentReferenceKey: KEY, name: 'Demo IT 2026', summary: 'The mesh now says 3D mesh.',
      modules: [imageText('Rete traspirante 3D', atAmazon('aplus-media/sc/one.jpg', 'Giacca Demo')), premiumText('Protezioni')],
    }

    it('says what changes (name, the one changed module), that an approved document becomes a draft while its approved version stays live, and stands on the document as Amazon keeps it', async () => {
      seed('APPROVED')
      const p = await preview('set-aplus-content', UPDATE)
      expect(h.calls).toEqual(['resolve:IT', `get:${KEY}`, `asins:${KEY}`, 'validate'])
      expect(h.validate.mock.calls[0][2]).toEqual([A1, A2])
      expect(p.summary).toBe(`Changes the Premium A+ document "Demo IT" in Amazon IT (its name, 1 of 2 modules) as a draft; buyers keep seeing its approved version on 1 ASIN until this one is submitted (submit-aplus-content) and approved.`)
      expect(Object.keys(p.changes)).toEqual(['name', 'module 1 (PREMIUM_IMAGE_TEXT)'])
      expect(p.changes.name).toEqual({ from: 'Demo IT', to: 'Demo IT 2026' })
      expect(p.changes['module 1 (PREMIUM_IMAGE_TEXT)'].from).toMatch(/"Rete traspirante",/)
      expect(p.changes['module 1 (PREMIUM_IMAGE_TEXT)'].to).toMatch(/"Rete traspirante 3D",/)
      expect(p.warnings).toEqual(['Amazon makes the APPROVED document a DRAFT again: its approved version stays live on its ASINs until this one is submitted (submit-aplus-content) and approved.'])
      expect(p.target).toEqual({ market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1', contentReferenceKey: KEY, locale: 'it-IT', contentType: 'EBC' })
      expect(p.basis).toBe(factHash({ documentHash: documentHash(demoDoc() as never), status: 'APPROVED', updateTime: UPDATED }))
      expect(p.asins).toBeNull()
      expect(p.totals).toEqual({ modules: 2, newImages: 0, imagesAtAmazon: 1, asins: 2 })
    })

    it('a name only, the same document, or another language: said in words', async () => {
      seed('DRAFT')
      const rename = await preview('set-aplus-content', { op: 'update', market: 'IT', contentReferenceKey: KEY, name: 'Demo IT v2', summary: 'Demo IT v2' })
      expect(Object.keys(rename.changes)).toEqual(['name'])
      expect(rename.summary).toMatch(/\(its name\) as a draft; buyers keep seeing its approved version on 1 ASIN/)
      expect((await ask('set-aplus-content', { op: 'update', market: 'IT', contentReferenceKey: KEY, name: 'Demo IT', summary: 'same' })).error)
        .toBe('Nothing to change: the document already has this name and these modules. Nothing was queued.')
      expect((await ask('set-aplus-content', { ...UPDATE, language: 'de' })).error).toMatch(/^An update keeps the document's own language \(it-IT\)/)
      expect((await ask('set-aplus-content', { ...UPDATE, contentReferenceKey: 'k-missing' })).error)
        .toBe('Amazon refused it: Amazon has no such A+ document in this market. Nothing was queued.')
    })

    it('runs as approved: Amazon checks the sent document, then it is updated and read back; undo puts the document back', async () => {
      seed('APPROVED')
      const p = await preview('set-aplus-content', UPDATE)
      h.calls.length = 0
      const out = await run('set-aplus-content', UPDATE, approved(p))
      expect(out.error).toBeUndefined()
      expect(writes()).toEqual(['validate', 'update'])
      expect(h.update.mock.calls[0][1]).toBe(KEY)
      const sent = h.update.mock.calls[0][2] as Doc
      expect(sent).toMatchObject({ name: 'Demo IT 2026', contentType: 'EBC', locale: 'it-IT' })
      const ids = { op: 'update', market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1', contentReferenceKey: KEY }
      expect(out.change).toEqual({
        before: { ...ids, name: 'Demo IT', documentHash: documentHash(demoDoc() as never), document: normalizeAmazonDocument(demoDoc() as never) },
        after: { ...ids, name: 'Demo IT 2026', documentHash: documentHash(sent as never) },
      })
      expect(out.data).toMatchObject({ contentReferenceKey: KEY, name: 'Demo IT 2026', status: 'DRAFT' })
      const undo = tool('set-aplus-content').undo!
      expect(await undo.current(out.change!)).toEqual(out.change!.after)
      const request = undo.request(out.change!) as { tool: string; args: Record<string, unknown> }
      expect(request).toMatchObject({ tool: 'set-aplus-content', args: { op: 'update', market: 'IT', accountId: 'acc-1', contentReferenceKey: KEY, name: 'Demo IT', language: 'it' } })
      expect(tool('set-aplus-content').input.safeParse(request.args).success).toBe(true)
      // The undo is itself a request with a preview: it puts back exactly the document that was there.
      const back = await preview('set-aplus-content', request.args)
      expect(back.changes.name).toEqual({ from: 'Demo IT 2026', to: 'Demo IT' })
      // Someone changed it since: the undo reads a different document now.
      h.docs.get(at(IT, KEY))!.document.name = 'Demo IT by hand'
      expect(await undo.current(out.change!)).not.toEqual(out.change!.after)
    })
  })

  describe('copy', () => {
    it('duplicates a document into another market of the same account: the source\'s modules, a "(copy)" name, the target\'s locale, and the language left as it was', async () => {
      seed('APPROVED')
      const p = await preview('set-aplus-content', { op: 'copy', market: 'DE', fromMarket: 'IT', contentReferenceKey: KEY })
      expect(h.calls).toEqual(['resolve:DE', 'resolve:IT', `get:${KEY}`, 'validate'])
      expect(h.validate.mock.calls[0][0]).toEqual({ accountId: 'acc-1', marketplaceId: DE.marketplaceId })
      expect(p).toMatchObject({
        op: 'copy',
        summary: 'Copies the Premium A+ document "Demo IT" (Amazon IT) as a new draft "Demo IT (copy)" in Amazon DE; buyers see nothing until it is submitted (submit-aplus-content) and Amazon approves it.',
        target: { market: 'DE', marketplaceId: DE.marketplaceId, contentReferenceKey: null, locale: 'de-DE', contentType: 'EBC' },
        source: { market: 'IT', marketplaceId: IT.marketplaceId, contentReferenceKey: KEY, name: 'Demo IT', locale: 'it-IT' },
        basis: factHash({ documentHash: documentHash(demoDoc() as never), status: 'APPROVED', updateTime: UPDATED }),
      })
      expect(p.warnings).toContain('The text stays in the source\'s language (it-IT) in a de-DE document: to translate it, read it with aplus-content and make the translated document with op create.')
    })

    it('a copy whose images Amazon cannot reach in the other market says how to send them', async () => {
      seed()
      h.validate.mockResolvedValueOnce({ errors: [{ code: 'CONTENT_FAILED_VALIDATION', message: 'We can\'t read one of the images that you uploaded', details: '' }], warnings: [] })
      const out = await ask('set-aplus-content', { op: 'copy', market: 'DE', fromMarket: 'IT', contentReferenceKey: KEY })
      expect(out.error).toMatch(/give those images as assetId or url \(they are uploaded again\) with op create\. Nothing was queued\.$/)
    })
  })

  describe('the run', () => {
    it('runs only as an approved request, only while Amazon publishing is live, only as approved, and never on a moved basis', async () => {
      seed('DRAFT')
      const UPDATE = { op: 'update', market: 'IT', contentReferenceKey: KEY, name: 'Demo IT v2', summary: 'Demo IT v2' }
      const p = await preview('set-aplus-content', UPDATE)
      h.calls.length = 0
      expect((await run('set-aplus-content', UPDATE, asker)).error).toBe('A+ content changes only as a request a person approved in Nexus. Nothing was changed.')
      h.mode = 'dry-run'
      expect((await run('set-aplus-content', UPDATE, approved(p))).error).toBe('Not sent: Amazon publishing is not live in Nexus (mode dry-run), so nothing goes to Amazon. Nothing was changed.')
      const offPreview = await preview('set-aplus-content', UPDATE)
      expect(offPreview.warnings).toContain('Amazon publishing is not live in Nexus (mode dry-run): after approval this is NOT sent to Amazon.')
      h.calls.length = 0
      h.mode = 'live'
      expect((await run('set-aplus-content', UPDATE, approved(offPreview))).error).toMatch(/^Not sent: it was approved while Amazon publishing was not live in Nexus/)
      expect(writes()).toEqual([])
      // Someone changed the document at Amazon after the person approved it.
      h.docs.get(at(IT, KEY))!.meta.updateTime = '2026-10-19T08:00:00Z'
      h.calls.length = 0
      expect((await run('set-aplus-content', UPDATE, approved(p))).error).toBe('Not changed: the A+ document changed since you approved it (basis). Ask again to see it as it is now.')
      expect(writes()).toEqual([])
    })

    it('a new draft with a new photo and ASINs: upload → Amazon\'s check → create → ASINs → read back; undo takes it off its ASINs', async () => {
      const p = await preview('set-aplus-content', NEW_IMAGE)
      h.calls.length = 0
      const out = await run('set-aplus-content', NEW_IMAGE, approved(p))
      expect(out.error).toBeUndefined()
      expect(h.calls.filter((c) => !c.startsWith('resolve') && c !== 'inspect')).toEqual(['upload', 'validate', 'create', 'post-asins', 'asins:NEW-KEY', 'get:NEW-KEY'])
      const sent = h.create.mock.calls[0][1] as Doc
      expect(h.validate.mock.calls[0][1]).toEqual(sent)
      expect(h.validate.mock.calls[0][2]).toEqual([A1, A2])
      expect((sent.contentModuleList[0].premiumImageText as { image: unknown }).image).toMatchObject({ uploadDestinationId: 'aplus-media/sc/hash-da_new1.jpg', altText: 'Giacca Demo nuova' })
      expect(h.postAsins.mock.calls[0].slice(1)).toEqual(['NEW-KEY', [A1, A2]])
      const ids = { op: 'create', market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1' }
      expect(out.change).toEqual({
        before: { ...ids, contentReferenceKey: null, name: null, documentHash: null, asins: [] },
        after: { ...ids, contentReferenceKey: 'NEW-KEY', name: 'Demo IT 2026', documentHash: documentHash(sent as never), asins: [A1, A2] },
      })
      expect(out.data).toMatchObject({ contentReferenceKey: 'NEW-KEY', status: 'DRAFT', asins: [A1, A2] })
      const undo = tool('set-aplus-content').undo!
      expect(await undo.current(out.change!)).toEqual(out.change!.after)
      const request = undo.request(out.change!) as { tool: string; args: Record<string, unknown> }
      expect(request).toEqual({ tool: 'set-aplus-asins', args: { market: 'IT', accountId: 'acc-1', contentReferenceKey: 'NEW-KEY', remove: [A1, A2] } })
      expect(tool('set-aplus-asins').input.safeParse(request.args).success).toBe(true)
    })

    it('Amazon refuses the uploaded document: nothing is created, and it says the uploads stay unused', async () => {
      const p = await preview('set-aplus-content', NEW_IMAGE)
      h.validate.mockResolvedValueOnce({ errors: [{ code: 'CONTENT_FAILED_VALIDATION', message: 'The image is too small', details: '' }], warnings: [] })
      const out = await run('set-aplus-content', NEW_IMAGE, approved(p))
      expect(out).toEqual({ ok: false, error: 'Amazon\'s check refused it: The image is too small. Nothing was created; the uploaded images stay unused in Amazon\'s media library.' })
      expect(h.create).not.toHaveBeenCalled()
    })

    it('after the draft is made, a failure is a warning, never a failed run (approving again would make a second document)', async () => {
      const p = await preview('set-aplus-content', CREATE)
      h.postAsins.mockRejectedValueOnce(new h.AplusError('throttled', 'Amazon is busy', 429))
      const out = await run('set-aplus-content', CREATE, approved(p))
      expect(out.ok).toBe(true)
      expect((out.data as { warnings: string[] }).warnings).toEqual(['The draft was made, but Amazon did not take its ASINs: Amazon refused it: Amazon is busy. Apply them with set-aplus-asins.'])
      expect((out.change!.after as { asins: string[] }).asins).toEqual([])
      expect(tool('set-aplus-content').undo!.request(out.change!)).toEqual({
        refusal: 'Amazon has no way to delete an A+ document. This draft is applied to no ASIN, so no buyer sees it; leave it or change it with set-aplus-content op update.',
      })
    })

    it('Amazon gives no answer to the create: it never says nothing changed', async () => {
      const p = await preview('set-aplus-content', CREATE)
      h.create.mockRejectedValueOnce(new h.AplusError('no_answer', 'timeout', 0))
      expect((await run('set-aplus-content', CREATE, approved(p))).error).toBe('Amazon did not answer; it may or may not have applied it — read it with aplus-content before asking again.')
    })
  })

  it('never throws: an Amazon refusal, a photo problem and anything unexpected are answered in words', async () => {
    seed()
    const getMock = (await import('../../aplus/aplus-client.js')).getContentDocument as unknown as ReturnType<typeof vi.fn>
    getMock.mockRejectedValueOnce(new h.AplusError('forbidden', 'access refused', 403))
    expect(await ask('set-aplus-content', { op: 'update', market: 'IT', contentReferenceKey: KEY, name: 'X', summary: 'x' }))
      .toEqual({ ok: false, error: 'Amazon refused it: access refused. Nothing was queued.' })
    h.inspect.mockRejectedValueOnce(new h.AplusImageError('0:image: the photo is 800×500; Amazon needs at least 800×600.', '0:image'))
    expect(await ask('set-aplus-content', NEW_IMAGE)).toEqual({ ok: false, error: '0:image: the photo is 800×500; Amazon needs at least 800×600. Nothing was queued.' })
    h.inspect.mockRejectedValueOnce(new TypeError('fetch failed at https://example.test/secret?sig=1'))
    expect(await ask('set-aplus-content', NEW_IMAGE)).toEqual({ ok: false, error: 'Nexus could not do this: fetch failed at (a link). Nothing was queued.' })
  })
})

// ── set-aplus-asins ─────────────────────────────────────────────────────────────────────────────────────────────

describe('set-aplus-asins', () => {
  const CHANGE = { market: 'IT', contentReferenceKey: KEY, add: [A3], remove: [A1] }

  it('add and remove: the new set, what goes off at once, the approved document becoming a draft, and what it replaces on an added ASIN', async () => {
    seed('APPROVED')
    h.records.set(A3, [{ marketplaceId: IT.marketplaceId, locale: 'it_IT', asin: A3, contentType: 'EBC', contentSubType: null, contentReferenceKey: OTHER }])
    const p = await preview('set-aplus-asins', CHANGE)
    expect(h.validate.mock.calls[0][2]).toEqual([A2, A3])
    expect(h.calls).toEqual(['resolve:IT', `get:${KEY}`, `asins:${KEY}`, 'validate', `records:${A3}`, `get:${OTHER}`])
    expect(p).toMatchObject({
      action: 'set-aplus-asins',
      summary: 'Sets the ASINs of the Premium A+ document "Demo IT" in Amazon IT: applies it to 1 more ASIN and takes it off 1 ASIN, 2 ASINs in all.',
      changes: { ASINs: { from: [A1, A2], to: [A2, A3] }, 'ASINs added': { from: null, to: [A3] }, 'ASINs removed': { from: [A1], to: null } },
      totals: { added: 1, removed: 1, total: 2 },
      added: [A3],
      removed: [A1],
      target: { market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1', contentReferenceKey: KEY, locale: 'it-IT', contentType: 'EBC' },
      basis: factHash({ asins: [A1, A2], status: 'APPROVED', updateTime: UPDATED, documentHash: documentHash(demoDoc() as never) }),
      plan: factHash([A2, A3]),
      publishMode: 'live',
    })
    expect(p.warnings).toEqual([
      `Removing takes this A+ off ${A1} at once: buyers there see another approved document's A+, or none.`,
      'Amazon makes the APPROVED document a DRAFT again: its approved version stays live on its ASINs until this one is submitted (submit-aplus-content) and approved.',
      'The added ASIN shows nothing until the document is submitted (submit-aplus-content) and approved.',
      `Once approved it replaces "Demo old" (${OTHER}) on ${A3}: Amazon shows one A+ per ASIN.`,
    ])
  })

  it('the whole set, the empty set, nothing to change, and requests that cannot be read', async () => {
    seed('DRAFT')
    const whole = await preview('set-aplus-asins', { market: 'IT', contentReferenceKey: KEY, asins: [A2, A2] })
    expect(whole.changes.ASINs).toEqual({ from: [A1, A2], to: [A2] })
    const empty = await preview('set-aplus-asins', { market: 'IT', contentReferenceKey: KEY, remove: [A1, A2] })
    expect(empty).toMatchObject({ totals: { added: 0, removed: 2, total: 0 }, changes: { ASINs: { from: [A1, A2], to: [] } } })
    // Nothing is added, so Amazon has nothing to check.
    expect(h.validate).not.toHaveBeenCalled()
    expect((await ask('set-aplus-asins', { market: 'IT', contentReferenceKey: KEY, add: [A1] })).error).toBe('Nothing to change: the document is applied to exactly these ASINs already. Nothing was queued.')
    h.calls.length = 0
    expect((await ask('set-aplus-asins', { market: 'IT', contentReferenceKey: KEY, asins: [A1], add: [A3] })).error).toBe('Give asins (the whole new set) or add and remove, not both. Nothing was queued.')
    expect((await ask('set-aplus-asins', { market: 'IT', contentReferenceKey: KEY })).error).toBe('Name the ASINs: asins (the whole new set), or add and remove. Nothing was queued.')
    expect((await ask('set-aplus-asins', { market: 'IT', contentReferenceKey: KEY, add: [A3], remove: [A3] })).error).toBe(`${A3} cannot be added and removed at once. Nothing was queued.`)
    expect(h.calls).toEqual([])
    h.complete = false
    expect((await ask('set-aplus-asins', CHANGE)).error).toMatch(/more ASINs than Nexus reads in one go/)
  })

  it('an added ASIN Amazon refuses is named and nothing is queued', async () => {
    seed('DRAFT')
    h.validate.mockResolvedValueOnce({ errors: [], warnings: [{ code: 'ASIN_FAILED_VALIDATION', message: 'You are unable to add content to this ASIN because our system does not recognize this ASIN as part of your brand.', details: A3 }] })
    expect((await ask('set-aplus-asins', CHANGE)).error).toBe(`Amazon would not show this A+ on ${A3}: You are unable to add content to this ASIN because our system does not recognize this ASIN as part of your brand (${A3}). Leave it out. Nothing was queued.`)
  })

  it('the re-check asks Amazon nothing but the reads; the run posts the set and reads it back; undo puts the set back', async () => {
    seed('DRAFT')
    const p = await preview('set-aplus-asins', CHANGE)
    h.calls.length = 0
    const again = await ask('set-aplus-asins', CHANGE, recheck)
    expect(h.calls).toEqual(['resolve:IT', `get:${KEY}`, `asins:${KEY}`])
    expect(pick(again.preview, ['target', 'basis', 'plan'])).toEqual(pick(p, ['target', 'basis', 'plan']))
    h.calls.length = 0
    const out = await run('set-aplus-asins', CHANGE, approved(p))
    expect(out.error).toBeUndefined()
    expect(h.calls).toEqual(['resolve:IT', `get:${KEY}`, `asins:${KEY}`, 'post-asins', `asins:${KEY}`])
    expect(h.postAsins.mock.calls[0].slice(1)).toEqual([KEY, [A2, A3]])
    const ids = { market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1', contentReferenceKey: KEY }
    expect(out.change).toEqual({ before: { ...ids, asins: [A1, A2] }, after: { ...ids, asins: [A2, A3] } })
    const undo = tool('set-aplus-asins').undo!
    expect(await undo.current(out.change!)).toEqual(out.change!.after)
    const request = undo.request(out.change!) as { tool: string; args: Record<string, unknown> }
    expect(request).toEqual({ tool: 'set-aplus-asins', args: { market: 'IT', accountId: 'acc-1', contentReferenceKey: KEY, asins: [A1, A2] } })
    expect(tool('set-aplus-asins').input.safeParse(request.args).success).toBe(true)
    // A document that had none before is emptied again by removing what it was given.
    const fromNone = undo.request({ before: { ...ids, asins: [] }, after: { ...ids, asins: [A3] } }) as { args: Record<string, unknown> }
    expect(fromNone.args).toEqual({ market: 'IT', accountId: 'acc-1', contentReferenceKey: KEY, remove: [A3] })
    expect(tool('set-aplus-asins').input.safeParse(fromNone.args).success).toBe(true)
    // Its ASINs moved since the person approved: not run.
    h.relations.set(at(IT, KEY), [rel(A1)])
    h.calls.length = 0
    expect((await run('set-aplus-asins', CHANGE, approved(p))).error).toMatch(/^Not changed: the A\+ document or its ASINs changed since you approved it \(basis, plan\)/)
    expect(writes()).toEqual([])
  })
})

// ── submit-aplus-content ────────────────────────────────────────────────────────────────────────────────────────

describe('submit-aplus-content', () => {
  const SUBMIT = { op: 'submit', market: 'IT', contentReferenceKey: KEY }
  const SUSPEND = { op: 'suspend', market: 'IT', contentReferenceKey: KEY }

  it('submit: refused with no ASIN, while in review, once approved, and for an ASIN outside the brand', async () => {
    seed('DRAFT')
    h.relations.set(at(IT, KEY), [])
    expect((await ask('submit-aplus-content', SUBMIT)).error).toBe('It is applied to no ASIN: apply it first with set-aplus-asins. Nothing was queued.')
    seed('SUBMITTED')
    expect((await ask('submit-aplus-content', SUBMIT)).error).toMatch(/^It is already waiting for Amazon's review \(SUBMITTED\)/)
    seed('APPROVED')
    expect((await ask('submit-aplus-content', SUBMIT)).error).toMatch(/^It is already approved and published on its ASINs/)
    seed('DRAFT')
    h.relations.set(at(IT, KEY), [rel(A1), rel(A2, ['BRAND_NOT_ELIGIBLE'])])
    expect((await ask('submit-aplus-content', SUBMIT)).error).toBe(`Amazon says ${A2} (BRAND_NOT_ELIGIBLE) cannot show A+ from this brand: take it off with set-aplus-asins first. Nothing was queued.`)
    seed('DRAFT')
    h.validate.mockResolvedValueOnce({ errors: [], warnings: [{ code: 'ASIN_FAILED_VALIDATION', message: 'Failed asin permissions check.', details: A2 }] })
    expect((await ask('submit-aplus-content', SUBMIT)).error).toBe(`Amazon would not show it on ${A2}: Failed asin permissions check (${A2}). Take it off with set-aplus-asins first. Nothing was queued.`)
    expect(h.submit).not.toHaveBeenCalled()
  })

  it('submit: the status it goes to, the documents it replaces once approved, and what it stands on', async () => {
    seed('DRAFT')
    h.records.set(A2, [{ marketplaceId: IT.marketplaceId, locale: 'it_IT', asin: A2, contentType: 'EBC', contentSubType: null, contentReferenceKey: OTHER },
      { marketplaceId: IT.marketplaceId, locale: 'it_IT', asin: A2, contentType: 'BrandStory', contentSubType: null, contentReferenceKey: 'k-story' }])
    const p = await preview('submit-aplus-content', SUBMIT)
    expect(p).toMatchObject({
      action: 'submit-aplus-content',
      op: 'submit',
      summary: 'Sends the Premium A+ document "Demo IT" in Amazon IT for Amazon\'s approval; once Amazon approves it, it is published on its 2 ASINs, replacing any A+ shown there now.',
      changes: { status: { from: 'DRAFT', to: 'SUBMITTED (Amazon reviews it)' } },
      totals: { asins: 2, published: 1 },
      target: { market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1', contentReferenceKey: KEY },
      basis: factHash({ status: 'DRAFT', updateTime: UPDATED, documentHash: documentHash(demoDoc() as never), asins: [A1, A2], publishedAsins: [A1] }),
      publishMode: 'live',
    })
    // A Brand Story published on the same ASIN is another family: it stays.
    expect(p.warnings).toEqual([
      'Amazon reviews it (minutes to days; some accounts at once): read its status with aplus-content, at most once an hour.',
      `Once approved it replaces "Demo old" (${OTHER}) on ${A2}: Amazon shows one A+ per ASIN.`,
    ])
  })

  it('suspend: off every ASIN at once (an older approved version too); refused when nothing shows and nothing waits', async () => {
    seed('APPROVED')
    const p = await preview('submit-aplus-content', SUSPEND)
    expect(p).toMatchObject({
      op: 'suspend',
      summary: 'Takes the Premium A+ document "Demo IT" off the 1 ASIN it is shown on in Amazon IT at once; the document and its ASINs stay, and it comes back only when submitted and approved again.',
      changes: { 'shown on': { from: [A1], to: [] } },
      totals: { asins: 2, published: 1 },
    })
    expect(p.warnings).toContain('A suspend also takes off an older approved version of this document that is live now: nothing of it shows until it is submitted and approved again.')
    expect(h.validate).not.toHaveBeenCalled()
    seed('DRAFT')
    h.relations.set(at(IT, KEY), [rel(A1), rel(A2)])
    expect((await ask('submit-aplus-content', SUSPEND)).error).toBe('It is shown on no ASIN and is not waiting for review: there is nothing to suspend. Nothing was queued.')
  })

  it('the re-check asks Amazon nothing but the reads; a submit runs as approved and its undo is a suspend', async () => {
    seed('DRAFT')
    const p = await preview('submit-aplus-content', SUBMIT)
    h.calls.length = 0
    const again = await ask('submit-aplus-content', SUBMIT, recheck)
    expect(h.calls).toEqual(['resolve:IT', `get:${KEY}`, `asins:${KEY}`])
    expect(pick(again.preview, ['op', 'target', 'basis'])).toEqual(pick(p, ['op', 'target', 'basis']))
    const out = await run('submit-aplus-content', SUBMIT, approved(p))
    expect(out.error).toBeUndefined()
    expect(writes()).toEqual(['submit'])
    const ids = { op: 'submit', market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1', contentReferenceKey: KEY }
    expect(out.change).toEqual({ before: { ...ids, phase: 'draft' }, after: { ...ids, phase: 'submitted' } })
    expect(out.data).toMatchObject({ status: 'SUBMITTED' })
    const undo = tool('submit-aplus-content').undo!
    expect(await undo.current(out.change!)).toEqual(out.change!.after)
    h.docs.get(at(IT, KEY))!.meta.status = 'APPROVED'
    expect(await undo.current(out.change!)).toEqual(out.change!.after)
    h.docs.get(at(IT, KEY))!.meta.status = 'REJECTED'
    expect(await undo.current(out.change!)).toEqual({ ...out.change!.after, phase: 'rejected' })
    const request = undo.request(out.change!) as { tool: string; args: Record<string, unknown> }
    expect(request).toEqual({ tool: 'submit-aplus-content', args: { op: 'suspend', market: 'IT', accountId: 'acc-1', contentReferenceKey: KEY } })
    expect(tool('submit-aplus-content').input.safeParse(request.args).success).toBe(true)
    // A second run of the same request finds it in review: refused.
    h.docs.get(at(IT, KEY))!.meta.status = 'SUBMITTED'
    expect((await run('submit-aplus-content', SUBMIT, approved(p))).error).toMatch(/^It is already waiting for Amazon's review/)
  })

  it('a suspend runs as approved: it was published, now it is suspended; its undo is a submit', async () => {
    seed('APPROVED')
    const p = await preview('submit-aplus-content', SUSPEND)
    const out = await run('submit-aplus-content', SUSPEND, approved(p))
    expect(out.error).toBeUndefined()
    expect(writes()).toEqual(['suspend'])
    const ids = { op: 'suspend', market: 'IT', marketplaceId: IT.marketplaceId, accountId: 'acc-1', contentReferenceKey: KEY }
    expect(out.change).toEqual({ before: { ...ids, phase: 'published' }, after: { ...ids, phase: 'suspended' } })
    const undo = tool('submit-aplus-content').undo!
    expect(await undo.current(out.change!)).toEqual(out.change!.after)
    expect(undo.request(out.change!)).toEqual({ tool: 'submit-aplus-content', args: { op: 'submit', market: 'IT', accountId: 'acc-1', contentReferenceKey: KEY } })
    h.mode = 'gated'
    expect((await run('submit-aplus-content', SUSPEND, approved(p))).error).toMatch(/^Not sent: Amazon publishing is not live in Nexus \(mode gated\)/)
  })
})
