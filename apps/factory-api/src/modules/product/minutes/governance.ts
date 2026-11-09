import type { FactoryClient } from '@nexus/factory-db'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { typedSmvRefusal, typedStepRefusal } from '@nexus/factory-domain/product/minutes/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import { MINUTES_OPERATION_COLUMNS, readVersions, storedMinutesOf } from './store'

/**
 * The W1 writes that type an SMV, refused in words where the database would refuse them (B-W2b-205's guards answer a
 * check_violation, the API a 500) or where SMV governance takes over (B-W2b-215; PRD-113: "from W2b an SMV change opens
 * 'Propose SMV change' instead"):
 *
 *   the library   PATCH /product/operations/:id standardMinutes, and its import: refused (409 invalid_state) when the
 *                 operation is governed (an approved version), its SMV is built from allowances, or a proposal waits
 *   a step        PATCH …/routing/steps/:stepId standardMinutes: refused when the step's SMV is copied from a version or
 *                 built from allowances (change it with PUT …/steps/:stepId/minutes, which can type an SMV again)
 *
 * Inside the caller's command (its transaction): the operation's row is the one W1 just locked or compared.
 */

/** Why a typed SMV cannot change this operation now, or null. */
export async function typedSmvRefusalOf(tx: CommandTx | FactoryClient, operationId: string): Promise<string | null> {
  const row = await tx.operation.findUnique({ where: { id: operationId }, select: MINUTES_OPERATION_COLUMNS })
  if (!row) return null
  return typedSmvRefusal(row.code, storedMinutesOf(row), await readVersions(tx, operationId))
}

/** W1's operation PATCH: a typed SMV only where governance allows it. */
export async function assertTypedSmv(tx: CommandTx, operationId: string): Promise<void> {
  const refusal = await typedSmvRefusalOf(tx, operationId)
  if (refusal) throw new InvalidStateError(refusal)
}

/** W1's step PATCH: a typed SMV only on a step whose SMV is typed. */
export async function assertTypedStepSmv(tx: CommandTx, stepId: string): Promise<void> {
  const step = await tx.routingOperation.findUnique({ where: { id: stepId }, select: { seq: true, basicMinutes: true, timeVersionId: true } })
  if (!step) return
  const number = step.timeVersionId === null ? null : ((await tx.operationTimeVersion.findUnique({ where: { id: step.timeVersionId }, select: { number: true } }))?.number ?? null)
  const refusal = typedStepRefusal(step.seq, { basicMinutes: step.basicMinutes === null ? null : decimalText(step.basicMinutes.toString()), timeVersionId: step.timeVersionId }, number)
  if (refusal) throw new InvalidStateError(refusal)
}
