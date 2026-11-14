import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The capture address's contracts (B-W2b-394; COL-021; design home.mail band "Copy capture address", admin.connections "Capture
 * address (W2b): forward or BCC any mail to it"). Office only. The address is the company's to copy; it is no secret worth a
 * step-up (only a mail from an office person's own address, passing DMARC, is ever matched through it).
 */

const version = z.number().int().min(1)

export const captureView = output({
  id: id(),
  companyId: id(),
  /** `c-<token>@<the company's receiving domain>`; null while the company sends no mail (no identity). */
  address: z.string().nullable(),
  /** The team inbox mail it cannot place lands in (null: Mail to sort). */
  defaultTeamInbox: output({ id: id(), name: z.string(), active: z.boolean() }).nullable(),
  createdAt: instant(),
  version: z.number().int(),
})
export type CaptureView = z.infer<typeof captureView>

export const getCaptureContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      capture: captureView.nullable(),
      /** The domain its address is made at; null: the company has no sending address yet (Admin › Connections › mail domain). */
      receivingDomain: z.string().nullable(),
      /** The reader may make, replace or turn it off (email.inboxes.manage). */
      mayManage: z.boolean(),
    }),
  },
})

export const createCaptureContract = defineContract({
  body: input({
    companyId: id(),
    /** Left out: the replaced address's (else none). */
    defaultTeamInboxId: id().nullable().optional(),
    /** The live address this one replaces (a leaked one): it is turned off in the same step. Needed while one is live. */
    replacing: input({ id: id(), version }).optional(),
  }),
  response: { 201: output({ capture: captureView }) },
})

export const updateCaptureContract = defineContract({
  params: input({ captureAddressId: id() }),
  body: input({ version, defaultTeamInboxId: id().nullable() }),
  response: { 200: output({ capture: captureView }) },
})

export const turnOffCaptureContract = defineContract({
  params: input({ captureAddressId: id() }),
  body: input({ version }),
  response: { 200: output({ capture: captureView }) },
})
