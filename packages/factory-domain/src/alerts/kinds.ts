import { z } from 'zod'
import { CERTIFICATES_VIEW } from '../compliance/certificates/permissions'
import type { Permission } from '../core/permissions'
import { INVOICES_VIEW } from '../invoicing/permissions'
import { PLANNING_VIEW } from '../planning/permissions'
import { PURCHASING_VIEW } from '../purchasing/permissions'
import { QUALITY_HOLDS_VIEW } from '../quality/holds/permissions'
import { ORDERS_VIEW } from '../sales/orders/permissions'
import { QUOTES_VIEW } from '../sales/quotes/permissions'
import type { TimerKind } from '../timers/rules'

/**
 * The kinds of exception rule (B-W2a-33; ANA-036 exception rules, PLT-100 time-based triggers; design home.alerts
 * "Rules": "order at risk of being late · hold longer than 24 h · material short for a released order · certificate
 * expiring · approval overdue", admin.automation "Reminders & timers": "30 days before a certificate expires → tell
 * Compliance"), pure. A rule (AlertRule) is one of these kinds with its numbers, its place, whom it tells, how and how
 * often; the kind says what it watches, which numbers it takes, which record an alert names, and who may see that alert
 * (the record's own view permission over the record's company, site and party).
 *
 *   CONDITION   evaluated by the scheduler every few minutes (and again for one record after the events that change it):
 *               a record that meets the condition raises an alert; an alert whose record no longer meets it is
 *               resolved by the system (CLEARED).
 *   DATE        fires relative to a record's date through ONE date timer per record (timers/rules): the scheduler keeps
 *               the timers in step with the dates; when a timer's time comes, it raises the alert; the alert clears when
 *               the record no longer has the date in its window (renewed, invoiced).
 *
 * The kinds ship as BUILT-IN rules for every tenant (switched on, the design's "the factory's exceptions ship ready"),
 * each telling the holders of one system role. Not built here (design built-ins, gaps for later steps): "integration
 * failing" (the connections' health, B-W2a-36). Kinds are upper case text in the database, so a new one needs no
 * migration.
 */

export const RULE_KINDS = ['ORDER_LATE_RISK', 'HOLD_TOO_LONG', 'MATERIAL_SHORT', 'APPROVAL_OVERDUE', 'PO_NOT_CONFIRMED', 'CERTIFICATE_EXPIRING', 'INVOICE_DEADLINE'] as const
export type RuleKind = (typeof RULE_KINDS)[number]
export const isRuleKind = (value: unknown): value is RuleKind => typeof value === 'string' && (RULE_KINDS as readonly string[]).includes(value)

export const RULE_TRIGGERS = ['CONDITION', 'DATE'] as const
export type RuleTrigger = (typeof RULE_TRIGGERS)[number]

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

export const ALERT_CHANNELS = ['IN_APP', 'EMAIL'] as const
export type AlertChannel = (typeof ALERT_CHANNELS)[number]

/** Words in the two languages of the office. */
export interface Words {
  readonly en: string
  readonly it: string
}

/** An event after which a record's condition may have changed, and the payload key naming the record. */
export interface Recheck {
  readonly event: string
  readonly key: string
}

export interface KindSpec {
  readonly kind: RuleKind
  readonly trigger: RuleTrigger
  /** The record an alert names (its type in Alert.recordType). */
  readonly recordType: string
  /** Seeing the record: an alert of this kind is shown only to who holds this over the record's company, site, party. */
  readonly view: Permission
  /** The rule's numbers: a strict object with its defaults (the threshold column). */
  readonly threshold: z.ZodType<Record<string, number | boolean>>
  /** The built-in rule every tenant gets. */
  readonly builtIn: {
    readonly name: Words
    readonly threshold: Readonly<Record<string, number | boolean>>
    readonly severity: AlertSeverity
    readonly cooldownMinutes: number
    /** The system role (template key) it tells. */
    readonly recipientRole: string
  }
  /** What it watches, in a few words (the rules list's kind column, Today's tile). */
  readonly label: Words
  /** DATE kinds: the timer kind it sets (one timer per record and rule). */
  readonly timer?: TimerKind
  /** The events after which one record is evaluated again at once (the next scheduled pass does it anyway). */
  readonly recheck: readonly Recheck[]
}

