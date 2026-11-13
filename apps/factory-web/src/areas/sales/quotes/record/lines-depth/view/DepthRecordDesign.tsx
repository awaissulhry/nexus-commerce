'use client'

import { WithMessages } from '../../../../../../record-panels/i18n'
import { useT } from '../../../../../../lib/i18n/provider'
import type { QuoteRecordViewModel } from '../../record-model'
import { QuoteRecordView } from '../../view/QuoteRecordView'
import { DEPTH_NS } from '../model'
import { depthSlots, type QuoteDepthModel } from './DepthSlots'

export interface DepthRecordDesignModel {
  record: QuoteRecordViewModel
  depth: QuoteDepthModel
}

/** The quote record with its W2b parts drawn from one model (the design index's SCR-035-depth; the live page uses use-depth). */
export function DepthRecordDesign({ model }: { model: DepthRecordDesignModel }) {
  return (
    <WithMessages namespaces={['sales', 'records', DEPTH_NS]}>
      <Record model={model} />
    </WithMessages>
  )
}

function Record({ model }: { model: DepthRecordDesignModel }) {
  const t = useT(DEPTH_NS)
  return <QuoteRecordView model={model.record} depth={depthSlots(model.depth, undefined, t)} />
}
