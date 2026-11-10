import { z } from 'zod'
import { brandingSetsView, brandingSetView, type AddSetFileBody, type CreateSetBody, type UpdateSetBody } from '@nexus/factory-domain/product/branding-sets/contracts'
import type { BrandingFileRole } from '@nexus/factory-domain/product/branding-sets/rules'
import { colourCountsView, colourLibraryRow, colourLibraryView, type CreateColourBody, type UpdateColourBody } from '@nexus/factory-domain/product/colours/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { downloadLink, presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import type { BrandChoice, BrandingSetRow, BrandingSetView, ColourCountsView, ColourLibraryRow, SetView } from './model'

/**
 * Products › Colours & artwork (B-W2b-247): every call of the page, each answer checked against factory-domain's own
 * contracts (apps/factory-api modules/product/colours and branding-sets). A colour's photo and a set's logos and artwork
 * are files of the colour or the set: announced (`POST /files`), PUT to the store with the presigned request, confirmed
 * (`POST /files/<id>/complete`); a picture is drawn from the API's own address (`/product/colours/pictures/<id>`), never a
 * presigned store address per picture.
 */

export type ColourPage = z.infer<typeof colourLibraryView>

const colourAnswer = z.object({ colour: colourLibraryRow })
const setAnswer = z.object({ set: brandingSetView })

export const listColours = (api: ApiClient, query: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<ColourPage> =>
  api.get('/product/colours/library', { query, schema: colourLibraryView, signal })

export const colourCounts = (api: ApiClient, signal?: AbortSignal): Promise<ColourCountsView> => api.get('/product/colours/counts', { schema: colourCountsView, signal })

export const createColour = (api: ApiClient, body: CreateColourBody): Promise<ColourLibraryRow> =>
  api.post('/product/colours', { body, schema: colourAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.colour)

export const updateColour = (api: ApiClient, id: string, body: UpdateColourBody): Promise<ColourLibraryRow> =>
  api.request('PATCH', `/product/colours/${encodeURIComponent(id)}`, { body, schema: colourAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.colour)

export const setColourStatus = (api: ApiClient, row: Pick<ColourLibraryRow, 'id' | 'version'>, to: 'archive' | 'restore', reason?: string): Promise<ColourLibraryRow> =>
  api
    .post(`/product/colours/${encodeURIComponent(row.id)}/${to}`, { body: { version: row.version, ...(reason ? { reason } : {}) }, schema: colourAnswer, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.colour)

/** A picture file of a record: announced, sent, confirmed. Answers its id and whether it is available (a scanner may hold it). */
async function uploadFile(api: ApiClient, record: { type: string; id: string; companyId: string | null }, file: File, kind: 'PHOTO' | 'DOCUMENT'): Promise<{ fileId: string; available: boolean }> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post('/files', {
    body: { companyId: record.companyId, recordType: record.type, recordId: record.id, kind, originalName: file.name, contentType: file.type, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: z.object({ file: z.object({ id: z.string() }), upload: presignedSchema }),
    idempotencyKey: newIdempotencyKey(),
  })
  await putToStore(announced.upload, bytes)
  const done = await api.post(`/files/${encodeURIComponent(announced.file.id)}/complete`, { body: {}, schema: z.object({ file: z.object({ id: z.string(), status: z.string() }) }), idempotencyKey: newIdempotencyKey() })
  return { fileId: announced.file.id, available: done.file.status === 'AVAILABLE' }
}

/** A colour's photo: a PHOTO file of the colour (the newest one is its photo). */
export const uploadColourPhoto = (api: ApiClient, row: Pick<ColourLibraryRow, 'id' | 'companyId'>, file: File) => uploadFile(api, { type: 'Colour', id: row.id, companyId: row.companyId }, file, 'PHOTO')

export const listSets = (api: ApiClient, sets: SetView, signal?: AbortSignal): Promise<BrandingSetRow[]> =>
  api.get('/product/branding-sets', { query: { status: sets === 'active' ? 'ACTIVE' : sets === 'archived' ? 'ARCHIVED' : 'ALL' }, schema: brandingSetsView, signal }).then((answer) => answer.sets)

export const getSet = (api: ApiClient, id: string, signal?: AbortSignal): Promise<BrandingSetView> => api.get(`/product/branding-sets/${encodeURIComponent(id)}`, { schema: setAnswer, signal }).then((answer) => answer.set)

export const createSet = (api: ApiClient, body: CreateSetBody): Promise<BrandingSetView> =>
  api.post('/product/branding-sets', { body, schema: setAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.set)

export const updateSet = (api: ApiClient, id: string, body: UpdateSetBody): Promise<BrandingSetView> =>
  api.request('PATCH', `/product/branding-sets/${encodeURIComponent(id)}`, { body, schema: setAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.set)

export const addSetFile = (api: ApiClient, id: string, body: AddSetFileBody): Promise<BrandingSetView> =>
  api.post(`/product/branding-sets/${encodeURIComponent(id)}/files`, { body, schema: setAnswer, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.set)

export const setSetStatus = (api: ApiClient, set: Pick<BrandingSetRow, 'id' | 'version'>, to: 'archive' | 'restore', reason?: string): Promise<BrandingSetView> =>
  api
    .post(`/product/branding-sets/${encodeURIComponent(set.id)}/${to}`, { body: { version: set.version, ...(reason ? { reason } : {}) }, schema: setAnswer, idempotencyKey: newIdempotencyKey() })
    .then((answer) => answer.set)

/** A logo (a picture) or label artwork (a picture or a PDF) of the set: sent as a file of the set, then named in it. */
export async function uploadSetFile(api: ApiClient, set: Pick<BrandingSetView, 'id' | 'companyId' | 'version'>, file: File, role: BrandingFileRole): Promise<BrandingSetView> {
  const kind = file.type.startsWith('image/') ? 'PHOTO' : 'DOCUMENT'
  const sent = await uploadFile(api, { type: 'BrandingSet', id: set.id, companyId: set.companyId }, file, kind)
  return addSetFile(api, set.id, { version: set.version, fileId: sent.fileId, role })
}

const brandsAnswer = z.object({
  brands: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), active: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string() })) })),
})

/** The customers and brands a new set may be for (20 at a time, by code), each with the sets it has in use. */
export const findBrands = (api: ApiClient, q: string, signal?: AbortSignal): Promise<BrandChoice[]> =>
  api.get('/product/branding-sets/brands', { query: { q: q.trim() || undefined }, schema: brandsAnswer, signal }).then((answer) => answer.brands)

const materialsAnswer = z.object({ materials: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() })) })

/** The materials a packaging rule may name: active packaging, labels and trims (200 by code). */
export const packagingMaterials = (api: ApiClient, signal?: AbortSignal): Promise<Array<{ id: string; code: string; name: string; kind: string }>> =>
  api.get('/product/materials', { query: { kind: 'PACKAGING,LABEL,TRIM', status: 'ACTIVE', limit: 200 }, schema: materialsAnswer, signal }).then((answer) => answer.materials)

/** The active colours a set may name (200 by code). */
export const activeColours = (api: ApiClient, signal?: AbortSignal): Promise<ColourLibraryRow[]> => listColours(api, { view: 'active', limit: 200 }, signal).then((page) => page.colours)

/** A document of a set (a PDF artwork): a presigned download, opened in a new tab on the person's click. */
export const openDocument = (api: ApiClient, fileId: string): Promise<string> => downloadLink(api, fileId).then((answer) => answer.download.url)
