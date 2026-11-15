import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { DomainError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRIVACY_REQUESTS_MANAGE } from '@nexus/factory-domain/privacy/retention/permissions'
import { REQUEST_HELD_WORDS, type DataSubjectKind } from '@nexus/factory-domain/privacy/retention/requests'
import { writeZip, type ZipEntry } from '../../../modules/accounting/guest/zip'
import { command, type CommandCaller } from '../../../core/command'
import { downloadFile, putGeneratedFile, recordGeneratedFile, storeCall, systemCallerOf } from '../../files/files'
import { processFiles, type FilesRuntime } from '../../files/service'
import { defineHandler, type EventHandler } from '../../outbox/dispatch'
import { sourcesFor } from '../erasure/sources'
import { personFacts } from '../erasure/sources/person'
import type { Section } from '../erasure/sources/type'
import { COLLECT_ACTIONS, readRequest, REQUEST_SELECT } from './read'
import { emitChange } from './requests'

/**
 * A person's data package (B-W2b-405; PLT-202; PV1:03; GDPR arts. 15, 20; design admin.privacy "Collect data (background job)"):
 * every record, message and file about the person, in one ZIP, a file of the request. The worker's handler
 * `privacy.collectPackage`, on privacy.request_collect_asked, in the request's tenant's system scope:
 *
 *   1. the person's data from every source of their kind (erasure/sources/*.ts): each section as JSON (sections/<key>.json, and
 *      all of them in data.json, machine-readable for art. 20), at most 2000 rows each, oldest first (a longer list says so);
 *   2. the AVAILABLE files of the records the sources name (their photos, the documents they sent, the mails' attachments), read
 *      from the store and checked against their SHA-256 (files/<nnn>-<name>); a file the store does not give as kept is left out
 *      and named (README.txt, data.json `missingFiles`): the person gets the rest now; README.txt says what is in it; SHA256SUMS.txt;
 *   3. ONE command: the ZIP recorded as the request's file (office only, read only through the privacy routes), the request's
 *      package set (an earlier package of the request is deleted), the audit row, privacy.request_changed PACKAGE_READY.
 * A refusal in words (more than 25 MiB or 200 files) → an audit row with why and PACKAGE_FAILED;
 * nothing changes on the request. Any other failure is retried; after the last attempt → PACKAGE_FAILED "stopped".
 *
 * Health records (art. 9) are opened only where each opening is recorded (Safety › Health): not in the package (named in it).
 */

export const COLLECT_HANDLER = 'privacy.collectPackage'
export const COLLECT_ATTEMPTS = 3
export const PACKAGE_LIMITS = Object.freeze({ zipBytes: 25 * 1024 * 1024, files: 200 })

class Refused extends DomainError {
  override name = 'Refused'
  constructor(message: string) {
    super('invalid_state', message)
  }
}

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const safeName = (name: string): string => name.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120) || 'file'

function readme(person: { kind: string; name: string }, madeAt: Date, sections: readonly Section[], files: number, missing: readonly { name: string }[]): string {
  return [
    'Your personal data (GDPR arts. 15 and 20)',
    '',
    `Made: ${toUtcIso(madeAt)}`,
    `Person: ${person.name} (${person.kind.toLowerCase()})`,
    '',
    'data.json holds every section below in one machine-readable file; sections/ holds them one by one; files/ holds the files',
    'about you (photos, documents you sent, attachments of your mails). SHA256SUMS.txt lets you check nothing changed.',
    '',
    'Sections:',
    ...sections.map((entry) => `  ${entry.key}.json  ${entry.title}: ${entry.rows.length} ${entry.rows.length === 1 ? 'row' : 'rows'}${entry.truncated ? ' (the oldest 2000; ask for the rest)' : ''}`),
    `Files: ${files}`,
    ...(missing.length === 0 ? [] : ['', 'Files we hold a record of but could not read from the store (ask the company for them):', ...missing.map((file) => `  ${file.name}`)]),
    '',
    'Not in this package: health surveillance records, which are opened only where each opening is recorded; ask the company and',
    'they are handed to you in person. Who keeps your data, why and for how long: the company privacy notice (/privacy/<company>).',
    '',
  ].join('\n')
}

