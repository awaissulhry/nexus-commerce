/**
 * Meta ads step 31 — whose are the ids an audience change names INSIDE its body: the Page, Instagram account, lead
 * forms, Instant Experiences and videos an audience is built from, and the ad accounts it is shared with. ONE place, used
 * by the tools' previews (to refuse in words) and by the gateway before anything is sent (gateway.ts metaBodyIdsProblem):
 *   page        the Facebook Page this business chose (its MetaAccountLink PAGE; a Page belongs to one business);
 *   instagram   the Instagram account this business chose;
 *   leadform    one of the chosen Page's lead forms (live-engagement.ts ownForm);
 *   canvas      an Instant Experience the chosen Page owns (live-media.ts ownedByPage);
 *   video       a video of the chosen Page or of the chosen ad account's library (live-media.ts ownVideo);
 *   adaccount   an ad account a share goes to: never the chosen account itself, never one another business in Nexus
 *               chose, never one of a business portfolio another business in Nexus uses (its `business` read live;
 *               unreadable: refused) — nexus_meta_links_taken: an audience is never shared across Nexus businesses.
 *               An UNSHARE names no recipient to check: taking access away is how such a share ends.
 * Anything Nexus cannot confirm is refused (fail closed); the sentence never names another business.
 */
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { MetaReadError } from './errors.js'
import { ownForm } from './live-engagement.js'
import { ownedByPage, ownVideo } from './live-media.js'
import { takenIds } from './taken.js'
import { metaReadOne } from './read-client.js'

export type AudienceIdKind = 'page' | 'instagram' | 'leadform' | 'canvas' | 'video' | 'adaccount'

const WORD: Readonly<Record<AudienceIdKind, string>> = {
  page: 'Facebook Page', instagram: 'Instagram account', leadform: 'lead form', canvas: 'Instant Experience', video: 'video', adaccount: 'ad account',
}

/** Why this id may not be named in an audience change of the chosen account, or null. Throws nothing. */
export async function audienceIdProblem(account: MetaChosenAccount, inner: { id: string; kind: AudienceIdKind }): Promise<string | null> {
  const { id, kind } = inner
  if (!/^\d{1,20}$/.test(id)) return `${WORD[kind]} ${id.slice(0, 40)} is not a Meta id (digits).`
  try {
    switch (kind) {
      case 'page':
        return account.pageId === id ? null : `${WORD.page} ${id} is not the Facebook Page this business chose (meta-ad-accounts / Settings › Channels › Meta).`
      case 'instagram':
        return account.instagramId === id ? null : `${WORD.instagram} ${id} is not the Instagram account this business chose.`
      case 'leadform':
        await ownForm(account, id)
        return null
      case 'canvas':
        await ownedByPage(account, id, 'Instant Experience', 'audiences.canvasOwnerCheck')
        return null
      case 'video':
        await ownVideo(account, id)
        return null
      case 'adaccount': {
        if (id === account.adAccountId) return 'an audience is never shared with its own ad account.'
        const taken = await takenIds('AD_ACCOUNT', [id])
        if (taken.has(id)) return `ad account ${id} is one another business in Nexus uses: an audience is never shared across Nexus businesses.`
        // Review A1 — and never into a business portfolio another business in Nexus uses (two businesses can share one
        // portfolio, step 10): the recipient's portfolio is read, and a share that cannot be placed is refused.
        const body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'audiences.recipientPortfolio', path: `act_${id}`, query: { fields: 'business{id}' } })).body as { business?: { id?: unknown } | null }
        const portfolio = body.business && (typeof body.business.id === 'string' || typeof body.business.id === 'number') ? String(body.business.id) : null
        if (!portfolio) return `ad account ${id} names no business portfolio Nexus can read, so Nexus cannot confirm no other business in Nexus uses it: nothing is shared.`
        return (await takenIds('PORTFOLIO', [portfolio])).has(portfolio)
          ? `ad account ${id} belongs to a business portfolio another business in Nexus uses: an audience is never shared across Nexus businesses.`
          : null
      }
    }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return err.message
    if (err instanceof MetaReadError) return `Nexus could not confirm ${WORD[kind]} ${id} is this business's (${err.failure.sentence}).`
    return `Nexus could not confirm ${WORD[kind]} ${id} is this business's (${err instanceof Error ? err.message : String(err)}).`
  }
}

/** The gateway's door (gateway.ts metaBodyIdsProblem): the chosen account of this connection, then audienceIdProblem. */
export async function metaAudienceIdProblem(connectionId: string, inner: { id: string; kind: AudienceIdKind }): Promise<string | null> {
  let account: MetaChosenAccount
  try {
    account = await metaChosenAccount(connectionId)
  } catch (err) {
    return err instanceof MetaLiveRefusal ? err.message : `Nexus could not read this business's Meta connection (${err instanceof Error ? err.message : String(err)}).`
  }
  return audienceIdProblem(account, inner)
}
