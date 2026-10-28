import { describe, expect, it } from 'vitest'
import { compose, formatExpiry } from './compose'
import { footerOf, formatCapital, legalLines, officeAddress, privacyNoticeUrl, type CompanyLegal } from './footer'
import { cleanDisplayName, encodeHeaderText, formatAddress, fromLine, mailDate, messageIdFor, replyAddress, replySubject, threadingOf, type IdentityHeaders } from './headers'
import { buildMime } from './mime'
import {
  canMove,
  cleanSubject,
  domainOf,
  failureText,
  identityReady,
  isAddress,
  localeOf,
  normalizeRecipients,
  OUTBOUND_STATUSES,
  recipientProblems,
  statusAfter,
  suppressedRecipients,
  suppressionProblems,
} from './rules'

const COMPANY: CompanyLegal = {
  legalName: 'Pelletteria Esempio S.r.l.',
  address: { line1: 'Via Esempio 1', postalCode: '50100', city: 'Firenze', province: 'FI', country: 'IT' },
  vatNumber: 'IT00000000000',
  fiscalCode: '00000000000',
  reaOffice: 'FI',
  reaNumber: '123456',
  shareCapital: '10000.00',
  currency: 'EUR',
  pec: 'esempio@pec.example.com',
}
const PRIVACY = privacyNoticeUrl('https://factory.example.com/', '0192f0a0-0000-7000-8000-000000000001')
const IDENTITY: IdentityHeaders = { domain: 'esempio.example.com', fromAddress: 'noreply@esempio.example.com', displayName: 'Esempio', displayNamePolicy: 'PERSON_VIA_COMPANY' }
const decode = (part: string): string => Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString('utf8')

describe('addresses and recipients', () => {
  it('takes plain addresses and refuses anything that could carry a header or a second address', () => {
    for (const ok of ['ada@example.com', 'ada.rossi+quotes@sub.example.co.uk', "o'brien@example.com"]) expect(isAddress(ok)).toBe(true)
    for (const bad of ['', 'ada', '@example.com', 'ada@', 'ada@example', 'Ada <ada@example.com>', 'ada@example.com\r\nBcc: x@example.com', 'a@b@example.com', 'ada@exa mple.com', 'a..b@example.com', `${'a'.repeat(65)}@example.com`]) {
      expect(isAddress(bad), bad).toBe(false)
    }
    expect(domainOf(' Mail.Example.COM. ')).toBe('mail.example.com')
    expect(domainOf('not a domain')).toBeNull()
  })

  it('normalizes recipients, each address once, to before cc before bcc', () => {
    const recipients = normalizeRecipients({ to: [' Ada@Example.com', 'ada@example.com'], cc: ['ADA@example.com', 'carlo@example.com'], bcc: ['carlo@example.com', 'eva@example.com'] })
    expect(recipients).toEqual({ to: ['ada@example.com'], cc: ['carlo@example.com'], bcc: ['eva@example.com'] })
    expect(recipientProblems(recipients)).toEqual([])
    expect(recipientProblems(normalizeRecipients({ to: [], cc: ['nope'] }))).toEqual([
      { path: 'body/to', message: 'Name at least one recipient.' },
      { path: 'body/cc/0', message: 'Not an email address.' },
    ])
    expect(recipientProblems(normalizeRecipients({ to: Array.from({ length: 51 }, (_, index) => `p${index}@example.com`) }))[0]?.message).toMatch(/at most 50/)
  })

  it('finds suppressed recipients wherever they are, with their paths', () => {
    const recipients = normalizeRecipients({ to: ['ada@example.com'], cc: ['gone@example.com'], bcc: ['eva@example.com'] })
    expect(suppressedRecipients(recipients, ['gone@example.com'])).toEqual(['gone@example.com'])
    expect(suppressedRecipients(recipients, new Set<string>())).toEqual([])
    expect(suppressionProblems(recipients, new Set(['gone@example.com', 'eva@example.com']))).toEqual([
      { path: 'body/cc/0', message: expect.stringMatching(/bounced or complained/) },
      { path: 'body/bcc/0', message: expect.stringMatching(/bounced or complained/) },
    ])
  })

  it('keeps a subject on one line and a failure without an address', () => {
    expect(cleanSubject(' Quote\r\nBcc: x@example.com\t 12 ')).toBe('Quote Bcc: x@example.com 12')
    expect(failureText('MessageRejected: Email address is not verified: ada@example.com\n  (eu-south-1)')).toBe('MessageRejected: Email address is not verified: [email] (eu-south-1)')
    expect(localeOf('en-GB')).toBe('en')
    expect(localeOf('de')).toBe('it')
  })
})

