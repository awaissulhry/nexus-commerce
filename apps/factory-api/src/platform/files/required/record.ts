import type { Prisma } from '@nexus/factory-db'
import { FILES_READ, FILES_UPLOAD } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { dayOf, daysUntil, expiryDateProblem, expiryStateOf } from '@nexus/factory-domain/files/expiry/rules'
import { isRequiredRecordType, REQUIRED_RECORD_TYPES, requirementStates, rulesThatApply, type DocumentCategory } from '@nexus/factory-domain/files/required/rules'
import { isCurrentVersion } from '@nexus/factory-domain/files/versions/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, mayWrite, readOffice } from '../files'
import { assertGenericPath, readsThroughModule } from '../owned'
import { activeRulesOf, documentsOf, recordFactsOf, type DocumentRow } from './check'
import type { documentView } from './contract'
import type { z } from 'zod'
import { closeAnsweredExpiryTasks } from '../expiry/answered'

/**
 * A record's documents (COL-048, COL-049; B-W2b-177), for its Files panel:
 *
 *   GET /files/documents?recordType=&recordId=  what each current document of the record (and of its party) is and until
 *        when, and — for a record type rules may name — each status move with rules: what it needs, met, missing or expired
 *        (the record frame's "What is missing" list, before anyone tries the move). Office, files.read on the record's company.
 *   PUT /files/:fileId/document {category?, expiresOn?, version}  what the file is evidence of and the last day it is valid
 *        (files.upload, as whoever adds files says what they are). Only the current version (an earlier one is read-only);
 *        a new date clears the last reminder in the same update, so the reminders start again; a request to the partner
 *        for this document closes when the new date is beyond the reminders (../expiry/source.ts).
 */

type DocumentView = z.infer<typeof documentView>

const documentOf = (row: Pick<DocumentRow, 'id' | 'category' | 'expiresOn' | 'originalName'>, today: BusinessDate, ofParty: boolean): DocumentView => {
  const expiresOn = row.expiresOn === null ? null : dayOf(row.expiresOn)
  return {
    fileId: row.id,
    category: row.category as DocumentCategory | null,
    expiresOn,
    expiryState: expiryStateOf(expiresOn, today),
    daysLeft: expiresOn === null ? null : daysUntil(expiresOn, today),
    ofParty,
    originalName: row.originalName,
  }
}

const UNTAGGED_SELECT = { id: true, category: true, status: true, supersededAt: true, expiresOn: true, originalName: true, recordType: true, recordId: true, companyId: true } as const satisfies Prisma.StoredFileSelect

export async function recordDocuments(caller: CommandCaller, query: { readonly recordType: string; readonly recordId: string }, now: Date) {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const today = businessDate(now)
  return caller.withClient(async (client) => {
    const facts = await recordFactsOf(client, query.recordType, query.recordId)
    // Every current file of the record (tagged or not: the panel offers to tag it), plus the party's tagged documents.
    // B-W2b-371: none of a record whose files only its module reads (a rider's photos, an incident's): as listFiles.
    const own = readsThroughModule(query.recordType)
      ? []
      : await client.storedFile.findMany({
          where: { recordType: query.recordType, recordId: query.recordId, status: 'AVAILABLE', supersededAt: null },
          select: UNTAGGED_SELECT,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 500,
        })
    const companyId = facts?.companyId ?? own[0]?.companyId ?? null
    if (!can(actor, FILES_READ, { companyId })) throw new NotFoundError('Record not found.')
    const tagged = facts ? await documentsOf(client, query.recordType, query.recordId, facts.partyId) : []
    const party = tagged.filter((row) => !(row.recordType === query.recordType && row.recordId === query.recordId))
    const documents = [...own.filter((row) => can(actor, FILES_READ, { companyId: row.companyId })).map((row) => documentOf(row, today, false)), ...party.map((row) => documentOf(row, today, true))]
    const moves: Array<{ toStatus: string; requirements: ReturnType<typeof requirementStates> }> = []
    if (facts && isRequiredRecordType(query.recordType)) {
      const rules = await activeRulesOf(client, query.recordType, facts.companyId ?? (context.audience === 'office' ? (context.companyId ?? null) : null))
      const files = [...own.filter((row) => row.category !== null), ...party].map((row) => ({ ...row, expiresOn: row.expiresOn === null ? null : dayOf(row.expiresOn) }))
      for (const toStatus of REQUIRED_RECORD_TYPES[query.recordType].statuses) {
        const applying = rulesThatApply(rules, query.recordType, toStatus, facts.partyRoles)
        if (applying.length > 0) moves.push({ toStatus, requirements: requirementStates(applying, files, today) })
      }
    }
    return {
      status: facts?.status ?? null,
      today,
      documents,
      moves: moves.map((move) => ({
        toStatus: move.toStatus,
        requirements: move.requirements.map((state) => ({ ruleId: state.ruleId, category: state.category as never, partyRole: state.partyRole as never, level: state.level, reason: state.reason, fileId: state.fileId, expiresOn: state.expiresOn })),
      })),
      mayTag: can(actor, FILES_UPLOAD, { companyId }),
    }
  })
}

