import { Readable } from 'node:stream'
import { SESv2Client, type SESv2ClientConfig } from '@aws-sdk/client-sesv2'

/**
 * Test support for the SES adapter and its notifications (imported by tests only):
 *   - FakeSesTransport: the real SESv2 client, with a request handler that answers from a script instead of opening a
 *     socket. Every request the SDK would send is recorded, so a test proves what reached "SES" (and that nothing else
 *     did): no network.
 *   - sesNotificationBody: an SNS envelope around an SES event, as SNS posts it to the inbound route.
 */

export interface RecordedSesRequest {
  readonly method: string
  readonly hostname: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface ScriptedAnswer {
  readonly status: number
  readonly body: unknown
  /** SES's error type (`MessageRejected`, `AlreadyExistsException`) for an error answer. */
  readonly errorType?: string
}

export class FakeSesTransport {
  readonly requests: RecordedSesRequest[] = []
  readonly configs: SESv2ClientConfig[] = []
  /** Answers by `<METHOD> <path prefix>`; the first matching entry wins. */
  readonly script: Array<{ readonly match: string; readonly answer: ScriptedAnswer }> = []

  answer(match: string, answer: ScriptedAnswer): this {
    this.script.unshift({ match, answer })
    return this
  }

  /** The adapter's `clientFor`: a real SESv2Client whose transport is this fake. */
  readonly clientFor = (config: SESv2ClientConfig): SESv2Client => {
    this.configs.push(config)
    return new SESv2Client({ ...config, requestHandler: { handle: (request: Parameters<FakeSesTransport['handle']>[0]) => this.handle(request) } as never })
  }

  async handle(request: { method: string; hostname: string; path: string; headers: Record<string, string>; body?: unknown }) {
    const body = request.body === undefined ? '' : typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString('utf8')
    this.requests.push({ method: request.method, hostname: request.hostname, path: decodeURIComponent(request.path), headers: { ...request.headers }, body })
    const key = `${request.method} ${decodeURIComponent(request.path)}`
    const answer = this.script.find((entry) => key.startsWith(entry.match))?.answer ?? { status: 404, body: { message: 'not scripted' }, errorType: 'NotFoundException' }
    return {
      response: {
        statusCode: answer.status,
        headers: { 'content-type': 'application/json', ...(answer.errorType ? { 'x-amzn-errortype': answer.errorType } : {}) },
        body: Readable.from([Buffer.from(JSON.stringify(answer.body))]),
      },
    }
  }
}

/** An SNS Notification carrying one SES event (event publishing's JSON), as the body SNS posts. */
export function sesNotificationBody(input: {
  readonly snsMessageId: string
  readonly eventType: 'Delivery' | 'Bounce' | 'Complaint' | 'Send'
  readonly sesMessageId: string
  readonly outboundId?: string
  readonly at?: Date
  readonly bounce?: { readonly type: 'Permanent' | 'Transient' | 'Undetermined'; readonly subType?: string; readonly recipients: readonly string[] }
  readonly complaint?: { readonly recipients: readonly string[]; readonly feedbackType?: string }
  readonly delivered?: readonly string[]
}): string {
  const timestamp = (input.at ?? new Date('2026-10-28T09:05:00Z')).toISOString()
  const event: Record<string, unknown> = {
    eventType: input.eventType,
    mail: { messageId: input.sesMessageId, timestamp, tags: input.outboundId ? { outbound: [input.outboundId] } : {} },
  }
  if (input.bounce) {
    event.bounce = {
      bounceType: input.bounce.type,
      bounceSubType: input.bounce.subType ?? 'General',
      bouncedRecipients: input.bounce.recipients.map((emailAddress) => ({ emailAddress, action: 'failed', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' })),
      timestamp,
    }
  }
  if (input.complaint) {
    event.complaint = { complainedRecipients: input.complaint.recipients.map((emailAddress) => ({ emailAddress })), complaintFeedbackType: input.complaint.feedbackType ?? 'abuse', timestamp }
  }
  if (input.delivered) event.delivery = { recipients: [...input.delivered], timestamp, processingTimeMillis: 500, smtpResponse: '250 ok' }
  return JSON.stringify({
    Type: 'Notification',
    MessageId: input.snsMessageId,
    TopicArn: 'arn:aws:sns:eu-south-1:000000000000:factory-ses-events',
    Message: JSON.stringify(event),
    Timestamp: timestamp,
    SignatureVersion: '2',
  })
}
