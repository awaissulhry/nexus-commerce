import type { Prisma } from '@nexus/factory-db'
import type { KpiState } from '@nexus/factory-domain/insights/kpis/catalogue'
import type { Reader } from '../facts/rows'

/**
 * The KPI versions and uses as stored (B-W2b-381's KpiDefinition and KpiUse), read for the KPI library (B-W2b-428). The
 * version in force of a key is its one ACTIVE row (the partial unique KpiDefinition_one_active).
 */

export const VERSION_SELECT = {
  id: true,
  kpiKey: true,
  kpiVersion: true,
  basedOnId: true,
  changeNote: true,
  state: true,
  nameIt: true,
  nameEn: true,
  definitionIt: true,
  definitionEn: true,
  formulaIt: true,
  formulaEn: true,
  sourceRecords: true,
  measureKeys: true,
  ownerRoleId: true,
  unit: true,
  grain: true,
  activatedAt: true,
  activatedById: true,
  endedAt: true,
  endedById: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.KpiDefinitionSelect

export type VersionRow = Prisma.KpiDefinitionGetPayload<{ select: typeof VERSION_SELECT }>

export const USE_SELECT = { id: true, kpiKey: true, usedIn: true, useKey: true, createdAt: true } as const satisfies Prisma.KpiUseSelect
export type UseRow = Prisma.KpiUseGetPayload<{ select: typeof USE_SELECT }>

/** Every version of these keys (or of every key), newest first per key. */
export async function versionsOf(db: Reader, keys?: readonly string[]): Promise<VersionRow[]> {
  return db.kpiDefinition.findMany({ where: keys ? { kpiKey: { in: [...keys] } } : {}, select: VERSION_SELECT, orderBy: [{ kpiKey: 'asc' }, { kpiVersion: 'desc' }] })
}

/** The version a KPI is shown by: the one in force, else its newest draft, else its newest. */
export function shownVersion(rows: readonly VersionRow[]): VersionRow | null {
  return rows.find((row) => row.state === 'ACTIVE') ?? rows.find((row) => row.state === 'DRAFT') ?? rows[0] ?? null
}

export const inForce = (rows: readonly VersionRow[]): VersionRow | null => rows.find((row) => row.state === ('ACTIVE' satisfies KpiState)) ?? null

export async function usesOf(db: Reader, keys?: readonly string[]): Promise<UseRow[]> {
  return db.kpiUse.findMany({ where: keys ? { kpiKey: { in: [...keys] } } : {}, select: USE_SELECT, orderBy: [{ kpiKey: 'asc' }, { usedIn: 'asc' }, { useKey: 'asc' }] })
}

/** The names of the people and roles a set of versions names (who wrote, put in force, ended; the owner role). */
export async function namesFor(db: Reader, rows: readonly VersionRow[]) {
  const userIds = [...new Set(rows.flatMap((row) => [row.createdById, row.activatedById, row.endedById]).filter((id): id is string => id !== null))]
  const roleIds = [...new Set(rows.map((row) => row.ownerRoleId))]
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }) : []
  const roles = roleIds.length ? await db.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, key: true, name: true } }) : []
  return { users: new Map(users.map((user) => [user.id, user.displayName])), roles: new Map(roles.map((role) => [role.id, role])) }
}
