import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { LABEL_LANGUAGES, type LabelInput, type LabelLanguage } from '@nexus/factory-domain/labels/model'
import { MAX_LABEL_COPIES } from '@nexus/factory-domain/labels/zpl'
import { UNITS } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { printJobView, type PrintJobView } from '../contract'
import { queueLabel } from '../jobs'

/**
 * What the roll and remnant tags share (B-W2b-219; FC4:06; plan A1 §3.9): a number in a label's words, the record's check,
 * the route's contract and the queue. The layouts (./roll.ts, ./remnant.ts) read their record and compose its label
 * (factory-domain labels/model ROLL | REMNANT); the platform queues it as ZPL for the printer's stock (jobs.ts queueLabel:
 * print.labels, a label printer of a site the caller prints at, the tenant's own scan id of the label's kind).
 */

/** A quantity as a label prints it: two places, the language's decimal mark, the unit's symbol ("25,40 m"). */
export function labelNumber(value: { toString(): string }, uom: string, language: LabelLanguage): string {
  const text = new Dec(value.toString()).toFixed(2)
  const symbol = uom in UNITS ? UNITS[uom as keyof typeof UNITS].symbol : uom
  return `${language === 'it' ? text.replace('.', ',') : text} ${symbol}`
}

/** The record is the caller's: the floor reads only its own site (row-level security), the office needs inventory.stock.view there. */
export function assertSeen<Row extends { readonly companyId: string; readonly siteId: string }>(caller: CommandCaller, row: Row | null, what: string): Row {
  const context = caller.factoryContext
  if (!row || !context) throw new NotFoundError(`${what} not found.`)
  if (context.audience === 'office' && !can(actorOf(context), INVENTORY_STOCK_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError(`${what} not found.`)
  if (context.audience !== 'office' && context.audience !== 'floor') throw new NotFoundError(`${what} not found.`)
  return row
}

export interface TagBody {
  readonly printerId: string
  readonly copies?: number | undefined
  readonly language?: LabelLanguage | undefined
}

export const tagBody = { printerId: id(), copies: z.number().int().min(1).max(MAX_LABEL_COPIES).optional(), language: z.enum(LABEL_LANGUAGES).optional() }

export const rollTagContract = defineContract({ params: input({ rollId: id() }), body: input(tagBody), response: { 201: output({ job: printJobView }) } })
export const remnantTagContract = defineContract({ params: input({ remnantId: id() }), body: input(tagBody), response: { 201: output({ job: printJobView }) } })

/** Queues the composed tag on the printer (print.labels is checked there). */
export function queueTag(caller: CommandCaller, record: { readonly type: string; readonly id: string }, label: LabelInput, body: TagBody, idempotencyKey?: string): Promise<PrintJobView> {
  return queueLabel(caller, { printerId: body.printerId, recordType: record.type, recordId: record.id, copies: body.copies ?? 1, label }, idempotencyKey)
}
