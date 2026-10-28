import { GetObjectCommand, S3Client, S3ServiceException, type S3ClientConfig } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import type { RawMailAdapter, RawMailLocation } from '../../platform/email-in/port'

/**
 * SES receiving's S3 bucket (plan A1 §3.7 "Receiving": an MX record on the reply domain → a receipt rule stores the raw
 * mail in S3 in Milan, 30-day lifecycle), the raw-mail store of an SES account in LIVE or SANDBOX mode. Every read runs
 * inside a gateway call (platform/email-in/store.ts), which supplies the account's settings and sealed credentials and
 * records the call; nothing here reads the environment.
 *
 *   settings      { region?: "eu-south-1", inboundBucket: "<the receipt rule's bucket>" } — the SES account's own
 *                 settings (email out ignores inboundBucket)
 *   credentials   { accessKeyId, secretAccessKey } of the IAM user limited to SES, S3 and KMS (A1 §5.4); without them
 *                 the environment's (FACTORY_AWS_…, staging and production only), passed in as `environmentCredentials`
 *
 *   fetch         GetObject of the mail SES's notification named, from the account's inbound bucket ONLY (a notification
 *                 naming another bucket is refused before anything is sent); 404 → null; a body larger than the reader
 *                 allows is refused from its length before it is read (not retryable)
 *
 * The client makes one attempt per call (the gateway retries) and gets the gateway's abort signal. Tests give
 * `clientFor` an S3Client with a fake request handler (testing.ts): no network.
 */

const settingsSchema = z.object({
  region: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/)
    .default('eu-south-1'),
  inboundBucket: z.string().min(3).max(63),
})
const credentialsSchema = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) })
export type S3Credentials = z.infer<typeof credentialsSchema>

export interface InboundS3Options {
  /** Makes the client for one call (tests: a fake request handler). Default `new S3Client(config)`. */
  readonly clientFor?: (config: S3ClientConfig) => S3Client
  /** The environment's AWS keys (staging, production), for an account without sealed credentials of its own. */
  readonly environmentCredentials?: S3Credentials | undefined
}

export function inboundS3Store(options: InboundS3Options = {}): RawMailAdapter {
  const clientFor = options.clientFor ?? ((config: S3ClientConfig) => new S3Client(config))

  return {
    async fetch(call: GatewayCall, location: RawMailLocation, maxBytes: number): Promise<Buffer | null> {
      if (call.account.mode === 'FAKE') throw new ProviderError('A FAKE account uses the fake receiving bucket, not S3.', { retryable: false })
      const settings = settingsSchema.safeParse(call.account.settings ?? {})
      if (!settings.success) throw new ProviderError('The SES account settings need the receiving bucket (inboundBucket) and a valid region.', { retryable: false })
      if (location.bucket !== settings.data.inboundBucket) throw new ProviderError('The notification names another bucket than the account receives into.', { retryable: false })
      const sealed = await call.credentials()
      const credentials = sealed === null ? options.environmentCredentials : credentialsSchema.safeParse(sealed).data
      if (!credentials) throw new ProviderError('The SES account has no access key.', { retryable: false })
      const client = clientFor({
        region: settings.data.region,
        credentials,
        maxAttempts: 1,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      })
      let found
      try {
        found = await client.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }), { abortSignal: call.signal })
      } catch (error) {
        if (error instanceof S3ServiceException) {
          const httpStatus = error.$metadata?.httpStatusCode
          if (httpStatus === 404 || error.name === 'NoSuchKey') {
            call.answer({ httpStatus: 404, response: { found: false } })
            return null
          }
          throw new ProviderError(`S3 GetObject: ${error.name}`, httpStatus === undefined ? {} : { httpStatus })
        }
        throw error
      }
      const length = found.ContentLength ?? 0
      if (length > maxBytes) {
        found.Body?.transformToWebStream().cancel().catch(() => {})
        throw new ProviderError(`The raw mail holds ${length} bytes; at most ${maxBytes} are read.`, { httpStatus: 413, retryable: false })
      }
      const body = Buffer.from((await found.Body?.transformToByteArray()) ?? new Uint8Array())
      if (body.length > maxBytes) throw new ProviderError(`The raw mail holds more than ${maxBytes} bytes.`, { httpStatus: 413, retryable: false })
      call.answer({ httpStatus: 200, response: { sizeBytes: body.length } })
      return body
    },
  }
}
