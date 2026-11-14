import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { MAX_LABEL_COPIES } from '@nexus/factory-domain/labels/zpl'
import { PACK_PARTS, PART_STATES } from '@nexus/factory-domain/shipping/shipment-pack/rules'

/** One PDF per shipment (B-W2b-391; LOG-031). No money in any answer (a priced part is only named). */

const part = output({
  kind: z.enum(PACK_PARTS),
  state: z.enum(PART_STATES),
  number: z.string().nullable(),
  /** Why it is missing or not shown; for a ready part a note (a parcel without its label yet). */
  words: z.string().nullable(),
  /** How many files it adds (one per labelled parcel for the labels). */
  files: z.number().int(),
})

const version = output({
  documentId: id(),
  version: z.number().int(),
  pages: z.number().int().nullable(),
  createdAt: instant(),
  /** It still holds the papers as they are now. */
  current: z.boolean(),
})

export const packStateContract = defineContract({
  params: input({ shipmentId: id() }),
  response: {
    200: output({
      shipmentId: id(),
      number: z.string(),
      status: z.string(),
      parts: z.array(part),
      latest: version.nullable(),
      /** The site's document printer (A4) the office's pack goes to; null: none (the browser prints the PDF). */
      printer: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
    }),
  },
})

export const makePackContract = defineContract({
  params: input({ shipmentId: id() }),
  body: input({
    /** Office: queue ONE print job of the pack on the document printer (default true). A floor device prints the PDF itself. */
    print: z.boolean().optional(),
    /** An A4 printer of the shipment's site; default the site's document printer. */
    printerId: id().optional(),
    copies: z.number().int().min(1).max(MAX_LABEL_COPIES).optional(),
  }),
  response: {
    200: output({
      shipmentId: id(),
      number: z.string(),
      /** made false: the newest version already holds these papers. */
      pack: output({ documentId: id(), version: z.number().int(), pages: z.number().int().nullable(), made: z.boolean(), createdAt: instant() }),
      parts: z.array(part),
      /** The one print job (office), or null. */
      job: output({ jobId: id(), printerId: id(), status: z.literal('QUEUED') }).nullable(),
      /** Why it was not printed (no document printer, a printer that prints from the browser), or null. */
      problem: output({ code: z.enum(['NO_PRINTER', 'PRINTER']), message: z.string() }).nullable(),
    }),
  },
})

export const packPdfContract = defineContract({
  params: input({ shipmentId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1).optional() }),
  response: {},
})
