/**
 * Meta step 28 (2026-10-21) — the gateway's account checks for what step 28's changes name (gateway.ts metaOwnerProblem
 * and metaBodyIdsProblem hand these kinds here). Nothing is sent to Meta unless it is of the ad account (or Page) THIS
 * business chose through THIS connection; a check that cannot be made sends nothing. Reads only, through the gateway.
 *
 *   object a change names
 *     adaccount      `act_<id>` (an apply's edge): exactly the chosen ad account
 *     business       `<business>/ad_studies` (a new study): the chosen ad account's own business portfolio (Meta's
 *                    `business` of the ad account, read now)
 *     adstudy        `<study>` (a study change): Meta's list of the studies that impact the chosen ad account names it
 *                    (paged, at most 10 pages) AND it is owned by the chosen account's portfolio (step 8's own rule for
 *                    reading one)
 *     page           `<page>/ab_tests` (a Page video test): exactly the Page this business chose
 *     pagevideotest  `<test>` (deleting one): its control video was posted by the chosen Page
 *   ids inside a body
 *     adsetorad      a recommendation's object_selection: an ad set of the chosen account, else an ad of it
 *     adaccount      a lift cell's ad account: exactly the chosen ad account
 *     customconversion  a lift objective's custom conversion: one of the chosen account's own (at most 100 per account)
 *     person         a study's viewer: someone with a role on the chosen ad account (its assigned users in its
 *                    portfolio), or already one of the study's viewers
 *     pagevideo      a Page video test's video: posted by the chosen Page
 *     studycell      an existing cell a study change names by id: one of that study's own cells (`<study>/cells`)
 *
 * Checked 2026-10-21: reference/ad-account `business`, ad-account/impacting_ad_studies, ad-account/customconversions
 * ("max 100 per ad account", facts F2), ad-account/assigned_users (`business` required), ad-study `business`,
 * ad-study/viewers, docs/video-api/ab-testing (a test's control_video_id), the video node's `from`.
 */
import prisma from '../../db.js'
import type { MetaJudgedWrite, MetaWriteBodyId } from './meta-calls.js'

export const META_OPTIMIZE_OBJECT_KINDS = ['adaccount', 'business', 'adstudy', 'page', 'pagevideotest'] as const
export type MetaOptimizeObjectKind = typeof META_OPTIMIZE_OBJECT_KINDS[number]
export const META_OPTIMIZE_BODY_KINDS: ReadonlySet<string> = new Set(['adsetorad', 'adaccount', 'customconversion', 'person', 'pagevideo', 'studycell'])
export const isMetaOptimizeKind = (kind: string | undefined): kind is MetaOptimizeObjectKind => !!kind && (META_OPTIMIZE_OBJECT_KINDS as readonly string[]).includes(kind)

export interface MetaOwnerProblem { code: string; sentence: string }

/** What the checks need from the gateway (gateway.ts builds it: its own GETs, its own campaign / ad set / ad check). */
export interface MetaOwnerIo {
  chosenAdAccount: () => Promise<string | null>
  /** One GET (fields and the other query keys given), or null when Meta did not answer it with a success. */
  read: (path: string, query: Record<string, string>) => Promise<Record<string, unknown> | null>
  /**
   * Gap 46b (re-review NIT 2) — the same GET with the words of a refusal: the gateway's own (a Page's video is read with the
   * chosen Page's token — meta-page-reads.ts — and a missing or refused one is refused before Meta) or Meta's.
   */
  readWithWords?: (path: string, query: Record<string, string>) => Promise<{ body: Record<string, unknown> | null; words: string | null }>
  /** The existing check of a campaign, ad set or ad of the chosen account (gateway.ts metaOwnerProblem). */
  objectProblem: (id: string, kind: 'campaign' | 'adset' | 'ad') => Promise<MetaOwnerProblem | null>
}

/** The Page this business chose through this connection (its PAGE MetaAccountLink), or null. */
export async function metaChosenPageOf(connectionId: string): Promise<string | null> {
  const link = await prisma.metaAccountLink.findFirst({ where: { connectionId, product: 'PAGE' }, select: { externalId: true } })
  return link?.externalId ?? null
}