export async function setDocument(
  caller: CommandCaller,
  fileId: string,
  body: { readonly category?: DocumentCategory | null | undefined; readonly expiresOn?: string | null | undefined; readonly version: number },
  now: Date,
  idempotencyKey?: string,
) {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new NotFoundError('File not found.')
  const file = await readOffice(caller, fileId)
  if (!can(actorOf(context), FILES_READ, { companyId: file.companyId })) throw new NotFoundError('File not found.')
  mayWrite(caller, FILES_UPLOAD, { companyId: file.companyId, floorSiteId: null, partyId: null })
  assertGenericPath(file.recordType, file.kind, {})
  if (body.category === undefined && body.expiresOn === undefined) throw new ValidationError('Say what changes: the kind of document or its expiry date.', [{ path: 'body', message: 'Nothing to change.' }])
  const today = businessDate(now)
  const problem = body.expiresOn ? expiryDateProblem(body.expiresOn, today) : null
  if (problem) throw new ValidationError('The expiry date is not valid.', [{ path: 'body/expiresOn', message: problem }])
  if (file.status !== 'AVAILABLE' || !isCurrentVersion({ status: file.status, supersededAt: file.supersededAt ?? null })) {
    throw new ConflictError('Only the current version of a file says what it is and until when: an earlier version is read-only.')
  }
  const { result } = await command(
    caller,
    { name: 'files.setDocument', idempotencyKey, input: { fileId, ...body }, record: { type: 'StoredFile', id: fileId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, audit } = tools
      const before = await tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: { ...UNTAGGED_SELECT, expiryRemindedAt: true, version: true, seriesId: true, partyId: true } })
      if (!isCurrentVersion(before)) throw new ConflictError('A later version replaced this file meanwhile: say it on the current version.')
      const oldDay = before.expiresOn === null ? null : dayOf(before.expiresOn)
      const newDay = body.expiresOn === undefined ? oldDay : body.expiresOn
      const moved = newDay !== oldDay
      const after = await tx.storedFile.update({
        where: { id: fileId },
        data: {
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(moved ? { expiresOn: newDay === null ? null : new Date(`${newDay}T00:00:00Z`), expiryRemindedAt: null } : {}),
          updatedAt: tools.now,
        },
        select: { ...UNTAGGED_SELECT, version: true },
      })
      audit({
        action: 'files.setDocument',
        recordType: 'StoredFile',
        recordId: fileId,
        companyId: before.companyId,
        before: { category: before.category, expiresOn: oldDay, reminded: before.expiryRemindedAt !== null },
        after: { category: after.category, expiresOn: newDay, ...(moved ? { remindersRestart: true } : {}) },
      })
      // A partner was asked for a new version of this document: a date beyond the reminders answers it.
      if (moved) await closeAnsweredExpiryTasks(tools, { root: before.seriesId ?? before.id, recordType: before.recordType, recordId: before.recordId, today })
      return { document: documentOf(after, today, false), version: after.version }
    },
  )
  return result
}
