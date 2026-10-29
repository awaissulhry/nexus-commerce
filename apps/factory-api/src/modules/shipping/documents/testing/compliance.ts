import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Permission } from '@nexus/factory-domain/core/permissions'

/**
 * Test helpers (never imported by a route): a style revision's signed EU Declaration of Conformity and user information
 * put on file through the style compliance tab's own routes (announce, send to the file store, confirm: B-W1-20), so a
 * shipment of PPE may leave (B-W1-49). The app's test sessions are read from the `x-test-session` header; the session
 * named must hold TRAVEL_DOCUMENT_PERMISSIONS. Every PDF is made up.
 */

export const TRAVEL_DOCUMENT_PERMISSIONS: Permission[] = ['compliance.certificates.view', 'compliance.declarations.manage', 'files.read', 'files.upload']

export const madeUpPdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n% made-up signed document: ${text}\n%%EOF\n`)

async function expectStatus(answer: { statusCode: number; body: string }, status: number, what: string): Promise<Record<string, any>> {
  if (answer.statusCode !== status) throw new Error(`${what}: expected ${status}, got ${answer.statusCode} ${answer.body}`)
  return JSON.parse(answer.body) as Record<string, any>
}

/** One signed PDF of a style revision, in one language, on file (ISSUED, or a new version of it). */
export async function uploadComplianceDocument(
  app: FastifyInstance,
  session: string,
  input: { readonly styleId: string; readonly revisionId: string; readonly kind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'; readonly language: string; readonly body: Buffer },
): Promise<{ readonly documentId: string; readonly fileId: string }> {
  const headers = { 'x-test-session': session }
  const base = `/product/styles/${input.styleId}/compliance/documents`
  const announced = await expectStatus(
    await app.inject({
      method: 'POST',
      url: base,
      headers,
      payload: {
        revisionId: input.revisionId,
        kind: input.kind,
        language: input.language,
        originalName: `${input.kind.toLowerCase()}-${input.language}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: input.body.length,
        sha256: createHash('sha256').update(input.body).digest('hex'),
      },
    }),
    201,
    'announcing the signed PDF',
  )
  await expectStatus(await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: input.body }), 200, 'sending the signed PDF')
  await expectStatus(await app.inject({ method: 'POST', url: `${base}/${announced.document.id}/files/${announced.file.id}/complete`, headers }), 200, 'confirming the signed PDF')
  return { documentId: announced.document.id, fileId: announced.file.id }
}

/** The DoC and the leaflet of a style revision in one language (default Italian, the seeded orders' language). */
export async function fileTravelDocuments(app: FastifyInstance, session: string, styleId: string, revisionId: string, language = 'it'): Promise<void> {
  for (const kind of ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const) {
    await uploadComplianceDocument(app, session, { styleId, revisionId, kind, language, body: madeUpPdf(`${styleId} revision ${revisionId} ${kind} ${language}`) })
  }
}
