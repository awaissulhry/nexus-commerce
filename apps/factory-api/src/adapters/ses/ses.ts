import {
  AlreadyExistsException,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
  SESv2Client,
  SESv2ServiceException,
  type DkimAttributes,
  type SESv2ClientConfig,
} from '@aws-sdk/client-sesv2'
import { z } from 'zod'
import { VERIFICATION_STATUSES, type VerificationStatus } from '@nexus/factory-domain/email/rules'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import type { IdentityState, MailAdapter, OutgoingMail, SentMail } from '../../platform/email-out/port'

/**
 * Amazon SES v2 (plan A1 §3.7, §4 "MailPort"; research 03: SES in Milan, by API only — Milan has no SMTP endpoint), the
 * mail provider of an SES account in LIVE or SANDBOX mode. Every operation runs inside a gateway call
 * (platform/email-out/store.ts), which supplies the account's settings and sealed credentials and records the call;
 * nothing here reads the environment.
 *
 *   settings      { region?: "eu-south-1", configurationSet?: "<the set whose events go to SNS>", awsAccountId?: "<12
 *                 digits, to name the identity's ARN>" }
 *   credentials   { accessKeyId, secretAccessKey } of an IAM user limited to SES (A1 §5.4); without them the
 *                 environment's (FACTORY_AWS_…, staging and production only), passed in as `environmentCredentials`
 *
 *   send             SendEmail, Content.Raw (the MIME built by factory-domain email/mime.ts), the recipients as
 *                    Destination (bcc only there), the configuration set, and EmailTags outbound=<id>, template=<key>
 *                    (SES copies the tags into its delivery, bounce and complaint events)
 *   createIdentity   CreateEmailIdentity for the domain (Easy DKIM: SES answers three DKIM tokens); an identity SES has
 *                    already is read with GetEmailIdentity instead
 *   getIdentity      GetEmailIdentity: the domain's verification and DKIM state
 *
 * The client makes one attempt per call (the gateway decides about retries) and gets the gateway's abort signal. Tests
 * give `clientFor` an SESv2Client with a fake request handler (testing.ts): no network.
 */

const settingsSchema = z.object({
  region: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/)
    .default('eu-south-1'),
  configurationSet: z.string().min(1).max(64).optional(),
  awsAccountId: z
    .string()
    .regex(/^\d{12}$/)
    .optional(),
})
const credentialsSchema = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) })
export type SesCredentials = z.infer<typeof credentialsSchema>

export interface SesOptions {
  /** Makes the client for one call (tests: a fake request handler). Default `new SESv2Client(config)`. */
  readonly clientFor?: (config: SESv2ClientConfig) => SESv2Client
  /** The environment's AWS keys (staging, production), for an account without sealed credentials of its own. */
  readonly environmentCredentials?: SesCredentials | undefined
}

/** SES's error answer as the gateway's ProviderError (a 4xx is final, a 5xx or 429 retryable); other errors pass on. */
function asProviderError(error: unknown, operation: string): never {
  if (error instanceof SESv2ServiceException) {
    const httpStatus = error.$metadata?.httpStatusCode
    throw new ProviderError(`SES ${operation}: ${error.name}: ${error.message}`, httpStatus === undefined ? {} : { httpStatus })
  }
  throw error
}

const statusOf = (value: unknown, fallback: VerificationStatus): VerificationStatus =>
  (VERIFICATION_STATUSES as readonly unknown[]).includes(value) ? (value as VerificationStatus) : fallback

