import { createHash } from 'node:crypto'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { PRINT_LABELS } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { LabelInput, LabelLanguage } from '@nexus/factory-domain/labels/model'
import { UNITS } from '@nexus/factory-domain/product/units/units'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { queueLabel } from '../../../platform/print/jobs'
import { readPrinter } from '../../../platform/print/printers'
import { byId, ids, readColours, readItems } from '../receipts/store'
import { tagPrinterOf } from './read'

/**
 * Hide tags on the station's label printer (B-W1-33; SCM-259, SCM-268; design floor.receive "Save · print tag", popup
 * receive.reprint): one HIDE label per hide (factory-domain labels/model: its HIDE scan id as Code 128 and text, the
 * article, colour, grade, area, thickness and lot), one print job each (platform/print queueLabel, print.labels at the
 * device's site), so a tag that failed is retried or reprinted alone. After the receipt's command, never inside it: the
 * receipt stands whatever the printer does.
 *
 *   first print   right after the receipt, key `hide-tag.<hide>`: a resend of the receipt's request prints nothing twice
 *   reprint       POST …/receipts/:id/tags with a reason: one floor command that logs each reprint on its hide
 *                 (`inventory.hideTagReprinted`, the reason), then the jobs, keyed by the request
 *
 * The printer: the one asked (a label printer of the device's site), else the device's station's, else the site's only
 * active label printer; none: no job, the answer says why (the tags print as PDF from the office later).
 */

export const REPRINT_REASONS = { DAMAGED: 'The tag was damaged.', LOST: 'The tag was lost.', NOT_PRINTED: 'The tag did not print.', OTHER: 'Printed again.' } as const
export type ReprintReason = keyof typeof REPRINT_REASONS

const NO_PRINTER = 'No label printer at this station or site: the tags are not printed.'

/** A decimal as a label prints it in the language ("52,3" in Italian). */
const number = (value: { toString(): string }, language: LabelLanguage): string => {
  const text = new Dec(value.toString()).toString()
  return language === 'it' ? text.replace('.', ',') : text
}

interface TagTarget {
  readonly printer: { readonly id: string; readonly code: string; readonly name: string } | null
  readonly problem: string | null
}

/** The label printer the tags go to, checked before any job. */
async function tagTarget(caller: CommandCaller, context: FloorContext, printerId: string | null | undefined): Promise<TagTarget> {
  if (printerId === null) return { printer: null, problem: 'Printing was not asked for.' }
  if (printerId === undefined) {
    const printer = await caller.withClient((client) => tagPrinterOf(client, context))
    return printer ? { printer, problem: null } : { printer: null, problem: NO_PRINTER }
  }
  const printer = await readPrinter(caller, printerId)
  if (printer.siteId !== context.siteId || printer.kind !== 'LABEL_ZPL') {
    throw new ValidationError('Hide tags print on a label printer of this site.', [{ path: 'body/printerId', message: 'Pick a label printer of this site.' }])
  }
  if (!can(actorOf(context), PRINT_LABELS, { companyId: printer.companyId, siteId: printer.siteId })) throw new ForbiddenError('Printing tags needs print.labels.')
  if (printer.status !== 'ACTIVE') throw new InvalidStateError(`Printer ${printer.code} is ${printer.status.toLowerCase()}; it takes no tags now.`)
  return { printer: { id: printer.id, code: printer.code, name: printer.name }, problem: null }
}

