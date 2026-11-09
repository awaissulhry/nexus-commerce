import { z } from 'zod'
import { SHEET_TYPES } from '../../imports/job'
import { COMMERCE_IMPORT_LIMITS, COMMERCE_IMPORTER_KEY } from './importer'

/**
 * Where a style started from a Nexus Commerce product comes from (B-W2b-209; PRD-265; Owner answer 2026-11-09 Q4 = A:
 * "Nexus Commerce = an export FILE only"). Two sources, one of them switched off:
 *
 *   EXPORT_FILE  a Commerce product export the person downloads in Commerce and uploads here (./importer, through the
 *                imports registry: dry run, then apply). Always on.
 *   LIVE_READ    the factory reading product families from Commerce itself. OFF: it waits for the Owner's word (W2b-4
 *                plan, question 4 "B later, when you widen the range, with its own yes"). No code reads Commerce: no
 *                link, no key, no call to the Commerce API or its database. Turning it on is a later step with its own
 *                provider behind the gateway (a fake one in tests) and this switch read from a setting.
 *
 * Nothing goes back to Commerce either way: a style's release is not sent there (B-W2b-231 waits for the same word).
 * The answer below is what `GET /product/commerce-import` says, so the screen draws the switch from the server's word.
 */

/** The file formats an export is read in (the imports engine's). */
export const SHEET_FORMATS = ['csv', 'xlsx'] as const satisfies readonly (keyof typeof SHEET_TYPES)[]

export const COMMERCE_SOURCES = ['EXPORT_FILE', 'LIVE_READ'] as const
export type CommerceSource = (typeof COMMERCE_SOURCES)[number]

export const SWITCH_STATES = ['ON', 'OFF'] as const
/** Why a source is off: the Owner has not said yes to a live link with Commerce. */
export const SOURCE_HELD_REASONS = ['OWNER_WORD'] as const

/** The live read's switch: OFF until the Owner's word (a constant on purpose: no setting can turn it on by mistake). */
export const COMMERCE_LIVE_READ = Object.freeze({ state: 'OFF' as const, reasonCode: 'OWNER_WORD' as const })

export const commerceSourceView = z.strictObject({
  source: z.enum(COMMERCE_SOURCES),
  state: z.enum(SWITCH_STATES),
  /** Why it is off; null while on. */
  reasonCode: z.enum(SOURCE_HELD_REASONS).nullable(),
})
export type CommerceSourceView = z.infer<typeof commerceSourceView>

export const commerceImportView = z.strictObject({
  /** The importer the export file goes through (POST /imports with this key). */
  importerKey: z.literal(COMMERCE_IMPORTER_KEY),
  /** At most this many rows (SKUs) in one file: a bigger export is split by family. */
  maxRows: z.number().int(),
  formats: z.array(z.enum(SHEET_FORMATS)),
  sources: z.array(commerceSourceView),
})
export type CommerceImportView = z.infer<typeof commerceImportView>

/** What `GET /product/commerce-import` answers: the file is on, the live read OFF with its reason. */
export function commerceImportInfo(): CommerceImportView {
  return {
    importerKey: COMMERCE_IMPORTER_KEY,
    maxRows: COMMERCE_IMPORT_LIMITS.rows,
    formats: [...SHEET_FORMATS],
    sources: [
      { source: 'EXPORT_FILE', state: 'ON', reasonCode: null },
      { source: 'LIVE_READ', state: COMMERCE_LIVE_READ.state, reasonCode: COMMERCE_LIVE_READ.reasonCode },
    ],
  }
}

/** A style an import job of Commerce families started or added to (`GET /product/commerce-import/jobs/:jobId`). */
export const startedStyleView = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
  lifecycle: z.string(),
  /** The job made the style (true) or added colours, sizes and SKUs to one that was there (false). */
  started: z.boolean(),
  /** The SKUs the job made on it. */
  skus: z.number().int(),
})
export type StartedStyleView = z.infer<typeof startedStyleView>

export const startedStylesView = z.strictObject({
  jobId: z.uuid(),
  status: z.string(),
  styles: z.array(startedStyleView),
  /** Styles the job wrote that the caller may not see (counted, never named). */
  hidden: z.number().int(),
})
export type StartedStylesView = z.infer<typeof startedStylesView>
