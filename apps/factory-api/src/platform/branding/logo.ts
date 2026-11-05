import type { FactoryClient } from '@nexus/factory-db'
import { BRANDING_RECORD_TYPE, LOGO_FILE_KIND, LOGO_MAX_BYTES, logoTypeOf, type LogoContentType } from '@nexus/factory-domain/branding/rules'
import type { DocumentLogo } from '@nexus/factory-domain/documents/model'
import type { CommandCaller } from '../../core/command'
import { processFiles } from '../files/service'

/**
 * A company's logo as bytes (B-W2b-161): what the documents' PDF draws (platform/documents companyLegalOf → pdf.ts) and
 * what the public logo route serves (GET /branding/public/:companyId/logo/:fileId).
 *
 * A logo is a StoredFile of record CompanyBranding (the company's id), kind PHOTO, AVAILABLE, PNG or JPEG by its first
 * bytes, at most 1 MiB. Its bytes come from the file store through the gateway (files.read: one IntegrationCall row) with
 * an office or a system caller, never inside a command's transaction. A stored object never changes (files: content
 * columns are fixed, a new logo is a new file), so the bytes are kept in this process by tenant and file id: a company's
 * hundredth PDF or portal page reads nothing from the store.
 */

export interface LogoBytes {
  readonly bytes: Buffer
  readonly contentType: LogoContentType
}

/** What the store call needs of a logo's file row. */
export interface LogoFile {
  readonly id: string
  readonly storeAccountId: string
  readonly storageKey: string
  readonly sizeBytes: number
}

const CACHE_LIMIT = 48
const cache = new Map<string, LogoBytes>()

const cacheKey = (tenantId: string, fileId: string) => `${tenantId}:${fileId}`

/** The bytes kept for a logo, newest use last (a Map keeps insertion order: the oldest entry goes first). */
function remember(key: string, logo: LogoBytes): LogoBytes {
  cache.delete(key)
  cache.set(key, logo)
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  return logo
}

/** Forget every kept logo (tests). */
export function forgetLogos(): void {
  cache.clear()
}

/** The tenant of an office or system caller; null for any other (they never read the store). */
export function storeTenantOf(caller: CommandCaller): string | null {
  const context = caller.factoryContext
  return context && (context.audience === 'office' || context.audience === 'system') ? context.tenantId : null
}

/**
 * The logo's bytes: kept, else read from the store with this office or system caller (outside any transaction) and
 * checked by their first bytes. Null when the file is missing, not a PNG or JPEG, too large, or the store does not answer.
 */
export async function logoBytes(caller: CommandCaller, file: LogoFile): Promise<LogoBytes | null> {
  const tenantId = storeTenantOf(caller)
  if (!tenantId) return null
  const key = cacheKey(tenantId, file.id)
  const kept = cache.get(key)
  if (kept) return remember(key, kept)
  if (file.sizeBytes > LOGO_MAX_BYTES) return null
  try {
    const bytes = await processFiles().storage.read(caller, file.storeAccountId, file.storageKey, LOGO_MAX_BYTES)
    const contentType = bytes ? logoTypeOf(bytes) : null
    return bytes && contentType ? remember(key, { bytes, contentType }) : null
  } catch {
    return null
  }
}

const LOGO_FILE = { id: true, storeAccountId: true, storageKey: true, sizeBytes: true, status: true, kind: true, recordType: true, recordId: true, companyId: true, contentType: true } as const

/** A logo file of the company, usable as it is stored: AVAILABLE, a PHOTO of record CompanyBranding of this company. */
export async function usableLogoFile(client: Pick<FactoryClient, 'storedFile'>, companyId: string, fileId: string): Promise<(LogoFile & { readonly contentType: string }) | null> {
  const row = await client.storedFile.findUnique({ where: { id: fileId }, select: LOGO_FILE })
  if (!row || row.status !== 'AVAILABLE' || row.kind !== LOGO_FILE_KIND || row.recordType !== BRANDING_RECORD_TYPE || row.recordId !== companyId || row.companyId !== companyId) return null
  return { id: row.id, storeAccountId: row.storeAccountId, storageKey: row.storageKey, sizeBytes: row.sizeBytes, contentType: row.contentType }
}

/**
 * The company's logo for its documents (platform/documents companyLegalOf), read in the caller's own scope: only an office
 * or a system caller reads the branding (its table has no floor or partner grant, and a refused read would end the
 * caller's transaction). The bytes are read only when the PDF is painted (`load`).
 */
export async function documentLogoIn(client: Pick<FactoryClient, 'companyBranding' | 'storedFile'>, caller: CommandCaller, companyId: string): Promise<DocumentLogo | null> {
  if (!storeTenantOf(caller)) return null
  const branding = await client.companyBranding.findUnique({ where: { id: companyId }, select: { companyId: true, logoFileId: true } })
  if (!branding || branding.companyId !== companyId || !branding.logoFileId) return null
  const file = await usableLogoFile(client, companyId, branding.logoFileId)
  if (!file) return null
  return { fileId: file.id, load: async () => (await logoBytes(caller, file))?.bytes ?? null }
}
