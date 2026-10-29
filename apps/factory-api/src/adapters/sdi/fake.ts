import { randomInt, randomUUID } from 'node:crypto'
import type { Clock } from '@nexus/factory-domain/ports/clock'
import { sdiMessageSchema, type SdiArchiveReceipt, type SdiArchiveRequest, type SdiMessage, type SdiNotificationType, type SdiSendReceipt, type SdiSendRequest, type SdiStatusAnswer, type SdiStatusRequest } from '@nexus/factory-domain/ports/sdi'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import type { SdiAdapter } from './port'
import { fatturaPaSchemaValidator, type XmlValidator } from './xsd'

/**
 * The FAKE SDI intermediary (plan A1 §4 "SdiPort … Fake behaviour"; FIN-096 test mode; local and test only:
 * modules/invoicing/sdi/runtime.ts makes none in staging or production, where the gateway refuses FAKE accounts anyway).
 * Nothing leaves the process; what it holds is kept in memory.
 *
 *   send      checks the account is FAKE and the XML against the FatturaPA schema (invalid: refused with a 422, as an
 *             intermediary refuses a file before SDI), keeps the file (one per idempotency key: a retry gets the same
 *             receipt) and schedules SDI's answer `answerAfterMs` later: RC by default
 *   status    what it holds about a file (by the provider's id, else the key, else the file name): unknown, or known with
 *             the notifications whose time has come — the status poll's view, which also catches a lost webhook
 *   archive   puts a delivered or not-deliverable file in "legal archiving" and records it (`archives`)
 *   webhooks  `takeWebhooks()` hands the deliveries due (body + a stable event id) to whoever posts them to the inbound
 *             route signed with the fake signature (tests, a local helper); `webhookMessages` reads such a body back
 *
 * Scripting (tests and demos), first match wins:
 *   1. `scriptNext(plan)`: the next new files take these plans, in order;
 *   2. a marker in the XML (e.g. in the invoice's causale): `[sdi-fake:ns]`, `[sdi-fake:ns:00305]`, `[sdi-fake:mc]`,
 *      `[sdi-fake:send_error]`, `[sdi-fake:refuse]`, `[sdi-fake:timeout]`;
 *   3. RC.
 * Plans: RC, MC, NS (an error code, default 00423 with SDI's sample description), SEND_ERROR (a 503 on the first
 * `attempts` attempts, default every one: the gateway retries, then gives up), REFUSE (a 422: final), TIMEOUT (the file
 * is kept, then no answer ever comes: the gateway times out; the status poll later finds the file and its RC).
 */

export type FakeSdiPlan =
  | { readonly kind: 'RC' }
  | { readonly kind: 'MC' }
  | { readonly kind: 'NS'; readonly code?: string }
  | { readonly kind: 'SEND_ERROR'; readonly httpStatus?: number; readonly attempts?: number }
  | { readonly kind: 'REFUSE'; readonly httpStatus?: number }
  | { readonly kind: 'TIMEOUT' }

/** SDI's sample descriptions of the codes the fake uses (Elenco controlli). */
const SAMPLE_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  '00305': '1.4.1.1.2 <IdCodice> non valido',
  '00311': '1.1.4 <CodiceDestinatario> non valido',
  '00404': 'Fattura duplicata',
  '00423': '2.2.1.11 <PrezzoTotale> non calcolato secondo le regole definite nelle specifiche tecniche',
})

interface FakeFile {
  readonly providerRef: string
  readonly fileName: string
  readonly idempotencyKey: string
  readonly tenantId: string
  readonly accountId: string
  readonly acceptedAt: Date
  readonly sdiIdentifier: string
  readonly plan: FakeSdiPlan
  readonly messages: SdiMessage[]
  readonly delivered: Set<string>
  archive: SdiArchiveReceipt | null
}

export interface FakeWebhook {
  /** The delivery's id (the fake signature's event id): one per message, so a replay is the same delivery. */
  readonly eventId: string
  readonly tenantId: string
  readonly accountId: string
  readonly body: string
}

export interface FakeSdiOptions {
  readonly clock?: Clock
  /** How long after the send SDI's answer is ready. Default 30 s. */
  readonly answerAfterMs?: number
  /** The schema check. Default the official FatturaPA schema (xsd.ts). */
  readonly validate?: XmlValidator
}

const MARKER = /\[sdi-fake:(rc|mc|ns|send_error|refuse|timeout)(?::(\d{5}))?\]/i

