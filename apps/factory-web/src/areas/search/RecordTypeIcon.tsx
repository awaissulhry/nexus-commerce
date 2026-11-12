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
  Palette,
  PackageCheck,
  PackageX,
  Receipt,
  ReceiptText,
  Ruler,
  Scissors,
  ShieldAlert,
  ShoppingCart,
  Stamp,
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
// B-W2b-244: a change request's and a change order's icons (Changes & versions).
import { GitPullRequestArrow, MessageSquareDiff } from 'lucide-react'
// B-W2b-274: a point of measure's and a grade rule's icons (Sizes & measurements).
import { MoveHorizontal, Scaling } from 'lucide-react'
// B-W2b-322: an inquiry's icon (as its navigation row).
import { Inbox } from 'lucide-react'

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
  // B-W2b-247
  Colour: Palette,
  BrandingSet: Stamp,
  // B-W2b-244
  ChangeRequest: MessageSquareDiff,
  ChangeOrder: GitPullRequestArrow,
  // B-W2b-274
  PointOfMeasure: MoveHorizontal,
  GradeRule: Scaling,
  // B-W2b-322
  Inquiry: Inbox,
})

export function RecordTypeIcon({ type, size = 16 }: { type: string; size?: number }) {
  const Icon = ICONS[type] ?? Boxes
  return <Icon size={size} aria-hidden />
}
