/**
 * Meta step 17 — the ONE Meta ad account a change of THIS business goes to: the ad account the business chose through its
 * own Meta connection (its AD_ACCOUNT MetaAccountLink; live.ts metaChosenAccount). Never an account another business
 * chose; never an account id a caller names (a change names objects; the gateway checks each is of this account).
 */
import { metaChosenAccount, MetaLiveRefusal } from './live.js'
import type { MetaWriteTarget } from './write-client.js'

export interface MetaChangeAccount {
  target: MetaWriteTarget
  /** The Meta connection (channel-connections) the calls go through. */
  accountId: string
  /** The chosen ad account, digits only (the Graph node is act_<id>). */
  adAccountId: string
  name: string | null
  /** ISO 4217 (null when Nexus has not read the account yet); every amount of a change is in it, never converted. */
  currency: string | null
}

/**
 * The business's chosen Meta ad account, or why there is none. `connectionId` picks the connection when given (a
 * business has one Meta connection today). A token Meta's last check found without ads_management is refused here: Meta
 * needs it for any change.
 */
export async function metaChangeAccount(connectionId?: string | null): Promise<MetaChangeAccount | { refusal: string }> {
  try {
    const chosen = await metaChosenAccount(connectionId ?? null)
    const token = chosen.connection.token
    if (token.checkedAt && token.scopes.length && token.missing.some((gap) => gap.scope === 'ads_management')) {
      return { refusal: 'This business\'s Meta system-user token does not carry ads_management, which Meta needs for any change. A person makes a new token with it ticked in Meta Business settings and enters it in Settings › Channels › Meta.' }
    }
    return {
      target: { connectionId: chosen.connectionId, adAccountId: chosen.adAccountId },
      accountId: chosen.connectionId,
      adAccountId: chosen.adAccountId,
      name: chosen.name,
      currency: chosen.currency,
    }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}
