import { z } from 'zod'
import { defineEvent } from '../events/define'
import { TECH_PACK_AUDIENCES } from '../product/techpack/rules'

/**
 * The tech pack's event (B-W2b-230; the code is factory-domain product/techpack). A module folder of its own, as
 * product-measures and product-lifecycle (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/product/techpack emits it in the command that keeps a new PDF version.
 *
 *   style.tech_pack_made   a new version of a revision's tech pack PDF was kept (for an audience and a language)
 *
 * Live on the style's Tech pack and Documents tabs for product.bom.view. Ids, codes and what was made only: no person, no
 * party, no money.
 */
export const events = [
  defineEvent({
    type: 'style.tech_pack_made',
    context: 'product-techpack',
    description: "A new version of a style revision's tech pack PDF was kept, for an audience (internal, a workshop, a brand) and a language.",
    payload: z.strictObject({
      styleId: z.uuid(),
      code: z.string(),
      revisionId: z.uuid(),
      revision: z.number().int(),
      generatedDocumentId: z.uuid(),
      version: z.number().int(),
      audience: z.enum(TECH_PACK_AUDIENCES),
      language: z.string(),
    }),
    live: { permission: 'product.bom.view', fields: ['styleId', 'code', 'revisionId', 'revision', 'generatedDocumentId', 'version', 'audience', 'language'] },
  }),
] as const
