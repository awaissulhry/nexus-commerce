import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { sheetStateOf, type ChemicalStatus, type ChemicalUse, type GhsPictogram, type QuantityUnit, type SheetStatus, type SignalWord } from '@nexus/factory-domain/safety/chemicals/rules'
import { SAFETY_CHEMICALS_MANAGE } from '@nexus/factory-domain/safety/chemicals/permissions'
import type { CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { userNames } from '../../people/employees/employees'

/**
 * The chemical register's rows as the screens show them (B-W2b-143): one read for the sites and companies, the supplier
 * parties, the role sheets, the PPE items, the sheets with their files and who added or superseded them. No person but the
 * office users who added a sheet (an office act, as any record's history), no money.
 */

type Client = FactoryClient | CommandTx

export const CHEMICAL_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  name: true,
  supplierPartyId: true,
  supplierName: true,
  use: true,
  ghsPictograms: true,
  signalWord: true,
  hazardStatements: true,
  precautionStatements: true,
  storagePlace: true,
  cabinetCode: true,
  maxQuantity: true,
  maxQuantityUnit: true,
  roleSheetIds: true,
  ppeItemIds: true,
  status: true,
  note: true,
  version: true,
} as const satisfies Prisma.ChemicalSelect

export interface ChemicalRow {
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly name: string
  readonly supplierPartyId: string | null
  readonly supplierName: string | null
  readonly use: ChemicalUse
  readonly ghsPictograms: GhsPictogram[]
  readonly signalWord: SignalWord | null
  readonly hazardStatements: string[]
  readonly precautionStatements: string[]
  readonly storagePlace: string
  readonly cabinetCode: string | null
  readonly maxQuantity: { toString(): string } | null
  readonly maxQuantityUnit: QuantityUnit | null
  readonly roleSheetIds: string[]
  readonly ppeItemIds: string[]
  readonly status: ChemicalStatus
  readonly note: string | null
  readonly version: number
}

export const SHEET_SELECT = {
  id: true,
  siteId: true,
  chemicalId: true,
  versionLabel: true,
  revisedOn: true,
  language: true,
  fileId: true,
  status: true,
  supersededAt: true,
  supersededById: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.SafetyDataSheetSelect

export interface SheetRow {
  readonly id: string
  readonly siteId: string
  readonly chemicalId: string
  readonly versionLabel: string
  readonly revisedOn: Date
  readonly language: string
  readonly fileId: string
  readonly status: SheetStatus
  readonly supersededAt: Date | null
  readonly supersededById: string | null
  readonly createdAt: Date
  readonly createdById: string | null
}

const day = (value: Date): string => value.toISOString().slice(0, 10)
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString())

/** A stored decimal as the screens show it ("25", "2.5"): no trailing zeros. */
export function quantityText(value: { toString(): string } | null): string | null {
  if (value === null) return null
  const text = value.toString()
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** The sheets as the screens show them, with their files and the office users who added or superseded them. */
export async function sheetViews(client: Client, rows: readonly SheetRow[]) {
  const files = new Map(
    (rows.length === 0 ? [] : await client.storedFile.findMany({ where: { id: { in: rows.map((row) => row.fileId) } }, select: { id: true, originalName: true, sizeBytes: true, sha256: true } })).map((file) => [file.id, file]),
  )
  const names = await userNames(client, rows.flatMap((row) => [row.createdById, row.supersededById]))
  return rows.map((row) => {
    const file = files.get(row.fileId)
    return {
      id: row.id,
      versionLabel: row.versionLabel,
      revisedOn: day(row.revisedOn),
      language: row.language,
      status: row.status,
      fileId: row.fileId,
      fileName: file?.originalName ?? '',
      sizeBytes: file?.sizeBytes ?? 0,
      sha256: file?.sha256 ?? '',
      supersededAt: iso(row.supersededAt),
      supersededBy: row.supersededById ? (names.get(row.supersededById) ?? null) : null,
      addedAt: row.createdAt.toISOString(),
      addedBy: row.createdById ? (names.get(row.createdById) ?? null) : null,
    }
  })
}
export type SheetView = Awaited<ReturnType<typeof sheetViews>>[number]

/** Newest first: the revision day, then when it was added. */
export const newestFirst = (a: SheetRow, b: SheetRow): number => b.revisedOn.getTime() - a.revisedOn.getTime() || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)

