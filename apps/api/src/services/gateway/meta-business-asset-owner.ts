/**
 * Meta step 43 (2026-10-26) — the gateway's own check of a create-meta-backed-account change (gateway.ts hands every write a
 * step-43 rule judged here, by the rule, never by the kind alone). Nothing is sent to Meta unless the object is the one the
 * business chose through this connection (its own link, read here — never the caller's word):
 *   backedpage       the business's CHOSEN Facebook Page (its PAGE link through this connection)
 *   backedinstagram  the business's CHOSEN Instagram account (its INSTAGRAM link through this connection)
 */
import type { MetaJudgedWrite } from './meta-calls.js'
import type { MetaOwnerProblem } from './meta-optimize-owner.js'
import { metaChosenInstagramOf, metaChosenPageOf } from './account.js'
import type { MetaBusinessAssetKind } from './meta-business-asset-rules.js'

const NOT_CHOSEN = 'META_ACCOUNT_NOT_CHOSEN'
const NOT_ALLOWED = 'META_WRITE_NOT_ALLOWED'
const say = (code: string, sentence: string): MetaOwnerProblem => ({ code, sentence: `Nothing was sent to Meta: ${sentence}` })

/** Why a step-43 change of this object is refused for this connection, or null. */
export async function metaBusinessAssetOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string | undefined): Promise<MetaOwnerProblem | null> {
  if (write.check) return say(NOT_ALLOWED, 'Meta documents no check (validate_only) for this change.')
  if (!kind || !(write.kinds as readonly string[] | undefined)?.includes(kind)) return say(NOT_ALLOWED, `this change is not one of a ${kind ?? 'named kind of object'}.`)
  const id = write.objectId
  if ((kind as MetaBusinessAssetKind) === 'backedpage') {
    const page = await metaChosenPageOf(connectionId)
    if (!page) return say(NOT_CHOSEN, 'this business has chosen no Facebook Page through this connection.')
    return id === page ? null : say(NOT_CHOSEN, `${id} is not the Facebook Page this business chose.`)
  }
  const instagram = await metaChosenInstagramOf(connectionId)
  if (!instagram) return say(NOT_CHOSEN, 'this business has chosen no Instagram account through this connection.')
  return id === instagram ? null : say(NOT_CHOSEN, `${id} is not the Instagram account this business chose.`)
}
