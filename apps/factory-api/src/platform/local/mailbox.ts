import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { headerOf, textOf, type FakeMail, type FakeMailSink } from '../../adapters/ses/fake'

/**
 * The local mailbox (B-W2b-F58; the Owner tests everything on a local server first): on FACTORY_ENV=local ONLY, the FAKE
 * mail provider (adapters/ses/fake.ts) also keeps each mail it "sends" as one JSON file in this folder
 * (`FACTORY_LOCAL_FILES_DIR/mailbox/`), so a mail sent by the API (sign-in mail: invitations, password resets, portal codes),
 * the worker (record mail: quote links, documents) or the scheduler lands where every process sees it, and the office page
 * Local mailbox (`GET /local/mailbox`) lists it: who to, the subject, when, the text and its links. Newest first; the newest
 * MAX_KEPT are kept. Never on test, staging or production: there the mailbox does not exist (stack.ts), the FAKE provider
 * keeps mail in memory only, and the route is not registered. The folder holds made-up local data and the links of local
 * sign-in mail: it is the Owner's machine's, like the local file store beside it.
 */

export const MAX_KEPT = 200

export interface MailboxMessage {
  /** The FAKE provider's message id. */
  readonly id: string
  readonly tenantId: string
  readonly sentAt: string
  readonly templateKey: string
  readonly from: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  /** The mail's text part. */
  readonly text: string
  /** Every web address in the text, in order, once each (the links a person opens). */
  readonly links: readonly string[]
}

export interface LocalMailbox extends FakeMailSink {
  readonly folder: string
  /** The tenant's mails, newest first, at most `limit`. */
  list(tenantId: string, limit: number): Promise<MailboxMessage[]>
}

/** A header's text: folded lines joined, RFC 2047 encoded words (`=?UTF-8?B?…?=`, `?Q?`) decoded. */
export function decodeHeaderText(value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]+/g, ' ')
  return unfolded
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, _charset: string, encoding: string, text: string) =>
      encoding.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1').toString('utf8'),
    )
}

/** The whole (folded) value of one header of a raw mail. */
function foldedHeader(raw: string, name: string): string | null {
  const head = raw.split('\r\n\r\n', 1)[0] ?? ''
  const lines = head.split('\r\n')
  const at = lines.findIndex((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
  if (at === -1) return headerOf(raw, name)
  let value = lines[at]!.slice(name.length + 1)
  for (let next = at + 1; next < lines.length && /^[ \t]/.test(lines[next]!); next++) value += `\r\n${lines[next]}`
  return value.trim()
}

/** Every web address in a text, once each, without the punctuation that ends a sentence. */
export function linksOf(text: string): string[] {
  const found = (text.match(/https?:\/\/[^\s<>"'`]+/g) ?? []).map((link) => link.replace(/[.,;:!?)\]]+$/, ''))
  return [...new Set(found)]
}

/** The mailbox's view of a mail the FAKE provider took. */
export function messageOf(mail: FakeMail, sentAt: Date): MailboxMessage {
  const text = textOf(mail.raw)
  return {
    id: mail.sesMessageId,
    tenantId: mail.tenantId,
    sentAt: sentAt.toISOString(),
    templateKey: mail.templateKey,
    from: mail.from,
    to: [...mail.to],
    cc: [...mail.cc],
    bcc: [...mail.bcc],
    subject: decodeHeaderText(foldedHeader(mail.raw, 'Subject') ?? ''),
    text,
    links: linksOf(text),
  }
}

const NAME = /^\d{8}T\d{9}Z-[A-Za-z0-9_-]+\.json$/
const fileNameOf = (message: MailboxMessage) => `${message.sentAt.replace(/[-:.]/g, '')}-${message.id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`

async function namesIn(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).filter((name) => NAME.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** The mailbox in a folder (made on the first mail). */
export function localMailbox(options: { readonly folder: string; readonly max?: number }): LocalMailbox {
  const { folder } = options
  const max = options.max ?? MAX_KEPT
  return Object.freeze({
    folder,
    async keep(mail: FakeMail, sentAt: Date): Promise<void> {
      const message = messageOf(mail, sentAt)
      await mkdir(folder, { recursive: true })
      const name = fileNameOf(message)
      // Written whole, then renamed: a reader in another process never sees half a mail.
      const temporary = join(folder, `.${name}.tmp`)
      await writeFile(temporary, `${JSON.stringify(message, null, 2)}\n`, 'utf8')
      await rename(temporary, join(folder, name))
      const names = await namesIn(folder)
      for (const old of names.slice(0, Math.max(0, names.length - max))) await rm(join(folder, old), { force: true })
    },
    async list(tenantId: string, limit: number): Promise<MailboxMessage[]> {
      const messages: MailboxMessage[] = []
      for (const name of (await namesIn(folder)).reverse()) {
        if (messages.length >= limit) break
        let message: MailboxMessage
        try {
          message = JSON.parse(await readFile(join(folder, name), 'utf8')) as MailboxMessage
        } catch {
          continue
        }
        if (message.tenantId === tenantId) messages.push(message)
      }
      return messages
    },
  })
}
