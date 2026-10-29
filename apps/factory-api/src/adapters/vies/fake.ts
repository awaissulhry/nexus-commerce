import { createHash, randomUUID } from 'node:crypto'
import type { ViesAnswer, ViesRequest } from '@nexus/factory-domain/ports/vies'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { ViesFault, type ViesAdapter } from './port'

/**
 * The FAKE VIES (plan A1 §4 "Fake behaviour"; local and test only: modules/parties/vies.ts makes none in staging or
 * production, where the gateway refuses FAKE accounts anyway). Nothing leaves the process. It answers by the LAST
 * character of the number (without the member-state code), so a test or a demo picks the answer by the number it types:
 *
 *   …8          INVALID
 *   …9          no answer: the fault MS_UNAVAILABLE (retryable; the check is recorded as ERROR, the party HELD)
 *   anything    VALID, with a fresh consultation number when the check names a requester (an identified check), the
 *   else        trader's name and address made up from the number
 *
 * Tests read the requests (`requests`) and script a fault for the next checks (`failNext`).
 */

export const FAKE_VIES_RULE = Object.freeze({ invalidEnding: '8', unavailableEnding: '9' })

export class FakeVies implements ViesAdapter {
  readonly requests: ViesRequest[] = []
  private readonly faults: string[] = []

  /** The next `count` checks answer this VIES fault code. */
  failNext(count: number, code = 'MS_UNAVAILABLE'): void {
    for (let index = 0; index < count; index++) this.faults.push(code)
  }

  async check(call: GatewayCall, request: ViesRequest): Promise<ViesAnswer> {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE account uses the fake VIES.', { retryable: false })
    this.requests.push(Object.freeze({ ...request }))
    const body = JSON.stringify({ fake: true, countryCode: request.countryCode, vatNumber: request.vatNumber, attempt: call.attempt, at: Date.now() })
    const responseSha256 = createHash('sha256').update(body).digest('hex')
    const scripted = this.faults.shift()
    const ending = request.vatNumber.slice(-1)
    if (scripted !== undefined || ending === FAKE_VIES_RULE.unavailableEnding) {
      call.answer({ httpStatus: 500, response: { fault: scripted ?? 'MS_UNAVAILABLE' } })
      throw new ViesFault(scripted ?? 'MS_UNAVAILABLE', { httpStatus: 500, responseSha256 })
    }
    const valid = ending !== FAKE_VIES_RULE.invalidEnding
    const consultationNumber = valid && request.requester !== null ? `FAKE${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}` : null
    call.answer({ httpStatus: 200, response: { valid, identified: consultationNumber !== null } })
    return {
      result: valid ? 'VALID' : 'INVALID',
      requestDate: new Date().toISOString().slice(0, 10),
      consultationNumber,
      traderName: valid ? `FAKE TRADER ${request.countryCode}${request.vatNumber}` : null,
      traderAddress: valid ? 'FAKE STREET 1, 00000 FAKE TOWN' : null,
      responseSha256,
    }
  }
}
