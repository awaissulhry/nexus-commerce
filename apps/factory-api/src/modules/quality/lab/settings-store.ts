import { StaleVersionError, type CommandTools } from '../../../core/command'
import { EVIDENCE_RULES, type EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import type { Reader } from './store'

/**
 * THE SEAM for the quality settings: what counts as chromium VI evidence (Q14). The lab step reads and saves the rule
 * only through `processQualitySettings()`, so the store is one file to swap. Keyed like SalesSettings: the company's id,
 * or the tenant's own id for the tenant-wide row; no row: the domain's default (Q14 (a), DEFAULT_EVIDENCE_RULE).
 *
 * INTERIM (lead 10-29): there is no QualitySettings table yet. Until the schema step (approved: `QualitySettings` with
 * `crViEvidenceRule CrViEvidenceRule @default(SUPPLIER_REPORT_ACCEPTED)`, version, and a seeded default row), a save is
 * ONE audit row (action `quality.settingsSaved`, recordType `QualitySettings`, recordId = the row's id, `after.settings`
 * = the row below) under a transaction advisory lock per row; the newest such row is the setting, and the count of them
 * is its version. `AUDIT_QUALITY_SETTINGS` is replaced by the table. NOT to be merged as it is.
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
  save(tools: Pick<CommandTools, 'tx' | 'audit' | 'now' | 'context'>, row: { readonly id: string; readonly companyId: string | null; readonly crViEvidenceRule: EvidenceRule; readonly expectedVersion: number; readonly byId: string | null; readonly reason: string | null }): Promise<QualitySettingsRow>
}

export const SETTINGS_ACTION = 'quality.settingsSaved'

const rowOf = (after: unknown): Omit<QualitySettingsRow, 'version'> | null => {
  const value = (after as { settings?: QualitySettingsRow } | null)?.settings
  return value && typeof value === 'object' && (EVIDENCE_RULES as readonly string[]).includes(value.crViEvidenceRule) ? value : null
}

async function current(client: Reader, id: string): Promise<QualitySettingsRow | null> {
  const saves = await client.auditLog.findMany({ where: { recordType: 'QualitySettings', recordId: id, action: SETTINGS_ACTION }, select: { after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] })
  const newest = saves.length > 0 ? rowOf(saves[0]!.after) : null
  return newest ? { ...newest, version: saves.length } : null
}

/** Interim: the newest audit row of the settings row is the setting (see above). */
export const AUDIT_QUALITY_SETTINGS: QualitySettingsStore = Object.freeze({
  rows: async (client: Reader, tenantId: string, companyId: string | null) => {
    const rows: QualitySettingsRow[] = []
    for (const id of companyId === null ? [tenantId] : [companyId, tenantId]) {
      const row = await current(client, id)
      if (row) rows.push(row)
    }
    return rows
  },
  save: async (tools: Parameters<QualitySettingsStore['save']>[0], row: Parameters<QualitySettingsStore['save']>[1]) => {
    await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.quality-settings', ${row.id}::uuid), 0))`
    const before = await current(tools.tx, row.id)
    const version = before?.version ?? 0
    if (version !== row.expectedVersion) throw new StaleVersionError('QualitySettings', row.id, version, row.expectedVersion)
    const saved: QualitySettingsRow = { id: row.id, companyId: row.companyId, crViEvidenceRule: row.crViEvidenceRule, version: version + 1, updatedAt: tools.now.toISOString(), updatedById: row.byId }
    tools.audit({
      action: SETTINGS_ACTION,
      recordType: 'QualitySettings',
      recordId: row.id,
      companyId: row.companyId,
      ...(before ? { before: { crViEvidenceRule: before.crViEvidenceRule } } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      after: { settings: saved },
    })
    return saved
  },
})

let configured: QualitySettingsStore | undefined

/** Tests (and the schema step) swap the store; `undefined` puts the default back. */
export function useQualitySettings(store: QualitySettingsStore | undefined): void {
  configured = store
}

export function processQualitySettings(): QualitySettingsStore {
  return configured ?? AUDIT_QUALITY_SETTINGS
}
