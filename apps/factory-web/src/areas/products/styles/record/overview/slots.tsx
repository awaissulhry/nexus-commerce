'use client'

import type { ReactNode } from 'react'
import type { SkuView } from '@nexus/factory-domain/product/styles/contracts'
import type { StyleDepthActions, StyleDepthModel } from './model'
import { GtinCellWords, GtinMatrixTools, GtinNotice } from './view/GtinDepth'
import { IdentityDepth } from './view/IdentityDepth'
import { CompletenessLine, LifecycleCard, WhereUsedCard } from './view/SideDepth'
import './depth.css'

/**
 * Where the depth (B-W2b-237) sits in W1's Style studio: the parts the Overview and Colourways & sizes mount at their
 * places (StyleRecordView passes them on, OverviewTab and VariantsTab draw them). Built from one model by the container
 * (StyleRecord.tsx) and by the design cases, so the views stay without a fetch.
 */
export interface StyleDepthSlots {
  /** Overview, the identity column under W1's identity card: product type, names per language, private label. */
  identity: ReactNode
  /** Overview, the side panel's first card: the lifecycle and what it allows. */
  sideTop: ReactNode
  /** Overview, inside the release check card: the completeness % and the first open item. */
  gate: ReactNode
  /** Overview, the side panel after the certificate coverage: where the style is used. */
  side: ReactNode
  /** Colourways & sizes, the matrix card's header: what a cell shows, Assign GTINs. */
  matrixTools: ReactNode
  /** Colourways & sizes, above the matrix: a GTIN given, or why it was refused. */
  matrixNotice: ReactNode
  /** What a matrix cell says beside its state mark. */
  cell: (sku: Pick<SkuView, 'sku' | 'gtin' | 'status'> | null) => ReactNode
}

export function depthSlots(model: StyleDepthModel, actions: StyleDepthActions | undefined, skus: readonly SkuView[]): StyleDepthSlots {
  return {
    identity: <IdentityDepth model={model} actions={actions} />,
    sideTop: <LifecycleCard model={model} actions={actions} />,
    gate: <CompletenessLine model={model} actions={actions} />,
    side: <WhereUsedCard model={model} actions={actions} />,
    matrixTools: <GtinMatrixTools model={model} actions={actions} skus={skus} />,
    matrixNotice: <GtinNotice model={model} actions={actions} />,
    cell: (sku) => <GtinCellWords show={model.matrixShow} sku={sku} />,
  }
}
