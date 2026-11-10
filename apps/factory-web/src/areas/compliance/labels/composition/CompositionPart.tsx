'use client'

import { StyleCompositionCard, type StyleComposition } from '../../../products/styles/compliance/composition'

/** The design frame's model of the style's composition card (SCR-331): the read and the page's address prefix. */
export interface CompositionPartModel {
  read: StyleComposition
  prefix: string
  labelId: string | null
}

/**
 * SCR-331 — Style › Compliance › Composition computed from the BOM (B-W2b-270; design products.styles style.cp.label#2),
 * drawn alone for the design review: the same card the style's Compliance tab (SCR-045) shows under the garment label.
 */
export function CompositionPart({ model }: { model: CompositionPartModel }) {
  return <StyleCompositionCard read={model.read} prefix={model.prefix} labelId={model.labelId} />
}
