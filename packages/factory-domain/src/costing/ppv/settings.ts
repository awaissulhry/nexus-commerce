import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { PPV_AT, type PpvAt } from './rules'

/**
 * A company's actual-cost settings (B-W2b-407; FIN-031, FIN-043, FIN-044; GATE-ACCOUNTANT; ActualCostSettings of B-W2b-376):
 * the company's switch for the accountant's figures (purchase price variance, cost of goods sold, landed cost posted; a
 * work order close's variances and closing entry, B-W2b-411) and where it takes its purchase price variance. The switch
 * is OFF by default (no row) and only a company's own row turns it on, with when and by whom; while it is off nothing of
 * those figures is written and every screen says so in these words. Where the variance is taken changes only while the
 * switch is off (a change while figures are written would take one purchase twice, at the receipt and at the invoice).
 * The close tolerance is read here and kept by the work order close (B-W2b-411).
 */

/** The words of every figure that waits for the switch (the API's and the screens'). */
export const ACCOUNTANT_WAITS =
  "Waits for the accountant: the company's figures for the accountant (purchase price variance, cost of goods sold, landed cost) are off until a person switches them on in the costing settings, once the accountant has confirmed the rules (GATE-ACCOUNTANT)."

export const PPV_AT_WORDS: Readonly<Record<PpvAt, string>> = Object.freeze({
  RECEIPT: "At the goods receipt, at the purchase order's price.",
  INVOICE: "At the supplier's invoice, at the invoiced price, once the invoice is approved.",
})

/** Where a company's setting comes from: its own row, the tenant-wide row, or the default. */
export const SETTING_SOURCES = ['COMPANY', 'TENANT', 'DEFAULT'] as const

/** Why a settings change is refused, as the issue path `refusal/<code>`. */
export const SETTINGS_REFUSALS = ['PPV_AT_WHILE_ON', 'NOTHING_CHANGES'] as const
export type SettingsRefusal = (typeof SETTINGS_REFUSALS)[number]

export const actualSettingsQuery = input({ companyId: id() })
export type ActualSettingsQuery = z.infer<typeof actualSettingsQuery>

export const actualSettingsView = output({
  companyId: id(),
  /** The company's own row (null: none yet; the first change makes it). */
  settingsId: id().nullable(),
  version: z.number().int().nullable(),
  ppvAt: z.enum(PPV_AT),
  ppvAtFrom: z.enum(SETTING_SOURCES),
  ppvAtWords: z.string(),
  /** The close tolerance in force (percent), kept by the work order close. */
  closeTolerancePct: z.string(),
  postingsOn: z.boolean(),
  postingsOnAt: instant().nullable(),
  /** Who switched them on (an office user; inside one record). */
  postingsOnBy: output({ id: id(), name: z.string() }).nullable(),
  /** ACCOUNTANT_WAITS while off, else null. */
  waits: z.string().nullable(),
  words: z.string(),
  can: output({ manage: z.boolean(), changePpvAt: z.boolean() }),
})
export type ActualSettingsView = z.infer<typeof actualSettingsView>

export const actualSettingsBody = input({
  companyId: id(),
  ppvAt: z.enum(PPV_AT).optional(),
  postingsOn: z.boolean().optional(),
  /** The row's version when it exists (the edit-conflict guard). */
  version: z.number().int().min(1).optional(),
  /** Why (kept on the audit row), 3 to 1,000 characters. */
  reason: z.string().trim().min(3).max(1000).optional(),
})
export type ActualSettingsBody = z.infer<typeof actualSettingsBody>

/** The settings in words: where the variance is taken and whether the figures are written. */
export function settingsWords(view: { readonly ppvAt: PpvAt; readonly postingsOn: boolean; readonly postingsOnDay: string | null }): string {
  const where = `Purchase price variance: ${PPV_AT_WORDS[view.ppvAt].charAt(0).toLowerCase()}${PPV_AT_WORDS[view.ppvAt].slice(1)}`
  return view.postingsOn ? `The figures for the accountant are on since ${view.postingsOnDay}. ${where}` : `${ACCOUNTANT_WAITS} ${where}`
}
