/**
 * Meta step 33 (lane C3, 2026-10-21) — the ONE rule for the pixel a Conversions API request of THIS business goes to,
 * asked by upload-meta-events before its preview and again by the gateway before it sends anything (gateway.ts
 * metaOwnerProblem, kind `pixel`):
 *   - the business switched "Send sales to Meta" on (events-switch.ts; off by default);
 *   - the pixel is one of the chosen ad account's own (`/act_<id>/adspixels` — Meta keeps pixels on the ad account) AND
 *     Nexus checked, now, that no other business in Nexus uses it (live-audiences.ts pixelVerdict: its owner portfolio,
 *     the ad accounts it is connected to there and in every partner portfolio). One it could not check is refused too.
 * A lookup that fails (Meta's refusal, a lost connection, the database) never lets a request through.
 */
import { MetaLiveRefusal, metaChosenAccount } from './live.js'
import { ownPixelState, TAKEN_PIXEL } from './live-audiences.js'
import { META_EVENTS_OFF, metaEventsSwitch } from './events-switch.js'

/** Why Nexus sends no Conversions API event of this business to this pixel through this connection, in words; null when it may. */
export async function metaEventsPixelProblem(connectionId: string, pixelId: string): Promise<string | null> {
  try {
    if (!(await metaEventsSwitch()).on) return META_EVENTS_OFF
    const account = await metaChosenAccount(connectionId)
    if (account.connectionId !== connectionId) return 'this connection is not the one through which the business chose its Meta ad account.'
    const state = await ownPixelState(account, pixelId, false)
    return state.takenByAnotherBusiness ? TAKEN_PIXEL : null
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return err.message
    return `Nexus could not confirm the pixel (${err instanceof Error ? err.message : String(err)}), so nothing is sent.`
  }
}