const whole = (min: number, max: number) => z.number().int().min(min).max(max)

const spec = (content: KindSpec): KindSpec => Object.freeze(content)

export const KINDS: Readonly<Record<RuleKind, KindSpec>> = Object.freeze({
  ORDER_LATE_RISK: spec({
    kind: 'ORDER_LATE_RISK',
    trigger: 'CONDITION',
    recordType: 'SalesOrder',
    view: ORDERS_VIEW,
    // Promised within this many days and still being made (confirmed, in production), or past its promise (any open order).
    threshold: z.strictObject({ daysBeforePromise: whole(0, 30).default(3) }),
    builtIn: { name: { en: 'Order at risk of being late', it: 'Ordine a rischio di ritardo' }, threshold: { daysBeforePromise: 3 }, severity: 'WARNING', cooldownMinutes: 1440, recipientRole: 'planner' },
    label: { en: 'Orders at risk of being late', it: 'Ordini a rischio di ritardo' },
    recheck: [
      { event: 'sales_order.status_changed', key: 'orderId' },
      { event: 'sales_order.promise_changed', key: 'orderId' },
    ],
  }),
  HOLD_TOO_LONG: spec({
    kind: 'HOLD_TOO_LONG',
    trigger: 'CONDITION',
    recordType: 'QualityHold',
    view: QUALITY_HOLDS_VIEW,
    // A quality hold still ACTIVE this many hours after it was placed.
    threshold: z.strictObject({ hours: whole(1, 720).default(24) }),
    builtIn: { name: { en: 'Hold longer than 24 hours', it: 'Blocco da più di 24 ore' }, threshold: { hours: 24 }, severity: 'WARNING', cooldownMinutes: 1440, recipientRole: 'quality_inspector' },
    label: { en: 'Holds that last too long', it: 'Blocchi che durano troppo' },
    recheck: [
      { event: 'quality.hold_released', key: 'holdId' },
      { event: 'quality.hold_changed', key: 'holdId' },
    ],
  }),
  MATERIAL_SHORT: spec({
    kind: 'MATERIAL_SHORT',
    trigger: 'CONDITION',
    recordType: 'WorkOrder',
    view: PLANNING_VIEW,
    // The planning run's open SHORT exceptions of a released (or started) work order; no numbers of its own.
    threshold: z.strictObject({}),
    builtIn: { name: { en: 'Material short for a released work order', it: 'Materiale mancante per un ordine di lavoro rilasciato' }, threshold: {}, severity: 'CRITICAL', cooldownMinutes: 1440, recipientRole: 'planner' },
    label: { en: 'Material short for released work orders', it: 'Materiale mancante per ordini di lavoro rilasciati' },
    recheck: [],
  }),
  APPROVAL_OVERDUE: spec({
    kind: 'APPROVAL_OVERDUE',
    trigger: 'CONDITION',
    recordType: 'Quote',
    view: QUOTES_VIEW,
    // A quote's approval request still PENDING this many hours after it was asked.
    threshold: z.strictObject({ hours: whole(1, 720).default(24) }),
    builtIn: { name: { en: 'Approval waiting more than 24 hours', it: 'Approvazione in attesa da più di 24 ore' }, threshold: { hours: 24 }, severity: 'WARNING', cooldownMinutes: 1440, recipientRole: 'finance' },
    label: { en: 'Approvals overdue', it: 'Approvazioni in ritardo' },
    recheck: [
      { event: 'quote.approval_decided', key: 'quoteId' },
      { event: 'quote.reopened', key: 'quoteId' },
      { event: 'quote.cancelled', key: 'quoteId' },
    ],
  }),
  PO_NOT_CONFIRMED: spec({
    kind: 'PO_NOT_CONFIRMED',
    trigger: 'CONDITION',
    recordType: 'PurchaseOrder',
    view: PURCHASING_VIEW,
    // A purchase order still SENT (no answer from the supplier) this many days after it went out.
    threshold: z.strictObject({ days: whole(1, 30).default(2) }),
    builtIn: { name: { en: 'Purchase order not confirmed', it: 'Ordine di acquisto non confermato' }, threshold: { days: 2 }, severity: 'INFO', cooldownMinutes: 1440, recipientRole: 'buyer' },
    label: { en: 'Purchase orders not confirmed', it: 'Ordini di acquisto non confermati' },
    recheck: [
      { event: 'purchase_order.confirmed', key: 'purchaseOrderId' },
      { event: 'purchase_order.declined', key: 'purchaseOrderId' },
      { event: 'purchase_order.changes_proposed', key: 'purchaseOrderId' },
      { event: 'purchase_order.cancelled', key: 'purchaseOrderId' },
    ],
  }),
  CERTIFICATE_EXPIRING: spec({
    kind: 'CERTIFICATE_EXPIRING',
    trigger: 'DATE',
    recordType: 'Certificate',
    view: CERTIFICATES_VIEW,
    // This many days (calendar, or working days of the certificate's company) before a VALID certificate's last valid day.
    threshold: z.strictObject({ daysBefore: whole(1, 365).default(30), workingDays: z.boolean().default(false) }),
    builtIn: { name: { en: 'Certificate expiring', it: 'Certificato in scadenza' }, threshold: { daysBefore: 30, workingDays: false }, severity: 'CRITICAL', cooldownMinutes: 1440, recipientRole: 'quality_inspector' },
    label: { en: 'Certificates expiring', it: 'Certificati in scadenza' },
    timer: 'CERTIFICATE_EXPIRY',
    recheck: [{ event: 'compliance.certificate_expired', key: 'certificateId' }],
  }),
  INVOICE_DEADLINE: spec({
    kind: 'INVOICE_DEADLINE',
    trigger: 'DATE',
    recordType: 'Ddt',
    view: INVOICES_VIEW,
    // This many days (working days of the DDT's company by default) before the last day to invoice a DDT's goods.
    threshold: z.strictObject({ daysBefore: whole(0, 15).default(3), workingDays: z.boolean().default(true) }),
    builtIn: { name: { en: 'Invoice deadline coming', it: 'Scadenza di fatturazione vicina' }, threshold: { daysBefore: 3, workingDays: true }, severity: 'WARNING', cooldownMinutes: 1440, recipientRole: 'finance' },
    label: { en: 'Shipped goods near their invoice deadline', it: 'Merce spedita vicina alla scadenza di fatturazione' },
    timer: 'INVOICE_DEADLINE',
    recheck: [],
  }),
})

