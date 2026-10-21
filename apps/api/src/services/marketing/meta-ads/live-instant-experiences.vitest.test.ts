/**
 * Meta step 27b review B-1 — the live state an Instant Experience change stands on: Meta's read-back of its parts
 * (body_elements, and fb_body_elements when Meta answers it — each row's own id, or its `element`'s) and the body Nexus last
 * SENT (its own change records: a create's or a later edit's bodyElementIds — an edit's fields.elementIds before re-review
 * #2 — with each part's type, bodyElementTypes). Meta and the database are stand-ins. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const PAGE = '120000000000010'
const CANVAS = '120000000000701'
const h = vi.hoisted(() => ({
  reads: [] as Array<{ path: string; fields: string }>,
  answer: (() => ({})) as (path: string, fields: string) => unknown,
  rows: [] as Array<{ after: unknown }>,
  where: null as unknown,
}))
vi.mock('./read-client.js', () => ({
  metaReadOne: vi.fn(async (_t: unknown, input: { path: string; query?: Record<string, unknown> }) => {
    const fields = String(input.query?.fields ?? '')
    h.reads.push({ path: input.path, fields })
    const body = h.answer(input.path, fields)
    if (body instanceof Error) throw body
    return { body, calls: 1 }
  }),
  metaReadAll: vi.fn(),
}))
vi.mock('./live.js', async (importActual) => ({
  ...(await importActual<typeof import('./live.js')>()),
  metaChosenAccount: vi.fn(async () => ({ connection: {}, connectionId: 'm-1', adAccountId: '1234567890', name: null, currency: 'EUR', timeZone: null, businessId: null, pageId: PAGE, instagramId: null })),
}))
vi.mock('../../../db.js', () => ({
  default: { agentChange: { findMany: vi.fn(async (args: { where: unknown }) => { h.where = args.where; return h.rows }) } },
}))

import { liveIxCanvas, nexusIxBodyOf } from './live-instant-experiences.js'
import { MetaReadError, localFailure } from './errors.js'

const CANVAS_READ = {
  id: CANVAS, name: 'Experience A', is_published: false, is_hidden: false, background_color: 'FFFFFFFF',
  body_elements: [{ id: '120000000000711' }, { element: { id: '120000000000712' } }],
  fb_body_elements: [{ id: '120000000000711' }, { id: '120000000000712' }, { element: { id: '120000000000713' } }],
}
const answers = (canvas: (fields: string) => unknown) => (path: string, fields: string) => (path === CANVAS && fields === 'id,owner' ? { id: CANVAS, owner: { id: PAGE } } : path === CANVAS ? canvas(fields) : {})

beforeEach(() => { h.reads = []; h.rows = []; h.where = null })

describe('an Instant Experience as a change reads it', () => {
  it('its parts from body_elements and fb_body_elements (a row\'s id or its element\'s), and the body Nexus last sent', async () => {
    h.answer = answers(() => CANVAS_READ)
    h.rows = [
      { after: { action: 'edit', pageId: PAGE, canvasId: CANVAS, fields: { name: 'Experience B' } } },
      { after: { action: 'edit', pageId: PAGE, canvasId: CANVAS, fields: { elementIds: ['120000000000711', '120000000000712', '120000000000713'] } } },
      { after: { action: 'create', pageId: PAGE, canvasId: CANVAS, bodyElementIds: ['120000000000711'] } },
    ]
    const canvas = await liveIxCanvas('m-1', CANVAS)
    expect(canvas).toMatchObject({
      canvasId: CANVAS, published: false, elementIds: ['120000000000711', '120000000000712'],
      fbElementIds: ['120000000000711', '120000000000712', '120000000000713'],
      sentElementIds: ['120000000000711', '120000000000712', '120000000000713'],
      sentElementTypes: null,
    })
    expect(h.reads[1].fields.split(',')).toEqual(expect.arrayContaining(['body_elements', 'fb_body_elements']))
    expect(h.where).toEqual({
      toolName: { in: ['create-meta-instant-experience', 'set-meta-instant-experience'] },
      AND: [{ after: { path: ['canvasId'], equals: CANVAS } }, { after: { path: ['pageId'], equals: PAGE } }],
    })
  })
  it('fb_body_elements refused by Meta: dropped alone (the other fields stay); no record: nothing sent known', async () => {
    h.answer = answers((fields) => (fields.includes('fb_body_elements')
      ? new MetaReadError({ ...localFailure('Meta refused the read: (#100) Tried accessing nonexisting field (fb_body_elements) on node type (Canvas).', '100'), origin: 'meta' }, 'x')
      : { ...CANVAS_READ, fb_body_elements: undefined, hero_asset_instagram_media_id: '17900000000000001' }))
    const canvas = await liveIxCanvas('m-1', CANVAS)
    expect(canvas).toMatchObject({ elementIds: ['120000000000711', '120000000000712'], fbElementIds: null, sentElementIds: null, heroInstagramMediaId: '17900000000000001' })
    expect(canvas.fieldsNote).toMatch(/Meta refused fb_body_elements/)
  })
  it('the body Nexus sent: the newest record that sent one; anything that is not a list of ids is not taken', async () => {
    h.rows = [
      { after: { action: 'edit', pageId: PAGE, canvasId: CANVAS, fields: { elementIds: ['@1'] } } },
      { after: { action: 'hide', pageId: PAGE, canvasId: CANVAS, hidden: true } },
      { after: { action: 'create', pageId: PAGE, canvasId: CANVAS, bodyElementIds: ['120000000000711', '120000000000713'] } },
    ]
    expect(await nexusIxBodyOf(PAGE, CANVAS)).toEqual({ ids: ['120000000000711', '120000000000713'], types: null })
    h.rows = [{ after: { action: 'create', pageId: PAGE, canvasId: CANVAS, bodyElementIds: null } }]
    expect(await nexusIxBodyOf(PAGE, CANVAS)).toBeNull()
  })
  it('re-review #2 — the body Nexus sent comes with each part\'s type; an edit whose parts have no undo keeps its body in bodyElementIds; types that are not one per part are not taken', async () => {
    h.answer = answers(() => CANVAS_READ)
    h.rows = [
      { after: { action: 'edit', pageId: PAGE, canvasId: CANVAS, fields: { name: 'Experience B' }, bodyElementIds: ['120000000000711', '120000000000713'], bodyElementTypes: ['listed', 'templateVideo'] } },
      { after: { action: 'create', pageId: PAGE, canvasId: CANVAS, bodyElementIds: ['120000000000711'], bodyElementTypes: ['photo'] } },
    ]
    expect(await liveIxCanvas('m-1', CANVAS)).toMatchObject({ sentElementIds: ['120000000000711', '120000000000713'], sentElementTypes: ['listed', 'templateVideo'] })
    h.rows = [{ after: { action: 'create', pageId: PAGE, canvasId: CANVAS, bodyElementIds: ['120000000000711', '120000000000713'], bodyElementTypes: ['photo', null] } }]
    expect(await nexusIxBodyOf(PAGE, CANVAS)).toEqual({ ids: ['120000000000711', '120000000000713'], types: ['photo', null] })
    h.rows = [{ after: { action: 'create', pageId: PAGE, canvasId: CANVAS, bodyElementIds: ['120000000000711', '120000000000713'], bodyElementTypes: ['photo'] } }]
    expect(await nexusIxBodyOf(PAGE, CANVAS)).toEqual({ ids: ['120000000000711', '120000000000713'], types: null })
    h.rows = [{ after: { action: 'create', pageId: PAGE, canvasId: CANVAS, bodyElementIds: ['120000000000711'], bodyElementTypes: [7] } }]
    expect(await nexusIxBodyOf(PAGE, CANVAS)).toEqual({ ids: ['120000000000711'], types: null })
  })
})
