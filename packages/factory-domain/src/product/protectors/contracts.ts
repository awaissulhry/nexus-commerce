import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { bomRevisionView } from '../bom/contracts'
import { MATERIAL_APPROVALS } from '../bom-structure/rules'
import { STYLE_STATUSES } from '../styles/rules'
import { PLACEMENT_FINDINGS, PLACEMENT_LIMITS, PROTECTOR_LEVELS, PROTECTOR_POCKETS } from './rules'

/**
 * Protector placement's contracts (B-W2b-233; PRD-074; design products.styles › Sizes & measurements › Protector
 * placement): what apps/factory-api's modules/product/protectors accepts and answers, and what the web's typed client
 * reads. No money. A placement's change sends the PLACEMENT's `version` (COL-078); adding, removing and ordering lock the
 * style and check the revision is a draft.
 */

const version = () => z.number().int().min(1)
const sizes = () => z.array(z.string().trim().min(1).max(40)).max(60)
const standard = () => z.string().trim().min(1).max(PLACEMENT_LIMITS.standard)
const note = () => z.string().trim().max(PLACEMENT_LIMITS.positionNote).nullable()

/** A new placement at the end of the list. Standard and level default from the protector's properties (else the pocket's standard, level 1). */
export const addPlacementBody = input({
  pocket: z.enum(PROTECTOR_POCKETS),
  protectorItemId: id(),
  standard: standard().optional(),
  level: z.enum(PROTECTOR_LEVELS).optional(),
  /** Codes of the style's range; empty: every size. */
  sizes: sizes().default([]),
  positionNote: note().default(null),
})
export type AddPlacementBody = z.output<typeof addPlacementBody>

/** A change to one placement (a cell, autosaved): only what it names; null clears the note. */
export const updatePlacementBody = input({
  version: version(),
  pocket: z.enum(PROTECTOR_POCKETS).optional(),
  protectorItemId: id().optional(),
  standard: standard().optional(),
  level: z.enum(PROTECTOR_LEVELS).optional(),
  sizes: sizes().optional(),
  positionNote: note().optional(),
})
export type UpdatePlacementBody = z.output<typeof updatePlacementBody>

/** The selection removed, each at the version read; all or none. */
export const removePlacementsBody = input({ placements: z.array(input({ id: id(), version: version() })).min(1).max(PLACEMENT_LIMITS.placements) })
export type RemovePlacementsBody = z.output<typeof removePlacementsBody>

/** The new order: every placement of the revision once. */
export const orderPlacementsBody = input({ placementIds: z.array(id()).min(1).max(PLACEMENT_LIMITS.placements) })
export type OrderPlacementsBody = z.output<typeof orderPlacementsBody>

const protector = output({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  approval: z.enum(MATERIAL_APPROVALS),
  /** Its own standard and level (its material properties), when typed. */
  standard: z.string().nullable(),
  level: z.string().nullable(),
})

export const placementView = output({
  id: id(),
  seq: z.number().int(),
  pocket: z.enum(PROTECTOR_POCKETS),
  protector,
  standard: z.string(),
  level: z.enum(PROTECTOR_LEVELS),
  /** Empty: every size of the range. */
  sizes: z.array(z.string()),
  positionNote: z.string().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})
export type PlacementView = z.output<typeof placementView>

export const placementFindingView = output({
  code: z.enum(PLACEMENT_FINDINGS),
  placementId: z.string().nullable(),
  itemId: z.string().nullable(),
  sizes: z.array(z.string()),
  params: z.record(z.string(), z.string()),
  message: z.string(),
})
export type PlacementFindingView = z.output<typeof placementFindingView>

/** One revision's protector placement (the style's "Protector placement" section). */
export const protectorPlacementView = output({
  revision: bomRevisionView,
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: z.string().nullable(), status: z.enum(STYLE_STATUSES), sizes: z.array(z.string()) }),
  placements: z.array(placementView),
  findings: z.array(placementFindingView),
  /** The protector materials a pocket may take (PROTECTOR, not blocked, of the style's company or every company), each marked when the BOM has it. */
  choices: z.array(protector.extend({ inBom: z.boolean() })),
  editable: z.boolean(),
  /** Why the list cannot be changed now (a released revision, the style's edit rule, an archived style), or null. */
  refusal: z.string().nullable(),
  words: z.string(),
})
export type ProtectorPlacementView = z.output<typeof protectorPlacementView>
