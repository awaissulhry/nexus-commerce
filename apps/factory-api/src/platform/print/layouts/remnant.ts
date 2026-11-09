import type { LabelInput, LabelLanguage } from '@nexus/factory-domain/labels/model'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { PrintJobView } from '../contract'
import { assertSeen, labelNumber, queueTag, remnantTagContract, type TagBody } from './tag'

/**
 * The remnant's tag (B-W2b-219; FC4:06; B-W2b-100 and -110: a usable offcut of a hide is stock with its own REMNANT scan id,
 * RM-…, and its return printed the hide's HD tag until now). One REMNANT label (factory-domain labels/model): heading
 * "Ritaglio · <maker>", the article as the title, then article, colour, the piece's area, its grade, the hide it is cut from
 * and the lot; the RM code as Code 128 and as text (the HD code stays on the hide's own tag).
 *
 *   POST /print/jobs/remnant-tag/:remnantId   print.labels (office: inventory.stock.view at the piece's site; a tablet: its
 *        {printerId, copies?, language?}        site's pieces only): the tag on a label printer of a site the caller prints at
 */

export interface RemnantTagFacts {
  readonly code: string
  readonly maker: string | null
  readonly itemCode: string
  readonly itemName: string
  readonly colour: string | null
  readonly area: string
  readonly areaUom: string
  readonly grade: string | null
  readonly hideCode: string
  readonly lotCode: string
}

/** The remnant's label (pure). */
export function remnantLabel(facts: RemnantTagFacts, language: LabelLanguage): LabelInput {
  return {
    kind: 'REMNANT',
    language,
    scanId: facts.code,
    maker: facts.maker,
    title: `${facts.itemCode} · ${facts.itemName}`,
    fields: { article: facts.itemCode, colour: facts.colour, area: labelNumber(facts.area, facts.areaUom, language), grade: facts.grade, hide: facts.hideCode, lot: facts.lotCode },
  }
}

/** The remnant's facts for its tag, in the caller's scope (null: not found or not seen). */
export async function remnantTagOf(db: Pick<CommandTx, 'remnant' | 'company'>, remnantId: string): Promise<(RemnantTagFacts & { readonly id: string; readonly companyId: string; readonly siteId: string }) | null> {
  const piece = await db.remnant.findUnique({
    where: { id: remnantId },
    select: {
      id: true,
      companyId: true,
      siteId: true,
      code: true,
      area: true,
      areaUom: true,
      grade: { select: { code: true } },
      hide: { select: { code: true, grade: true, lot: { select: { code: true, item: { select: { code: true, name: true } }, itemColour: { select: { code: true, name: true } } } } } },
    },
  })
  if (!piece) return null
  const company = await db.company.findUnique({ where: { id: piece.companyId }, select: { legalName: true, tradeName: true } })
  return {
    id: piece.id,
    companyId: piece.companyId,
    siteId: piece.siteId,
    code: piece.code,
    maker: company?.tradeName || company?.legalName || null,
    itemCode: piece.hide.lot.item.code,
    itemName: piece.hide.lot.item.name,
    colour: piece.hide.lot.itemColour ? `${piece.hide.lot.itemColour.code} ${piece.hide.lot.itemColour.name}`.trim() : null,
    area: piece.area.toString(),
    areaUom: piece.areaUom,
    grade: piece.grade?.code ?? piece.hide.grade ?? null,
    hideCode: piece.hide.code,
    lotCode: piece.hide.lot.code,
  }
}

export const printRemnantTagContract = remnantTagContract

/** POST /print/jobs/remnant-tag/:remnantId. */
export async function printRemnantTag(caller: CommandCaller, remnantId: string, body: TagBody, idempotencyKey?: string): Promise<PrintJobView> {
  const piece = assertSeen(caller, await caller.withClient((client) => remnantTagOf(client, remnantId)), 'Remnant')
  return queueTag(caller, { type: 'Remnant', id: piece.id }, remnantLabel(piece, body.language ?? 'it'), body, idempotencyKey)
}
