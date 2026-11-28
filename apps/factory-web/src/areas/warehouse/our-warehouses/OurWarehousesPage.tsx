'use client'

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { WithMessages } from '../../../record-panels/i18n'
import { readProblem } from '../shipments/model'
import { ourWarehouses } from '../../sales/orders/record/shipments/legs/api'
import { LEG_NS, LegActWindow } from '../../sales/orders/record/shipments/legs/LegActWindow'
import { shipRightsOf, type LegAct } from '../../sales/orders/record/shipments/legs/model'
import { actsOf, sectionsOf } from './model'
import { OurWarehousesView, type OurWarehousesViewModel } from './view/OurWarehousesView'

/**
 * `/w/<company>/warehouse/our-warehouses` (owb-ss3 step 3.4; permission shipping.view; design plan § 7): reads the company's own
 * warehouses with what sits there and what is on its way (`GET /shipping/our-warehouses`) and opens the leg's window — the SAME as the
 * order's Shipments tab — on a shipment: **Send on to the customer** or **It arrived at the warehouse** (pack and send). After the act the
 * page reads itself again.
 */
export function OurWarehousesPage(): ReactElement {
  return (
    <WithMessages namespaces={['our-warehouses', 'shipments', 'orders', 'order-life', ...LEG_NS]}>
      <Container />
    </WithMessages>
  )
}

function Container(): ReactElement {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const prefix = session.company ? companyPrefix(session.company.code) : ''
  const rights = useMemo(() => shipRightsOf(session.permissions), [session.permissions])
  const [sections, setSections] = useState<OurWarehousesViewModel['sections']>({ state: 'reading' })
  const [open, setOpen] = useState<{ readonly shipmentId: string; readonly act: LegAct } | null>(null)

  const load = useCallback(() => {
    ourWarehouses(api)
      .then((rows) => setSections({ state: 'ready', value: sectionsOf(rows) }))
      .catch((error: unknown) => setSections({ state: 'failed', problem: readProblem(error) }))
  }, [api])
  useEffect(() => load(), [load])

  const model: OurWarehousesViewModel = { prefix, sections, acts: actsOf(rights) }
  return (
    <>
      <OurWarehousesView
        model={model}
        actions={{
          onSendOn: (shipmentId) => setOpen({ shipmentId, act: 'SEND_ON' }),
          onArrived: (shipmentId) => setOpen({ shipmentId, act: 'ARRIVED' }),
          onRetry: () => {
            setSections({ state: 'reading' })
            load()
          },
        }}
      />
      {open ? <LegActWindow open act={open.act} shipmentId={open.shipmentId} onClose={() => setOpen(null)} onDone={load} /> : null}
    </>
  )
}
