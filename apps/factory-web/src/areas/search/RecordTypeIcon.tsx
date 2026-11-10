'use client'

import {
  BadgeCheck,
  Bandage,
  Banknote,
  Boxes,
  ChartBarIncreasing,
  ClipboardCheck,
  ClipboardList,
  Cog,
  Contact,
  Factory,
  FileOutput,
  FileText,
  Hammer,
  Layers,
  ListChecks,
  ListTodo,
  MapPin,
  MessageSquareWarning,
  OctagonPause,
  PackageCheck,
  PackageX,
  Receipt,
  ReceiptText,
  Ruler,
  Scissors,
  ShieldAlert,
  ShoppingCart,
  Shirt,
  Siren,
  Tag,
  TriangleAlert,
  Truck,
  Undo2,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
// B-W2b-261: a sample round's icon (as its navigation row).
import { FlaskConical } from 'lucide-react'

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
  // B-W2a-83's four, and B-W2b-23's: every other W1 and W2a record type.
  ReturnAuthorisation: Undo2,
  RepairOrder: Bandage,
  Complaint: MessageSquareWarning,
  SupplierClaim: PackageX,
  Payment: Banknote,
  SupplierInvoice: ReceiptText,
  Inspection: ClipboardCheck,
  QualityHold: OctagonPause,
  Nonconformance: TriangleAlert,
  Certificate: BadgeCheck,
  LabelTemplate: Tag,
  PpeRegisterEntry: ShieldAlert,
  StockCount: ListChecks,
  Location: MapPin,
  Ddt: FileOutput,
  SubcontractOrder: Factory,
  Operation: Workflow,
  SizeScale: ChartBarIncreasing,
  Machine: Cog,
  MaintenanceJob: Hammer,
  // B-W2b-149
  Incident: Siren,
  // B-W2b-104
  InspectionPlan: ListTodo,
  // B-W2b-119
  Capa: ListChecks,
  // B-W2b-261
  SampleRound: FlaskConical,
})

export function RecordTypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const Icon = ICONS[type] ?? Boxes
  return <Icon size={size} aria-hidden />
}
