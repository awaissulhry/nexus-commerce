import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { signedInBody, tokenText } from '../office/contract'

/** Invitations by email (feature PLT-015). The link's token travels in bodies only. */

const invitationView = output({ id: id(), userId: id(), email: z.string(), expiresAt: instant() })

export const inviteContract = defineContract({
  body: input({
    email: z.string().trim().min(3).max(320),
    displayName: z.string().trim().min(1).max(200),
    locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).optional(),
  }),
  /** The link goes to the mail seam (sessions/mail.ts), never into this answer. */
  response: { 200: output({ invitation: invitationView }) },
})

export const revokeInvitationContract = defineContract({
  params: input({ invitationId: id() }),
  response: { 200: output({ id: id(), revokedAt: instant() }) },
})

export const previewInvitationContract = defineContract({
  body: input({ token: tokenText }),
  response: { 200: output({ tenant: output({ name: z.string() }), email: z.string(), displayName: z.string(), expiresAt: instant() }) },
})

export const acceptInvitationContract = defineContract({
  body: input({
    token: tokenText,
    password: z.string().min(1).max(1024),
    displayName: z.string().trim().min(1).max(200).optional(),
  }),
  response: { 200: signedInBody },
})

export type InviteBody = z.infer<typeof inviteContract.body>
export type AcceptInvitationBody = z.infer<typeof acceptInvitationContract.body>
