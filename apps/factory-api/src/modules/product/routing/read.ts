import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { LocalisedNames } from '@nexus/factory-domain/product/materials/rules'
import type { LibraryOperation, StepData } from '@nexus/factory-domain/product/routing/rules'
import type { Subcontract } from '@nexus/factory-domain/product/routing/subcontract'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'

/**
 * A revision's routing steps and the library operations they name, as the domain reads them (factory-db
 * `RoutingOperation`, `Operation`): the columns every read names, no relation selects. A leaf module: the routing's store
 * and the BOM's (the release check and the BOM view's `releasable`, modules/product/bom) both read through it, so neither
 * imports the other's store.
 *
 * A step's subcontract details (W2a, PRD-120: workshop, fee per piece, transit days) are read on their own
 * (`readSubcontracts`, office reads only): the fee is the cost grain and never part of the steps the rules and diffs
 * see; the floor never reads RoutingOperation's fee (its grant leaves it out) and reads its work order's operations.
 */

export const STEP_COLUMNS = {
  id: true,
  seq: true,
  operationId: true,
  code: true,
  name: true,
  nameI18n: true,
  workCentreKind: true,
  standardMinutes: true,
  scanRequired: true,
  instructions: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.RoutingOperationSelect
type StepRow = Prisma.RoutingOperationGetPayload<{ select: typeof STEP_COLUMNS }>

export const OPERATION_REF_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  workCentreKind: true,
  machineType: true,
  skill: true,
  standardMinutes: true,
  instructions: true,
  status: true,
} as const satisfies Prisma.OperationSelect
type OperationRefRow = Prisma.OperationGetPayload<{ select: typeof OPERATION_REF_COLUMNS }>

const text = (value: { toString(): string }): string => decimalText(value.toString())

/** A stored step, as the domain reads it, with its row's version and times. */
export interface StepRecord extends StepData {
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** A library operation, as the rules read it and the view shows it. */
export interface OperationFacts extends LibraryOperation {
  readonly companyId: string | null
  readonly machineType: string | null
  readonly skill: string | null
}

const operationOf = (row: OperationRefRow): OperationFacts => ({
  id: row.id,
  companyId: row.companyId,
  code: row.code,
  name: row.name,
  nameI18n: (row.nameI18n as LocalisedNames | null) ?? null,
  workCentreKind: row.workCentreKind,
  machineType: row.machineType,
  skill: row.skill,
  standardMinutes: text(row.standardMinutes),
  instructions: row.instructions,
  status: row.status,
})

const stepOf = (row: StepRow): StepRecord => ({
  id: row.id,
  seq: row.seq,
  operationId: row.operationId,
  code: row.code,
  name: row.name,
  nameI18n: (row.nameI18n as LocalisedNames | null) ?? null,
  workCentreKind: row.workCentreKind,
  standardMinutes: text(row.standardMinutes),
  scanRequired: row.scanRequired,
  instructions: row.instructions,
  version: row.version,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** The steps of one revision, in routing order. */
export async function readSteps(client: FactoryClient | CommandTx, revisionId: string): Promise<StepRecord[]> {
  const rows = await client.routingOperation.findMany({ where: { revisionId }, select: STEP_COLUMNS, orderBy: { seq: 'asc' } })
  return rows.map(stepOf)
}

/** The library operations these steps name, by id (archived ones too). */
export async function readOperations(client: FactoryClient | CommandTx, operationIds: readonly string[]): Promise<Map<string, OperationFacts>> {
  const ids = [...new Set(operationIds)].filter(isUuid)
  const rows = ids.length === 0 ? [] : await client.operation.findMany({ where: { id: { in: ids } }, select: OPERATION_REF_COLUMNS })
  return new Map(rows.map((row) => [row.id, operationOf(row)]))
}

/** The subcontract columns of a step (office only: the floor's grant leaves pricePerPiece out). */
export const SUBCONTRACT_COLUMNS = { id: true, supplierId: true, pricePerPiece: true, transitDays: true } as const satisfies Prisma.RoutingOperationSelect

/** The subcontracted steps of one revision: their workshop, fee per piece and transit days, by step id. */
export async function readSubcontracts(client: FactoryClient | CommandTx, revisionId: string): Promise<Map<string, Subcontract>> {
  const rows = await client.routingOperation.findMany({ where: { revisionId, supplierId: { not: null } }, select: SUBCONTRACT_COLUMNS })
  return new Map(
    rows.map((row) => [row.id, { supplierId: row.supplierId!, pricePerPiece: row.pricePerPiece === null ? null : text(row.pricePerPiece), transitDays: row.transitDays }]),
  )
}

/** The workshops these subcontracts name, by id (code and trade name, else legal name). */
export async function readWorkshops(client: FactoryClient | CommandTx, subcontracts: Iterable<Subcontract>): Promise<Map<string, { id: string; code: string; name: string }>> {
  const ids = [...new Set([...subcontracts].map((entry) => entry.supplierId))]
  const rows = ids.length === 0 ? [] : await client.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.tradeName ?? row.legalName }]))
}
