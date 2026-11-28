'use client'

import { PrintStartWindow } from '../print/PrintStartWindow'
import { ShipWholeOrderWindow } from '../shipments/ShipWholeOrderWindow'
import { WarehouseLegWindow } from '../shipments/WarehouseLegWindow'
import type { BandActKind } from '../../model'

/**
 * owb-of5 step 1 (L10: other sessions' windows sit in S2's pages ONLY through the base's stubs) — the windows the band's ONE act
 * opens, mounted once for the order page: Print and start the work… (S3 owb-ss4), Ship… (S3 owb-ss3) and the warehouse leg's It
 * arrived / Send on (S3 owb-ss3). S2 opens them; S3 fills them (a stub draws nothing until then). Never another session's internals.
 */
export function OrderActWindows({ open, onClose, companyId, orderId }: { readonly open: BandActKind | null; readonly onClose: () => void; readonly companyId: string; readonly orderId: string }) {
  return (
    <>
      <PrintStartWindow open={open === 'printStart'} onClose={onClose} companyId={companyId} orderId={orderId} />
      <ShipWholeOrderWindow open={open === 'ship'} onClose={onClose} companyId={companyId} orderId={orderId} />
      <WarehouseLegWindow open={open === 'arrived' || open === 'sendOn'} onClose={onClose} companyId={companyId} orderId={orderId} act={open === 'arrived' ? 'ARRIVED' : 'SEND_ON'} />
    </>
  )
}