const NOT_CHOSEN = 'META_ACCOUNT_NOT_CHOSEN'
const UNCONFIRMED = 'META_ACCOUNT_UNCONFIRMED'
const NOT_ALLOWED = 'META_WRITE_NOT_ALLOWED'
const say = (code: string, sentence: string): MetaOwnerProblem => ({ code, sentence: `Nothing was sent to Meta: ${sentence}` })
const idOf = (v: unknown): string | null => {
  const raw = v && typeof v === 'object' ? (v as Record<string, unknown>).id : v
  return (typeof raw === 'string' || typeof raw === 'number') && /^\d{1,25}$/.test(String(raw)) ? String(raw) : null
}

/** The ids of a list, following Meta's `after` cursor up to `maxPages` pages; null when a page could not be read or more pages are left. Step 34 reuses it (meta-catalog-owner.ts). */
export async function listedIds(io: MetaOwnerIo, path: string, query: Record<string, string> = {}, maxPages = 10): Promise<Set<string> | null> {
  const ids = new Set<string>()
  let after: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const body = await io.read(path, { fields: 'id', limit: '100', ...query, ...(after ? { after } : {}) })
    if (!body || !Array.isArray(body.data)) return null
    for (const row of body.data) { const id = idOf(row); if (id) ids.add(id) }
    const paging = body.paging as { cursors?: { after?: unknown }; next?: unknown } | undefined
    after = paging?.next && typeof paging.cursors?.after === 'string' ? paging.cursors.after : null
    if (!after) return ids
  }
  return null
}

/** The chosen ad account's business portfolio, read now (null: none, or not readable). Step 34 reuses it (meta-catalog-owner.ts). */
export async function chosenBusiness(io: MetaOwnerIo, chosen: string): Promise<string | null> {
  const body = await io.read(`act_${chosen}`, { fields: 'business{id}' })
  return idOf(body?.business)
}

/** Gap 46b — a Page video's owner read (`id,from{id}`, the chosen Page's token), with the words when it could not be made. */
async function videoRead(io: MetaOwnerIo, videoId: string): Promise<{ body: Record<string, unknown> | null; words: string | null }> {
  return io.readWithWords ? io.readWithWords(videoId, { fields: 'id,from{id}' }) : { body: await io.read(videoId, { fields: 'id,from{id}' }), words: null }
}

/** Why a change of this object (step 28's kinds) is refused for this connection, or null. */
export async function metaOptimizeOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: MetaOptimizeObjectKind, io: MetaOwnerIo): Promise<MetaOwnerProblem | null> {
  const id = write.objectId
  if (write.check) return say(NOT_ALLOWED, 'Meta documents no check (validate_only) for this change.')
  if (kind === 'page' || kind === 'pagevideotest') {
    const page = await metaChosenPageOf(connectionId)
    if (!page) return say(NOT_CHOSEN, 'this business has chosen no Facebook Page through this connection.')
    if (kind === 'page') return id === page ? null : say(NOT_CHOSEN, `${id} is not the Facebook Page this business chose.`)
    const test = await io.read(id, { fields: 'id,control_video_id,optimization_goal' })
    const control = idOf(test?.control_video_id)
    if (!control) return say(UNCONFIRMED, `Nexus could not read ${id} as a video A/B test of the chosen Page.`)
    const video = await videoRead(io, control)
    if (!video.body && video.words) return say(UNCONFIRMED, `Nexus could not read the control video of ${id}, which it reads with the chosen Facebook Page's own token (${video.words.slice(0, 300)}).`)
    return idOf(video.body?.from) === page ? null : say(NOT_CHOSEN, `${id} is not a video A/B test of the Facebook Page this business chose.`)
  }
  const chosen = await io.chosenAdAccount()
  if (!chosen) return say(NOT_CHOSEN, 'this business has no Meta ad account chosen through this connection, so Nexus changes nothing on Meta.')
  if (kind === 'adaccount') return id === `act_${chosen}` ? null : say(NOT_CHOSEN, 'the ad account named is not the one this business chose through this connection.')
  const business = await chosenBusiness(io, chosen)
  if (!business) return say(UNCONFIRMED, 'Nexus could not read the business portfolio of the chosen ad account (Meta makes studies on a portfolio).')
  if (kind === 'business') return id === business ? null : say(NOT_CHOSEN, `${id} is not the business portfolio of the ad account this business chose.`)
  // adstudy
  const study = await io.read(id, { fields: 'id,type,business{id}' })
  if (!study || typeof study.type !== 'string') return say(UNCONFIRMED, `Nexus could not read ${id} as a Meta study.`)
  if (idOf(study.business) !== business) return say(NOT_CHOSEN, `study ${id} is not owned by the business portfolio of the ad account this business chose.`)
  const touching = await listedIds(io, `act_${chosen}/impacting_ad_studies`)
  if (!touching) return say(UNCONFIRMED, 'Nexus could not read the list of the studies that impact the chosen ad account.')
  return touching.has(id) ? null : say(NOT_CHOSEN, `study ${id} does not touch the ad account this business chose.`)
}

