/**
 * A company's tax switches (B-W2b-392; GATE-ACCOUNTANT, lead decision 11-13; factory-db tax.prisma
 * CompanyEInvoiceSettings, one row per company, no row: every switch off). Each duty works only while its switch is on,
 * with made-up values until the accountant confirms; while off every answer says in words that it waits for the
 * accountant. The self-invoice switch (selfInvoicesOn) is B-W2b-401's.
 */
export const TAX_SWITCHES = ['taxCodesOn', 'stampDutyOn', 'declarationsOfIntentOn'] as const
export type TaxSwitch = (typeof TAX_SWITCHES)[number]
export type TaxSwitches = Readonly<Record<TaxSwitch, boolean>>

export const ALL_OFF: TaxSwitches = Object.freeze({ taxCodesOn: false, stampDutyOn: false, declarationsOfIntentOn: false })

/** What each switch does when on, and what waits while it is off. */
export const SWITCH_WORDS: Readonly<Record<TaxSwitch, { readonly on: string; readonly off: string }>> = Object.freeze({
  taxCodesOn: {
    on: "Invoices use the company's tax codes: every line's VAT is a code in force on the issue day, and a line without VAT prints the code's law.",
    off: "Waits for the accountant: invoices use the built-in VAT rules; the company's tax codes are kept but reach no invoice yet.",
  },
  stampDutyOn: {
    on: 'Stamp duty is charged to the customer as an invoice line, and each quarter is counted for payment.',
    off: 'Waits for the accountant: stamp duty is printed on the e-invoice when due, but not charged to the customer, and the quarters are not counted.',
  },
  declarationsOfIntentOn: {
    on: "Invoices rest on the customers' declarations of intent: lines without VAT (N3.5) name a checked declaration of the year with enough left.",
    off: "Waits for the accountant: declarations are recorded and checked, but no invoice names one yet.",
  },
})

/** The words of each switch now: what it does, or what waits. */
export const switchWords = (switches: TaxSwitches): Record<TaxSwitch, string> =>
  Object.fromEntries(TAX_SWITCHES.map((name) => [name, switches[name] ? SWITCH_WORDS[name].on : SWITCH_WORDS[name].off])) as Record<TaxSwitch, string>
