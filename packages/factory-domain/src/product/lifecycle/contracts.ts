import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { STYLE_STATUSES } from '../styles/rules'
import { EDIT_KINDS, EDIT_REFUSALS, EDIT_RULES, LIFECYCLE_REFUSALS, RULE_SOURCES, STYLE_LIFECYCLES } from './rules'

/**
 * The style lifecycle's contracts (B-W2b-221; PRD-007, PRD-182): what apps/factory-api's modules/product/lifecycle accepts
 * and answers. A refusal is a 409 whose issue is `refusal/<CODE>` (LIFECYCLE_REFUSALS, EDIT_REFUSALS) with the words. No
 * money, no person but the id of who moved it last.
 */

const version = () => z.number().int().min(1)
const ref = output({ id: id(), code: z.string(), name: z.string() })
const refusal = output({ code: z.enum([...LIFECYCLE_REFUSALS, ...EDIT_REFUSALS]), message: z.string() })

export const styleParams = input({ styleId: id() })

/** A move: to the state, with the reason (a move back needs it) and, into phase out or discontinued, the replacing style. */
export const moveLifecycleBody = input({
  version: version(),
  to: z.enum(STYLE_LIFECYCLES),
  reason: z.string().trim().min(1).max(500).optional(),
  /** Into PHASE_OUT or DISCONTINUED: the style that replaces it (null: none). Left out: the one named stays. */
  replacedById: id().nullish(),
})
export type MoveLifecycleBody = z.output<typeof moveLifecycleBody>

/** The replacing style of a style being phased out or discontinued (null clears it). */
export const replacementBody = input({ version: version(), replacedById: id().nullable(), reason: z.string().trim().min(1).max(500).optional() })
export type ReplacementBody = z.output<typeof replacementBody>

const editRuleView = output({ state: z.enum(STYLE_LIFECYCLES), rule: z.enum(EDIT_RULES), source: z.enum(RULE_SOURCES) })

/** The style's lifecycle: where it is, where it may go, what may change in it now (SCR-041 band, B-W2b-237). */
export const lifecycleView = output({
  style: output({
    id: id(),
    code: z.string(),
    name: z.string(),
    companyId: id().nullable(),
    status: z.enum(STYLE_STATUSES),
    lifecycle: z.enum(STYLE_LIFECYCLES),
    /** The style's version: the next write's `version`. */
    version: z.number().int(),
    /** When and by whom it last moved; null: not moved since W2b-4 (the state was set from what it was). */
    changedAt: instant().nullable(),
    changedById: id().nullable(),
  }),
  /** The style that replaces it (PHASE_OUT, DISCONTINUED). */
  replacedBy: ref.nullable(),
  /** The styles it replaces. */
  replaces: z.array(ref),
  releasedRevision: output({ id: id(), revision: z.number().int() }).nullable(),
  draftRevision: output({ id: id(), revision: z.number().int() }).nullable(),
  /** Each move the state allows, and whether it may be made now (else the refusal in words). */
  moves: z.array(output({ to: z.enum(STYLE_LIFECYCLES), backward: z.boolean(), allowed: z.boolean(), refusal: refusal.nullable() })),
  /** The rule in force now, and what each kind of write may do under it (null: allowed). */
  editRule: editRuleView.extend({ kinds: z.array(output({ kind: z.enum(EDIT_KINDS), refusal: refusal.nullable() })) }),
  /** Every state's rule in force for the style's company (the visible table). */
  rules: z.array(editRuleView),
})
export type LifecycleView = z.infer<typeof lifecycleView>