/** Why an id inside a body (step 28's kinds) is refused, or null. One list read per kind is kept for the whole body. */
export function metaOptimizeBodyChecker(connectionId: string, write: MetaJudgedWrite, io: MetaOwnerIo) {
  const lists = new Map<string, Promise<Set<string> | null>>()
  const once = (key: string, load: () => Promise<Set<string> | null>) => {
    if (!lists.has(key)) lists.set(key, load())
    return lists.get(key)!
  }
  const inside = (problem: MetaOwnerProblem): MetaOwnerProblem => ({ ...problem, sentence: problem.sentence.replace(/^Nothing was sent to Meta: /, 'Nothing was sent to Meta: inside this change, ') })
  return async (inner: MetaWriteBodyId): Promise<MetaOwnerProblem | null> => {
    if (inner.kind === 'pagevideo') {
      const page = await metaChosenPageOf(connectionId)
      if (!page) return inside(say(NOT_CHOSEN, 'this business has chosen no Facebook Page through this connection.'))
      const video = await videoRead(io, inner.id)
      if (!video.body && video.words) return inside(say(UNCONFIRMED, `Nexus could not read video ${inner.id}, which it reads with the chosen Facebook Page's own token (${video.words.slice(0, 300)}).`))
      return idOf(video.body?.from) === page ? null : inside(say(NOT_CHOSEN, `video ${inner.id} is not one the chosen Page posted.`))
    }
    const chosen = await io.chosenAdAccount()
    if (!chosen) return inside(say(NOT_CHOSEN, 'this business has no Meta ad account chosen through this connection.'))
    switch (inner.kind) {
      case 'studycell': {
        const cells = await once('cells', async () => (write.rule === 'study.update' ? listedIds(io, `${write.objectId}/cells`, {}, 2) : null))
        if (!cells) return inside(say(UNCONFIRMED, 'Nexus could not read the cells of this study.'))
        return cells.has(inner.id) ? null : inside(say(NOT_ALLOWED, `cell ${inner.id} is not one of this study's cells.`))
      }
      case 'adaccount':
        return inner.id === chosen ? null : inside(say(NOT_CHOSEN, 'an ad account named is not the one this business chose (a study here measures only it).'))
      case 'adsetorad': {
        const asAdSet = await io.objectProblem(inner.id, 'adset')
        if (!asAdSet) return null
        if (asAdSet.code !== NOT_ALLOWED) return inside(asAdSet)
        const asAd = await io.objectProblem(inner.id, 'ad')
        return asAd ? inside(asAd) : null
      }
      case 'customconversion': {
        const own = await once('customconversions', () => listedIds(io, `act_${chosen}/customconversions`, {}, 1))
        if (!own) return inside(say(UNCONFIRMED, 'Nexus could not read the chosen ad account\'s custom conversions.'))
        return own.has(inner.id) ? null : inside(say(NOT_CHOSEN, `custom conversion ${inner.id} is not one of the chosen ad account's.`))
      }
      case 'person': {
        // A study change keeps the study's own viewers: they may stay on the list.
        const viewers = await once('viewers', async () => (write.rule === 'study.update' ? listedIds(io, `${write.objectId}/viewers`) : new Set<string>()))
        if (viewers?.has(inner.id)) return null
        const assigned = await once('assigned', async () => {
          const business = await chosenBusiness(io, chosen)
          return business ? listedIds(io, `act_${chosen}/assigned_users`, { business }) : null
        })
        if (!assigned) return inside(say(UNCONFIRMED, 'Nexus could not read who has a role on the chosen ad account.'))
        return assigned.has(inner.id) ? null : inside(say(NOT_CHOSEN, `person ${inner.id} has no role on the chosen ad account: Nexus shares a study only with people who do.`))
      }
      default:
        return inside(say(NOT_ALLOWED, `${inner.id} is not an id Nexus checks here.`))
    }
  }
}
