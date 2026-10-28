import { describe, expect, it } from 'vitest'
import { buildMime } from '@nexus/factory-domain/email/mime'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { FakeSes, headerOf, textOf } from './fake'
import { sesMailAdapter } from './ses'
import { parseSesNotification, snsVerifier } from './sns'
import { FakeSesTransport, sesNotificationBody } from './testing'

// The SES adapter on the real SESv2 client with a scripted transport (no network), the fake mailbox, and the SNS
// notifications' parser and verifier.

const ACCESS_KEY = 'made-up-access-key-id-01'
const SECRET_KEY = 'made-up-secret-access-key-for-tests-only'

function callFor(mode: AdapterAccount['mode'], settings: unknown = { region: 'eu-south-1', configurationSet: 'factory-events' }, credentials: unknown = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }) {
  const answers: unknown[] = []
  const call: GatewayCall = {
    account: { id: '01a18208-e882-70ce-8bb6-0d4afb932bc3', tenantId: '01a18208-e882-70ce-8bb6-0d4afb932bc1', companyId: null, provider: 'SES', mode, settings },
    attempt: 1,
    signal: new AbortController().signal,
    idempotencyKey: null,
    credentials: async <T>() => credentials as T,
    answer: (details) => void answers.push(details),
  }
  return { call, answers }
}

const raw = buildMime({
  id: '01a18208-e882-70ce-8bb6-0d4afb932bc4',
  from: { name: 'Ada via Esempio', address: 'noreply@esempio.example.com' },
  to: ['buyer@example.com'],
  cc: [],
  replyTo: 'r-abcdefghijklmnopqrstuvwxyz@reply.esempio.example.com',
  subject: 'Preventivo',
  messageId: '<01a18208-e882-70ce-8bb6-0d4afb932bc4@esempio.example.com>',
  inReplyTo: null,
  references: [],
  date: new Date('2026-10-28T09:00:00Z'),
  text: 'Testo',
  html: '<p>Testo</p>',
  automatic: false,
})
const mail = { outboundId: '01a18208-e882-70ce-8bb6-0d4afb932bc4', templateKey: 'thread.message', from: 'noreply@esempio.example.com', to: ['buyer@example.com'], cc: [], bcc: ['audit@example.com'], raw }

