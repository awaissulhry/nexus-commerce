/**
 * Meta step 26 (2026-10-21), moved here by gap 46b (2026-10-26) — ONE check of a creator's content for a partnership ad:
 * create-meta-boost asks it for a creator's media, post or ad code (change-boosts.ts), and create-meta-creative for a
 * partner's post or media as an Advantage+ catalog ad's intro card (change-creatives.ts, master CR-331). Moved from
 * change-boosts.ts unchanged (one check, never a copy), into its own small module so neither change module imports the
 * other. It reads only through step 16's look-up (live-partners.ts livePartnership: Meta's content discovery API) and
 * step 10's taken ids.
 */
import { livePartnership, type Row } from './live-partners.js'
import { MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { takenIds } from './taken.js'

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const isRow = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
/** Review round 2 (step 26) — a Meta id as text, never with a leading 0 (`0<id>` is the same id to Meta and would slip past a compare). */
const creatorIdText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^[1-9]\d{0,24}$/.test(String(v)) ? String(v) : null)

/** One creator content row as Meta's content discovery answers it (step 16's look-up, masked when another business's). */
export interface CreatorRow { contentId: string | null; platform: string | null; mediaType: string | null; author: { pageId: string | null; instagramId: string | null } | null; eligibility: Array<{ adEligibility: string | null; permissionStatus: string | null; errors: string[]; partner: { pageId: string | null; instagramId: string | null } | null }> }

/**
 * A creator's content Meta's content discovery lists for the brand (step 16's look-up: content_ids or ad_codes, the chosen
 * Page and Instagram account): never the business's own, never another Nexus business's, of the platform asked; its
 * eligibility (ad_eligibility, eligibility_errors) said or refused before any write. The ad code goes to Meta in the
 * look-up's query only (the ledger keeps a path) and is never put in a sentence. Gap 46b — `use`: the words of a
 * refusal for the tool that asks (a boost, or create-meta-creative's intro card); the check is the same.
 */
export async function creatorContent(chosen: MetaChosenAccount, by: { contentId: string } | { adCode: string }, platform: 'INSTAGRAM' | 'FACEBOOK', use: 'boost' | 'intro' = 'boost'): Promise<{ row: CreatorRow; warnings: string[] }> {
  const usesIt = use === 'boost' ? 'boosts it' : 'shows it'
  const what = 'adCode' in by ? 'the creator\'s ad code' : `content ${by.contentId}`
  const answer = await livePartnership({ connectionId: chosen.connectionId, view: 'lookup', ...('adCode' in by ? { adCodes: [by.adCode] } : { contentIds: [by.contentId] }) }) as unknown as { items?: Array<Row> }
  const items = Array.isArray(answer.items) ? answer.items : []
  const match = 'adCode' in by
    ? (items.length === 1 ? items[0] : null)
    : items.find((r) => r.contentId === by.contentId || (by.contentId.includes('_') && r.contentId === by.contentId.split('_')[1])) ?? null
  if (!match) throw new MetaLiveRefusal(`Meta's content discovery does not list ${what} as content the chosen Page or Instagram account may advertise${'adCode' in by && items.length > 1 ? ' (it answered more than one)' : ''}: nothing was asked of Meta. meta-partnership-content view search shows what it lists.`)
  if (match.takenByAnotherBusiness === true) throw new MetaLiveRefusal(`${what === 'the creator\'s ad code' ? 'That content' : what} is by a Page or Instagram account another business in Nexus uses: no creative of this business ${usesIt}.`)
  const author = isRow(match.author) ? { pageId: creatorIdText(match.author.pageId), instagramId: creatorIdText(match.author.instagramId) } : null
  const row: CreatorRow = {
    contentId: text(match.contentId), platform: text(match.platform), mediaType: text(match.mediaType), author,
    eligibility: (Array.isArray(match.partnerships) ? match.partnerships : []).filter(isRow).map((p) => ({
      adEligibility: text(p.adEligibility), permissionStatus: text(p.permissionStatus),
      errors: (Array.isArray(p.eligibilityErrors) ? p.eligibilityErrors : []).filter(isRow).map((e) => text(e.message) ?? text(e.code) ?? '').filter(Boolean),
      partner: isRow(p.taggedPartner) ? { pageId: creatorIdText(p.taggedPartner.pageId), instagramId: creatorIdText(p.taggedPartner.instagramId) } : null,
    })),
  }
  if (row.platform && row.platform !== platform) throw new MetaLiveRefusal(`${what === 'the creator\'s ad code' ? 'That ad code' : what} is ${row.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} content: ask with the ${row.platform === 'INSTAGRAM' ? 'creator-instagram' : 'creator-facebook'} source.`)
  const pages = [author?.pageId, 'contentId' in by && by.contentId.includes('_') ? by.contentId.split('_')[0] : null].filter((v): v is string => !!v)
  const igs = [author?.instagramId].filter((v): v is string => !!v)
  if (!pages.length && !igs.length) throw new MetaLiveRefusal(`Meta's content discovery names no author for ${what}, so Nexus cannot confirm whose it is: nothing was asked of Meta.`)
  if ((chosen.pageId && pages.includes(chosen.pageId)) || (chosen.instagramId && igs.includes(chosen.instagramId))) {
    throw new MetaLiveRefusal(use === 'boost'
      ? `${what === 'the creator\'s ad code' ? 'That content' : what} is the business's own: boost it with source facebook-post or instagram-media (a partnership boost is a creator's content).`
      : `${what} is the business's own: name it as introPost source facebook-post or instagram-media (a creator-… source is the partner's content).`)
  }
  const [takenPages, takenIgs] = await Promise.all([takenIds('PAGE', pages), takenIds('INSTAGRAM', igs)])
  if (takenPages.size || takenIgs.size) throw new MetaLiveRefusal(`That content is by a Page or Instagram account another business in Nexus uses: no creative of this business ${usesIt}.`)
  // The eligibility Meta gives for the brand (its entry, else the first).
  const mine = row.eligibility.find((e) => (chosen.pageId && e.partner?.pageId === chosen.pageId) || (chosen.instagramId && e.partner?.instagramId === chosen.instagramId)) ?? row.eligibility[0] ?? null
  const warnings: string[] = []
  if (!mine?.adEligibility) warnings.push('Meta\'s content discovery gave no ad eligibility for it: Meta\'s check (validate_only) answers before anything is made.')
  else if (mine.adEligibility === 'INELIGIBLE' || mine.adEligibility === 'EXCLUDED') {
    throw new MetaLiveRefusal(`Meta says it cannot be used in an ad (${mine.adEligibility}${mine.errors.length ? `: ${mine.errors.slice(0, 3).join('; ')}` : ''}) — copyrighted music, an unsupported format or a missing permission. Nothing was asked of Meta.`)
  } else if (mine.adEligibility === 'NEEDS_ATTENTION') warnings.push(`Meta says it needs attention before it can run${mine.errors.length ? `: ${mine.errors.slice(0, 3).join('; ')}` : ''}.`)
  if (mine?.permissionStatus && !/APPROVED|GRANTED|ACTIVE/i.test(mine.permissionStatus)) warnings.push(`The creator's permission reads ${mine.permissionStatus}: Meta keeps the ad "pending delivery" until the creator allows it (account-level permission: set-meta-partnership-access action request; or the creator's ad code).`)
  return { row, warnings }
}
