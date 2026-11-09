import type { LabelInput, LabelLanguage } from '@nexus/factory-domain/labels/model'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { PrintJobView } from '../contract'
import { assertSeen, labelNumber, queueTag, rollTagContract, type TagBody } from './tag'

/**
 * The fabric roll's tag (B-W2b-219; FC4:06; B-W2b-107: a roll is tagged with the tenant's ROLL scan id, RL-…, and printed
 * nothing until now). One ROLL label (factory-domain labels/model): heading "Rotolo · <maker>", the article as the title, then
 * article, colour, the length left (with its unit), the width, the shade and the lot; the RL code as Code 128 and as text.
 *
 *   POST /print/jobs/roll-tag/:rollId   print.labels (office: inventory.stock.view at the roll's site; a tablet: its site's
 *        {printerId, copies?, language?}  rolls only): the tag on a label printer of a site the caller prints at
 */

export interface RollTagFacts {
  readonly code: string
  readonly maker: string | null
  readonly itemCode: string
  readonly itemName: string
  readonly colour: string | null
  readonly lengthLeft: string
  readonly uom: string
  readonly widthCm: string | null
  readonly shade: string | null
  readonly lotCode: string
}

/** The roll's label (pure). */
export function rollLabel(facts: RollTagFacts, language: LabelLanguage): LabelInput {
  return {
    kind: 'ROLL',
    language,
    scanId: facts.code,
    maker: facts.maker,
    title: `${facts.itemCode} · ${facts.itemName}`,
    fields: {
      article: facts.itemCode,
      colour: facts.colour,
      length: labelNumber(facts.lengthLeft, facts.uom, language),
      width: facts.widthCm === null ? null : labelNumber(facts.widthCm, 'CM', language),
      shade: facts.shade,
      lot: facts.lotCode,
    },
  }
}

/** The roll's facts for its tag, in the caller's scope (null: not found or not seen). */
export async function rollTagOf(db: Pick<CommandTx, 'fabricRoll' | 'company'>, rollId: string): Promise<(RollTagFacts & { readonly id: string; readonly companyId: string; readonly siteId: string }) | null> {
  const roll = await db.fabricRoll.findUnique({
    where: { id: rollId },
    select: {
      id: true,
      companyId: true,
      siteId: true,
      code: true,
      lengthLeft: true,
      uom: true,
      widthCm: true,
      shade: true,
      shadeGroup: { select: { label: true } },
      lot: { select: { code: true, item: { select: { code: true, name: true } }, itemColour: { select: { code: true, name: true } } } },
    },
  })
  if (!roll) return null
  const company = await db.company.findUnique({ where: { id: roll.companyId }, select: { legalName: true, tradeName: true } })
  return {
    id: roll.id,
    companyId: roll.companyId,
    siteId: roll.siteId,
    code: roll.code,
    maker: company?.tradeName || company?.legalName || null,
    itemCode: roll.lot.item.code,
    itemName: roll.lot.item.name,
    colour: roll.lot.itemColour ? `${roll.lot.itemColour.code} ${roll.lot.itemColour.name}`.trim() : null,
    lengthLeft: roll.lengthLeft.toString(),
    uom: roll.uom,
    widthCm: roll.widthCm === null ? null : roll.widthCm.toString(),
    shade: roll.shadeGroup?.label ?? roll.shade ?? null,
    lotCode: roll.lot.code,
  }
}

export const printRollTagContract = rollTagContract

/** POST /print/jobs/roll-tag/:rollId. */
export async function printRollTag(caller: CommandCaller, rollId: string, body: TagBody, idempotencyKey?: string): Promise<PrintJobView> {
  const roll = assertSeen(caller, await caller.withClient((client) => rollTagOf(client, rollId)), 'Roll')
  return queueTag(caller, { type: 'FabricRoll', id: roll.id }, rollLabel(roll, body.language ?? 'it'), body, idempotencyKey)
}
