import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { cancelFeePctOf, cancelFeeProblems, cancelFeeWords } from '@nexus/factory-domain/sales/change-requests/fee'
import { cutoffProblems, cutoffsOf, type Cutoffs, type CutoffStatus } from '@nexus/factory-domain/sales/change-requests/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { Clock } from '../../../core/time'
import { mayWrite } from '../../product/materials/store'
import { officeContextOf } from '../orders/access'
import { CUTOFF_COLUMNS, readCutoffs, type CutoffRow } from './store'

/**
 * The cut-off rules of change and cancel requests (B-W2b-183; SAL-078; B-W2b-157's SalesSettings columns): from which order
 * status on a cancel or a change is no longer asked from the portal, and within how many days of the promise date a cancel
 * is not. Kept on the sales settings row of a company (else the tenant's: the whole row, B-W2b-157), which the quote rules
 * make (PUT /sales/settings): these routes change only the three columns of a row that exists.
 *
 *   GET /sales/change-requests/settings?companyId   orders.view: the rules in force and where they come from
 *   PUT /sales/change-requests/settings             sales.settings.manage (a tenant-wide row only by a grant over every
 *                                                   company): the three columns at the row's version
 * B-W2b-F14 (SalesSettings.cancelFeePct): the cancel fee travels with them — a percent of the cancelled lines' net value,
 * 0 to 100 with at most 4 decimals, null free; refused out of range in words (the database's check holds the same). The
 * PUT leaves it as it is when the body does not name it.
 */

const cutoffView = (cutoffs: Cutoffs, cancelFeePct: string | null) => ({ cancelCutoffStatus: cutoffs.cancelStatus, cancelCutoffDays: cutoffs.cancelDays, changeCutoffStatus: cutoffs.changeStatus, cancelFeePct })
const rowView = (row: CutoffRow | null) => (row ? { id: row.id, version: row.version, cutoffs: cutoffView(cutoffsOf(row), cancelFeePctOf(row.cancelFeePct)) } : null)

async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } }))
  if (!row || !can(actorOf(context), ORDERS_VIEW, { companyId })) throw new NotFoundError('Company not found.')
}

export async function getCutoffs(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  const companyId = query.companyId ?? null
  const found = await caller.withClient((client) => readCutoffs(client, context.tenantId, companyId))
  return { companyId, source: found.source, inForce: cutoffView(found.cutoffs, found.cancelFeePct), row: rowView(companyId === null ? found.tenant : found.company), cancelFeeWords: cancelFeeWords(found.cancelFeePct) }
}

export interface SaveCutoffsBody {
  readonly companyId?: string | null | undefined
  readonly version: number
  readonly cancelCutoffStatus: CutoffStatus | null
  readonly cancelCutoffDays: number | null
  readonly changeCutoffStatus: CutoffStatus | null
  /** B-W2b-F14: the cancel fee, percent (decimal text); null: free; left out: unchanged. */
  readonly cancelFeePct?: string | null | undefined
}

const FIELDS = ['cancelCutoffStatus', 'cancelCutoffDays', 'changeCutoffStatus'] as const

export async function saveCutoffs(caller: CommandCaller, body: SaveCutoffsBody, idempotencyKey: string | undefined, clock: Clock) {
  const context = officeContextOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? 'The tenant-wide sales settings are changed only by a role over every company.' : undefined)
  if (companyId !== null) await assertCompany(caller, companyId)
  const problems = [...cutoffProblems({ cancelStatus: body.cancelCutoffStatus, cancelDays: body.cancelCutoffDays, changeStatus: body.changeCutoffStatus }), ...(body.cancelFeePct === undefined ? [] : cancelFeeProblems(body.cancelFeePct))]
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const id = companyId ?? context.tenantId
  const existing = await caller.withClient((client) => client.salesSettings.findUnique({ where: { id }, select: CUTOFF_COLUMNS }))
  if (!existing) throw new ConflictError('Save the sales settings of this company first (Sales › Settings): the cut-off rules are kept with them.')
  const wanted = { cancelCutoffStatus: body.cancelCutoffStatus, cancelCutoffDays: body.cancelCutoffDays, changeCutoffStatus: body.changeCutoffStatus }
  await runCommand(
    caller,
    { name: 'sales.saveChangeCutoffs', idempotencyKey, input: body, record: { type: 'SalesSettings', id, expectedVersion: body.version } },
    async (tools) => {
      const before = await tools.tx.salesSettings.findUniqueOrThrow({ where: { id }, select: CUTOFF_COLUMNS })
      const changed: string[] = FIELDS.filter((field) => before[field] !== wanted[field])
      // B-W2b-F14: the cancel fee, when named (compared as a number: "15" and "15.0000" are the same fee).
      const feeBefore = cancelFeePctOf(before.cancelFeePct)
      const feeAfter = body.cancelFeePct === undefined ? feeBefore : body.cancelFeePct === null ? null : cancelFeePctOf(body.cancelFeePct.trim())
      if (feeAfter !== feeBefore) changed.push('cancelFeePct')
      if (changed.length > 0) await tools.tx.salesSettings.update({ where: { id }, data: { ...wanted, ...(feeAfter !== feeBefore ? { cancelFeePct: feeAfter } : {}), updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'SalesSettings', recordId: id, companyId, before: { cancelCutoffStatus: before.cancelCutoffStatus, cancelCutoffDays: before.cancelCutoffDays, changeCutoffStatus: before.changeCutoffStatus, cancelFeePct: feeBefore }, after: { ...wanted, cancelFeePct: feeAfter } })
      if (changed.length > 0) tools.emit({ type: 'sales_settings.changed', subject: id, companyId, payload: { settingsId: id, fields: [...changed] } })
      return null
    },
    { ...COMMAND_SETTINGS, clock },
  )
  return getCutoffs(caller, companyId === null ? {} : { companyId })
}