/** packageFailed: an audit row with why and PACKAGE_FAILED; nothing changes on the request. */
async function failPackage(caller: CommandCaller, requestId: string, reason: string, causationId?: string): Promise<'failed'> {
  await command(caller, { name: COLLECT_ACTIONS.failed, input: { requestId, reason }, causationId }, async (tools) => {
    const request = await tools.tx.dataRequest.findUniqueOrThrow({ where: { id: requestId }, select: { id: true, companyId: true, kind: true, personKind: true, status: true } })
    tools.audit({ recordType: 'DataRequest', recordId: requestId, companyId: request.companyId, after: { failedAt: toUtcIso(tools.now) }, reason: reason.slice(0, 500) })
    emitChange(tools, request, request.status, 'PACKAGE_FAILED')
    return null
  })
  return 'failed'
}

export interface CollectWork {
  readonly files?: FilesRuntime
  readonly lastAttempt?: boolean
  readonly causationId?: string
}

/** Collects one request's package (the handler's work; tests call it too). */
export async function collectPackage(caller: CommandCaller, requestId: string, work: CollectWork = {}): Promise<'built' | 'failed' | 'settled'> {
  const request = await caller.withClient((db) => db.dataRequest.findUnique({ where: { id: requestId }, select: REQUEST_SELECT }))
  if (!request || request.kind !== 'ACCESS' || request.status !== 'IN_PROGRESS') return 'settled'
  try {
    const files = work.files ?? processFiles()
    const now = files.clock.now()
    const collected = await caller.withClient(async (db) => {
      const person = await personFacts(db, request.personKind as DataSubjectKind, request.personRecordType, request.personRecordId)
      if (!person) throw new Refused("The person's record is no longer there: nothing to collect.")
      const sections: Section[] = []
      const records: Array<{ recordType: string; recordId: string }> = []
      for (const source of sourcesFor(person.kind)) {
        const part = await source.collect(db, person)
        sections.push(...part.sections)
        records.push(...part.fileRecords)
      }
      const stored = records.length === 0 ? [] : await db.storedFile.findMany({
        where: { status: 'AVAILABLE', OR: records.map((record) => ({ recordType: record.recordType, recordId: record.recordId })) },
        select: { id: true, recordType: true, recordId: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, storeAccountId: true, storageKey: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      return { person, sections, stored }
    })
    if (collected.stored.length > PACKAGE_LIMITS.files) throw new Refused(`More than ${PACKAGE_LIMITS.files} files are about this person: the package holds at most ${PACKAGE_LIMITS.files}. Hand the rest over from their records.`)

    const entries: ZipEntry[] = []
    let total = 0
    for (const entry of collected.sections) {
      const bytes = Buffer.from(JSON.stringify({ key: entry.key, title: entry.title, truncated: entry.truncated, rows: entry.rows }, null, 2), 'utf8')
      entries.push({ path: `sections/${entry.key}.json`, bytes })
      total += bytes.length
    }
    // A file the store does not give as it was kept (gone, or changed) is left out and named: the person gets the rest now.
    const missing: Array<{ name: string; recordType: string; recordId: string }> = []
    let added = 0
    for (const file of collected.stored) {
      if (total + file.sizeBytes > PACKAGE_LIMITS.zipBytes) throw new Refused(`The person's records and files together are larger than ${PACKAGE_LIMITS.zipBytes / 1024 / 1024} MiB, the most one package holds: hand the largest files over from their records.`)
      const bytes = await storeCall(() => files.storage.read(caller, file.storeAccountId, file.storageKey, file.sizeBytes))
      if (!bytes || sha(bytes) !== file.sha256) {
        missing.push({ name: file.originalName, recordType: file.recordType, recordId: file.recordId })
        continue
      }
      total += file.sizeBytes
      added += 1
      entries.push({ path: `files/${String(added).padStart(3, '0')}-${safeName(file.originalName)}`, bytes })
    }
    const data = Buffer.from(JSON.stringify({ madeAt: toUtcIso(now), person: { kind: collected.person.kind, recordType: collected.person.recordType, recordId: collected.person.recordId, name: collected.person.name }, sections: collected.sections, missingFiles: missing }, null, 2), 'utf8')
    const text = Buffer.from(readme(collected.person, now, collected.sections, added, missing), 'utf8')
    const all: ZipEntry[] = [{ path: 'README.txt', bytes: text }, { path: 'data.json', bytes: data }, ...entries]
    const sums = all.map((entry) => `${sha(entry.bytes)}  ${entry.path}`).join('\n')
    const zip = writeZip([...all, { path: 'SHA256SUMS.txt', bytes: Buffer.from(`${sums}\n`, 'utf8') }], now)
    if (zip.length > PACKAGE_LIMITS.zipBytes) throw new Refused(`The package would be larger than ${PACKAGE_LIMITS.zipBytes / 1024 / 1024} MiB: hand the largest files over from their records.`)
    const day = businessDate(now)
    const prepared = await putGeneratedFile(files, caller, { companyId: request.companyId, recordType: 'DataRequest', recordId: request.id, kind: 'DOCUMENT', originalName: `personal-data-${day}.zip`, contentType: 'application/zip', body: zip, visibility: ['OFFICE'] })

    await command(caller, { name: COLLECT_ACTIONS.ready, input: { requestId, sha256: prepared.sha256 }, causationId: work.causationId, record: { type: 'DataRequest', id: requestId } }, async (tools) => {
      const current = await tools.tx.dataRequest.findUniqueOrThrow({ where: { id: requestId }, select: { status: true, packageFileId: true } })
      if (current.status !== 'IN_PROGRESS') throw new InvalidStateError(REQUEST_HELD_WORDS.CLOSED)
      const file = await recordGeneratedFile(tools, prepared, { details: { documentType: 'PERSONAL_DATA_PACKAGE', sections: collected.sections.length, files: added, missingFiles: missing.length } })
      await tools.tx.dataRequest.update({ where: { id: requestId }, data: { packageFileId: file.id, updatedAt: tools.now }, select: { id: true } })
      // The earlier package of the request goes (a person's data is not kept twice).
      if (current.packageFileId) await tools.tx.storedFile.updateMany({ where: { id: current.packageFileId, status: 'AVAILABLE' }, data: { status: 'DELETED', deletedAt: tools.now } })
      tools.audit({ recordType: 'DataRequest', recordId: requestId, companyId: request.companyId, before: { packageFileId: current.packageFileId }, after: { packageFileId: file.id, sections: collected.sections.length, files: added, missingFiles: missing.length, sha256: prepared.sha256 } })
      emitChange(tools, request, 'IN_PROGRESS', 'PACKAGE_READY')
      return null
    })
    return 'built'
  } catch (error) {
    if (error instanceof InvalidStateError) return 'settled'
    if (error instanceof Refused) return failPackage(caller, requestId, error.message, work.causationId)
    if (work.lastAttempt) return failPackage(caller, requestId, 'The collection stopped before it ended: collect the package again.', work.causationId)
    throw error
  }
}

/** The worker's handler (background.ts): one collection per ask. */
export function collectPackageHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: COLLECT_HANDLER,
      events: ['privacy.request_collect_asked'],
      attempts: COLLECT_ATTEMPTS,
      async handle(event, { caller, attempt }) {
        const { requestId } = event.payload as { requestId: string }
        await collectPackage(caller, requestId, { lastAttempt: attempt >= COLLECT_ATTEMPTS, causationId: event.eventId })
      },
    }),
  ]
}

/** GET /privacy/requests/:requestId/package: a link to download the package (60 seconds); the read log records it (DOWNLOAD). */
export async function packageDownload(request: FastifyRequest, requestId: string) {
  const { request: row } = await readRequest(request, requestId, PRIVACY_REQUESTS_MANAGE)
  if (!row.packageFileId || row.packageFile?.status !== 'AVAILABLE') throw new InvalidStateError(REQUEST_HELD_WORDS.NO_PACKAGE)
  return { download: await downloadFile(processFiles(), { caller: request, system: systemCallerOf(request) }, row.packageFileId, { viaModule: true }) }
}
