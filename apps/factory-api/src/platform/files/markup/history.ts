import type { Prisma } from '@nexus/factory-db'
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, holds, isPermission } from '@nexus/factory-domain/core/permissions'
import { seriesRootOf } from '@nexus/factory-domain/files/versions/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf, readVisible, SELECT_FOR, viewOf, type Row } from '../files'
import { namesOf } from './markup'
import type { historyVersionView } from './contract'
import type { z } from 'zod'

/**
 * The shell's Versions pop-up (design shell.panels › pop:file-versions, "Versions of JK-210-pattern.pdf": "List: version,
 * who, when, size, which records use it ('Work order WO-0098 uses v2'); Restore makes a new version"; B-W2b-177 on
 * B-W2b-160's versions):
 *
 *   GET /files/:fileId/history (office, files.read)  every version of the file's series that is not deleted, the first
 *        first, each with `current`, who added it (a colleague, a partner person, or the system), the markup it was made by
 *        (a marked picture), how many markups were drawn on it, and the copies of it on other records (StoredFile.sourceFileId,
 *        "which records use it") with the record's number where the person may see that record (the search index's label
 *        and its view permission), else none.
 *
 * Restore stays B-W2b-160's POST /files/:fileId/restore; the preview is GET /files/:fileId/preview.
 */

type HistoryVersion = z.infer<typeof historyVersionView>

export async function fileHistory(caller: CommandCaller, fileId: string): Promise<HistoryVersion[]> {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new NotFoundError('File not found.')
  const actor = actorOf(context)
  const named = await readVisible(caller, fileId)
  const root = seriesRootOf({ id: named.id, seriesId: named.seriesId ?? null })
  return caller.withClient(async (client) => {
    const rows = (await client.storedFile.findMany({
      where: { OR: [{ id: root }, { seriesId: root }], status: { not: 'DELETED' } },
      select: { ...SELECT_FOR.office, createdById: true },
      orderBy: { versionNo: 'asc' },
      take: 500,
    })) as Array<Row & { createdById: string | null }>
    const ids = rows.map((row) => row.id)
    const [markups, copies] = await Promise.all([
      client.fileMarkup.findMany({ where: { OR: [{ fileId: { in: ids } }, { resultFileId: { in: ids } }] }, select: { id: true, fileId: true, resultFileId: true, note: true, shapes: true } }),
      client.storedFile.findMany({
        where: { sourceFileId: { in: ids }, status: { not: 'DELETED' } },
        select: { id: true, sourceFileId: true, recordType: true, recordId: true, companyId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
      }),
    ])
    const seen = copies.filter((copy) => can(actor, FILES_READ, { companyId: copy.companyId }))
    const entries =
      seen.length === 0
        ? []
        : await client.searchEntry.findMany({
            where: { OR: seen.map((copy) => ({ recordType: copy.recordType, recordId: copy.recordId })) },
            select: { recordType: true, recordId: true, number: true, title: true, viewPermission: true, companyId: true } satisfies Prisma.SearchEntrySelect,
          })
    const labelOf = (recordType: string, recordId: string): string | null => {
      const entry = entries.find((item) => item.recordType === recordType && item.recordId === recordId)
      if (!entry || !isPermission(entry.viewPermission) || !holds(actor, entry.viewPermission) || !can(actor, entry.viewPermission, { companyId: entry.companyId })) return null
      return entry.number ?? entry.title
    }
    const names = await namesOf(caller, rows.map((row) => row.createdById))
    return rows.map((row) => {
      const made = markups.find((markup) => markup.resultFileId === row.id) ?? null
      const who = row.createdById ? names.get(row.createdById) : undefined
      return {
        ...viewOf(row),
        current: row.status === 'AVAILABLE' && (row.supersededAt ?? null) === null,
        addedBy: { id: row.createdById, name: who?.name ?? null, fromPartner: who?.fromPartner ?? false },
        madeByMarkup: made ? { id: made.id, note: made.note, marks: Array.isArray(made.shapes) ? made.shapes.length : 0 } : null,
        usedBy: seen.filter((copy) => copy.sourceFileId === row.id).map((copy) => ({ fileId: copy.id, recordType: copy.recordType, recordId: copy.recordId, label: labelOf(copy.recordType, copy.recordId) })),
        markups: markups.filter((markup) => markup.fileId === row.id).length,
      }
    })
  })
}
