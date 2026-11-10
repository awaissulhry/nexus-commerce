import { z } from 'zod'
import { businessDate as businessDateField, output } from '../../core/contracts'
import { businessDate } from '../../core/time'
import { RECALL_KINDS, type PublicNotice, type RecallKind } from './rules'

/**
 * A recall's public notice on the public DoC page (B-W2b-260 RG1:01; design links.doc › sec:recall "Safety notice: a recall
 * or safety warning for this batch comes first"; Reg. (EU) 2023/988 art. 35-36). Pure: the API reads the recalls of the
 * page's style whose notice is published and not taken down (in the tenant's system scope, as it reads the DoC) and this
 * decides which the page shows and how:
 *
 *   a batch page   the notices that call back the whole style, the batch (its number, or its work order), or garments of
 *                  it (through serials or shipments: `reach` PART, "check the serial on the label");
 *   a style page   every published notice of the style (the reader cannot tell the batch from the instructions'
 *                  code): STYLE, or the batches it calls back listed so the reader checks the label.
 *
 * Newest first. The words come per language as written; the page picks the reader's language like the declaration's.
 * Codes, numbers and the person's own words only: no person, no price.
 */

export const NOTICE_REACHES = ['STYLE', 'BATCH', 'PART'] as const
export type NoticeReach = (typeof NOTICE_REACHES)[number]

export const publicSafetyNotice = output({
  kind: z.enum(RECALL_KINDS),
  /** The action's number (RCL-2026-0003), to quote when asking. */
  number: z.string(),
  /** The day it was published (Europe/Rome). */
  publishedOn: businessDateField(),
  /**
   * STYLE: every garment of the style. BATCH: this batch whole (a batch page), or the batches listed (a style page). PART:
   * some garments of this batch (by serial or by shipment): the reader checks the serial or asks.
   */
  reach: z.enum(NOTICE_REACHES),
  /** The batch numbers it calls back whole (a style page lists them); empty for STYLE. */
  batches: z.array(z.string()),
  /** It names garment serials: the reader checks the serial on the label. */
  bySerial: z.boolean(),
  /** Per language (BCP 47): what is wrong, what to do, whom to contact. */
  words: z.record(z.string(), output({ title: z.string(), problem: z.string(), action: z.string(), contact: z.string() })),
})
export type PublicSafetyNotice = z.infer<typeof publicSafetyNotice>

/** A recall whose notice is published and not taken down, with what it calls back resolved to work orders. */
export interface PublishedRecall {
  readonly kind: RecallKind
  readonly number: string
  readonly publishedAt: Date
  readonly wholeStyle: boolean
  /** The batch numbers it calls back whole: its own and those of the work orders it names. */
  readonly wholeBatches: readonly string[]
  /** The work orders it calls back whole (named, or found by their batch number). */
  readonly wholeWorkOrderIds: readonly string[]
  /** The work orders it reaches in part: the serials' and the named shipments' lines'. */
  readonly partWorkOrderIds: readonly string[]
  readonly bySerial: boolean
  readonly words: PublicNotice
}

export interface NoticePage {
  readonly kind: 'BATCH' | 'STYLE'
  /** A batch page: its work order and its batch number. */
  readonly workOrderId: string | null
  readonly batchNumber: string | null
}

/** The notices a page shows, newest first. */
export function noticesForPage(recalls: readonly PublishedRecall[], page: NoticePage): PublicSafetyNotice[] {
  const shown: { at: number; notice: PublicSafetyNotice }[] = []
  for (const recall of recalls) {
    let reach: NoticeReach | null
    if (recall.wholeStyle) reach = 'STYLE'
    else if (page.kind === 'STYLE') reach = recall.wholeBatches.length > 0 ? 'BATCH' : 'PART'
    else if ((page.batchNumber !== null && recall.wholeBatches.includes(page.batchNumber)) || (page.workOrderId !== null && recall.wholeWorkOrderIds.includes(page.workOrderId))) reach = 'BATCH'
    else if (page.workOrderId !== null && recall.partWorkOrderIds.includes(page.workOrderId)) reach = 'PART'
    else reach = null
    if (reach === null) continue
    shown.push({
      at: recall.publishedAt.getTime(),
      notice: {
        kind: recall.kind,
        number: recall.number,
        publishedOn: businessDate(recall.publishedAt),
        reach,
        batches: reach === 'STYLE' ? [] : page.kind === 'BATCH' && page.batchNumber !== null && reach === 'BATCH' ? [page.batchNumber] : [...recall.wholeBatches],
        bySerial: recall.bySerial,
        words: Object.fromEntries(Object.entries(recall.words).map(([language, words]) => [language, { ...words }])),
      },
    })
  }
  return shown.sort((a, b) => b.at - a.at).map((entry) => entry.notice)
}
