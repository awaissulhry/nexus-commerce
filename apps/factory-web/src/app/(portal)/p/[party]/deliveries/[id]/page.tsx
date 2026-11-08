'use client'

import { use } from 'react'
import { usePortalFrame } from '../../../../../../portal/shell/frame'
import { SupplierNoticePage } from '../../../../../../portal/supplier/deliveries/NoticePage'
import { NotInAccessHere } from '../../../../../../portal/supplier/orders/parts'

/**
 * `/p/<party code>/deliveries/<id>?step=lines|packing|transport|review` — one ship notice (B-W2b-186; design
 * portal.supplier.asn "Row → ship notice view; editable until received"): a draft on its steps, a sent one as it stands or
 * being changed (`step`), a received or cancelled one as it stands.
 */
export default function PortalNoticePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { kinds } = usePortalFrame()
  if (kinds.includes('SUPPLIER')) return <SupplierNoticePage key={id} id={id} />
  return <NotInAccessHere />
}
