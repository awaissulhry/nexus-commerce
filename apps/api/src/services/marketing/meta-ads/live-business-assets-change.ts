/**
 * Meta ads step 43 (2026-10-26) — the live reads behind create-meta-backed-account (pure draft: change-business-assets.ts).
 * GET only, through the gateway, with the paths and keys the merged reads use: step 10's read of the chosen Page's Page-backed
 * Instagram account and its connected Instagram account (live-media.ts), step 15's of the Instagram- and Page-backed Threads
 * accounts (live-messaging.ts destinations). Only the business's chosen Page or Instagram account is read.
 */
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { listPaged, part } from './paging.js'
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { BackedKind, BackedLive } from './change-business-assets.js'

type Row = Record<string, unknown>
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : []).map(obj).filter((r): r is Row => !!r)
/** One row of an answer that is a list or a node (Meta answers these edges either way). */
const firstOf = (v: unknown): Row | null => (Array.isArray(v) || Array.isArray(obj(v)?.data) ? rowsOf(v)[0] ?? null : obj(v))
/** The id of the account a read answered (digits), or null. */
const idIn = (row: Row | null, key: string) => metaObjectId(row?.[key])

/** What exists already for the backed account asked: one per Page / Instagram account (Meta answers the existing one). */
export async function liveBacked(chosen: MetaChosenAccount, kind: BackedKind): Promise<BackedLive> {
  const { connectionId } = chosen
  const refused = (err: unknown) => {
    if (err instanceof MetaReadError) return { refused: err.message }
    if (err instanceof MetaLiveRefusal) return { refused: err.message }
    throw err
  }
  if (kind === 'threads-for-instagram') {
    const ig = chosen.instagramId
    if (!ig) return { kind, objectId: null, existing: { id: null } }
    let existing: BackedLive['existing']
    try {
      const read = await metaReadOne({ connectionId }, { operation: 'backedChange.instagramThreads', path: `${ig}/instagram_backed_threads_user`, query: { fields: 'threads_user_id' } })
      existing = { id: idIn(firstOf(read.body), 'threads_user_id') }
    } catch (err) { existing = refused(err) }
    const linked = await part(() => metaReadOne({ connectionId }, { operation: 'backedChange.linkedThreads', path: `${ig}/connected_threads_user`, query: { fields: 'threads_user_id' } }))
    return { kind, objectId: ig, existing, linkedThreads: linked.value ? idIn(firstOf(linked.value.body), 'threads_user_id') : undefined }
  }
  const page = chosen.pageId
  if (!page) return { kind, objectId: null, existing: { id: null } }
  const pbia = async () => {
    const read = await listPaged(connectionId, 'backedChange.pageBackedInstagram', `${page}/page_backed_instagram_accounts`, { fields: 'id' }, 5)
    return metaObjectId(read.rows[0]?.id)
  }
  if (kind === 'instagram-for-page') {
    let existing: BackedLive['existing']
    try { existing = { id: await pbia() } } catch (err) { existing = refused(err) }
    // Review N2 — the Page's connected Instagram account (step 10's read: instagram_business_account on the Page).
    const connected = await part(() => metaReadOne({ connectionId }, { operation: 'backedChange.pageConnectedInstagram', path: page, query: { fields: 'id,instagram_business_account{id}' } }))
    const body = obj(connected.value?.body)
    const connectedInstagram = !body || metaObjectId(body.id) !== page ? undefined : idIn(obj(body.instagram_business_account), 'id')
    return { kind, objectId: page, existing, connectedInstagram }
  }
  let existing: BackedLive['existing']
  try {
    const read = await metaReadOne({ connectionId }, { operation: 'backedChange.pageThreads', path: page, query: { fields: 'id,page_backed_threads_account_id' } })
    const body = obj(read.body)
    if (metaObjectId(body?.id) !== page) throw new MetaLiveRefusal('Meta answered for another Page than the chosen one.')
    existing = { id: idIn(body, 'page_backed_threads_account_id') }
  } catch (err) { existing = refused(err) }
  const instagram = await part(pbia)
  return { kind, objectId: page, existing, pageBackedInstagram: instagram.value === null && instagram.notRead ? undefined : instagram.value }
}
