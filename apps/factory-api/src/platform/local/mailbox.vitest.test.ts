import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMime } from '@nexus/factory-domain/email/mime'
import type { FakeMail } from '../../adapters/ses/fake'
import { decodeHeaderText, linksOf, localMailbox, messageOf } from './mailbox'
import { localStackOf, NO_LOCAL_STACK } from './stack'

/**
 * The local mailbox (B-W2b-F58): what a FAKE mail becomes on the Owner's local test server (made-up mail and addresses), and
 * that only FACTORY_ENV=local has one.
 */

const folders: string[] = []
const folder = () => {
  const made = mkdtempSync(join(tmpdir(), 'factory-mailbox-'))
  folders.push(made)
  return made
}
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true })
})

const TENANT = '0190f0e2-1111-7000-8000-000000000001'
const OTHER = '0190f0e2-1111-7000-8000-000000000002'

function mail(n: number, subject: string, text: string, tenantId = TENANT): FakeMail {
  const raw = buildMime({
    id: `0190f0e2-2222-7000-8000-00000000000${n}`,
    from: { name: 'Officina Prova', address: 'noreply@mail.prova.example.com' },
    to: [`persona.${n}@example.com`],
    cc: [],
    replyTo: null,
    subject,
    messageId: `<m${n}@mail.prova.example.com>`,
    inReplyTo: null,
    references: [],
    date: new Date('2026-11-15T17:00:00.000Z'),
    text,
    html: `<p>${text}</p>`,
    automatic: true,
  })
  return { sesMessageId: `fake-0000000${n}`, accountId: 'acc', tenantId, outboundId: `out-${n}`, templateKey: 'auth.invitation', from: 'noreply@mail.prova.example.com', to: [`persona.${n}@example.com`], cc: [], bcc: [], raw }
}

describe('a FAKE mail in the local mailbox', () => {
  it('keeps who to, the subject in words (encoded words decoded), the text and its links', () => {
    const message = messageOf(mail(1, 'Sei invitata: Officina Prova – accesso', 'Ciao,\nimposta la password qui: http://localhost:3300/accept-invitation#token=made-up-token.\nGrazie.'), new Date('2026-11-15T17:40:00.000Z'))
    expect(message).toMatchObject({
      id: 'fake-00000001',
      tenantId: TENANT,
      sentAt: '2026-11-15T17:40:00.000Z',
      to: ['persona.1@example.com'],
      subject: 'Sei invitata: Officina Prova – accesso',
      links: ['http://localhost:3300/accept-invitation#token=made-up-token'],
    })
    expect(message.text).toContain('imposta la password qui')
  })

  it('decodes folded encoded words and finds each link once, without the punctuation after it', () => {
    expect(decodeHeaderText('=?UTF-8?B?w6hsYSBwcm92YQ==?=\r\n =?UTF-8?B?IGZpbml0YQ==?=')).toBe('èla prova finita')
    expect(decodeHeaderText('=?UTF-8?Q?caff=C3=A8_pronto?=')).toBe('caffè pronto')
    expect(decodeHeaderText('Plain subject')).toBe('Plain subject')
    expect(linksOf('Open (https://a.example.com/x?y=1), then https://a.example.com/x?y=1; or http://b.example.com.')).toEqual(['https://a.example.com/x?y=1', 'http://b.example.com'])
  })
})

describe('the mailbox folder', () => {
  it('lists the tenant’s mails newest first, keeps the newest only, and is shared by every process that opens it', async () => {
    const where = folder()
    const api = localMailbox({ folder: where, max: 3 })
    const worker = localMailbox({ folder: where, max: 3 })
    await worker.keep(mail(1, 'One', 'first'), new Date('2026-11-15T10:00:00.000Z'))
    await api.keep(mail(2, 'Two', 'second'), new Date('2026-11-15T10:01:00.000Z'))
    await worker.keep(mail(3, 'Other tenant', 'third', OTHER), new Date('2026-11-15T10:02:00.000Z'))
    await worker.keep(mail(4, 'Four', 'fourth'), new Date('2026-11-15T10:03:00.000Z'))
    expect((await api.list(TENANT, 10)).map((message) => message.subject)).toEqual(['Four', 'Two'])
    expect((await api.list(OTHER, 10)).map((message) => message.subject)).toEqual(['Other tenant'])
    expect((await api.list(TENANT, 1)).map((message) => message.subject)).toEqual(['Four'])
    // At most 3 files: the oldest went; no temporary file is left.
    expect(readdirSync(where).filter((name) => name.endsWith('.json'))).toHaveLength(3)
    expect(readdirSync(where).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('is empty before the first mail (no folder yet)', async () => {
    expect(await localMailbox({ folder: join(folder(), 'not-made-yet') }).list(TENANT, 10)).toEqual([])
  })
})

describe('only the local test server has one', () => {
  const base = { FACTORY_LOCAL_FILES_DIR: '/tmp/factory-local-files', FACTORY_QUEUE_PREFIX: 'w2bf58', FACTORY_HIDE_TEST_MODE_BANNER: '1' as const }
  it('FACTORY_ENV=local: the mailbox under the local files folder, and the TEST MODE bar hidden when asked', () => {
    const stack = localStackOf({ ...base, FACTORY_ENV: 'local' })
    expect(stack.mailbox?.folder).toBe('/tmp/factory-local-files/mailbox')
    expect(stack.hideTestModeBanner).toBe(true)
    expect(localStackOf({ ...base, FACTORY_ENV: 'local', FACTORY_HIDE_TEST_MODE_BANNER: undefined }).hideTestModeBanner).toBe(false)
  })
  it.each(['test', 'staging', 'production'] as const)('FACTORY_ENV=%s: no mailbox, the bar shows', (environment) => {
    expect(localStackOf({ ...base, FACTORY_ENV: environment })).toBe(NO_LOCAL_STACK)
  })
})
