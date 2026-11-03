import { createHash } from 'node:crypto'
import type { FactoryClient } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { tenantOf } from '../../shipping/cells'
import { namesOf } from '../amendments/records'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'

/**
 * The versions of a quality document (B-W2b-123; factory-db gendocs.prisma GeneratedDocument, B-W2b-79: INSPECTION_REPORT of
 * an Inspection, CERTIFICATE_OF_CONFORMITY of a Shipment), kept as the claim letter and the 8D are (B-W2b-14, -108):
 *
 *   1. the document composed and its fingerprint (SHA-256 of everything it says but its date, the banner and, for the
 *      certificate, who issued it); the same as the newest version (same language): nothing is written, it comes back
 *      (made false); the same as an earlier one: a new version naming that version's file; else the PDF is put in the
 *      file store OUTSIDE any transaction (putGeneratedFile), a DOCUMENT of the record seen by the office only;
 *   2. ONE command (the caller's): the document's advisory lock `factory.quality-document|<tenant>|<record>|<kind>`, the
 *      versions read again (made meanwhile with the same contents: that one), the next version, the StoredFile row, the
 *      GeneratedDocument row, the audit row on the record and the module's event.
 *
 * Sharing a version with the customer is ./share.ts (a copy on a shipment's documents link): the version's own file never
 * leaves the office.
 */

export type DocumentKind = 'INSPECTION_REPORT' | 'CERTIFICATE_OF_CONFORMITY'
export type Reader = FactoryClient | CommandTx

export interface DocumentRecord {
  readonly recordType: 'Inspection' | 'Shipment'
  readonly recordId: string
  readonly companyId: string
  readonly siteId: string
  /** The number printed on it (the inspection's, the shipment's). */
  readonly number: string
}

const VERSION_COLUMNS = { id: true, version: true, fingerprint: true, language: true, number: true, fileId: true, createdAt: true, createdById: true } as const

export async function readVersions(db: Reader, record: Pick<DocumentRecord, 'recordType' | 'recordId'>, kind: DocumentKind) {
  return db.generatedDocument.findMany({ where: { recordType: record.recordType, recordId: record.recordId, kind }, select: VERSION_COLUMNS, orderBy: { version: 'desc' } })
}

/** One keep of a record's document at a time. */
export async function lockDocument(tx: CommandTx, tenantId: string, recordId: string, kind: DocumentKind): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.quality-document', ${tenantId}::uuid, ${recordId}::uuid, ${kind}::text), 0))`
}

export const fingerprintOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export interface PreparedVersion {
  readonly fingerprint: string
  readonly language: string
  /** The newest version already says exactly this. */
  readonly current: { readonly id: string; readonly version: number; readonly fileId: string } | null
  /** An earlier version said exactly this: its file is named again. */
  readonly earlierFileId: string | null
  readonly file: PreparedGeneratedFile | null
}

/** Step 1, OUTSIDE any transaction (the store put): see the file's comment. */
export async function prepareVersion(
  files: FilesRuntime,
  caller: CommandCaller,
  record: DocumentRecord,
  kind: DocumentKind,
  composed: { readonly fingerprintText: string; readonly language: string; readonly fileName: string; readonly render: () => Promise<Buffer> },
): Promise<PreparedVersion> {
  const fingerprint = fingerprintOf(composed.fingerprintText)
  const versions = await caller.withClient((client) => readVersions(client, record, kind))
  const same = (version: { fingerprint: string; language: string }) => version.fingerprint === fingerprint && version.language === composed.language
  const newest = versions[0]
  if (newest && same(newest)) return { fingerprint, language: composed.language, current: { id: newest.id, version: newest.version, fileId: newest.fileId }, earlierFileId: null, file: null }
  const earlier = versions.find(same)
  if (earlier) return { fingerprint, language: composed.language, current: null, earlierFileId: earlier.fileId, file: null }
  const file = await putGeneratedFile(files, caller, {
    companyId: record.companyId,
    recordType: record.recordType,
    recordId: record.recordId,
    kind: 'DOCUMENT',
    originalName: composed.fileName,
    contentType: 'application/pdf',
    body: await composed.render(),
    // The office's: the customer gets a copy on a shipment's documents link (./share.ts).
    visibility: ['OFFICE'],
  })
  return { fingerprint, language: composed.language, current: null, earlierFileId: null, file }
}

export interface KeptVersion {
  readonly id: string
  readonly version: number
  readonly fileId: string
  readonly made: boolean
}

/** Step 2, INSIDE the caller's command: see the file's comment. `made` tells the caller to audit and emit. */
export async function keepVersionInCommand(tools: CommandTools, record: DocumentRecord, kind: DocumentKind, prepared: PreparedVersion): Promise<KeptVersion> {
  const { tx, now, context } = tools
  if (prepared.current) return { ...prepared.current, made: false }
  await lockDocument(tx, tenantOf(context), record.recordId, kind)
  const last = (await readVersions(tx, record, kind))[0]
  // Made meanwhile with the same contents: that one.
  if (last && last.fingerprint === prepared.fingerprint && last.language === prepared.language) return { id: last.id, version: last.version, fileId: last.fileId, made: false }
  const fileId = prepared.file ? (await recordGeneratedFile(tools, prepared.file, { details: { documentType: kind, number: record.number, language: prepared.language } })).id : prepared.earlierFileId!
  const id = newId()
  const version = (last?.version ?? 0) + 1
  await tx.generatedDocument.create({
    data: { id, companyId: record.companyId, siteId: record.siteId, recordType: record.recordType, recordId: record.recordId, kind, version, fingerprint: prepared.fingerprint, language: prepared.language, number: record.number, fileId, createdAt: now, createdById: context.audience === 'office' ? context.actorId : null },
    select: { id: true },
  })
  tools.audit({
    action: kind === 'INSPECTION_REPORT' ? 'quality.keepInspectionReport' : 'quality.keepConformityCertificate',
    recordType: record.recordType,
    recordId: record.recordId,
    companyId: record.companyId,
    siteId: record.siteId,
    after: { generatedDocumentId: id, kind, version, language: prepared.language, fileId, fingerprint: prepared.fingerprint, reused: prepared.file === null },
  })
  return { id, version, fileId, made: true }
}

/** A version as the answers show it (its maker by name). */
export const versionView = (row: Awaited<ReturnType<typeof readVersions>>[number], names: ReadonlyMap<string, string>) => ({
  id: row.id,
  version: row.version,
  language: row.language,
  number: row.number,
  fileId: row.fileId,
  createdAt: toUtcIso(row.createdAt),
  createdBy: row.createdById ? { id: row.createdById, name: names.get(row.createdById) ?? null } : null,
})

/** One kept version as the answers show it. */
export async function keptVersionView(caller: CommandCaller, record: Pick<DocumentRecord, 'recordType' | 'recordId'>, kind: DocumentKind, id: string) {
  return caller.withClient(async (db) => {
    const row = (await readVersions(db, record, kind)).find((version) => version.id === id)!
    return versionView(row, await namesOf(db, [row.createdById]))
  })
}
