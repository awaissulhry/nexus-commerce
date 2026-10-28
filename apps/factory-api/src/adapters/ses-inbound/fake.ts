import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import type { RawMailAdapter, RawMailLocation } from '../../platform/email-in/port'

/**
 * The FAKE receiving bucket (plan A1 §4 "MailPort … an inbound helper posts a sample raw mail"; §5.1: local mail is
 * fake): where an SES account in FAKE mode finds its received mail, local and test only (platform/email-in/service.ts
 * makes none in staging or production, where the gateway refuses FAKE accounts anyway). Nothing leaves the process: the
 * raw mails are kept IN MEMORY, never in a table or a file. Tests put a mail (`put`) before they post SES's
 * notification, and script a failure (`failNext`).
 */
export class FakeMailBucket implements RawMailAdapter {
  readonly objects = new Map<string, Buffer>()
  /** The next read fails with this answer (a provider failure). */
  failNext: { readonly httpStatus: number; readonly message: string } | null = null

  private static keyOf(location: RawMailLocation): string {
    return `${location.bucket}/${location.key}`
  }

  /** Stores a raw mail where SES would have put it. */
  put(location: RawMailLocation, raw: string | Uint8Array): void {
    this.objects.set(FakeMailBucket.keyOf(location), Buffer.from(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw))
  }

  /** Removes it (the bucket's lifecycle). */
  remove(location: RawMailLocation): void {
    this.objects.delete(FakeMailBucket.keyOf(location))
  }

  async fetch(call: GatewayCall, location: RawMailLocation, maxBytes: number): Promise<Buffer | null> {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE account uses the fake receiving bucket.', { retryable: false })
    const failure = this.failNext
    this.failNext = null
    if (failure) {
      call.answer({ httpStatus: failure.httpStatus })
      throw new ProviderError(`S3 GetObject: ${failure.message}`, { httpStatus: failure.httpStatus })
    }
    const object = this.objects.get(FakeMailBucket.keyOf(location))
    if (!object) {
      call.answer({ httpStatus: 404, response: { found: false } })
      return null
    }
    if (object.length > maxBytes) throw new ProviderError(`The raw mail holds ${object.length} bytes; at most ${maxBytes} are read.`, { httpStatus: 413, retryable: false })
    call.answer({ httpStatus: 200, response: { sizeBytes: object.length } })
    return Buffer.from(object)
  }
}
