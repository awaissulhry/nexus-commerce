import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MARKUP_MAX_SHAPES, MARKUP_NOTE_MAX } from '@nexus/factory-domain/files/markup/rules'
import { fileView, presignedView } from '../contract'

/**
 * Markup and the versions pop-up (COL-055, COL-046; B-W2b-177): marks on a picture (its marked copy becomes the next version)
 * or on a PDF page (an overlay), the markups of a file's series, and the series as the shell's Versions pop-up lists it.
 */

const fileParams = input({ fileId: id() })

const point = output({ x: z.number(), y: z.number() })
/** A mark as kept: the DS PhotoCapture's own (the rules check each before it is stored). */
const shapeView = z.union([output({ kind: z.literal('arrow'), from: point, to: point }), output({ kind: z.literal('circle'), center: point, radius: z.number() })])

export const markupView = output({
  id: id(),
  /** The version marked up. */
  fileId: id(),
  versionNo: z.number().int().nullable(),
  page: z.number().int().nullable(),
  shapes: z.array(shapeView),
  note: z.string().nullable(),
  /** The marked picture (the series' next version), or null for a PDF's overlay. */
  resultFileId: id().nullable(),
  createdById: id().nullable(),
  /** Who drew it as the office reads it: a colleague's name, the partner's organisation, or null (the system). */
  createdByName: z.string().nullable(),
  fromPartner: z.boolean(),
  createdAt: instant(),
})
export type MarkupView = z.infer<typeof markupView>

export const createMarkupContract = defineContract({
  params: fileParams,
  body: input({
    /** A PDF's page (1 = the first); null for a picture. */
    page: z.number().int().nullable(),
    shapes: z.array(z.unknown()).max(MARKUP_MAX_SHAPES + 1),
    note: z.string().max(MARKUP_NOTE_MAX + 100).nullable(),
    /** A picture's marked copy, announced like a new version (its bytes go to the store with the presigned PUT, then POST /files/:id/complete); null for a PDF. */
    result: input({
      contentType: z.string().min(1).max(200),
      sizeBytes: z.number().int().min(1),
      sha256: z.string(),
    }).nullable(),
  }),
  response: { 201: output({ markup: markupView, file: fileView.nullable(), upload: presignedView.nullable() }) },
})

export const listMarkupsContract = defineContract({ params: fileParams, response: { 200: output({ markups: z.array(markupView) }) } })

/** One version as the Versions pop-up lists it. */
export const historyVersionView = fileView.extend({
  current: z.boolean(),
  /** Who added it: a colleague, the partner's organisation, or null (the system: a copy, a document made by Nexus). */
  addedBy: output({ id: id().nullable(), name: z.string().nullable(), fromPartner: z.boolean() }),
  /** The markup it was made by (a marked picture), or null. */
  madeByMarkup: output({ id: id(), note: z.string().nullable(), marks: z.number().int() }).nullable(),
  /** The copies of this version on other records: "Goods receipt GR-0098 uses v2". */
  usedBy: z.array(output({ fileId: id(), recordType: z.string(), recordId: id(), label: z.string().nullable() })),
  /** How many markups were drawn on this version. */
  markups: z.number().int(),
})

export const fileHistoryContract = defineContract({ params: fileParams, response: { 200: output({ versions: z.array(historyVersionView) }) } })
