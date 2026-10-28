import { describe, expect, it } from 'vitest'
import { receivedMailOf } from './notification'
import { parseRawMail } from './parse'
import { rawMail, receivedNotificationBody } from './testing'

// Reading SES's "Received" notification and a raw mail: pure, no database, no network.

const PDF = Buffer.from('%PDF-1.7\n% made-up offer\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

describe("SES's Received notification", () => {
  it('reads the envelope, the common headers, the verdicts and the S3 place', () => {
    const body = receivedNotificationBody({
      snsMessageId: 'sns-1',
      sesMessageId: 'ses-abc',
      bucket: 'factory-inbound',
      key: 'inbound/ses-abc',
      from: '"Anna Esempio" <Anna@Buyer.example.com>',
      to: ['r-abcdefghijklmnopqrstuvwxyz@reply.acme.example.com'],
      cc: ['Boss@Buyer.example.com'],
      subject: 'Re:\r\n Preventivo',
      messageId: '<m1@buyer.example.com>',
      verdicts: { dmarc: 'FAIL', spam: 'GRAY' },
      dmarcPolicy: 'REJECT',
    })
    expect(receivedMailOf(body)).toEqual({
      sesMessageId: 'ses-abc',
      receivedAt: new Date('2026-10-28T09:10:00Z'),
      location: { bucket: 'factory-inbound', key: 'inbound/ses-abc' },
      envelopeFrom: 'anna@buyer.example.com',
      envelopeTo: ['r-abcdefghijklmnopqrstuvwxyz@reply.acme.example.com', 'boss@buyer.example.com'],
      from: { address: 'anna@buyer.example.com', name: 'Anna Esempio' },
      to: ['r-abcdefghijklmnopqrstuvwxyz@reply.acme.example.com'],
      cc: ['boss@buyer.example.com'],
      subject: 'Re: Preventivo',
      emailMessageId: '<m1@buyer.example.com>',
      verdicts: { spf: 'PASS', dkim: 'PASS', dmarc: 'FAIL', spam: 'GRAY', virus: 'PASS' },
      dmarcPolicy: 'reject',
    })
  })

  it('is not one for a delivery notification or a non-SNS body; a broken one throws', () => {
    expect(receivedMailOf(JSON.stringify({ Type: 'Notification', MessageId: 'x', Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'm' } }) }))).toBeNull()
    expect(receivedMailOf('not json')).toBeNull()
    expect(() => receivedMailOf(JSON.stringify({ Type: 'Notification', MessageId: 'x', Message: JSON.stringify({ notificationType: 'Received', mail: {} }) }))).toThrow(/not well formed/)
    const noS3 = receivedMailOf(receivedNotificationBody({ snsMessageId: 's', sesMessageId: 'e', bucket: 'b', key: 'k', from: 'a@b.example', to: ['c@d.example'], actionType: 'SNS' }))
    expect(noS3?.location).toBeNull()
  })
})

describe('a raw mail', () => {
  it('parses headers, keeps text and sanitised HTML, keeps allowed attachments and lists the others', async () => {
    const raw = rawMail({
      from: '"Luca" <Luca@Buyer.example.com>',
      to: ['orders@reply.acme.example.com'],
      cc: ['boss@buyer.example.com'],
      subject: 'Ordine',
      messageId: '<m2@buyer.example.com>',
      inReplyTo: '<o1@acme.example.com>',
      references: ['<o0@acme.example.com>', '<o1@acme.example.com>'],
      text: 'Ecco il PDF.',
      html: '<p onclick="x()">Ecco il <b>PDF</b><script>steal()</script><img src="cid:logo1"></p>',
      attachments: [
        { filename: 'offerta.pdf', contentType: 'application/pdf', content: PDF },
        { filename: 'logo.png', contentType: 'image/png', content: PNG, contentId: 'logo1' },
        { filename: 'setup.exe', contentType: 'application/x-msdownload', content: Buffer.from('MZ') },
        { filename: 'scan.bin', contentType: 'application/octet-stream', content: PDF },
        { filename: 'empty.txt', contentType: 'text/plain', content: Buffer.alloc(0) },
      ],
    })
    const mail = await parseRawMail(Buffer.from(raw))
    expect(mail).toMatchObject({
      from: { address: 'luca@buyer.example.com', name: 'Luca' },
      to: ['orders@reply.acme.example.com'],
      cc: ['boss@buyer.example.com'],
      subject: 'Ordine',
      emailMessageId: '<m2@buyer.example.com>',
      inReplyTo: '<o1@acme.example.com>',
      referenceIds: ['<o0@acme.example.com>', '<o1@acme.example.com>'],
      text: 'Ecco il PDF.',
    })
    expect(mail.html).toBe('<p>Ecco il <b>PDF</b><img data-cid="logo1" /></p>')
    expect(mail.parts.map((entry) => [entry.part.name, entry.kept, entry.kept ? entry.part.contentType : entry.part.reason])).toEqual([
      ['logo.png', false, 'inline'],
      ['offerta.pdf', true, 'application/pdf'],
      ['setup.exe', false, 'type_not_allowed'],
      ['scan.bin', true, 'application/pdf'],
      ['empty.txt', false, 'empty'],
    ])
  })

  it('takes the text of an HTML-only mail', async () => {
    const mail = await parseRawMail(Buffer.from(rawMail({ from: 'a@b.example', to: ['c@d.example'], subject: 'S', html: '<p>Riga uno</p><p>Riga&nbsp;due</p>' })))
    expect(mail.text).toBe('Riga uno\nRiga due')
    expect(mail.parts).toEqual([])
  })
})
