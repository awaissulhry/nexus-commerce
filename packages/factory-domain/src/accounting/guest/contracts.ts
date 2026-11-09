import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { ACCOUNTING_PACKAGES, LOCK_LEVELS } from '../packages'
import { GUEST_ZIP, GUEST_ZIP_WHAT, INVOICE_KINDS, INVOICE_SIDES, REGISTERS_LATER } from './files'
import { GUEST_PERIOD, GUEST_PERIOD_KINDS } from './periods'

/**
 * The contracts of accountant access (B-W2b-201; FIN-158; design portal.guest.accountant, SCR-268, and its office half on
 * Finance › Close). The portal's answers carry file names, numbers, days and states, never an amount and never a record's
 * fields beyond what names a file (the invoice's number, day, other party and SDI state). Words are the screens' (by code).
 */

const period = () => z.string().trim().regex(GUEST_PERIOD, 'Expected a month (2026-10), a quarter (2026-Q4) or a year (2026).')

export const guestFileView = output({ id: id(), name: z.string(), contentType: z.string(), sizeBytes: z.number().int(), sha256: z.string() })
export type GuestFileView = z.infer<typeof guestFileView>

const lockMark = output({ level: z.enum(LOCK_LEVELS), lockedAt: instant() })

// ---- the portal ----------------------------------------------------------------------------------------------------------

export const guestOverviewAnswer = output({
  access: output({
    /** The accounting firm (the party) and the company whose books these are (the session's). */
    firm: output({ id: id(), name: z.string() }),
    company: output({ id: id(), code: z.string(), name: z.string() }),
    /** The office person who invited the firm's person, as a name; null when not known. */
    givenBy: z.string().nullable(),
    /** The end of access (PLT-022: a guest always has one; null only for an office preview). */
    accessUntil: instant().nullable(),
    endsSoon: z.boolean(),
    preview: z.boolean(),
  }),
  /** The handed-over months, newest first: each with its lock and how many batches it has. */
  months: z.array(output({ month: z.string(), lock: lockMark.nullable(), batches: z.number().int() })),
  choices: output({ months: z.array(z.string()), quarters: z.array(z.string()), years: z.array(z.string()) }),
  /** The newest handed-over month (the page opens on it), or null: nothing handed over yet. */
  latest: z.string().nullable(),
  asOf: instant(),
})
export type GuestOverviewAnswer = z.infer<typeof guestOverviewAnswer>

export const guestPeriodParams = input({ period: period() })

export const guestExportView = output({
  exportId: id(),
  number: z.string(),
  month: z.string(),
  exportedAt: instant(),
  /** A re-export: the number of the batch it amends. */
  amends: z.string().nullable(),
  /** The re-export that followed it, or null: final. */
  amendedBy: z.string().nullable(),
  files: z.array(output({ package: z.enum(ACCOUNTING_PACKAGES), format: z.string(), rowCount: z.number().int(), file: guestFileView })),
})
export type GuestExportView = z.infer<typeof guestExportView>

export const guestInvoiceView = output({
  id: id(),
  side: z.enum(INVOICE_SIDES),
  kind: z.enum(INVOICE_KINDS),
  number: z.string(),
  /** Sales: the issue day; purchases: the day it was received (the purchases journal's day). */
  date: businessDate(),
  /** The other party's name (the buyer, the supplier). */
  party: z.string(),
  /** Sales: the SDI state (ISSUED … REJECTED); purchases: how it came in (SDI, EMAIL, MANUAL). */
  state: z.string(),
  xml: guestFileView.nullable(),
  pdf: guestFileView.nullable(),
})
export type GuestInvoiceView = z.infer<typeof guestInvoiceView>

export const guestRegisterView = output({
  package: z.enum(ACCOUNTING_PACKAGES),
  month: z.string(),
  exportNumber: z.string(),
  exportedAt: instant(),
  current: z.boolean(),
  replacedBy: z.string().nullable(),
  format: z.string(),
  file: guestFileView,
})
export type GuestRegisterView = z.infer<typeof guestRegisterView>

