import { z } from 'zod'
import { brandingView, type BrandingBody, type BrandingView } from '@nexus/factory-domain/branding/contracts'
import { LOGO_CONTENT_TYPES } from '@nexus/factory-domain/branding/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../../record-panels/store'

/**
 * Branding's calls (B-W2b-161; apps/factory-api platform/branding): the company's branding, the save (the API asks a fresh
 * step-up: the container runs it through useStepUp), and a logo's upload (announced, its bytes straight to the store,
 * confirmed and checked by its first bytes: it becomes the logo only when the branding is saved). Every answer is checked
 * against factory-domain's own shapes.
 */

const seg = (value: string) => encodeURIComponent(value)

export const getBranding = (api: ApiClient, companyId: string): Promise<BrandingView> =>
  api.get('/branding', { query: { companyId }, schema: z.object({ branding: brandingView }) }).then((answer) => answer.branding)

export const saveBranding = (api: ApiClient, companyId: string, body: BrandingBody, idempotencyKey: string): Promise<{ branding: BrandingView; changed: string[] }> =>
  api.request('PUT', `/branding/${seg(companyId)}`, { body, schema: z.object({ branding: brandingView, changed: z.array(z.string()) }), idempotencyKey })

const announced = z.object({ file: z.object({ id: z.string() }).loose(), upload: presignedSchema })
const completed = z.object({ file: z.object({ id: z.string(), originalName: z.string() }).loose(), logo: z.object({ fileId: z.string(), contentType: z.enum(LOGO_CONTENT_TYPES) }) })

/** A picked logo: what the store is told, and its bytes. */
export interface PickedLogo {
  readonly name: string
  readonly contentType: string
  readonly size: number
  readonly bytes: ArrayBuffer
}

export async function pickedLogo(file: File): Promise<PickedLogo> {
  return { name: file.name, contentType: file.type, size: file.size, bytes: await file.arrayBuffer() }
}

/** Announces the logo, sends its bytes to the store, confirms it: its file id (not the company's logo until saved). */
export async function uploadLogo(api: ApiClient, companyId: string, logo: PickedLogo): Promise<{ fileId: string; name: string }> {
  const base = `/branding/${seg(companyId)}/logo`
  const sha256 = await sha256Hex(logo.bytes)
  const answer = await api.post(base, { body: { originalName: logo.name, contentType: logo.contentType, sizeBytes: logo.size, sha256 }, schema: announced, idempotencyKey: newIdempotencyKey() })
  await putToStore(answer.upload as Presigned, logo.bytes)
  const done = await api.post(`${base}/${seg(answer.file.id)}/complete`, { schema: completed, idempotencyKey: newIdempotencyKey() })
  return { fileId: done.logo.fileId, name: done.file.originalName }
}

/** A logo's public path as this browser reaches it (the API's `/branding/public/…` through `/api`). */
export const logoSrc = (path: string): string => `/api${path}`
