import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES, PROFORMA_PURPOSES } from '@nexus/factory-domain/documents/model'
import { PROFORMA_NOTES_MAX, PROFORMA_RECORD_TYPES } from '@nexus/factory-domain/shipping/proforma/rules'

/** The proforma invoice (B-W2b-391; LOG-058). The answers carry no amount: the PDF is the file (its prices behind the grain). */

const versionView = output({
  documentId: id(),
  version: z.number().int(),
  number: z.string(),
  language: z.enum(DOCUMENT_LANGUAGES),
  /** The PDF: a file of the record (office, and the record's customer), downloaded through the files module. */
  fileId: id(),
  createdAt: instant(),
  createdBy: z.string().nullable(),
  /** The newest version. */
  current: z.boolean(),
})

export const listProformasContract = defineContract({
  querystring: input({ recordType: z.enum(PROFORMA_RECORD_TYPES), recordId: id() }),
  response: {
    200: output({
      recordType: z.enum(PROFORMA_RECORD_TYPES),
      recordId: id(),
      /** The record's own number (the shipment's, the sample round's, the deposit's order). */
      label: z.string(),
      purpose: z.enum(PROFORMA_PURPOSES),
      /** The record's PROFORMA number once taken (every version repeats it), else null. */
      number: z.string().nullable(),
      versions: z.array(versionView),
      /** Why it may have no proforma now (empty: it may). */
      problems: z.array(z.string()),
    }),
  },
})

export const makeProformaContract = defineContract({
  body: input({
    recordType: z.enum(PROFORMA_RECORD_TYPES),
    recordId: id(),
    /** Default the order's (or the party's) language. */
    language: z.enum(DOCUMENT_LANGUAGES).optional(),
    notes: z.string().trim().max(PROFORMA_NOTES_MAX).optional(),
    /** SampleShipment: the value per piece for customs (a decimal in the currency), required when the round is not charged. */
    unitValue: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).optional(),
    /** SampleShipment: the currency of that value (ISO 4217); default the round's charge currency, else the company's. */
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  }),
  response: {
    200: output({ proforma: versionView.extend({ made: z.boolean() }) }),
    201: output({ proforma: versionView.extend({ made: z.boolean() }) }),
  },
})
