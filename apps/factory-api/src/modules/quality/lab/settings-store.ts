import type { Prisma } from '@nexus/factory-db'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import { StaleVersionError, type CommandTools } from '../../../core/command'
import type { Reader } from './store'

/**
 * THE SEAM for the quality settings: what counts as chromium VI evidence (Q14). The lab step reads and saves the rule
 * only through `processQualitySettings()`. The default is the table (factory-db quality.prisma `QualitySettings`), keyed
 * like SalesSettings: the company's id, or the tenant's own id for the tenant-wide row; no row: the domain's default
 * (Q14 (a), DEFAULT_EVIDENCE_RULE). The seed writes the tenant-wide default row. Tests may swap the store with
 * `useQualitySettings`.
 */

export interface QualitySettingsRow {
  /** The company's id, or the tenant's id for the tenant-wide row. */
  readonly id: string
  readonly companyId: string | null
  readonly crViEvidenceRule: EvidenceRule
  readonly version: number
  readonly updatedAt: string
  readonly updatedById: string | null
}

export interface QualitySettingsStore {
  /** The company's row and the tenant-wide one, when set. */
  rows(client: Reader, tenantId: string, companyId: string | null): Promise<QualitySettingsRow[]>
  /** Inside the saving command: the row as saved; a stale `expectedVersion` (0: none yet) is a 409. */
  save(
    tools: Pick<CommandTools, 'tx' | 'audit' | 'now' | 'context'>,
    row: { readonly id: string; readonly companyId: string | null; readonly crViEvidenceRule: EvidenceRule; readonly expectedVersion: number; readonly byId: string | null; readonly reason: string | null },
  ): Promise<QualitySettingsRow>
}

const COLUMNS = { id: true, companyId: true, crViEvidenceRule: true, version: true, updatedAt: true, createdById: true } as const satisfies Prisma.QualitySettingsSelect
type Row = Prisma.QualitySettingsGetPayload<{ select: typeof COLUMNS }>

const rowOf = (row: Row, updatedById: string | null = row.createdById): QualitySettingsRow => ({
  id: row.id,
  companyId: row.companyId,
  crViEvidenceRule: row.crViEvidenceRule,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
  updatedById,
})

/** Who saved the row last: its newest audit row (the table keeps who created it). */
async function lastSavedBy(client: Reader, id: string): Promise<string | null> {
  const entry = await client.auditLog.findFirst({ where: { recordType: 'QualitySettings', recordId: id }, select: { actorId: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
  return entry?.actorId ?? null
}

/** The table. */
export const TABLE_QUALITY_SETTINGS: QualitySettingsStore = Object.freeze({
  rows: async (client: Reader, tenantId: string, companyId: string | null) => {
    const rows = await client.qualitySettings.findMany({ where: { id: { in: companyId === null ? [tenantId] : [companyId, tenantId] } }, select: COLUMNS })
    const out: QualitySettingsRow[] = []
    for (const row of rows) out.push(rowOf(row, (await lastSavedBy(client, row.id)) ?? row.createdById))
    return out
  },
  save: async (tools: Parameters<QualitySettingsStore['save']>[0], row: Parameters<QualitySettingsStore['save']>[1]) => {
    const { tx, now } = tools
    // The row locked (or none yet): two saves of one version take turns, and the second one's version is stale.
    const [locked] = await tx.$queryRaw<{ version: number; crViEvidenceRule: string }[]>`
      SELECT "version", "crViEvidenceRule"::text AS "crViEvidenceRule" FROM "QualitySettings" WHERE "id" = ${row.id}::uuid FOR UPDATE`
    const version = locked?.version ?? 0
    if (version !== row.expectedVersion) throw new StaleVersionError('QualitySettings', row.id, version, row.expectedVersion)
    const saved = locked
      ? await tx.qualitySettings.update({ where: { id: row.id }, data: { crViEvidenceRule: row.crViEvidenceRule, version: { increment: 1 }, updatedAt: now }, select: COLUMNS })
      : await tx.qualitySettings
          .create({ data: { id: row.id, companyId: row.companyId, crViEvidenceRule: row.crViEvidenceRule, createdAt: now, updatedAt: now, createdById: row.byId }, select: COLUMNS })
          .catch((error: unknown) => {
            if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('These quality settings were just saved by someone else: reload them.')
            throw error
          })
    tools.audit({
      recordType: 'QualitySettings',
      recordId: row.id,
      companyId: row.companyId,
      ...(locked ? { before: { crViEvidenceRule: locked.crViEvidenceRule } } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      after: { companyId: row.companyId, crViEvidenceRule: saved.crViEvidenceRule, version: saved.version },
    })
    return rowOf(saved, row.byId)
  },
})

let configured: QualitySettingsStore | undefined

/** Tests may swap the store; `undefined` puts the table back. */
export function useQualitySettings(store: QualitySettingsStore | undefined): void {
  configured = store
}

export function processQualitySettings(): QualitySettingsStore {
  return configured ?? TABLE_QUALITY_SETTINGS
}
