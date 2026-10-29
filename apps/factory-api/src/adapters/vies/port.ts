import type { ViesAnswer, ViesRequest } from '@nexus/factory-domain/ports/vies'
import { isViesFaultCode, VIES_FAULTS } from '@nexus/factory-domain/ports/vies'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'

/**
 * The VIES adapters' shape (plan A1 §4; the port's types: @nexus/factory-domain/ports/vies). Each check runs INSIDE one
 * gateway call (modules/parties/vies.ts): the adapter gets the call (its account, attempt, abort signal) and answers
 * VALID or INVALID, or throws a ViesFault with VIES's fault code, which the gateway retries when it may pass later.
 *
 *   ./soap.ts   LIVE and SANDBOX accounts: the European Commission's SOAP service checkVatApprox (the test service for
 *               SANDBOX)
 *   ./fake.ts   FAKE accounts (local and test only; the gateway refuses FAKE in production): deterministic by number
 */
export interface ViesAdapter {
  check(call: GatewayCall, request: ViesRequest): Promise<ViesAnswer>
}

/** VIES answered with a fault instead of a result (its documented codes; anything else is kept as given). */
export class ViesFault extends ProviderError {
  override name = 'ViesFault'
  readonly code: string
  readonly responseSha256: string | null
  constructor(code: string, options: { readonly httpStatus?: number; readonly responseSha256?: string | null } = {}) {
    const known = isViesFaultCode(code) ? VIES_FAULTS[code] : null
    super(`VIES answered ${code}${known ? `: ${known.meaning}` : ''}`, {
      ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
      retryable: known?.retryable ?? (options.httpStatus === undefined || options.httpStatus >= 500),
    })
    this.code = code
    this.responseSha256 = options.responseSha256 ?? null
  }
}
