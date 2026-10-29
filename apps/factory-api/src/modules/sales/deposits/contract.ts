import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/** A company's bank account: the holder, the IBAN (upper case, no spaces), the BIC and the bank; null: none on record. */
const bankView = output({
  companyId: id(),
  bank: output({ accountHolder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable() }).nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})

const params = input({ companyId: id() })

export const getBankDetailsContract = defineContract({ params, response: { 200: bankView } })

export const saveBankDetailsContract = defineContract({
  params,
  body: input({
    /** The company's version (the edit-conflict guard). */
    version: z.number().int().min(1),
    /** Every field empty (or null) removes the account. */
    accountHolder: z.string().max(200).nullable(),
    iban: z.string().max(60).nullable(),
    bic: z.string().max(20).nullable(),
    bankName: z.string().max(200).nullable(),
  }),
  response: { 200: bankView },
})
