import type { Prisma } from '@nexus/factory-db'
import { monthLabel } from '@nexus/factory-domain/accounting/periods'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { linkState } from '@nexus/factory-domain/links/purposes'
import { parseChecks } from '@nexus/factory-domain/people/payroll/checks'
import { CORRECTION_WORDS } from '@nexus/factory-domain/people/payroll/rules'
import { carriesPay, changeCounts, parseValues, valueChanges } from '@nexus/factory-domain/people/payroll/values'
import { confirmationWords, layoutConfirmed } from '@nexus/factory-domain/people/payroll/layouts'
import { PEOPLE_PAYROLL_MANAGE, PEOPLE_PAYROLL_RECORDS } from '@nexus/factory-domain/people/payroll/permissions'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { Client } from '../attendance/store'
import type { Place } from '../close/store'
import { userNames } from '../employees/employees'
import { seesPay } from '../piecerates/access'
import { EXPORT_SELECT, layoutUsedOf, mayDo, monthOfRow, type ExportRow } from './store'

/**
 * The exports as the screens read them (B-W2b-54; design people.payroll "Exports": period, company, format, version, made by and
 * when, sent to, downloaded at, DocumentSeal). No person, no figure: a row says what changed as counts.
 */

export const DOWNLOAD_ACTION = 'people.downloadPayrollFile'

const LINK_SELECT = { id: true, recordId: true, email: true, expiresAt: true, maxUses: true, uses: true, revokedAt: true, createdAt: true } as const satisfies Prisma.OneOffLinkSelect
type LinkRow = Prisma.OneOffLinkGetPayload<{ select: typeof LINK_SELECT }>

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

const held = (allowed: boolean, reason: string | null) => ({ allowed, reason: allowed ? null : reason })

interface Download {
  readonly exportId: string
  readonly linkId: string
  readonly fileId: string
  readonly at: Date
}

