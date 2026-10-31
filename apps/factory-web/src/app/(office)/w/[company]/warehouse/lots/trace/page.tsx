import type { Metadata } from 'next'
import { Suspense } from 'react'
import { TracePage } from '../../../../../../../areas/warehouse/lots/trace/TracePage'

export const metadata: Metadata = { title: 'Trace · Nexus Factory' }

/**
 * Warehouse › Lots & traceability › Trace (SCR-201-trace, B-W2a-64; `?kind=HIDE|BUNDLE|WORK_ORDER|SERIAL|SHIPMENT&id=
 * &direction=`): the trace of a record that is not a lot (a lot's trace is its record's Trace tab). Opened by the Trace
 * dialog; no navigation row. The company layout above loaded the session and draws the Office shell.
 */
export default function WarehouseTracePage() {
  return (
    <Suspense>
      <TracePage />
    </Suspense>
  )
}
