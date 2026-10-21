/**
 * Meta step 26 (2026-10-21) — the write allow-list entries of create-meta-boost and set-meta-partnership-access. A boost's
 * creative itself goes through step 25's ONE creative judge (meta-creative-rules.ts: its existing-post sources, sourceAssets);
 * these are the calls beside it:
 *
 *   adaccount.video.partner        POST   /act_<id>/advideos   source_instagram_media_id + partnership_ad_ad_code +
 *                                                                is_partnership_ad=true — a creator's Instagram video copied
 *                                                                into the chosen ad account's video library with the
 *                                                                creator's ad code (MD-138)
 *   iguser.partnership.permission  POST   /<ig id>/branded_content_ad_permissions   creator_instagram_account [+ revoke=true]
 *                                                                (CR-344 ask, CR-346 revoke)
 *   iguser.tagApproval.add         POST   /<ig id>/branded_content_tag_approval     user_ids (CR-354)
 *   iguser.tagApproval.remove      DELETE /<ig id>/branded_content_tag_approval     user_ids (CR-355)
 *   igmedia.adCode.create          POST   /<media id>/partnership_ad_code           no parameter (CR-363)
 *   igmedia.adCode.remove          DELETE /<media id>/partnership_ad_code           no parameter (CR-364)
 *   iguser.collab.respond          POST   /<ig id>/collaboration_invites            media_id + accept (MD-132)
 *
 * The object each names is checked by the gateway before anything is sent (gateway.ts metaInstagramOwnerProblem): `<ig id>`
 * IS the business's chosen Instagram account, `<media id>` is a media of it. Every id inside the body: a creator (never the
 * chosen account itself, never an Instagram account another Nexus business chose — `partnerinstagram`), a Collab invite the
 * chosen account has pending (`collabinvite`), a creator's ad code whose content Meta's content discovery lists for the brand,
 * of no other Nexus business, unlocking exactly the media named (`adcode`). Meta documents no validate_only on any of these
 * edges: the change tools say "Meta has no check for this change". An ad code is never quoted in a sentence, and a body that
 * carries one never reaches the ledger (`secret`).
 *
 * The Facebook side (api.facebook.com/partnership-ads/…: account-level permissions, the brand allowlist, the sponsor tag on
 * branded-content posts — master CR-348 … CR-362, OT-014 … OT-031) is NOT here: lane C2 files those writes under the Page's own
 * token, which comes with lane C4's Page-token mode (step 36): C2-PAGE-TOKEN. The REST host stays read-only (meta-calls.ts).
 *
 * Checked 2026-10-21 (curl ≥ 3 s apart, developers.facebook.com/documentation/…; Meta's Python Business SDK main,
 * facebook_business/adobjects):
 *   - ads-commerce/marketing-api/ad-creative/partnership-ads/account-level-permissioning.md: POST
 *     /{business-account-id}/branded_content_ad_permissions with creator_instagram_account (or _username) → {id}; revoke=true;
 *     instagram_branded_content_ads_brand + instagram_basic + business_management; SDK iguser.py
 *     create_branded_content_ad_permission (creator_instagram_account, creator_instagram_username: string; revoke: bool).
 *   - …/partnership-ads/post-level-permissioning.md: POST / DELETE /{user-id}/branded_content_tag_approval user_ids ("A
 *     comma-separated list"; all or nothing: false adds / removes none), a Facebook User token, instagram_branded_content_brand,
 *     Advanced Access; SDK iguser.py (user_ids list<unsigned int>).
 *   - …/partnership-ads/ad-codes.md: POST /{ig-media-id}/partnership_ad_code → {ad_code} ("for media you own"), DELETE → {success};
 *     instagram_basic, instagram_branded_content_creator, business_management; SDK igmedia.py (no parameters).
 *   - instagram-platform/instagram-api-with-facebook-login/collaboration.md: POST /<IG_USER_ID>/collaboration_invites media_id +
 *     accept true | false → {success}; feed image, Reels, carousel (no Stories); 50 calls per Instagram user per 24 h; a User
 *     access token; SDK iguser.py create_collaboration_invite (accept bool, media_id string).
 *   - …/partnership-ads/ads-creation/boost-existing-post.md "Uploading an Instagram video to Facebook": POST
 *     /act_<id>/advideos source_instagram_media_id + partnership_ad_ad_code + is_partnership_ad=true → {id}; SDK adaccount.py
 *     create_ad_video (partnership_ad_ad_code string, is_partnership_ad bool).
 * Meta's pages show a User token for the tag approvals and the Collab invites: Nexus sends the business's system-user token, and
 * Meta's own refusal answers in words (LIVE-PROBES CR-354, MD-132).
 */
import type { MetaWriteAsset, MetaWriteRule } from './meta-calls.js'
import { META_AD_CODE } from './meta-creative-rules.js'

type Params = ReadonlyMap<string, string>

const isDigits = (value: string | undefined) => !!value && /^\d{1,25}$/.test(value)
/** How many creators one tag-approval change names (Meta reads 100 per check; Nexus keeps a change small). */
export const META_TAG_APPROVAL_MAX = 25

