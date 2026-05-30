// RX.0 — Returns shared types.
//
// Extracted verbatim from ReturnsWorkspace.tsx so the command center
// (RX.1), the policies settings page (RX.2), and the analytics surface
// import one canonical set of shapes instead of redeclaring them. Any
// drift between operator surfaces was a latent inconsistency bug class;
// a single source of truth closes it.

// R2.2 — per-item inspection checklist. JSONB on ReturnItem.
export type ItemChecklist = {
  packagingPresent?: boolean
  tagsIntact?: boolean
  visibleDamage?: boolean
  damageNotes?: string
  functionalTestPassed?: boolean | null
  signsOfUse?: 'NONE' | 'LIGHT' | 'HEAVY'
}

// R2.1 — activity-log entry shown in the drawer timeline.
export type AuditEntry = {
  id: string
  userId: string | null
  action: string
  before: unknown
  after: unknown
  metadata: unknown
  createdAt: string
}

// R5.1 — refund history shape.
export type RefundAttempt = {
  id: string
  attemptedAt: string
  outcome: string
  channelRefundId: string | null
  errorMessage: string | null
  durationMs: number | null
}

// F1.4 — Italian nota di credito (one per Refund, lazy-assigned).
export type CreditNoteRow = {
  id: string
  creditNoteNumber: string
  fiscalYear: number
  sequenceNumber: number
  amountCents: number
  currencyCode: string
  causale: string | null
  originalInvoiceId: string | null
  sdiStatus: string | null
  issuedAt: string
}

export type RefundRow = {
  id: string
  amountCents: number
  currencyCode: string
  kind: 'CASH' | 'STORE_CREDIT' | 'EXCHANGE'
  channel: string
  channelStatus: 'PENDING' | 'POSTED' | 'FAILED' | 'MANUAL_REQUIRED' | 'NOT_IMPLEMENTED'
  channelRefundId: string | null
  channelError: string | null
  channelPostedAt: string | null
  reason: string | null
  actor: string | null
  createdAt: string
  attempts: RefundAttempt[]
  creditNote?: CreditNoteRow | null
}

export type ReturnRow = {
  id: string
  orderId: string | null
  channel: string
  marketplace: string | null
  rmaNumber: string | null
  status: string
  reason: string | null
  conditionGrade: string | null
  refundStatus: string
  refundCents: number | null
  isFbaReturn: boolean
  // RX.6b — warranty / defect / recall track.
  returnType?: string // STANDARD | WARRANTY | DEFECT
  warrantyStatus?: string | null
  warrantyResolution?: string | null
  defectReportedAt?: string | null
  manufacturerRef?: string | null
  receivedAt: string | null
  inspectedAt: string | null
  refundedAt: string | null
  restockedAt: string | null
  // Return label tracking (operator-attached for v0; native carrier
  // integration in a follow-up).
  returnLabelUrl: string | null
  returnLabelCarrier: string | null
  returnTrackingNumber: string | null
  returnLabelGeneratedAt: string | null
  returnLabelEmailedAt: string | null
  notes: string | null
  items: Array<{
    id: string
    sku: string
    productId: string | null
    quantity: number
    conditionGrade: string | null
    notes: string | null
    photoUrls: string[]
    inspectionChecklist: ItemChecklist | null
    disposition: string | null
    scrapReason: string | null
    lotId?: string | null
  }>
  // R2.1 — drawer-only fields. Populated by GET /returns/:id when
  // the route includes the order relation; absent on the list response.
  order?: {
    id: string
    channel: string
    marketplace: string | null
    channelOrderId: string | null
    customerName: string | null
    customerEmail: string | null
    shippingAddress: Record<string, unknown> | null
    createdAt: string
    shipments: Array<{
      id: string
      status: string
      trackingNumber: string | null
      trackingUrl: string | null
      carrierCode: string | null
      shippedAt: string | null
      deliveredAt: string | null
    }>
  } | null
  // UI.1 — latest POSTED refund's credit note (when present). Surfaced
  // on the list row as a "NC-NNNNN/YYYY" badge so the operator sees
  // fiscal-doc state at a glance without opening the drawer.
  refunds?: Array<{
    id: string
    creditNote: { creditNoteNumber: string; sdiStatus: string | null } | null
  }>
  createdAt: string
}

// R6.2 — refund-deadline view returned by the policy resolver.
export type RefundDeadlineView = {
  daysUntilDeadline: number | null
  refundDeadlineDays: number
  status: 'safe' | 'approaching' | 'overdue' | 'no_receive_date'
}

// R6.1 — return-window check returned alongside the deadline.
export type ReturnWindowView = {
  inWindow: boolean
  windowDays: number
  daysSinceDelivery: number | null
  reason?: string
}

// R6.1 — the resolved policy (most-specific match in the cascade) that
// drives the refund composer's fee suggestions.
export type ResolvedPolicyView = {
  channel: string
  marketplace: string | null
  productType: string | null
  windowDays: number
  refundDeadlineDays: number
  buyerPaysReturn: boolean
  restockingFeePct: number | null
  autoApprove: boolean
  highValueThresholdCents: number | null
  source: 'most_specific' | 'channel_marketplace' | 'channel_only' | 'fallback'
}

export type ReturnPolicyView = {
  window: ReturnWindowView
  deadline: RefundDeadlineView
  resolved?: ResolvedPolicyView
}

// RX.0 — single aggregate payload returned by GET /returns/:id/full.
// Collapses detail + audit + refunds + policy into one round-trip.
export type ReturnFull = {
  return: ReturnRow
  audit: { items: AuditEntry[] }
  refunds: { items: RefundRow[] }
  policy: ReturnPolicyView
}

export type SavedView = {
  id: string
  name: string
  filters: Record<string, unknown>
  isDefault: boolean
}
