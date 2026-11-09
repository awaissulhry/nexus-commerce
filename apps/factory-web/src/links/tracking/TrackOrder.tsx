'use client'

import { useState } from 'react'
import type { ApiClient } from '../../lib/api/client'
import { useTracking } from './hooks'
import { initialTracking, type TrackingViewModel } from './model'
import { TrackingView } from './view/TrackingView'

/**
 * A SHIPMENT_TRACK link of a Shipment, once it opened (the link landing did `POST /link/open`, which uses nothing): the
 * branded tracking page (SCR-194, B-W2b-170). The landing's client carries the token in `x-factory-link`; the landing's
 * branding context brands the frame (B-W2b-161).
 */
export function TrackOrder({ api }: { api: ApiClient }) {
  const [model, setModel] = useState<TrackingViewModel>(() => initialTracking(null))
  const actions = useTracking(api, model, setModel)
  return <TrackingView model={model} actions={actions} />
}
