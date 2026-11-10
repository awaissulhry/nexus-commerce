import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { REGISTER_KINDS } from '@nexus/factory-domain/compliance/register/rules'
import { COMPLIANCE_GATES } from '@nexus/factory-domain/compliance/requirements/rules'
import { GAP_TYPES } from '@nexus/factory-domain/compliance/reports/rules'

/**
 * Compliance reports (B-W2b-272; ANA-025; design compliance.reports SCR-261). Office only, read only. Percents and days are
 * decimal strings with one place ("96.4"), mg/kg up to three ("1.2"), null when nothing was counted (the screen says "—",
 * never 0). A figure whose records the reader may not see is null with its `sight` false. No field carries money or names a
 * person. The querystrings are strict: an unknown key is refused.
 */

const scope = {
  /** Default: the 365 days up to today (Rome). */
  from: businessDate().optional(),
  to: businessDate().optional(),
  /** One brand's styles (Party id); default every style of the screen's company and the tenant-wide ones. */
  brandId: id().optional(),
}

const one = () => z.string().regex(/^\d{1,9}\.\d$/).nullable()
const mgKg = () => z.string().regex(/^\d{1,9}(\.\d{1,3})?$/).nullable()
const ref = output({ id: id(), code: z.string(), name: z.string() })
const head = {
  /** The screen's company (null: every company the reader reaches). */
  company: ref.nullable(),
  /** The brand the figures are of (null: every brand). */
  brand: ref.nullable(),
  from: businessDate(),
  to: businessDate(),
  today: businessDate(),
  asOf: instant(),
}

/** Which records the reader may see (each figure is counted only from those). */
const sight = output({ certificates: z.boolean(), register: z.boolean(), lots: z.boolean(), shipments: z.boolean() })

/** How much of the style × market matrix the status board read (it reads at most 200 styles; `more`: a partial read). */
const styles = output({ read: z.number().int(), more: z.boolean(), markets: z.array(output({ code: z.string(), name: z.string() })) }).nullable()

export const kpisContract = defineContract({
  querystring: input(scope),
  response: {
    200: output({
      ...head,
      sight,
      styles,
      /** The brands of the company's styles (the scope's picker). */
      brands: z.array(ref),
      kpis: output({
        /** ANA-025: style × market cells with a valid certificate over the cells that need one (today). */
        coverage: output({ covered: z.number().int(), needing: z.number().int(), expiring: z.number().int(), pct: one(), cells: z.number().int() }).nullable(),
        /** Style × market pairs shipped in the period, covered today by a valid certificate and the DoC languages. */
        shipped: output({ pairs: z.number().int(), needing: z.number().int(), covered: z.number().int(), unknown: z.number().int(), pct: one(), shipments: z.number().int() }).nullable(),
        /** Open gaps today: missing requirement lines of the matrix + lots without Cr VI evidence (when lots are seen). */
        gaps: output({ count: z.number().int(), crViCounted: z.boolean() }).nullable(),
        /** Gate refusals recorded in the period (GateEvent), per gate; overrides given in the period. */
        refusals: output({ count: z.number().int(), overridden: z.number().int(), byGate: z.array(output({ gate: z.enum(COMPLIANCE_GATES), count: z.number().int() })) }).nullable(),
        /** Register entries open at the period's end; of them, those that may present a risk. */
        registerOpen: output({ count: z.number().int(), risk: z.number().int() }).nullable(),
        /** Lots that need a Cr VI test issued to production in the period, and those with a passing result. */
        crViLots: output({ lots: z.number().int(), withEvidence: z.number().int(), pct: one() }).nullable(),
      }),
    }),
  },
})
export type KpisQuery = z.infer<typeof kpisContract.querystring>

export const gapsContract = defineContract({
  querystring: input({ brandId: id().optional() }),
  response: {
    200: output({
      ...head,
      sight,
      styles,
      rows: z.array(
        output({
          type: z.enum(GAP_TYPES),
          count: z.number().int(),
          styles: z.number().int().nullable(),
          markets: z.number().int().nullable(),
          blocking: z.number().int().nullable(),
          requirements: z.array(z.string()),
        }),
      ),
    }),
  },
})
export type GapsQuery = z.infer<typeof gapsContract.querystring>

const expiryItem = output({
  recordType: z.enum(['Certificate', 'SupplierDeclarationRequest']),
  recordId: id(),
  /** "SEED-CERT-0001", "SD-2026-0003". */
  label: z.string(),
  /** The day it stops: a brand certificate's own end or its base's, whichever is first. */
  validTo: businessDate(),
  /** VALID / SUSPENDED (certificate), ACCEPTED (declaration). */
  status: z.string(),
  /** The standard (certificate) or the declaration's kind; the supplier's name for a declaration. */
  detail: z.string().nullable(),
  party: z.string().nullable(),
  /** A brand's own certificate that stops with its base certificate before its own end. */
  endsWithBase: z.boolean(),
})

export const expiriesContract = defineContract({
  querystring: input({ brandId: id().optional(), months: z.coerce.number().int().min(1).max(24).optional() }),
  response: {
    200: output({
      ...head,
      sight,
      months: z.array(output({ month: z.string(), count: z.number().int(), items: z.array(expiryItem) })),
      count: z.number().int(),
    }),
  },
})
export type ExpiriesQuery = z.infer<typeof expiriesContract.querystring>

export const cr6Contract = defineContract({
  querystring: input({ from: businessDate().optional(), to: businessDate().optional() }),
  response: {
    200: output({
      ...head,
      sight,
      /** The unit every value is in. */
      unit: z.literal('mg/kg'),
      results: z.number().int(),
      suppliers: z.array(
        output({
          /** The lots' supplier; null: lots without a supplier. */
          party: ref.nullable(),
          lots: z.number().int(),
          results: z.number().int(),
          measured: z.number().int(),
          belowDetection: z.number().int(),
          median: mgKg(),
          highest: mgKg(),
          fails: z.number().int(),
          limit: mgKg(),
          lotReports: z.number().int(),
          supplierReports: z.number().int(),
        }),
      ),
    }),
  },
})
export type Cr6Query = z.infer<typeof cr6Contract.querystring>

const registerRow = {
  opened: z.number().int(),
  closed: z.number().int(),
  openAtEnd: z.number().int(),
  medianDaysToClose: one(),
  /** Entries reported per month of the period, oldest first (the trend). */
  months: z.array(z.number().int()),
}

export const registerContract = defineContract({
  querystring: input(scope),
  response: {
    200: output({
      ...head,
      sight,
      /** The months of the period (YYYY-MM), oldest first. */
      months: z.array(z.string()),
      kinds: z.array(output({ kind: z.enum(REGISTER_KINDS), ...registerRow })),
      all: output(registerRow).nullable(),
      /** Authority notices marked sent in the period; drafts today. */
      notices: output({ sent: z.number().int(), drafts: z.number().int() }).nullable(),
      /** Recalls and withdrawals in progress today, closed in the period, units still out today. */
      recalls: output({ active: z.number().int(), closed: z.number().int(), unitsStillOut: z.number().int() }).nullable(),
      /** Authority requests received in the period; answered in it and of those on time; open and overdue today. */
      requests: output({ received: z.number().int(), answered: z.number().int(), onTime: z.number().int(), onTimePct: one(), open: z.number().int(), overdue: z.number().int() }).nullable(),
    }),
  },
})
export type RegisterQuery = z.infer<typeof registerContract.querystring>
