import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * A style's pictures and pattern files (B-W2b-236; the code is factory-domain product/images). A module folder of its own,
 * as product-measures and product-techpack (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/product/images (and the copy of a style, modules/product/styles/duplicate-pictures.ts) emit them in the command
 * that makes the change.
 *
 *   style.pictures_changed        a picture added, changed (kind, caption, callouts, revision, colourway), made the main
 *                                 one, moved, removed, or the pictures of a copy made
 *   style.pattern_files_changed   a revision's pattern, marker or CAD file named, changed, given a newer version, removed
 *
 * Live on the style's record and the styles' gallery for product.styles.view (pictures) and product.bom.view (pattern
 * files). Ids, codes and what changed only: no person, no money.
 */
export const PICTURE_CHANGES = ['ADDED', 'CHANGED', 'MAIN', 'ORDER', 'REMOVED', 'COPIED'] as const
export const PATTERN_FILE_CHANGES = ['ADDED', 'CHANGED', 'NEW_VERSION', 'REMOVED'] as const

export const events = [
  defineEvent({
    type: 'style.pictures_changed',
    context: 'product-images',
    description: "A style's pictures changed: one added, changed (kind, caption, callouts, revision or colourway), made the main picture, moved, removed, or a copy's pictures made.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), change: z.enum(PICTURE_CHANGES), pictureIds: z.array(z.uuid()) }),
    live: { permission: 'product.styles.view', fields: ['styleId', 'code', 'change', 'pictureIds'] },
  }),
  defineEvent({
    type: 'style.pattern_files_changed',
    context: 'product-images',
    description: "A style revision's pattern files changed: a pattern, marker or CAD file named, changed (kind, format, sizes, note), given a newer version, or removed.",
    payload: z.strictObject({ styleId: z.uuid(), code: z.string(), revisionId: z.uuid(), revision: z.number().int(), change: z.enum(PATTERN_FILE_CHANGES), patternFileIds: z.array(z.uuid()) }),
    live: { permission: 'product.bom.view', fields: ['styleId', 'code', 'revisionId', 'revision', 'change', 'patternFileIds'] },
  }),
] as const