export function sesMailAdapter(options: SesOptions = {}): MailAdapter {
  const clientFor = options.clientFor ?? ((config: SESv2ClientConfig) => new SESv2Client(config))

  async function open(call: GatewayCall): Promise<{ client: SESv2Client; settings: z.infer<typeof settingsSchema> }> {
    if (call.account.mode === 'FAKE') throw new ProviderError('A FAKE account uses the fake mailbox, not SES.', { retryable: false })
    const settings = settingsSchema.safeParse(call.account.settings ?? {})
    if (!settings.success) throw new ProviderError('The SES account settings are not valid (region, configurationSet, awsAccountId).', { retryable: false })
    const sealed = await call.credentials()
    const credentials = sealed === null ? options.environmentCredentials : credentialsSchema.safeParse(sealed).data
    if (!credentials) throw new ProviderError('The SES account has no access key.', { retryable: false })
    return { client: clientFor({ region: settings.data.region, credentials, maxAttempts: 1 }), settings: settings.data }
  }

  function identityState(domain: string, settings: z.infer<typeof settingsSchema>, answer: { VerificationStatus?: unknown; VerifiedForSendingStatus?: boolean | undefined; DkimAttributes?: DkimAttributes | undefined }): IdentityState {
    return {
      arn: settings.awsAccountId ? `arn:aws:ses:${settings.region}:${settings.awsAccountId}:identity/${domain}` : null,
      verificationStatus: statusOf(answer.VerificationStatus, answer.VerifiedForSendingStatus ? 'SUCCESS' : 'PENDING'),
      dkimStatus: statusOf(answer.DkimAttributes?.Status, 'NOT_STARTED'),
      dkimTokens: [...(answer.DkimAttributes?.Tokens ?? [])],
    }
  }

  async function read(client: SESv2Client, call: GatewayCall, domain: string, settings: z.infer<typeof settingsSchema>): Promise<IdentityState> {
    try {
      const answer = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }), { abortSignal: call.signal })
      call.answer({ httpStatus: answer.$metadata.httpStatusCode ?? 200, response: { verificationStatus: answer.VerificationStatus, dkimStatus: answer.DkimAttributes?.Status } })
      return identityState(domain, settings, answer)
    } catch (error) {
      return asProviderError(error, 'GetEmailIdentity')
    }
  }

  return {
    async send(call: GatewayCall, mail: OutgoingMail): Promise<SentMail> {
      const { client, settings } = await open(call)
      try {
        const answer = await client.send(
          new SendEmailCommand({
            FromEmailAddress: mail.from,
            Destination: { ToAddresses: [...mail.to], CcAddresses: [...mail.cc], BccAddresses: [...mail.bcc] },
            Content: { Raw: { Data: Buffer.from(mail.raw, 'utf8') } },
            ...(settings.configurationSet ? { ConfigurationSetName: settings.configurationSet } : {}),
            EmailTags: [
              { Name: 'outbound', Value: mail.outboundId },
              { Name: 'template', Value: mail.templateKey.replace(/[^A-Za-z0-9_-]/g, '_') },
            ],
          }),
          { abortSignal: call.signal },
        )
        if (!answer.MessageId) throw new ProviderError('SES SendEmail answered without a message id.', { retryable: false })
        call.answer({ httpStatus: answer.$metadata.httpStatusCode ?? 200, response: { messageId: answer.MessageId } })
        return { sesMessageId: answer.MessageId }
      } catch (error) {
        return asProviderError(error, 'SendEmail')
      }
    },

    async createIdentity(call: GatewayCall, domain: string): Promise<IdentityState> {
      const { client, settings } = await open(call)
      try {
        const answer = await client.send(
          new CreateEmailIdentityCommand({ EmailIdentity: domain, ...(settings.configurationSet ? { ConfigurationSetName: settings.configurationSet } : {}) }),
          { abortSignal: call.signal },
        )
        call.answer({ httpStatus: answer.$metadata.httpStatusCode ?? 200, response: { dkimStatus: answer.DkimAttributes?.Status } })
        return identityState(domain, settings, answer)
      } catch (error) {
        if (error instanceof AlreadyExistsException) return read(client, call, domain, settings)
        return asProviderError(error, 'CreateEmailIdentity')
      }
    },

    async getIdentity(call: GatewayCall, domain: string): Promise<IdentityState> {
      const { client, settings } = await open(call)
      return read(client, call, domain, settings)
    },
  }
}