export const guestPeriodAnswer = output({
  period: output({
    key: z.string(),
    kind: z.enum(GUEST_PERIOD_KINDS),
    start: businessDate(),
    end: businessDate(),
    months: z.array(output({ month: z.string(), shared: z.boolean(), lock: lockMark.nullable() })),
  }),
  exports: z.array(guestExportView),
  invoices: z.array(guestInvoiceView),
  registers: z.array(guestRegisterView),
  /** Registers the design names that nothing makes yet (W2b-6). */
  later: z.array(z.enum(REGISTERS_LATER)),
  counts: output({ files: z.number().int(), xml: z.number().int(), sizeBytes: z.number().int() }),
  asOf: instant(),
})
export type GuestPeriodAnswer = z.infer<typeof guestPeriodAnswer>

export const guestFileParams = input({ fileId: id() })
export const guestDownloadBody = input({ period: period() })
export const guestZipBody = input({
  period: period(),
  what: z.enum(GUEST_ZIP_WHAT),
  /** FILES: the files chosen (each one of the period's). */
  fileIds: z.array(id()).min(1).max(GUEST_ZIP.chosenMax).optional(),
})
export type GuestZipBody = z.infer<typeof guestZipBody>

// ---- the office (Finance › Close › Accounting export: Accountant access) -------------------------------------------------

export const ACCOUNTANT_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const

export const accountantsQuery = input({ companyId: id() })

export const accountantPersonView = output({
  id: id(),
  displayName: z.string(),
  email: z.string(),
  status: z.enum(ACCOUNTANT_STATUSES),
  accessUntil: instant().nullable(),
  endsSoon: z.boolean(),
  ended: z.boolean(),
  lastSignInAt: instant().nullable(),
  invitationExpiresAt: instant().nullable(),
  version: z.number().int(),
})
export type AccountantPersonView = z.infer<typeof accountantPersonView>

export const accountantsAnswer = output({
  company: output({ id: id(), code: z.string(), name: z.string() }),
  /** The adviser parties (CONSULTANT) of the company or of every company, with their guest people. */
  firms: z.array(
    output({
      party: output({ id: id(), code: z.string(), name: z.string(), everyCompany: z.boolean() }),
      portalOn: z.boolean(),
      people: z.array(accountantPersonView),
    }),
  ),
  /** The newest downloads of the company's accountants (who, when, what), newest first. */
  downloads: z.array(
    output({
      at: instant(),
      person: z.string().nullable(),
      firm: z.string().nullable(),
      what: z.enum(['FILE', 'ZIP']),
      period: z.string().nullable(),
      name: z.string().nullable(),
      files: z.number().int(),
    }),
  ),
  may: output({ manage: z.boolean() }),
  asOf: instant(),
})
export type AccountantsAnswer = z.infer<typeof accountantsAnswer>

export const inviteAccountantBody = input({
  companyId: id(),
  partyId: id(),
  email: z.string().trim().min(3).max(254),
  displayName: z.string().trim().min(1).max(120),
  locale: z.enum(['it', 'en']).default('it'),
  /** PLT-022: a guest always has an end of access. */
  accessUntil: instant(),
})
export type InviteAccountantBody = z.infer<typeof inviteAccountantBody>

export const accountantParams = input({ userId: id() })
export const changeAccountantBody = input({ companyId: id(), version: z.number().int().min(1), accessUntil: instant() })
export type ChangeAccountantBody = z.infer<typeof changeAccountantBody>
export const endAccountantBody = input({ companyId: id(), version: z.number().int().min(1), reason: z.string().trim().min(1).max(500).optional() })
export type EndAccountantBody = z.infer<typeof endAccountantBody>

export const invitedAccountantAnswer = output({
  invitation: output({ id: id(), userId: id(), email: z.string(), expiresAt: instant(), accessUntil: instant().nullable() }),
  delivery: z.enum(['sent', 'already_sent']),
  portalSwitchedOn: z.boolean(),
})
export const changedAccountantAnswer = output({ id: id(), accessUntil: instant().nullable() })
export const endedAccountantAnswer = output({ id: id(), status: z.enum(ACCOUNTANT_STATUSES), sessionsEnded: z.number().int() })
