/**
 * "Create an inquiry" from a mail (B-W2b-397; design home.mail pop:create-from "Create an inquiry (W2b), a customer or a
 * supplier (W1) prefilled from the sender"): ONE link to Sales › Inquiries' own dialog, `?mail=<inbound mail id>`
 * (B-W2b-322 on B-W2b-295's GET/POST /sales/inquiries/from-mail/:id), which reads the mail's draft and makes the inquiry.
 * Offered while the mail waits in Mail to sort or sits in a thread (TRIAGE, HELD, MATCHED: factory-domain sales/inquiries
 * `mailRefusal`), to a person who manages inquiries; a mail made into one already opens that inquiry instead.
 */

/** The statuses a mail is made into an inquiry from (factory-domain sales/inquiries/rules.ts mailRefusal). */
export const INQUIRY_FROM = ['TRIAGE', 'HELD', 'MATCHED'] as const

/** Where "Create an inquiry" goes: the inquiries page with the mail named. */
export const inquiryHref = (prefix: string, mailId: string): string => `${prefix}/sales/inquiries?mail=${encodeURIComponent(mailId)}`

/** Why "Create an inquiry" waits (a key of `mail-depth`), or null. */
export function inquiryHeld(mail: { readonly status: string; readonly inquiry?: { readonly number: string } | null }, mayManage: boolean): string | null {
  if (!mayManage) return 'inquiry.held.noRight'
  if (mail.inquiry) return 'inquiry.held.made'
  if (!(INQUIRY_FROM as readonly string[]).includes(mail.status)) return mail.status === 'FAILED' ? 'inquiry.held.failed' : 'inquiry.held.notWaiting'
  return null
}