/** `user_ids` in Nexus's one spelling: Meta's comma-separated list of 1 to 25 creator ids, each once, no space. */
export function metaUserIdsProblem(value: string): string | null {
  const ids = value.split(',')
  if (!ids.length || ids.length > META_TAG_APPROVAL_MAX || ids.some((id) => !isDigits(id))) return `user_ids is a comma-separated list of 1 to ${META_TAG_APPROVAL_MAX} Instagram account ids (digits, no spaces)`
  return new Set(ids).size === ids.length ? null : 'user_ids names each Instagram account once'
}
const creators = (params: Params): MetaWriteAsset[] => (params.get('user_ids') ?? '').split(',').filter(isDigits).map((id) => ({ id, kind: 'partnerinstagram' as const }))

const ACCOUNT = ['adaccount'] as const
const IG_USER = ['iguser'] as const
const IG_MEDIA = ['igmedia'] as const

/** Step 26 — create-meta-boost's and set-meta-partnership-access's entries of the write allow-list (meta-calls.ts writeRules). */
export const META_BOOST_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // MD-138: a creator's Instagram video into the chosen account's video library with the creator's ad code — the documented
    // fix for "Instagram Video Must Be Uploaded To Facebook". The code must unlock exactly this media (`adcode` with it).
    name: 'adaccount.video.partner', method: 'POST', path: /^act_\d{1,20}\/advideos$/, kinds: ACCOUNT,
    required: ['source_instagram_media_id', 'partnership_ad_ad_code', 'is_partnership_ad'], optional: [], edgeCall: true, budget: false,
    secret: (params) => [params.get('partnership_ad_ad_code') ?? ''],
    values: (params) => {
      if (!isDigits(params.get('source_instagram_media_id'))) return 'source_instagram_media_id is a Meta id (digits only)'
      if (!META_AD_CODE.test(params.get('partnership_ad_ad_code') ?? '')) return 'partnership_ad_ad_code is a partnership ad code as the creator shared it (letters, digits and _ = + / -; Nexus never repeats it)'
      return params.get('is_partnership_ad') === 'true' ? null : 'is_partnership_ad is true'
    },
    assets: (params) => [{ id: params.get('partnership_ad_ad_code')!, kind: 'adcode', with: params.get('source_instagram_media_id')! }],
  },
  {
    // CR-344 / CR-346: ask a creator for account-level partnership permission, or revoke it — by the creator's Instagram id
    // only (Nexus resolves a username first, so the gateway can check the account is no other Nexus business's).
    name: 'iguser.partnership.permission', method: 'POST', path: /^\d{1,25}\/branded_content_ad_permissions$/, kinds: IG_USER,
    required: ['creator_instagram_account'], optional: ['revoke'], edgeCall: true, budget: false,
    values: (params) => {
      if (!isDigits(params.get('creator_instagram_account'))) return 'creator_instagram_account is an Instagram account id (digits only)'
      return !params.has('revoke') || params.get('revoke') === 'true' ? null : 'revoke is true (a request is sent without it)'
    },
    assets: (params) => [{ id: params.get('creator_instagram_account')!, kind: 'partnerinstagram' }],
  },
  {
    // CR-354: creators added to the chosen Instagram account's approved-tagging list (all or nothing).
    name: 'iguser.tagApproval.add', method: 'POST', path: /^\d{1,25}\/branded_content_tag_approval$/, kinds: IG_USER,
    required: ['user_ids'], optional: [], edgeCall: true, budget: false,
    values: (params) => metaUserIdsProblem(params.get('user_ids') ?? ''),
    assets: creators,
  },
  {
    // CR-355: creators taken off that list (all or nothing) — also the undo of CR-354.
    name: 'iguser.tagApproval.remove', method: 'DELETE', path: /^\d{1,25}\/branded_content_tag_approval$/, kinds: IG_USER,
    required: ['user_ids'], optional: [], edgeCall: true, budget: false,
    values: (params) => metaUserIdsProblem(params.get('user_ids') ?? ''),
    assets: creators,
  },
  {
    // CR-363: an ad code made for a media of the chosen Instagram account (Meta: "for media you own"), so a partner can boost
    // it. No parameter; Meta answers the code, which the tool shows once and never stores.
    name: 'igmedia.adCode.create', method: 'POST', path: /^\d{1,25}\/partnership_ad_code$/, kinds: IG_MEDIA,
    required: [], optional: [], noBody: true, edgeCall: true, budget: false,
    values: () => null,
  },
  {
    // CR-364: the ad code taken off a media of the chosen Instagram account — also the undo of CR-363.
    name: 'igmedia.adCode.remove', method: 'DELETE', path: /^\d{1,25}\/partnership_ad_code$/, kinds: IG_MEDIA,
    required: [], optional: [], edgeCall: true, budget: false,
    values: () => null,
  },
  {
    // MD-132: accept or decline a Collab invite the chosen Instagram account has pending.
    name: 'iguser.collab.respond', method: 'POST', path: /^\d{1,25}\/collaboration_invites$/, kinds: IG_USER,
    required: ['media_id', 'accept'], optional: [], edgeCall: true, budget: false,
    values: (params) => {
      if (!isDigits(params.get('media_id'))) return 'media_id is an Instagram media id (digits only)'
      return ['true', 'false'].includes(params.get('accept') ?? '') ? null : 'accept is true or false'
    },
    assets: (params) => [{ id: params.get('media_id')!, kind: 'collabinvite' }],
  },
]
