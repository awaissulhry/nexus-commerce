import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'
import { DIE_CONDITIONS, DIE_LIMITS, DIE_MAX_COST } from '@nexus/factory-domain/plant/machines/dies'

/**
 * The clicking-die register's routes (B-W2b-136; QHS-173; design plant.machines "Clicking dies"). Money: only a die's
 * purchase cost, marked with the cost grain (dropped for whoever lacks it; a request that sends it without the grain is
 * refused). A refusal is a 409 with the issues `refusal/<CODE>` (factory-domain plant/machines/dies DIE_REFUSALS) and
 * `fix`.
 */

const version = () => z.number().int().min(1)
const words = (max: number) => z.string().trim().min(1).max(max)
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
    .pipe(z.array(z.enum(values)))
const brief = output({ id: id(), code: z.string(), name: z.string() })

export const dieOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  siteCode: z.string(),
  code: z.string(),
  style: brief,
  /** A size code of the style's range; null: one die for every size. */
  size: z.string().nullable(),
  piece: z.string(),
  /** The style's pattern piece it cuts, when the pattern names it (its revision with it). */
  patternPiece: output({ id: id(), name: z.string(), revision: z.number().int() }).nullable(),
  rackLocation: z.string().nullable(),
  material: z.string().nullable(),
  /** Who made it (office only). */
  supplier: brief.nullable(),
  /** What it cost, in the company's currency (minor units): the cost grain only; never on the floor. */
  purchaseCost: money.cost(z.number().int().nullable()),
  condition: z.enum(DIE_CONDITIONS),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

export const listDiesContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    styleId: id().optional(),
    /** Comma-separated conditions (RETIRED only when named). */
    condition: csv(DIE_CONDITIONS).optional(),
    /** The number, piece, rack, material or the style's code contains it. */
    q: z.string().trim().min(1).max(80).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ dies: z.array(dieOut), nextCursor: id().nullable(), canManage: z.boolean() }) },
})

export const dieStylesContract = defineContract({
  querystring: input({ q: z.string().trim().min(1).max(80).optional() }),
  response: { 200: output({ styles: z.array(output({ id: id(), code: z.string(), name: z.string(), sizes: z.array(z.string()) })) }) },
})

export const dieChoicesContract = defineContract({
  querystring: input({ styleId: id() }),
  response: {
    200: output({
      style: output({ id: id(), code: z.string(), name: z.string() }),
      /** The style's size range, in its order. */
      sizes: z.array(z.string()),
      /** The pattern pieces of its newest revision that is not obsolete (none: the pattern is not in Nexus). */
      pieces: z.array(output({ id: id(), name: z.string(), revision: z.number().int(), sizes: z.array(z.string()) })),
    }),
  },
})

const optionalWords = (max: number) => words(max).nullable().optional()

export const createDieContract = defineContract({
  body: input({
    siteId: id(),
    code: z.string().trim().min(1).max(DIE_LIMITS.code),
    styleId: id(),
    size: words(DIE_LIMITS.size).nullable().optional(),
    piece: words(DIE_LIMITS.piece),
    patternPieceId: id().nullable().optional(),
    rackLocation: optionalWords(DIE_LIMITS.rackLocation),
    material: optionalWords(DIE_LIMITS.material),
    supplierId: id().nullable().optional(),
    purchaseCost: money.cost(z.number().int().min(0).max(DIE_MAX_COST).nullable()),
    note: optionalWords(DIE_LIMITS.note),
  }),
  response: { 200: output({ die: dieOut, replayed: z.boolean() }), 201: output({ die: dieOut, replayed: z.boolean() }) },
})

export const updateDieContract = defineContract({
  params: input({ dieId: id() }),
  body: input({
    version: version(),
    size: words(DIE_LIMITS.size).nullable().optional(),
    piece: words(DIE_LIMITS.piece).optional(),
    patternPieceId: id().nullable().optional(),
    rackLocation: optionalWords(DIE_LIMITS.rackLocation),
    material: optionalWords(DIE_LIMITS.material),
    supplierId: id().nullable().optional(),
    purchaseCost: money.cost(z.number().int().min(0).max(DIE_MAX_COST).nullable()),
    /** Good, worn or damaged; RETIRED only through Retire. */
    condition: z.enum(DIE_CONDITIONS).optional(),
    note: optionalWords(DIE_LIMITS.note),
  }),
  response: { 200: output({ die: dieOut }) },
})

export const retireDieContract = defineContract({
  params: input({ dieId: id() }),
  body: input({ version: version(), reason: words(DIE_LIMITS.reason) }),
  response: { 200: output({ die: dieOut, replayed: z.boolean() }) },
})
