/**
 * "Make incoming request" from a mail (B-W2b-397, renamed by B-TH-224, threads plan TH-1b; design home.mail pop:create-from):
 * ONE link to Sales › Incoming's own dialog, `?mail=<inbound mail id>` (B-W2b-322 on B-W2b-295's GET/POST
 * /sales/inquiries/from-mail/:id), which reads the mail's draft and makes the request. Offered while the mail waits in Mail to
 * sort or sits in a thread (TRIAGE, HELD, MATCHED: factory-domain sales/inquiries `mailRefusal`), to a person who answers
 * requests; a mail made into one already offers "Open in Incoming" instead (O-HOME-MAIL.list-F02): it is answered there, never
 * here (O-HOME-MAIL.modal-F01).
 */

/** The statuses a mail is made into a request from (factory-domain sales/inquiries/rules.ts mailRefusal). */
export const INQUIRY_FROM = ['TRIAGE', 'HELD', 'MATCHED'] as const

/** Where "Make incoming request" goes: Incoming with the mail named. */
export const inquiryHref = (prefix: string, mailId: string): string => `${prefix}/sales/incoming?mail=${encodeURIComponent(mailId)}`

/** B-TH-224: where "Open in Incoming" goes — the request open beside the list. */
export const incomingHref = (prefix: string, inquiryId: string): string => `${prefix}/sales/incoming?open=${encodeURIComponent(inquiryId)}`

/** B-TH-224: the request a mail became, as far as the screen knows it (the read's answer, else the request thread it joined). */
export function requestOfMail(mail: { readonly inquiry?: { readonly id: string; readonly number: string } | null; readonly thread?: { readonly recordType: string; readonly recordId: string } | null }): { readonly id: string; readonly number: string | null } | null {
  if (mail.inquiry) return mail.inquiry
  if (mail.thread?.recordType === 'Inquiry') return { id: mail.thread.recordId, number: null }
  return null
}

/** Why "Make incoming request" waits (a key of `mail-depth`), or null. */
export function inquiryHeld(mail: { readonly status: string; readonly inquiry?: { readonly number: string } | null }, mayManage: boolean): string | null {
  if (!mayManage) return 'inquiry.held.noRight'
  if (mail.inquiry) return 'inquiry.held.made'
  if (!(INQUIRY_FROM as readonly string[]).includes(mail.status)) return mail.status === 'FAILED' ? 'inquiry.held.failed' : 'inquiry.held.notWaiting'
  return null
}
