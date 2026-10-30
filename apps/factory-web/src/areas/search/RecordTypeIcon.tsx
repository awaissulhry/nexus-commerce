'use client'

import { Boxes, ClipboardList, Contact, FileText, Layers, PackageCheck, Receipt, Ruler, Scissors, ShoppingCart, Shirt, Truck, Wrench, type LucideIcon } from 'lucide-react'

/** The icon of a record type in the search's rows (the palette's Records group, the All results page). */
const ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  Party: Contact,
  Quote: ClipboardList,
  SalesOrder: ShoppingCart,
  Style: Shirt,
  Item: Ruler,
  PurchaseOrder: Receipt,
  WorkOrder: Wrench,
  Lot: Layers,
  Hide: Scissors,
  GoodsReceipt: PackageCheck,
  Shipment: Truck,
  Invoice: FileText,
})

export function RecordTypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const Icon = ICONS[type] ?? Boxes
  return <Icon size={size} aria-hidden />
}
