import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'

/**
 * The office shell's notices (B-W2b-F49): what is in test mode where the person works, as names only (no settings, no
 * connection, no secret). A site or company is listed while its test mode is on; an empty list = nothing in test mode.
 */

export const shellNoticesContract = defineContract({
  /** The company the screen works in (the shell's own); left out: every company the person works in. */
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      testModes: output({
        /** The ACTIVE sites whose carrier is in test mode (labels marked TEST, nothing sent; B-W2b-390), by name. */
        carrierSites: z.array(output({ siteId: id(), name: z.string() })),
        /** The ACTIVE companies whose e-invoicing is in test mode (nothing goes to SDI; B-W2b-401): their legal name, by code. */
        eInvoicingCompanies: z.array(output({ companyId: id(), name: z.string() })),
      }),
    }),
  },
})
