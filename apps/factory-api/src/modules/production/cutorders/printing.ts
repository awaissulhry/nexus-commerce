import { createHash } from 'node:crypto'
import { DomainError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { LabelStock } from '@nexus/factory-domain/labels/zpl'
import type { CommandCaller } from '../../../core/command'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { queueModuleLabel } from '../../../platform/print/jobs'
import { readPrinter, type PrinterRow } from '../../../platform/print/printers'
import type { ModuleLabelKind } from '../../../platform/print/rules'
import { stationPrinterOf } from '../bundles/store'

/**
 * Where a cut ticket or a ply sticker run prints (B-W2b-112): the label printer asked (of the cut order's site, ACTIVE), none
 * (null: nothing is queued, the screen shows the label), or — when none is named — the floor device's station's label printer
 * (MES-184), else the cut order's table's, else the site's only ACTIVE label printer (several: the caller chooses). The job is
 * platform/print's (queueModuleLabel: print.labels at the printer is checked there, QUEUED → SENT → PRINTED or FAILED).
 */

export interface LabelTarget {
  readonly printer: PrinterRow | null
  readonly problem: string | null
}

export async function labelTarget(caller: CommandCaller, context: OfficeContext | FloorContext, site: { readonly siteId: string; readonly stationPrinterId: string | null }, printerId: string | null | undefined): Promise<LabelTarget> {
  if (printerId === null) return { printer: null, problem: 'No label printer is chosen: the label is shown, not printed.' }
  let chosen = printerId
  if (chosen === undefined && context.audience === 'floor') chosen = (await caller.withClient((client) => stationPrinterOf(client, context.deviceId))) ?? undefined
  if (chosen === undefined && site.stationPrinterId) chosen = site.stationPrinterId
  if (chosen === undefined) {
    const rows = await caller.withClient((client) => client.printer.findMany({ where: { siteId: site.siteId, kind: 'LABEL_ZPL', status: 'ACTIVE' }, select: { id: true } }))
    if (rows.length === 0) return { printer: null, problem: 'This site has no active label printer: the label is shown, not printed.' }
    if (rows.length > 1) throw new ValidationError(`This site has ${rows.length} label printers: choose one.`, [{ path: 'body/printerId', message: 'Name the label printer, or null to show the label without printing it.' }])
    chosen = rows[0]!.id
  }
  const printer = await readPrinter(caller, chosen)
  if (printer.siteId !== site.siteId || printer.kind !== 'LABEL_ZPL') {
    throw new ValidationError("Labels print on a label printer of the cut order's site.", [{ path: 'body/printerId', message: 'Pick a label printer of this site, or null to show the label.' }])
  }
  if (printer.status !== 'ACTIVE') throw new InvalidStateError(`Printer ${printer.code} is ${printer.status.toLowerCase()}; it takes no labels now. Pick another.`)
  return { printer, problem: null }
}

/** A print job key from the request's key (or a fresh one): short enough for the receipt's key rule. */
export const jobKey = (prefix: string, recordId: string, idempotencyKey: string | undefined): string =>
  `${prefix}:${recordId}:${createHash('sha256').update(idempotencyKey ?? newId()).digest('hex').slice(0, 24)}`

/** Queues the label (or says why not); a print refusal is words, never a failure of the change before it. */
export async function queueLabel(
  caller: CommandCaller,
  target: LabelTarget,
  label: { readonly recordType: string; readonly recordId: string; readonly kind: ModuleLabelKind; readonly scanId: string; readonly copies: number; readonly zplFor: (stock: LabelStock) => string },
  key: string,
) {
  if (!target.printer) return { job: null, problem: target.problem }
  try {
    const job = await queueModuleLabel(caller, { printerId: target.printer.id, recordType: label.recordType, recordId: label.recordId, copies: label.copies, labelKind: label.kind, scanId: label.scanId, zplFor: label.zplFor }, key)
    return { job, problem: null }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error
    return { job: null, problem: error.message }
  }
}