function planOfMarker(xml: string): FakeSdiPlan | null {
  const match = MARKER.exec(xml)
  if (!match) return null
  switch (match[1]!.toLowerCase()) {
    case 'mc':
      return { kind: 'MC' }
    case 'ns':
      return match[2] ? { kind: 'NS', code: match[2] } : { kind: 'NS' }
    case 'send_error':
      return { kind: 'SEND_ERROR' }
    case 'refuse':
      return { kind: 'REFUSE' }
    case 'timeout':
      return { kind: 'TIMEOUT' }
    default:
      return { kind: 'RC' }
  }
}

const never = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })

export class FakeSdi implements SdiAdapter {
  readonly files: FakeFile[] = []
  /** Every send attempt the fake saw (its idempotency key, file name and attempt), for the tests. */
  readonly attempts: { readonly idempotencyKey: string; readonly fileName: string; readonly attempt: number }[] = []
  readonly archives: { readonly providerRef: string; readonly fileName: string; readonly archiveRef: string }[] = []
  private readonly scripted: FakeSdiPlan[] = []
  private readonly plans = new Map<string, FakeSdiPlan>()
  private readonly clock: Clock
  private readonly answerAfterMs: number
  private readonly validate: XmlValidator
  private sequence = 0

  constructor(options: FakeSdiOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date() }
    this.answerAfterMs = options.answerAfterMs ?? 30_000
    this.validate = options.validate ?? fatturaPaSchemaValidator()
  }

  /** The next new files take these plans, in order. */
  scriptNext(...plans: FakeSdiPlan[]): void {
    this.scripted.push(...plans)
  }

  /** A file the fake holds, by the provider's id, the idempotency key or the file name. */
  file(ref: { readonly providerRef?: string | null; readonly idempotencyKey?: string; readonly fileName?: string }): FakeFile | undefined {
    return (
      (ref.providerRef ? this.files.find((file) => file.providerRef === ref.providerRef) : undefined) ??
      (ref.idempotencyKey ? this.files.find((file) => file.idempotencyKey === ref.idempotencyKey) : undefined) ??
      (ref.fileName ? this.files.find((file) => file.fileName === ref.fileName) : undefined)
    )
  }

  /** SDI says something more about a file (a late or contradicting notification), `afterMs` after now. */
  addMessage(providerRef: string, type: SdiNotificationType, options: { readonly afterMs?: number; readonly code?: string } = {}): SdiMessage {
    const file = this.file({ providerRef })
    if (!file) throw new Error(`the fake SDI has no file ${providerRef}`)
    const message = this.message(file, type, new Date(this.clock.now().getTime() + (options.afterMs ?? 0)), options.code)
    file.messages.push(message)
    return message
  }

  private message(file: FakeFile, type: SdiNotificationType, issuedAt: Date, code?: string): SdiMessage {
    this.sequence++
    const errors = type === 'NS' ? [{ code: code ?? '00423', description: SAMPLE_ERRORS[code ?? '00423'] ?? 'Errore di esempio del SDI finto', hint: null }] : []
    return sdiMessageSchema.parse({
      type,
      messageId: `FAKE-MSG-${String(this.sequence).padStart(6, '0')}-${randomUUID().slice(0, 8)}`,
      sdiIdentifier: file.sdiIdentifier,
      providerRef: file.providerRef,
      fileName: file.fileName,
      issuedAt: issuedAt.toISOString(),
      errors,
      outcome: type === 'NE' ? 'EC01' : null,
      note: null,
    }) as SdiMessage
  }

  async send(call: GatewayCall, request: SdiSendRequest): Promise<SdiSendReceipt> {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE account uses the fake SDI.', { retryable: false })
    this.attempts.push({ idempotencyKey: request.idempotencyKey, fileName: request.fileName, attempt: call.attempt })
    const kept = this.file({ idempotencyKey: request.idempotencyKey })
    if (kept) {
      if (kept.plan.kind === 'TIMEOUT') return never(call.signal)
      call.answer({ httpStatus: 200, response: { providerRef: kept.providerRef, repeated: true } })
      return { providerRef: kept.providerRef, acceptedAt: kept.acceptedAt.toISOString(), providerFileName: null }
    }
    let plan = this.plans.get(request.idempotencyKey)
    if (!plan) {
      plan = this.scripted.shift() ?? planOfMarker(request.xml) ?? { kind: 'RC' }
      this.plans.set(request.idempotencyKey, plan)
    }
    if (plan.kind === 'SEND_ERROR') {
      const tries = this.attempts.filter((attempt) => attempt.idempotencyKey === request.idempotencyKey).length
      if (plan.attempts === undefined || tries <= plan.attempts) {
        const httpStatus = plan.httpStatus ?? 503
        call.answer({ httpStatus })
        throw new ProviderError(`The fake SDI intermediary is unavailable (HTTP ${httpStatus}).`, { httpStatus })
      }
    }
    if (plan.kind === 'REFUSE') {
      const httpStatus = plan.httpStatus ?? 422
      call.answer({ httpStatus })
      throw new ProviderError(`The fake SDI intermediary refused the file (HTTP ${httpStatus}).`, { httpStatus, retryable: false })
    }
    const problems = await this.validate(request.xml)
    if (problems.length > 0) {
      call.answer({ httpStatus: 422, response: { problems: problems.length } })
      throw new ProviderError(`The file is not valid FatturaPA (the schema says: ${problems[0]!.slice(0, 200)})`, { httpStatus: 422, retryable: false })
    }
    const acceptedAt = this.clock.now()
    const file: FakeFile = {
      providerRef: `fake-sdi-${randomUUID()}`,
      fileName: request.fileName,
      idempotencyKey: request.idempotencyKey,
      tenantId: call.account.tenantId,
      accountId: call.account.id,
      acceptedAt,
      sdiIdentifier: String(randomInt(100_000_000, 999_999_999)),
      plan,
      messages: [],
      delivered: new Set(),
      archive: null,
    }
    const answerAt = new Date(acceptedAt.getTime() + this.answerAfterMs)
    const outcome: SdiNotificationType = plan.kind === 'MC' ? 'MC' : plan.kind === 'NS' ? 'NS' : 'RC'
    file.messages.push(this.message(file, outcome, answerAt, plan.kind === 'NS' ? plan.code : undefined))
    this.files.push(file)
    if (plan.kind === 'TIMEOUT') return never(call.signal)
    call.answer({ httpStatus: 201, response: { providerRef: file.providerRef } })
    return { providerRef: file.providerRef, acceptedAt: acceptedAt.toISOString(), providerFileName: null }
  }

  private due(file: FakeFile): SdiMessage[] {
    const now = this.clock.now().getTime()
    return file.messages.filter((message) => Date.parse(message.issuedAt) <= now)
  }

  async status(call: GatewayCall, request: SdiStatusRequest): Promise<SdiStatusAnswer> {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE account uses the fake SDI.', { retryable: false })
    const file = this.file({ providerRef: request.providerRef, idempotencyKey: request.idempotencyKey, fileName: request.fileName })
    if (!file || file.tenantId !== call.account.tenantId) {
      call.answer({ httpStatus: 404 })
      return { known: false, providerRef: null, acceptedAt: null, messages: [] }
    }
    const messages = this.due(file)
    call.answer({ httpStatus: 200, response: { known: true, notifications: messages.length } })
    return { known: true, providerRef: file.providerRef, acceptedAt: file.acceptedAt.toISOString(), messages }
  }

  async archive(call: GatewayCall, request: SdiArchiveRequest): Promise<SdiArchiveReceipt> {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE account uses the fake SDI.', { retryable: false })
    const file = this.file({ providerRef: request.providerRef })
    if (!file || file.tenantId !== call.account.tenantId) {
      call.answer({ httpStatus: 404 })
      throw new ProviderError('The fake SDI intermediary has no such file.', { httpStatus: 404, retryable: false })
    }
    if (!this.due(file).some((message) => message.type !== 'NS')) {
      call.answer({ httpStatus: 409 })
      throw new ProviderError('Only a file SDI delivered or left in the tax drawer is archived.', { httpStatus: 409, retryable: false })
    }
    if (!file.archive) {
      file.archive = { archiveRef: `fake-archive-${randomUUID()}`, archivedAt: this.clock.now().toISOString() }
      this.archives.push({ providerRef: file.providerRef, fileName: file.fileName, archiveRef: file.archive.archiveRef })
    }
    call.answer({ httpStatus: 200, response: { archived: true } })
    return file.archive
  }

  /** The webhook deliveries due and not handed out yet (each message once; take them again with `all`). */
  takeWebhooks(options: { readonly all?: boolean } = {}): FakeWebhook[] {
    return this.files.flatMap((file) =>
      this.due(file)
        .filter((message) => options.all || !file.delivered.has(message.messageId!))
        .map((message) => {
          file.delivered.add(message.messageId!)
          return {
            eventId: `fake-sdi-${message.messageId}`,
            tenantId: file.tenantId,
            accountId: file.accountId,
            body: JSON.stringify({ fake: 'sdi', providerRef: file.providerRef, fileName: file.fileName, messages: [message] }),
          }
        }),
    )
  }

  webhookMessages(body: string): SdiMessage[] {
    const parsed = JSON.parse(body) as { fake?: unknown; messages?: unknown }
    if (parsed.fake !== 'sdi' || !Array.isArray(parsed.messages)) throw new Error('Not a fake SDI webhook body.')
    return parsed.messages.map((message) => sdiMessageSchema.parse(message) as SdiMessage)
  }
}