/** The links of these exports, and each download through them (the audit row written with the use of the link). */
async function linksOf(db: Client, ids: readonly string[]): Promise<{ links: LinkRow[]; downloads: Download[] }> {
  if (ids.length === 0) return { links: [], downloads: [] }
  const links = await db.oneOffLink.findMany({ where: { recordType: 'PayrollExport', recordId: { in: [...ids] } }, select: LINK_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const rows = await db.auditLog.findMany({ where: { action: DOWNLOAD_ACTION, recordType: 'PayrollExport', recordId: { in: [...ids] } }, select: { recordId: true, at: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
  const downloads = rows.flatMap((row): Download[] => {
    const after = (row.after ?? {}) as { linkId?: string; fileId?: string }
    return after.linkId && after.fileId ? [{ exportId: row.recordId, linkId: after.linkId, fileId: after.fileId, at: row.at }] : []
  })
  return { links, downloads }
}

function rowOf(row: ExportRow, extras: { readonly names: ReadonlyMap<string, string>; readonly links: readonly LinkRow[]; readonly downloads: readonly Download[] }) {
  const month = monthOfRow(row)
  const used = layoutUsedOf(row.layoutSnapshot)
  const parts = { provider: (row.layoutSnapshot as { provider?: string | null } | null)?.provider ?? null, definition: used.definition }
  const data = row.files.find((file) => file.kind === 'DATA')
  const changed = row.correctionOf ? changeCounts(valueChanges(parseValues(row.correctionOf.values), parseValues(row.values))) : null
  const madeById = row.exportedById ?? row.createdById
  const own = extras.downloads.filter((entry) => entry.exportId === row.id)
  return {
    id: row.id,
    companyId: row.companyId,
    company: { code: row.company.code, legalName: row.company.legalName },
    month,
    label: monthLabel(month),
    number: row.number,
    revision: row.revision,
    status: row.status,
    correctionOfId: row.correctionOfId,
    correctedById: row.correctedBy[0]?.id ?? null,
    layout: { id: row.layout.id, name: row.layout.name, format: used.format, provider: parts.provider, confirmed: layoutConfirmed(parts), words: confirmationWords(parts) },
    madeBy: madeById ? { id: madeById, name: extras.names.get(madeById) ?? null } : null,
    createdAt: toUtcIso(row.createdAt),
    exportedAt: iso(row.exportedAt),
    seal: data?.file.sha256 ?? null,
    sentTo: [...new Set(extras.links.filter((link) => link.recordId === row.id).flatMap((link) => (link.email ? [link.email] : [])))],
    downloadedAt: iso(own.at(-1)?.at ?? null),
    changed,
    version: row.version,
  }
}

async function extrasOf(db: Client, rows: readonly ExportRow[]) {
  const names = await userNames(db, rows.flatMap((row) => [row.exportedById, row.createdById]))
  return { names, ...(await linksOf(db, rows.map((row) => row.id))) }
}

/** The rows of the Exports section. */
export async function exportRows(db: Client, rows: readonly ExportRow[]) {
  const extras = await extrasOf(db, rows)
  return rows.map((row) => rowOf(row, extras))
}

/** The record of one export: its checks as they stood, its files, its links and what the caller may do. */
export async function exportRecordOf(db: Client, context: OfficeContext, place: Place, row: ExportRow) {
  const extras = await extrasOf(db, [row])
  const view = rowOf(row, extras)
  const values = parseValues(row.values)
  const pay = carriesPay(values)
  const mayManage = mayDo(context, place, PEOPLE_PAYROLL_MANAGE)
  const mayOpen = mayDo(context, place, PEOPLE_PAYROLL_RECORDS)
  const now = serverClock.now()
  const latest = row.status === 'EXPORTED' && row.correctedBy.length === 0
  const payWords = 'This file carries amounts: it asks the pay grain.'
  return {
    ...view,
    payPeriodId: row.payPeriodId,
    checks: parseChecks(row.checks),
    files: row.files.map((file) => ({ id: file.fileId, seq: file.seq, kind: file.kind, format: file.format, rowCount: file.rowCount, name: file.file.originalName, contentType: file.file.contentType, sizeBytes: file.file.sizeBytes, sha256: file.file.sha256 })),
    links: extras.links.map((link) => ({
      id: link.id,
      email: link.email,
      state: linkState(link, now),
      expiresAt: toUtcIso(link.expiresAt),
      maxUses: link.maxUses,
      uses: link.uses,
      revokedAt: iso(link.revokedAt),
      createdAt: toUtcIso(link.createdAt),
      downloads: extras.downloads.filter((entry) => entry.linkId === link.id).map((entry) => ({ at: toUtcIso(entry.at), fileId: entry.fileId })),
    })),
    cancelledAt: iso(row.cancelledAt),
    cancelReason: row.cancelReason,
    note: row.note,
    carriesPay: pay,
    words: row.correctionOfId ? CORRECTION_WORDS : 'The first file of the month.',
    actions: {
      correct: held(mayManage && latest && (!pay || seesPay(context)), !mayManage ? 'Making a correction needs people.payroll.manage.' : !latest ? 'Only the latest exported file of the month is corrected.' : payWords),
      cancel: held(mayManage && row.status === 'DRAFT', !mayManage ? 'Cancelling needs people.payroll.manage.' : 'Only a draft is cancelled.'),
      send: held(mayManage && latest, !mayManage ? 'Sending needs people.payroll.manage.' : 'Only the latest exported file of the month is sent.'),
      open: held(mayOpen && row.status === 'EXPORTED' && (!pay || seesPay(context)), !mayOpen ? 'Opening the file needs people.payroll.records.' : row.status !== 'EXPORTED' ? 'Only an exported file is opened.' : payWords),
    },
  }
}

export const exportById = (db: Client, id: string): Promise<ExportRow | null> => db.payrollExport.findUnique({ where: { id }, select: EXPORT_SELECT })