/** The register's rows as the screens show them (one read for everything they name). */
export async function chemicalViews(client: Client, context: OfficeContext, rows: readonly ChemicalRow[]) {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const [sheets, sites, companies, parties, roles, ppe] = await Promise.all([
    client.safetyDataSheet.findMany({ where: { chemicalId: { in: ids } }, select: SHEET_SELECT }) as Promise<SheetRow[]>,
    client.site.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.siteId))] } }, select: { id: true, code: true, name: true } }),
    client.company.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.companyId))] } }, select: { id: true, code: true, legalName: true, locale: true } }),
    client.party.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.supplierPartyId).filter((id): id is string => id !== null))] } }, select: { id: true, legalName: true, tradeName: true } }),
    client.roleSheet.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => row.roleSheetIds))] } }, select: { id: true, code: true, name: true } }),
    client.ppeItem.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => row.ppeItemIds))] } }, select: { id: true, code: true, name: true } }),
  ])
  const current = await sheetViews(client, sheets.filter((sheet) => sheet.status === 'CURRENT').sort(newestFirst))
  const siteOf = new Map(sites.map((site) => [site.id, site]))
  const companyOf = new Map(companies.map((company) => [company.id, company]))
  const partyOf = new Map(parties.map((party) => [party.id, party]))
  const roleOf = new Map(roles.map((role) => [role.id, role]))
  const ppeOf = new Map(ppe.map((item) => [item.id, item]))
  const currentOf = new Map<string, SheetView[]>()
  for (const sheet of sheets.filter((row) => row.status === 'CURRENT').sort(newestFirst)) {
    const view = current.find((candidate) => candidate.id === sheet.id)!
    currentOf.set(sheet.chemicalId, [...(currentOf.get(sheet.chemicalId) ?? []), view])
  }
  return rows.map((row) => {
    const site = siteOf.get(row.siteId)
    const company = companyOf.get(row.companyId)
    const party = row.supplierPartyId ? partyOf.get(row.supplierPartyId) : undefined
    const language = company?.locale ?? 'it'
    const own = sheets.filter((sheet) => sheet.chemicalId === row.id)
    return {
      id: row.id,
      companyId: row.companyId,
      company: { code: company?.code ?? '', name: company?.legalName ?? '' },
      siteId: row.siteId,
      site: { code: site?.code ?? '', name: site?.name ?? '' },
      name: row.name,
      supplier: { partyId: row.supplierPartyId, name: party ? (party.tradeName ?? party.legalName) : row.supplierName },
      use: row.use,
      ghsPictograms: [...row.ghsPictograms],
      signalWord: row.signalWord,
      hazardStatements: [...row.hazardStatements],
      precautionStatements: [...row.precautionStatements],
      storagePlace: row.storagePlace,
      cabinetCode: row.cabinetCode,
      maxQuantity: quantityText(row.maxQuantity),
      maxQuantityUnit: row.maxQuantityUnit,
      roles: row.roleSheetIds.map((id) => roleOf.get(id)).filter((role): role is NonNullable<typeof role> => role !== undefined).map((role) => ({ id: role.id, code: role.code, name: role.name })),
      ppe: row.ppeItemIds.map((id) => ppeOf.get(id)).filter((item): item is NonNullable<typeof item> => item !== undefined).map((item) => ({ id: item.id, code: item.code, name: item.name })),
      status: row.status,
      note: row.note,
      current: currentOf.get(row.id) ?? [],
      superseded: own.filter((sheet) => sheet.status === 'SUPERSEDED').length,
      sheetState: sheetStateOf(own, language),
      language,
      version: row.version,
      canManage: mayManage(context, row),
    }
  })
}
export type ChemicalView = Awaited<ReturnType<typeof chemicalViews>>[number]

/** The caller keeps this chemical's register (safety.chemicals.manage over its company and site). */
export const mayManage = (context: OfficeContext, place: { readonly companyId: string; readonly siteId: string }): boolean =>
  (!context.companyId || context.companyId === place.companyId) && can(actorOf(context), SAFETY_CHEMICALS_MANAGE, place)

/** A list's filter: the chemicals the permission reaches, inside the screen's company when it names one. */
export function chemicalScope(context: OfficeContext, permission: Permission): Prisma.ChemicalWhereInput {
  const reach = scopeWhere(actorOf(context), permission, { company: 'companyId', site: 'siteId' }) as Prisma.ChemicalWhereInput
  return context.companyId ? { AND: [reach, { companyId: context.companyId }] } : reach
}