describe('the status machine', () => {
  it('moves only forward, and a notification only makes a sent mail worse', () => {
    expect(canMove('QUEUED', 'SENDING')).toBe(true)
    expect(canMove('SENDING', 'QUEUED')).toBe(true)
    expect(canMove('SENT', 'QUEUED')).toBe(false)
    expect(canMove('FAILED', 'QUEUED')).toBe(false)
    expect(canMove('COMPLAINED', 'BOUNCED')).toBe(false)
    expect(OUTBOUND_STATUSES.filter((status) => canMove(status, 'DELIVERED'))).toEqual(['SENT'])
    expect(statusAfter('SENT', 'DELIVERED')).toBe('DELIVERED')
    expect(statusAfter('BOUNCED', 'DELIVERED')).toBe('BOUNCED')
    expect(statusAfter('DELIVERED', 'COMPLAINED')).toBe('COMPLAINED')
    expect(statusAfter('QUEUED', 'DELIVERED')).toBe('QUEUED')
    expect(identityReady({ status: 'ACTIVE', verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS' })).toBe(true)
    expect(identityReady({ status: 'ACTIVE', verificationStatus: 'SUCCESS', dkimStatus: 'PENDING' })).toBe(false)
    expect(identityReady({ status: 'DISABLED', verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS' })).toBe(false)
  })
})

describe('headers', () => {
  it('names the sender as the identity says (COL-024)', () => {
    const ada = { name: 'Ada Esempio', email: 'ada.esempio@esempio.example.com' }
    expect(fromLine(IDENTITY, ada)).toEqual({ name: 'Ada Esempio via Esempio', address: 'noreply@esempio.example.com' })
    expect(fromLine({ ...IDENTITY, displayNamePolicy: 'COMPANY' }, ada)).toEqual({ name: 'Esempio', address: 'noreply@esempio.example.com' })
    expect(fromLine({ ...IDENTITY, displayNamePolicy: 'PERSON_ADDRESS' }, ada)).toEqual({ name: 'Ada Esempio', address: 'ada.esempio@esempio.example.com' })
    // Not at the verified domain: SES would refuse it, so the company's address with the person's name.
    expect(fromLine({ ...IDENTITY, displayNamePolicy: 'PERSON_ADDRESS' }, { name: 'Ada Esempio', email: 'ada@other.example.com' })).toEqual({ name: 'Ada Esempio via Esempio', address: 'noreply@esempio.example.com' })
    expect(fromLine(IDENTITY, null)).toEqual({ name: 'Esempio', address: 'noreply@esempio.example.com' })
  })

  it('never lets a name add a header', () => {
    expect(cleanDisplayName('Ada\r\nBcc: eve@example.com "x" <y>')).toBe('Ada Bcc: eve@example.com x y')
    expect(formatAddress({ name: 'Ada "the boss"', address: 'a@example.com' })).toBe('"Ada the boss" <a@example.com>')
    const encoded = formatAddress({ name: 'Niccolò Società Àèìòù '.repeat(3), address: 'n@example.com' })
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/)
    for (const word of encoded.replace(' <n@example.com>', '').split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75)
    expect(encodeHeaderText('Plain subject')).toBe('Plain subject')
  })

  it('threads a reply: In-Reply-To the latest mail, References the first and the latest ones', () => {
    expect(threadingOf([])).toEqual({ inReplyTo: null, references: [] })
    expect(threadingOf(['<a@x.example>', '<b@x.example>'])).toEqual({ inReplyTo: '<b@x.example>', references: ['<a@x.example>', '<b@x.example>'] })
    const many = Array.from({ length: 14 }, (_, index) => `<m${index}@x.example>`)
    const { inReplyTo, references } = threadingOf(many)
    expect(inReplyTo).toBe('<m13@x.example>')
    expect(references).toEqual(['<m0@x.example>', ...many.slice(5)])
    expect(threadingOf(['not-an-id', '<ok@x.example>']).references).toEqual(['<ok@x.example>'])
    expect(replyAddress('abcdefghijklmnopqrstuvwxyz', 'reply.esempio.example.com')).toBe('r-abcdefghijklmnopqrstuvwxyz@reply.esempio.example.com')
    expect(messageIdFor('0192f0a0-0000-7000-8000-000000000002', 'esempio.example.com')).toBe('<0192f0a0-0000-7000-8000-000000000002@esempio.example.com>')
    expect(replySubject('Re: Quote 12')).toBe('Re: Quote 12')
    expect(replySubject(' Quote 12 ')).toBe('Re: Quote 12')
    expect(mailDate(new Date('2026-10-28T09:00:00Z'))).toBe('Wed, 28 Oct 2026 09:00:00 +0000')
  })
})

describe('the footer (c.c. art. 2250, GDPR art. 13-14)', () => {
  it('prints the legal block the company row can fill, in Italian and English', () => {
    expect(legalLines(COMPANY, 'it')).toEqual([
      'Pelletteria Esempio S.r.l.',
      'Sede legale: Via Esempio 1, 50100 Firenze (FI), IT',
      'Registro delle Imprese di FI n. 00000000000 – REA FI-123456',
      'Capitale sociale € 10.000,00',
      'P. IVA IT00000000000 – C.F. 00000000000',
      'PEC: esempio@pec.example.com',
    ])
    expect(legalLines(COMPANY, 'en')).toContain('Share capital € 10,000.00')
    // A sole trader: no capital, no register line; only what exists.
    expect(legalLines({ legalName: 'Mario Esempio', vatNumber: 'IT11111111111', address: null }, 'it')).toEqual(['Mario Esempio', 'P. IVA IT11111111111'])
    expect(formatCapital('1234567.5', 'GBP', 'en')).toBe('£ 1,234,567.50')
    expect(officeAddress({ line1: 'Via\r\nX 1', city: 'Roma' })).toBe('Via X 1, Roma')
  })

  it('links the company privacy notice in text and HTML, escaped', () => {
    const footer = footerOf({ ...COMPANY, legalName: 'A <b>&</b> B' }, PRIVACY, 'it')
    expect(PRIVACY).toBe('https://factory.example.com/privacy/0192f0a0-0000-7000-8000-000000000001')
    expect(footer.text).toContain(`Informativa privacy (artt. 13-14 GDPR): ${PRIVACY}`)
    expect(footer.html).toContain(`<a href="${PRIVACY}"`)
    expect(footer.html).toContain('A &lt;b&gt;&amp;&lt;/b&gt; B')
    expect(footer.html).not.toContain('<b>')
    expect(() => footerOf(COMPANY, 'javascript:alert(1)', 'it')).toThrow(/http/)
  })
})

describe('compose', () => {
  const context = { locale: 'it' as const, company: COMPANY, privacyUrl: PRIVACY }

  it('a thread message: the person text, their signature, the shared files, the footer; HTML escaped', () => {
    const mail = compose(
      { template: 'thread.message', body: 'Buongiorno,\necco il preventivo.\n\n<script>alert(1)</script>', senderName: 'Ada Esempio', companyName: 'Esempio', attachmentNames: ['Preventivo <12>.pdf'] },
      context,
    )
    expect(mail.subject).toBeNull()
    expect(mail.text).toContain('Buongiorno,\necco il preventivo.')
    expect(mail.text).toContain('Ada Esempio\nEsempio')
    expect(mail.text).toContain('- Preventivo <12>.pdf')
    expect(mail.text).toContain('Registro delle Imprese di FI')
    expect(mail.text).toContain(PRIVACY)
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(mail.html).toContain('Preventivo &lt;12&gt;.pdf')
    expect(mail.html).toContain('Buongiorno,<br>ecco il preventivo.')
  })

  it('an invitation carries its link (http(s) only), its expiry and the footer, in the reader language', () => {
    const expiresAt = new Date('2026-10-31T09:00:00Z')
    const link = 'https://factory.example.com/accept-invitation#token=abc%2Edef'
    const it_ = compose({ template: 'auth.invitation', recipientName: 'Eva', inviterName: 'Ada Esempio', tenantName: 'Gruppo Esempio', link, expiresAt }, context)
    expect(it_.subject).toBe('Invito a Gruppo Esempio su Nexus Factory')
    expect(it_.text).toContain(link)
    expect(it_.text).toContain('Ada Esempio ti ha invitato')
    expect(it_.text).toContain(formatExpiry(expiresAt, 'it'))
    expect(it_.html).toContain(`href="${link}"`)
    const en = compose({ template: 'auth.password_reset', recipientName: 'Eva', link, expiresAt }, { ...context, locale: 'en' })
    expect(en.subject).toBe('New password for Nexus Factory')
    expect(en.text).toContain('Privacy notice (GDPR art. 13-14)')
    expect(() => compose({ template: 'auth.password_reset', recipientName: 'Eva', link: 'javascript:alert(1)', expiresAt }, context)).toThrow(/http/)
    expect(formatExpiry(expiresAt, 'it')).toBe('31/10/26, 10:00 (Europe/Rome)')
  })
})

describe('the MIME message', () => {
  const base = {
    id: '0192f0a0-0000-7000-8000-000000000002',
    from: { name: 'Ada Esempio via Esempio', address: 'noreply@esempio.example.com' },
    to: ['buyer@example.com'],
    cc: ['boss@example.com'],
    replyTo: 'r-abcdefghijklmnopqrstuvwxyz@reply.esempio.example.com',
    subject: 'Preventivo – giacche',
    messageId: '<0192f0a0-0000-7000-8000-000000000002@esempio.example.com>',
    inReplyTo: '<prev@example.com>',
    references: ['<first@example.com>', '<prev@example.com>'],
    date: new Date('2026-10-28T09:00:00Z'),
    text: 'Testo con àccenti',
    html: '<p>Testo</p>',
    automatic: false,
  }

  it('writes the headers, both parts in base64, and never the bcc', () => {
    const raw = buildMime(base)
    const head = raw.split('\r\n\r\n')[0]!
    expect(head).toContain('From: "Ada Esempio via Esempio" <noreply@esempio.example.com>')
    expect(head).toContain('To: buyer@example.com')
    expect(head).toContain('Cc: boss@example.com')
    expect(head).toContain('Reply-To: r-abcdefghijklmnopqrstuvwxyz@reply.esempio.example.com')
    expect(head).toContain('Message-ID: <0192f0a0-0000-7000-8000-000000000002@esempio.example.com>')
    expect(head).toContain('In-Reply-To: <prev@example.com>')
    expect(head).toContain('References: <first@example.com>\r\n <prev@example.com>')
    expect(head).toMatch(/Subject: =\?UTF-8\?B\?/)
    expect(head).not.toMatch(/Bcc|Auto-Submitted/)
    expect(raw).toContain('boundary="=_alt_0192f0a0000070008000000000000002"')
    const part = (type: string) => new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(raw)?.[1] ?? ''
    expect(decode(part('text/plain'))).toBe('Testo con àccenti')
    expect(decode(part('text/html'))).toBe('<p>Testo</p>')
    expect(raw.endsWith('--=_alt_0192f0a0000070008000000000000002--\r\n')).toBe(true)
    expect(raw.split('\r\n').every((line) => line.length <= 998)).toBe(true)
  })

  it('marks system mail as automatic and has no Reply-To without a reply address', () => {
    const raw = buildMime({ ...base, replyTo: null, inReplyTo: null, references: [], automatic: true })
    expect(raw).toContain('Auto-Submitted: auto-generated')
    expect(raw).not.toContain('Reply-To')
    expect(raw).not.toContain('In-Reply-To')
  })

  it('refuses a line break smuggled into a header value', () => {
    expect(() => buildMime({ ...base, to: ['a@example.com\r\nBcc: eve@example.com'] })).toThrow(/line break/)
  })
})