/** The receipt's hides as their labels say them. */
async function tagsOf(caller: CommandCaller, receiptId: string, hideIds: readonly string[] | undefined, language: LabelLanguage) {
  return caller.withClient(async (client) => {
    const receipt = await client.goodsReceipt.findUnique({ where: { id: receiptId }, select: { id: true, companyId: true, status: true } })
    if (!receipt) throw new NotFoundError('Goods receipt not found.')
    const lines = await client.goodsReceiptLine.findMany({ where: { receiptId }, select: { id: true, itemId: true, itemColourId: true } })
    const lots = byId(await client.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: { id: true, code: true, receiptLineId: true, itemColourId: true } }))
    const hides = await client.hide.findMany({
      where: { lotId: { in: [...lots.keys()] }, ...(hideIds ? { id: { in: ids(hideIds) } } : {}) },
      select: { id: true, code: true, lotId: true, itemId: true, area: true, areaUom: true, grade: true, thicknessMm: true },
      orderBy: { code: 'asc' },
    })
    if (hideIds && hides.length !== new Set(hideIds).size) throw new ValidationError('Not every hide is of this receipt.', [{ path: 'body/hideIds', message: 'Hides of this receipt only.' }])
    const items = await readItems(client, hides.map((hide) => hide.itemId))
    const colours = await readColours(client, [...lots.values()].map((lot) => lot.itemColourId))
    const company = await client.company.findUnique({ where: { id: receipt.companyId }, select: { legalName: true, tradeName: true } })
    const maker = company?.tradeName || company?.legalName || null
    return {
      receipt,
      tags: hides.map((hide) => {
        const item = items.get(hide.itemId)!
        const lot = lots.get(hide.lotId)!
        const colour = lot.itemColourId ? colours.get(lot.itemColourId) : undefined
        const label: LabelInput = {
          kind: 'HIDE',
          language,
          scanId: hide.code,
          maker,
          title: item.name,
          fields: {
            article: item.code,
            colour: colour ? `${colour.code} ${colour.name}` : null,
            grade: hide.grade,
            area: `${number(hide.area, language)} ${UNITS[hide.areaUom].symbol}`,
            thickness: hide.thicknessMm === null ? null : `${number(hide.thicknessMm, language)} mm`,
            lot: lot.code,
          },
        }
        return { hideId: hide.id, code: hide.code, label }
      }),
    }
  })
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)

/**
 * Queues the tags (after the receipt's command). `requestKey` null: the first print (once per hide, whatever is resent);
 * else a reprint, keyed by its request. A refusal of the print module (printer paused meanwhile) is the tag's problem,
 * not the request's.
 */
export async function queueTags(
  caller: CommandCaller,
  context: FloorContext,
  receiptId: string,
  options: { readonly printerId?: string | null | undefined; readonly language?: LabelLanguage | undefined; readonly hideIds?: readonly string[] | undefined; readonly requestKey: string | null },
): Promise<{ printer: TagTarget['printer']; problems: Map<string, string> }> {
  const language = options.language ?? 'it'
  const target = await tagTarget(caller, context, options.printerId)
  const { tags } = await tagsOf(caller, receiptId, options.hideIds, language)
  const problems = new Map<string, string>()
  for (const tag of tags) {
    if (!target.printer) {
      problems.set(tag.hideId, target.problem ?? NO_PRINTER)
      continue
    }
    const key = options.requestKey === null ? `hide-tag.${tag.hideId}` : `hide-tag.${tag.hideId}.${digest(options.requestKey)}`
    try {
      await queueLabel(caller, { printerId: target.printer.id, recordType: 'Hide', recordId: tag.hideId, copies: 1, label: tag.label }, key)
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      problems.set(tag.hideId, error.message)
    }
  }
  return { printer: target.printer, problems }
}

/** A reprint: one floor command logs each tag printed again with its reason on its hide (SCM-268), then the jobs. */
export async function reprintTags(
  caller: CommandCaller,
  context: FloorContext,
  receiptId: string,
  body: { readonly hideIds?: readonly string[] | undefined; readonly printerId?: string | null | undefined; readonly language?: LabelLanguage | undefined; readonly reason?: ReprintReason | undefined },
  idempotencyKey: string | undefined,
) {
  const { receipt, tags } = await tagsOf(caller, receiptId, body.hideIds, body.language ?? 'it')
  if (receipt.status !== 'POSTED') throw new InvalidStateError(`The receipt is ${receipt.status.toLowerCase()}: its tags are not printed again.`)
  const reason = REPRINT_REASONS[body.reason ?? 'OTHER']
  await command(caller, { name: 'inventory.reprintHideTags', idempotencyKey, input: { receiptId, ...body } }, async (tools) => {
    for (const tag of tags) {
      tools.audit({ action: 'inventory.hideTagReprinted', recordType: 'Hide', recordId: tag.hideId, companyId: receipt.companyId, siteId: context.siteId, reason, after: { code: tag.code, receiptId, printerId: body.printerId ?? null } })
    }
    return { hides: tags.length }
  })
  return queueTags(caller, context, receiptId, { printerId: body.printerId, language: body.language, hideIds: tags.map((tag) => tag.hideId), requestKey: idempotencyKey ?? null })
}
