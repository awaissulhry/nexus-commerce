import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { printerView, printJobView } from '../contract'
import { DIRECT_OUTCOMES, PRINTER_MODES } from './rules'

/**
 * The routes of direct thermal printing (B-W2b-391; LOG-026). The printer's address is handed to a station only in the answer
 * of the job it takes (a floor device reads no relay target otherwise).
 */

export const setPrinterModeContract = defineContract({
  params: input({ printerId: id() }),
  body: input({ mode: z.enum(PRINTER_MODES), version: z.number().int().min(1) }),
  /** changed false: the printer had this mode already (no audit row). */
  response: { 200: output({ printer: printerView, mode: z.enum(PRINTER_MODES), changed: z.boolean() }) },
})

/** A DIRECT printer as the station sees it (without its address). */
const directPrinter = output({
  id: id(),
  siteId: id(),
  code: z.string(),
  name: z.string(),
  dpi: z.number().int().nullable(),
  labelWidthMm: z.number().int().nullable(),
  labelHeightMm: z.number().int().nullable(),
  status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']),
})

export const directQueueContract = defineContract({
  querystring: input({ printerId: id().optional(), siteId: id().optional() }),
  /** The DIRECT printers the caller prints at, and their jobs waiting for a station (oldest first), without the ZPL. */
  response: { 200: output({ printers: z.array(directPrinter), jobs: z.array(printJobView) }) },
})

export const takeDirectJobContract = defineContract({
  params: input({ jobId: id() }),
  body: input({}),
  response: {
    200: output({
      job: printJobView,
      /** What the station sends: the ZPL exactly as queued (with its copies), to the printer's address. */
      zpl: z.string(),
      copies: z.number().int(),
      printer: output({ id: id(), code: z.string(), name: z.string(), address: z.string(), dpi: z.number().int().nullable(), labelWidthMm: z.number().int().nullable(), labelHeightMm: z.number().int().nullable() }),
      takenAt: instant(),
    }),
  },
})

export const reportDirectJobContract = defineContract({
  params: input({ jobId: id() }),
  body: input({
    outcome: z.enum(DIRECT_OUTCOMES),
    /** FAILED: what the station saw ("no answer from 192.168.1.50"); kept on the job in its words. */
    message: z.string().max(300).optional(),
  }),
  response: { 200: output({ job: printJobView }) },
})
