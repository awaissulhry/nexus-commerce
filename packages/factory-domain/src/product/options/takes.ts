import { z } from 'zod'
import { id, input, output } from '../../core/contracts'
import type { Words } from './rules'

/**
 * What a chosen value of an option group takes with it (B-W2b-374; XF3:05; OptionGroup.takes, B-W2b-363's column): COLOUR, a
 * colour of the colour library (a panel's colour); MATERIAL, a material and its colour (leather by article); null, either
 * (B-W2b-340's configurator offers both pickers). The …_followups_sales_w2b5_guards triggers refuse a COLOUR group's option
 * naming a material, a MATERIAL group's naming a library colour, and a takes change while a chosen option picks the other kind;
 * the API says each in these words first (409), so no database refusal reaches a person.
 */

export const OPTION_GROUP_TAKES = ['COLOUR', 'MATERIAL'] as const
export type OptionGroupTakes = (typeof OPTION_GROUP_TAKES)[number]

const w = (it: string, en: string): Words => ({ it, en })

/** Which pickers a value of the group offers: the colour library, the materials, or both (null). */
export function pickersOf(takes: OptionGroupTakes | null): { readonly colour: boolean; readonly material: boolean } {
  return { colour: takes !== 'MATERIAL', material: takes !== 'COLOUR' }
}

/** Why a pick of a group does not fit what the group takes, in words (null: it fits). */
export function pickTakesProblem(group: { readonly code: string; readonly takes: OptionGroupTakes | null }, pick: { readonly colourId?: string | null; readonly itemId?: string | null }): Words | null {
  if (group.takes === 'COLOUR' && pick.itemId) return w(`Il gruppo ${group.code} prende un colore della libreria: non un materiale.`, `Group ${group.code} takes a colour of the library: not a material.`)
  if (group.takes === 'MATERIAL' && pick.colourId) return w(`Il gruppo ${group.code} prende un materiale e il suo colore: non un colore della libreria.`, `Group ${group.code} takes a material and its colour: not a colour of the library.`)
  return null
}

/** Why a group cannot take `next` now (chosen options of quotes or orders pick the other kind), in words; null: it can. */
export function takesChangeProblem(code: string, next: OptionGroupTakes | null, picking: { readonly materials: number; readonly colours: number }): Words | null {
  if (next === 'COLOUR' && picking.materials > 0) {
    return w(
      `${picking.materials} opzioni scelte del gruppo ${code} hanno un materiale: cambiale prima, poi il gruppo prende un colore della libreria.`,
      `${picking.materials} chosen options of group ${code} pick a material: change them first, then the group takes a colour of the library.`,
    )
  }
  if (next === 'MATERIAL' && picking.colours > 0) {
    return w(
      `${picking.colours} opzioni scelte del gruppo ${code} hanno un colore della libreria: cambiale prima, poi il gruppo prende un materiale.`,
      `${picking.colours} chosen options of group ${code} pick a colour of the library: change them first, then the group takes a material.`,
    )
  }
  return null
}

// ---- contracts (PUT /product/option-groups/:groupId/takes) ---------------------------------------------------------------

export const takesParams = input({ groupId: id() })
export const takesBody = input({ version: z.number().int().min(1), takes: z.enum(OPTION_GROUP_TAKES).nullable() })
export type TakesBody = z.output<typeof takesBody>

const words = () => output({ it: z.string(), en: z.string() })

/** What a group takes, the chosen options that pick each kind, and whether the person may change it (else why). */
export const takesView = output({
  groupId: id(),
  code: z.string(),
  /** The group's version (a change sends it). */
  version: z.number().int(),
  takes: z.enum(OPTION_GROUP_TAKES).nullable(),
  /** Chosen options (quotes and orders) that pick a library colour, a material. */
  picking: output({ colours: z.number().int(), materials: z.number().int() }),
  may: output({ change: z.boolean(), held: words().nullable() }),
})
export type TakesView = z.infer<typeof takesView>
