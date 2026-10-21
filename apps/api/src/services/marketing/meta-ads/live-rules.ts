/**
 * Meta step 29 — the live state a change of Meta's automated rules stands on, read through the gateway:
 *   liveRule         ONE rule of the business's chosen ad account (step 8's ownRule: its account_id alone first, then
 *                    the rule — another account's rule, or any other node, is never read on), with its specs exactly as
 *                    Meta sends them back and the rule in words as meta-ad-rules shows it (step 8's mapRule)
 *   liveRuleGone     whether a rule is gone (deleted), for remove-meta-ad-rule's undo
 *   liveRulePreview  Meta's preview of a SCHEDULE rule: `POST /<rule id>/preview` (RU-031) — a POST that only reads
 *                    ("returns a list of objects that satisfy all specified filters of the rule at that time",
 *                    ad-rules/guides/api-calls "Preview a rule"; SDK AdRule.create_preview, POST, no params, its answer
 *                    parsed as AdRule). Meta documents no shape for the answer: Nexus reads `data[]` (or a plain list, or
 *                    `results[]`) of objects with an `id` (or `object_id`) and says plainly when it finds neither
 *                    (LIVE-PROBES RU-031). Sent only while Meta changes are switched on (like Meta's check).
 */
import { metaChosenAccount, MetaLiveRefusal, graphSafe, type MetaChosenAccount } from './live.js'
import { mapRule, ownRule, RULE_FIELDS } from './live-optimize.js'
import { MetaReadError, failureOfAnswer, failureOfThrow } from './errors.js'
import type { MetaChangeAccount } from './change-account.js'
import { metaRulePreviewCall } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { metaAdsWritesMode } from '../../gateway/channels.js'

type Row = Record<string, unknown>
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** A spec Meta may send back as a JSON string: read as an object. */
function specOf(v: unknown): Row | null {
  if (typeof v === 'string') { try { return obj(JSON.parse(v)) } catch { return null } }
  return obj(v)
}

export interface LiveRuleSpecs { evaluation: Row | null; execution: Row | null; schedule: Row | null }

export interface LiveRule {
  id: string
  name: string | null
  /** ENABLED, DISABLED, HAS_ISSUES (Meta stopped it) or DELETED. */
  status: string | null
  disableErrorCode: number | null
  /** The three specs exactly as Meta sent them back (null: the rule has none). */
  specs: LiveRuleSpecs
  /** The rule in words, as meta-ad-rules shows it (step 8's mapRule). */
  words: ReturnType<typeof mapRule>
}

/** The rule in words for any rule as Meta writes it (one Nexus is about to send): step 8's mapRule, for this account. */
export type RuleWords = (raw: Row) => ReturnType<typeof mapRule>

/** The chosen account as step 8's reads take it — refused when it is not the account the change goes to. */
async function chosenFor(account: MetaChangeAccount): Promise<MetaChosenAccount> {
  const chosen = await metaChosenAccount(account.accountId)
  if (chosen.adAccountId !== account.adAccountId) throw new MetaLiveRefusal('The business\'s chosen Meta ad account changed while this was being read: ask again.')
  return chosen
}

/** The rule in words for this account (the preview's from → to, whether it can raise spend). */
export async function ruleWordsFor(account: MetaChangeAccount): Promise<RuleWords> {
  const chosen = await chosenFor(account)
  return (raw) => mapRule(raw, chosen)
}

/** ONE rule of the chosen ad account, live; a refusal in words (MetaLiveRefusal) when it is not one. */
export async function liveRule(account: MetaChangeAccount, ruleId: string): Promise<LiveRule> {
  const chosen = await chosenFor(account)
  const { id, body } = await ownRule(chosen, ruleId, RULE_FIELDS)
  const specs = { evaluation: specOf(body.evaluation_spec), execution: specOf(body.execution_spec), schedule: specOf(body.schedule_spec) }
  return {
    id,
    name: text(body.name),
    status: text(body.status),
    disableErrorCode: typeof body.disable_error_code === 'number' ? body.disable_error_code : null,
    specs,
    words: mapRule({ ...body, evaluation_spec: specs.evaluation, execution_spec: specs.execution, schedule_spec: specs.schedule }, chosen),
  }
}

/** Is the rule gone (deleted, or no longer a rule of this account Meta shows)? Null when Nexus could not ask. */
export async function liveRuleGone(account: MetaChangeAccount, ruleId: string): Promise<boolean | null> {
  try {
    const rule = await liveRule(account, ruleId)
    return rule.status === 'DELETED'
  } catch (err) {
    if (err instanceof MetaLiveRefusal && /not a rule of the ad account/.test(err.message)) return true
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
    throw err
  }
}

export interface RulePreview {
  /** Meta answered with a list Nexus could read. */
  read: boolean
  /** The objects Meta says the rule would act on now (first page), by id. */
  objects: Array<{ id: string; name: string | null }>
  /** Meta has more on a next page (Nexus reads one page). */
  more: boolean
  /** One plain sentence: what Meta's preview says, or why there is none. */
  sentence: string
}

/** The answer's list of objects: `data[]`, a plain list, or `results[]`; null when it is none of them. */
function previewRows(body: unknown): Row[] | null {
  const top = obj(body)
  const list = Array.isArray(body) ? body : Array.isArray(top?.data) ? top!.data : Array.isArray(top?.results) ? top!.results : null
  return list ? (list as unknown[]).map(obj).filter((r): r is Row => !!r) : null
}

/** Meta's preview of a schedule rule (RU-031), through the gateway; never throws for Meta's answer. */
export async function liveRulePreview(account: MetaChangeAccount, ruleId: string): Promise<RulePreview> {
  const none = (sentence: string): RulePreview => ({ read: false, objects: [], more: false, sentence })
  if (metaAdsWritesMode() !== 'live') return none('Meta changes are switched off in Nexus (NEXUS_META_ADS_WRITES), so Meta was not asked for its preview either (it is a POST).')
  let answer: GatewayResponse
  try {
    answer = await metaRulePreviewCall({ connectionId: account.target.connectionId, ruleId })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (!failure) throw err
    return none(`Meta's preview of the rule was not asked: ${failure.sentence}`)
  }
  if (!answer.ok) return none(`Meta did not give its preview of the rule: ${failureOfAnswer(answer).sentence}`)
  const body = answer.json<unknown>()
  const rows = previewRows(body)
  if (!rows) return none('Meta answered its preview in a shape Nexus does not know yet (no list of objects), so it is not shown (LIVE-PROBES RU-031).')
  const objects = rows
    .map((r) => ({ id: typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : typeof r.object_id === 'string' || typeof r.object_id === 'number' ? String(r.object_id) : '', name: text(graphSafe(r.name)) }))
    .filter((o) => /^\d{1,25}$/.test(o.id))
  const more = !!obj(obj(body)?.paging)?.next
  const n = objects.length
  return {
    read: true,
    objects,
    more,
    sentence: n === 0
      ? 'Meta\'s preview: the rule would act on no object now.'
      : `Meta's preview: the rule would act on ${n}${more ? '+' : ''} object${n === 1 && !more ? '' : 's'} now (${objects.slice(0, 10).map((o) => (o.name ? `"${o.name}" (${o.id})` : o.id)).join(', ')}${n > 10 ? ', …' : ''}).`,
  }
}
