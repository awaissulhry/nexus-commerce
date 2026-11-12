import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LABEL_LANGUAGES } from '@nexus/factory-domain/labels/model'
import { MAX_LABEL_MM, MIN_LABEL_HEIGHT_MM, MIN_LABEL_WIDTH_MM } from '@nexus/factory-domain/labels/zpl'
import { BLOCK_NOTE_MAX, BLOCK_REASONS } from '@nexus/factory-domain/inventory/locations-depth/blocks'
import { DEFAULT_PURPOSES, HELD_ITEM_KINDS, LOCATION_GROUPS, LOCATION_HOLDS } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { LABEL_CODE_MAX, MAX_BIN_LABEL_COPIES, MAX_LABELS_AT_ONCE } from '@nexus/factory-domain/inventory/locations-depth/labels'
import { LOCATION_KINDS, LOCATION_STATUSES } from '@nexus/factory-domain/inventory/locations/rules'
import { PRINT_JOB_STATUSES } from '../../../platform/print/rules'

/**
 * Locations in depth (B-W2b-289; SCM-177, SCM-178, SCM-179, SCM-181): the contracts of the location types, the bin labels
 * (codes, the scan, print and PDF), the blocks and the default locations. No field carries money; no person's figure.
 */

const version = () => z.number().int().min(1)
const kind = z.enum(LOCATION_KINDS)
const purpose = z.enum(DEFAULT_PURPOSES)
const itemKind = z.enum(HELD_ITEM_KINDS)

// ---- SCM-177 location types ---------------------------------------------------------------------------------------------

export const kindProfileView = output({
  kind,
  group: z.enum(LOCATION_GROUPS),
  holds: z.enum(LOCATION_HOLDS),
  /** The party's roles an outside place names; null: none. */
  party: z.array(z.enum(['SUBCONTRACTOR', 'CUSTOMER', 'BRAND'])).nullable(),
  transferOnly: z.boolean(),
  purposes: z.array(purpose),
  labelled: z.boolean(),
  blockable: z.boolean(),
  atTop: z.boolean(),
  container: z.boolean(),
  fixed: z.boolean(),
})

export const kindsContract = defineContract({ response: { 200: output({ kinds: z.array(kindProfileView) }) } })

// ---- a place in short ---------------------------------------------------------------------------------------------------

export const blockView = output({
  reason: z.enum(BLOCK_REASONS),
  note: z.string().nullable(),
  /** The last day it holds (Europe/Rome); null: until unblocked. */
  until: businessDate().nullable(),
  at: instant(),
  byId: id().nullable(),
  /** False once its until-day passed (the database lets moves through again). */
  holds: z.boolean(),
  /** The count whose counting holds it (its mark), or null. */
  countNumber: z.string().nullable(),
})
export type BlockView = z.infer<typeof blockView>

export const placeView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  siteCode: z.string(),
  code: z.string(),
  name: z.string(),
  kind,
  status: z.enum(LOCATION_STATUSES),
  labelCode: z.string().nullable(),
  block: blockView.nullable(),
  version: z.number().int(),
})
export type PlaceView = z.infer<typeof placeView>

const params = input({ locationId: id() })
const one = { 200: output({ location: placeView }) }

// ---- SCM-181 blocks -----------------------------------------------------------------------------------------------------

export const blockContract = defineContract({
  params,
  body: input({
    version: version(),
    reason: z.enum(BLOCK_REASONS),
    note: z.string().trim().max(BLOCK_NOTE_MAX).nullish(),
    /** The last day the block holds (YYYY-MM-DD, Europe/Rome); none: until unblocked. */
    until: businessDate().nullish(),
  }),
  response: one,
})

export const unblockContract = defineContract({ params, body: input({ version: version() }), response: one })

export const blockedContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ locations: z.array(placeView) }) },
})

// ---- SCM-178 bin labels -------------------------------------------------------------------------------------------------

export const labelCodeContract = defineContract({
  params,
  body: input({
    version: version(),
    /** The code its label carries (upper-cased); null takes it off; left out: the suggested one. */
    labelCode: z.string().trim().min(1).max(LABEL_CODE_MAX).nullish(),
  }),
  response: { 200: output({ location: placeView, printed: z.number().int().min(0) }) },
})