/** The kinds of a trigger. */
export const kindsOf = (trigger: RuleTrigger): RuleKind[] => RULE_KINDS.filter((kind) => KINDS[kind].trigger === trigger)

/** The kinds a recheck event touches, with the payload key naming the record. */
export function recheckOf(eventType: string): { readonly kind: RuleKind; readonly key: string }[] {
  return RULE_KINDS.flatMap((kind) => KINDS[kind].recheck.filter((entry) => entry.event === eventType).map((entry) => ({ kind, key: entry.key })))
}

/** Every event type some kind rechecks on, sorted (the worker's handler listens to them). */
export const RECHECK_EVENTS: readonly string[] = Object.freeze([...new Set(RULE_KINDS.flatMap((kind) => KINDS[kind].recheck.map((entry) => entry.event)))].sort())

/** A rule's numbers as its kind reads them (defaults filled), or the problems. */
export function readThreshold(kind: RuleKind, value: unknown): { readonly ok: true; readonly threshold: Record<string, number | boolean> } | { readonly ok: false; readonly problems: string[] } {
  const parsed = KINDS[kind].threshold.safeParse(value ?? {})
  if (parsed.success) return { ok: true, threshold: parsed.data }
  return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'threshold'}: ${issue.message}`) }
}

/** The numbers of a rule as stored: its kind's defaults for anything missing or unreadable (a rule never stops working). */
export function thresholdOf(kind: RuleKind, value: unknown): Record<string, number | boolean> {
  const read = readThreshold(kind, value)
  return read.ok ? read.threshold : { ...KINDS[kind].builtIn.threshold }
}
