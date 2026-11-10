import { z } from 'zod'
import { scanView, techPackPdfView, techPackView, versionsView, type ScanView, type TechPackPdfView, type TechPackView } from '@nexus/factory-domain/product/techpack/contracts'
import type { TechPackAudience, TechPackLanguage, TechPackSection } from '@nexus/factory-domain/product/techpack/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The tech pack's calls (B-W2b-243 on the API of B-W2b-230; SCR-305 the Style › Tech pack tab, SCR-306 the PDF window), each
 * answer checked against the API's own contract (factory-domain product/techpack/contracts):
 *
 *   GET  …/tech-pack?audience&language&sections&companyId   the live view of the revision for an audience (the preview: what
 *                                                         that audience never gets is ABSENT from the answer, left out on
 *                                                         the server)
 *   POST …/tech-pack/pdf                                    Make tech pack PDF (201 a new version; 200 `made: false`: the
 *                                                         newest of that audience and language says the same)
 *   GET  …/tech-pack/versions                               every stored version of the revision
 *   GET  …/tech-pack/versions/:documentId/pdf               one version's PDF (a plain link cannot send the company header,
 *                                                         so the window reads the bytes)
 *   GET  /product/tech-packs/scan/:code                     a printed page's QR: which version it is, and whether a newer
 *                                                         one exists
 *
 * A tenant-wide style's copy is the page's company's (`companyId`).
 */

export type { ScanView, TechPackPdfView, TechPackView }
export type TechPackVersion = z.infer<typeof versionsView>['versions'][number]
export type TechPackBomLine = NonNullable<TechPackView['bom']>['sections'][number]['lines'][number]
export type TechPackPicture = NonNullable<TechPackView['sketches']>[number]

const enc = encodeURIComponent
const base = (styleId: string, revisionId: string) => `/product/styles/${enc(styleId)}/revisions/${enc(revisionId)}/tech-pack`

export interface TechPackAsk {
  audience: TechPackAudience
  language: TechPackLanguage
  /** Left out: every section. */
  sections?: readonly TechPackSection[]
  /** A tenant-wide style's company (the page's). */
  companyId?: string | null
}

const live = z.object({ techPack: techPackView })

export function getTechPack(api: ApiClient, styleId: string, revisionId: string, ask: TechPackAsk, signal?: AbortSignal): Promise<TechPackView> {
  return api
    .get(base(styleId, revisionId), {
      query: { audience: ask.audience, language: ask.language, sections: ask.sections && ask.sections.length > 0 ? ask.sections.join(',') : undefined, companyId: ask.companyId ?? undefined },
      schema: live,
      signal,
    })
    .then((answer) => answer.techPack)
}

export interface MakePdfInput {
  audience: TechPackAudience
  language: TechPackLanguage
  sections: readonly TechPackSection[]
  /** The party a partner copy is for (printed on the cover); a private-label style's brand copy names its brand. */
  partyId: string | null
  companyId: string | null
}

const made = z.object({ pdf: techPackPdfView })

export function makeTechPackPdf(api: ApiClient, styleId: string, revisionId: string, input: MakePdfInput): Promise<TechPackPdfView> {
  return api
    .post(`${base(styleId, revisionId)}/pdf`, {
      body: { audience: input.audience, language: input.language, sections: [...input.sections], ...(input.partyId ? { partyId: input.partyId } : {}), ...(input.companyId ? { companyId: input.companyId } : {}) },
      schema: made,
      idempotencyKey: newIdempotencyKey(),
    })
    .then((answer) => answer.pdf)
}

export function listTechPackVersions(api: ApiClient, styleId: string, revisionId: string, signal?: AbortSignal): Promise<TechPackVersion[]> {
  return api.get(`${base(styleId, revisionId)}/versions`, { schema: versionsView, signal }).then((answer) => answer.versions)
}

/** One version's PDF (stored; inline). */
export function techPackPdfBytes(api: ApiClient, styleId: string, revisionId: string, documentId: string, signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`${base(styleId, revisionId)}/versions/${enc(documentId)}/pdf`, { signal })
}

const scanned = z.object({ scan: scanView })

export function scanTechPack(api: ApiClient, code: string, signal?: AbortSignal): Promise<ScanView> {
  return api.get(`/product/tech-packs/scan/${enc(code)}`, { schema: scanned, signal }).then((answer) => answer.scan)
}

/** A party a partner copy may be for (parties.view): a workshop or supplier for the subcontractor copy, a customer or brand for the brand copy. */
const partyRow = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })
export type CopyPartyRow = z.infer<typeof partyRow>
const partyPage = z.object({ parties: z.array(partyRow) })

export function listCopyParties(api: ApiClient, audience: Exclude<TechPackAudience, 'INTERNAL'>, companyId: string | null): Promise<CopyPartyRow[]> {
  return api
    .get('/parties', { query: { role: audience === 'BRAND' ? 'CUSTOMER,BRAND' : 'SUBCONTRACTOR,SUPPLIER', status: 'ACTIVE', companyId: companyId ?? undefined, limit: 200 }, schema: partyPage })
    .then((answer) => answer.parties)
}