const binLabelView = output({
  language: z.enum(LABEL_LANGUAGES),
  heading: z.string(),
  title: z.string(),
  scanId: z.string(),
  fields: z.array(output({ label: z.string(), value: z.string() })),
})

const labelJobView = output({
  jobId: id(),
  printerId: id(),
  printerCode: z.string(),
  state: z.enum(PRINT_JOB_STATUSES),
  copies: z.number().int(),
  lastError: z.string().nullable(),
  at: instant(),
  printedAt: instant().nullable(),
})

export const labelContract = defineContract({
  params,
  querystring: input({ language: z.enum(LABEL_LANGUAGES).optional() }),
  response: {
    200: output({
      location: placeView,
      /** The code a label would carry now: its own, or (none yet) the suggested one. */
      code: z.string(),
      suggested: z.boolean(),
      labelled: z.boolean(),
      label: binLabelView,
      jobs: z.array(labelJobView),
    }),
  },
})

const locationIds = z.array(id()).min(1).max(MAX_LABELS_AT_ONCE)

export const printLabelsContract = defineContract({
  body: input({
    printerId: id(),
    locationIds,
    copies: z.number().int().min(1).max(MAX_BIN_LABEL_COPIES).default(1),
    language: z.enum(LABEL_LANGUAGES).default('it'),
  }),
  response: {
    201: output({
      jobs: z.array(output({ locationId: id(), labelCode: z.string(), jobId: id(), state: z.enum(PRINT_JOB_STATUSES) })),
      refused: z.array(output({ locationId: id(), code: z.string(), message: z.string() })),
    }),
  },
})

export const labelsPdfContract = defineContract({
  body: input({
    locationIds,
    widthMm: z.number().int().min(MIN_LABEL_WIDTH_MM).max(MAX_LABEL_MM).default(100),
    heightMm: z.number().int().min(MIN_LABEL_HEIGHT_MM).max(MAX_LABEL_MM).default(50),
    copies: z.number().int().min(1).max(MAX_BIN_LABEL_COPIES).default(1),
    language: z.enum(LABEL_LANGUAGES).default('it'),
  }),
  response: {},
})

export const scanContract = defineContract({
  querystring: input({ code: z.string().trim().min(1).max(LABEL_CODE_MAX) }),
  response: { 200: output({ location: placeView, path: z.array(z.string()) }) },
})

// ---- SCM-179 default locations ------------------------------------------------------------------------------------------

export const defaultView = output({
  id: id(),
  itemKind: itemKind.nullable(),
  purpose,
  location: output({ id: id(), code: z.string(), name: z.string(), kind, status: z.enum(LOCATION_STATUSES) }),
  version: z.number().int(),
  updatedAt: instant(),
  /** Who changed it last (Warehouse rules "Changed by"): a user id. */
  updatedById: id().nullable(),
})
export type DefaultView = z.infer<typeof defaultView>

export const defaultsContract = defineContract({
  querystring: input({ siteId: id() }),
  response: { 200: output({ siteId: id(), defaults: z.array(defaultView) }) },
})

export const setDefaultContract = defineContract({
  body: input({
    siteId: id(),
    /** null: the site's fallback for every kind without a default of its own. */
    itemKind: itemKind.nullable(),
    purpose,
    /** null clears it (the earlier row kept inactive). */
    locationId: id().nullable(),
    /** The version of the active default the caller read; left out when there is none yet. */
    version: version().optional(),
  }),
  response: { 200: output({ default: defaultView.nullable() }) },
})

export const resolveDefaultContract = defineContract({
  querystring: input({ siteId: id().optional(), purpose, itemId: id().optional(), itemKind: itemKind.optional() }),
  response: {
    200: output({
      /** The place a command takes when none is named; null: none (the command's own rule applies). */
      location: output({ id: id(), code: z.string(), name: z.string(), kind }).nullable(),
      /** Whose default it is: the kind's own, or the site's fallback. */
      from: z.enum(['KIND', 'FALLBACK']).nullable(),
    }),
  },
})