describe('the SES adapter (real client, scripted transport)', () => {
  it('sends the raw MIME to every recipient, with the configuration set and the tags, signed with the account key', async () => {
    const transport = new FakeSesTransport().answer('POST /v2/email/outbound-emails', { status: 200, body: { MessageId: 'ses-0001' } })
    const { call, answers } = callFor('SANDBOX')
    expect(await sesMailAdapter({ clientFor: transport.clientFor }).send(call, mail)).toEqual({ sesMessageId: 'ses-0001' })
    expect(transport.configs[0]).toMatchObject({ region: 'eu-south-1', maxAttempts: 1 })
    const [request] = transport.requests
    expect(request).toMatchObject({ method: 'POST', hostname: 'email.eu-south-1.amazonaws.com', path: '/v2/email/outbound-emails' })
    expect(request!.headers.authorization).toContain(`Credential=${ACCESS_KEY}/`)
    const body = JSON.parse(request!.body)
    expect(body).toMatchObject({
      FromEmailAddress: 'noreply@esempio.example.com',
      Destination: { ToAddresses: ['buyer@example.com'], CcAddresses: [], BccAddresses: ['audit@example.com'] },
      ConfigurationSetName: 'factory-events',
      EmailTags: [
        { Name: 'outbound', Value: mail.outboundId },
        { Name: 'template', Value: 'thread_message' },
      ],
    })
    expect(Buffer.from(body.Content.Raw.Data, 'base64').toString('utf8')).toBe(raw)
    expect(answers).toEqual([{ httpStatus: 200, response: { messageId: 'ses-0001' } }])
  })

  it('maps SES errors to provider errors (a 4xx is final, a 5xx retryable) and refuses what it cannot do', async () => {
    const transport = new FakeSesTransport()
      .answer('POST /v2/email/outbound-emails', { status: 400, body: { message: 'Email address is not verified.' }, errorType: 'MessageRejected' })
    const adapter = sesMailAdapter({ clientFor: transport.clientFor })
    const rejected = await adapter.send(callFor('LIVE').call, mail).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(ProviderError)
    expect(rejected).toMatchObject({ httpStatus: 400, retryable: false })
    transport.answer('POST /v2/email/outbound-emails', { status: 503, body: { message: 'busy' }, errorType: 'ServiceUnavailable' })
    expect(await adapter.send(callFor('LIVE').call, mail).catch((error: unknown) => error)).toMatchObject({ httpStatus: 503, retryable: true })
    await expect(adapter.send(callFor('FAKE').call, mail)).rejects.toThrow(/FAKE account uses the fake mailbox/)
    await expect(adapter.send(callFor('LIVE', {}, null).call, mail)).rejects.toThrow(/no access key/)
    await expect(adapter.send(callFor('LIVE', { region: 'Milan' }).call, mail)).rejects.toThrow(/settings are not valid/)
    // Without sealed credentials, the environment's keys (staging, production).
    transport.answer('POST /v2/email/outbound-emails', { status: 200, body: { MessageId: 'ses-0002' } })
    const fromEnvironment = sesMailAdapter({ clientFor: transport.clientFor, environmentCredentials: { accessKeyId: 'made-up-environment-key-id', secretAccessKey: 'environment-secret' } })
    expect(await fromEnvironment.send(callFor('LIVE', {}, null).call, mail)).toEqual({ sesMessageId: 'ses-0002' })
    expect(transport.requests.at(-1)!.headers.authorization).toContain('Credential=made-up-environment-key-id/')
  })

  it('creates a domain identity with Easy DKIM, and reads it instead when SES has it already', async () => {
    const dkim = { SigningEnabled: true, Status: 'PENDING', Tokens: ['tok1', 'tok2', 'tok3'] }
    const transport = new FakeSesTransport()
      .answer('POST /v2/email/identities', { status: 200, body: { IdentityType: 'DOMAIN', VerifiedForSendingStatus: false, DkimAttributes: dkim } })
      .answer('GET /v2/email/identities/esempio.example.com', { status: 200, body: { IdentityType: 'DOMAIN', VerificationStatus: 'SUCCESS', DkimAttributes: { ...dkim, Status: 'SUCCESS' } } })
    const adapter = sesMailAdapter({ clientFor: transport.clientFor })
    const settings = { region: 'eu-south-1', awsAccountId: '000000000000' }
    expect(await adapter.createIdentity(callFor('SANDBOX', settings).call, 'esempio.example.com')).toEqual({
      arn: 'arn:aws:ses:eu-south-1:000000000000:identity/esempio.example.com',
      verificationStatus: 'PENDING',
      dkimStatus: 'PENDING',
      dkimTokens: ['tok1', 'tok2', 'tok3'],
    })
    expect(JSON.parse(transport.requests[0]!.body)).toEqual({ EmailIdentity: 'esempio.example.com' })
    transport.answer('POST /v2/email/identities', { status: 400, body: { message: 'exists' }, errorType: 'AlreadyExistsException' })
    expect(await adapter.createIdentity(callFor('SANDBOX').call, 'esempio.example.com')).toMatchObject({ arn: null, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS' })
    expect(transport.requests.map((request) => `${request.method} ${request.path}`).slice(1)).toEqual(['POST /v2/email/identities', 'GET /v2/email/identities/esempio.example.com'])
  })
})

describe('the fake mailbox (FAKE accounts)', () => {
  it('keeps the mail in memory, answers a fake id, verifies identities at once, and fails when told to', async () => {
    const fake = new FakeSes()
    const { call } = callFor('FAKE')
    const sent = await fake.send(call, mail)
    expect(sent.sesMessageId).toMatch(/^fake-/)
    expect(fake.last('audit@example.com')).toMatchObject({ sesMessageId: sent.sesMessageId, bcc: ['audit@example.com'] })
    expect(textOf(fake.mails[0]!.raw)).toBe('Testo')
    expect(headerOf(fake.mails[0]!.raw, 'reply-to')).toBe('r-abcdefghijklmnopqrstuvwxyz@reply.esempio.example.com')
    expect(await fake.getIdentity(call, 'esempio.example.com')).toMatchObject({ verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS' })
    fake.failNext = { httpStatus: 454, message: 'Throttling' }
    await expect(fake.send(call, mail)).rejects.toMatchObject({ httpStatus: 454 })
    await expect(fake.send(callFor('LIVE').call, mail)).rejects.toThrow(/Only a FAKE account/)
    expect(fake.mails).toHaveLength(1)
  })
})

describe('SES notifications through SNS', () => {
  const secret = 'whsec_made_up_sns_basic_auth_secret'
  const body = sesNotificationBody({ snsMessageId: 'sns-1', eventType: 'Bounce', sesMessageId: 'ses-0001', outboundId: 'o-1', bounce: { type: 'Permanent', recipients: ['Buyer@Example.com'] } })
  const basic = (password: string) => `Basic ${Buffer.from(`sns:${password}`).toString('base64')}`
  const verify = (headers: Record<string, string>, raw = body, withSecret: string | null = secret) =>
    snsVerifier.verify({ rawBody: Buffer.from(raw), headers, secret: withSecret, now: new Date() })

  it('parses an SES event inside its SNS envelope', () => {
    expect(parseSesNotification(body)).toMatchObject({
      kind: 'event',
      snsMessageId: 'sns-1',
      event: 'Bounce',
      sesMessageId: 'ses-0001',
      tags: { outbound: ['o-1'] },
      bounce: { type: 'Permanent', subType: 'General', recipients: ['Buyer@Example.com'] },
    })
    expect(parseSesNotification(JSON.stringify({ Type: 'SubscriptionConfirmation', MessageId: 'sns-2' }))).toEqual({ kind: 'subscription', snsType: 'SubscriptionConfirmation', snsMessageId: 'sns-2' })
    expect(parseSesNotification('not json')).toBeNull()
    expect(parseSesNotification(JSON.stringify({ Type: 'Notification', MessageId: 'x', Message: 'not json' }))).toBeNull()
  })

  it('verifies the basic-auth secret in constant time and the SNS type, keyed by the SNS message id', async () => {
    expect(await verify({ authorization: basic(secret), 'x-amz-sns-message-type': 'Notification' })).toEqual({ ok: true, dedupeKey: 'sns-1', eventType: 'Bounce', externalId: 'ses-0001' })
    expect(await verify({ authorization: basic('wrong'), 'x-amz-sns-message-type': 'Notification' })).toEqual({ ok: false, reason: 'signature_mismatch' })
    expect(await verify({ 'x-amz-sns-message-type': 'Notification' })).toEqual({ ok: false, reason: 'missing_signature' })
    expect(await verify({ authorization: basic(secret), 'x-amz-sns-message-type': 'SubscriptionConfirmation' })).toEqual({ ok: false, reason: 'sns_type_mismatch' })
    expect(await verify({ authorization: basic(secret), 'x-amz-sns-message-type': 'Notification' }, '{"nope":1}')).toEqual({ ok: false, reason: 'not_an_sns_message' })
    expect(await verify({ authorization: basic(secret) }, body, null)).toEqual({ ok: false, reason: 'no_webhook_secret' })
  })
})
