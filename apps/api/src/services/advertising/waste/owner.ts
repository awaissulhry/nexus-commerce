/**
 * Negative Targeting page (NREAD) — ONE owner per row, pure (the Bid page's bid-owner.ts pattern). Kinds: Brain · Rule ·
 * Harvest · You (PERSON) · Claude · — (NONE). read.ts gives the facts; each is read where its writer keeps it.
 *
 * A row that RUNS or is PAUSED (a keyword, or a search term not negated in its place), first that applies:
 *   1. kept paused         the hold's holder (AdTarget.keptPausedBy — NWRITE's columns, read defensively in read.ts)
 *   2. waiting             who asked for the change that waits (the brain, a rule's Ask-me card, Claude, a person) —
 *                          unless the row's state changed after the ask (then that writer, step 3)
 *   3. recent writer       who changed its state in the last 7 days (Bid audit M2: "who decides" never contradicts the
 *                          last change — an approved rule ask carries the rule's actor and stays the rule's)
 *   3b. the stopper        a paused keyword: who paused it, however long ago (its stop is theirs)
 *   4. the brain           a search term in a campaign the product's brain owns for negatives (lever at Watch or higher;
 *                          the brain never pauses a keyword, so never a keyword's owner here)
 *   5. a rule              the first enabled rule (by priority) whose scope reaches the row and whose action fits it
 *                          (pause_target for our keyword, add_negative_* for a search term)
 *   6. older writer        who changed its state in the last 30 days
 *   7. —                   nobody
 * A NEGATED row and every standing negative: its author (negativeOwner): NWRITE's stored origin where it is set, then a
 * harvest pair's source, the brain's own log (its funnel apart), the create record's actor and evidence, else Unknown.
 */
import { classifyActor, engineLabel } from '../ads-engine-actors.js'
import type { Owner, Ref } from './pure.js'

export const BRAIN_REF: Ref = { id: 'brain', name: 'Brain' }
export const HARVEST_OWNER: Owner = { kind: 'HARVEST', name: 'Harvest', id: 'harvest' }
export const NO_OWNER: Owner = { kind: 'NONE', name: '—', id: null }
const UNKNOWN: Owner = { kind: 'NONE', name: 'Unknown', id: null }

/** The names a writer goes by. */
export interface OwnerNames {
  /** Rule id → name. */
  rules: ReadonlyMap<string, string>
  /** Change sets (AgentApproval ids) asked for through Claude: a person's write inside one is Claude's. */
  claudeChangeSets: ReadonlySet<string>
}

const stripLegacy = (actor: string | null | undefined): string | null => {
  let a = actor ?? null
  while (a?.startsWith('automation:automation:')) a = a.slice('automation:'.length)
  return a
}

/**
 * Who one recorded write was, as an owner: the brain's writers are the Brain (its harvest writer is Harvest), a rule is
 * the rule by name, a harvest actor is Harvest, a person inside a Claude change set is Claude, else the person (You).
 * An engine this page has no kind for keeps its own name under — (NONE); no actor, or a rule since deleted, is Unknown.
 */
export function ownerOfActor(actor: string | null | undefined, names: OwnerNames, executionId?: string | null): Owner {
  const a = stripLegacy(actor)
  if (a && /harvest/i.test(a) && a.startsWith('automation:')) return { ...HARVEST_OWNER }
  const c = classifyActor(a)
  if (c.kind === 'engine') {
    if (c.engine === 'brain-harvest') return { ...HARVEST_OWNER }
    if (c.engine === 'bid-brain' || c.engine.startsWith('brain-')) return { kind: 'BRAIN', name: 'Brain', id: 'brain' }
    return { kind: 'NONE', name: engineLabel(c.engine), id: c.engine }
  }
  if (c.kind === 'rule-candidate') {
    const name = names.rules.get(c.ruleId)
    return name ? { kind: 'RULE', name, id: c.ruleId } : { ...UNKNOWN }
  }
  if (c.kind === 'person') {
    if (executionId && names.claudeChangeSets.has(executionId)) return { kind: 'CLAUDE', name: 'Claude', id: executionId }
    const id = a!.startsWith('user:') ? a!.slice(5) : a!
    return { kind: 'PERSON', name: 'You', id }
  }
  return { ...UNKNOWN }
}

/** An owner as a Ref (a change's `by`). */
export const refOfOwner = (o: Owner): Ref => ({ id: o.id ?? o.kind.toLowerCase(), name: o.name })

export interface RowOwnerFacts {
  /** NWRITE's hold, when the keyword is kept paused: who holds it. */
  hold?: { by: string | null } | null
  /** Who asked for the change that waits, and when (ms). */
  waitingBy?: Owner | null
  waitingAt?: number | null
  /** The newest change of the row's state, with when (ms) and its writer. */
  lastWriter?: { owner: Owner; at: number } | null
  /** A paused keyword: who paused it (the newest pause on record, any age). */
  pausedBy?: Owner | null
  /** A search term in a campaign the brain owns for negatives. */
  brainCovers?: boolean
  /** The first rule whose scope and action reach the row. */
  rule?: { id: string; name: string } | null
}

export function rowOwner(f: RowOwnerFacts, now: number, names: OwnerNames): Owner {
  if (f.hold) return f.hold.by ? ownerOfActor(f.hold.by, names) : { kind: 'PERSON', name: 'You', id: null }
  const recent = f.lastWriter && now - f.lastWriter.at <= 7 * 86_400_000 ? f.lastWriter.owner : null
  // What waits is newer news than an older change; a change made after the ask is newer than the ask.
  if (f.waitingBy && !(recent && f.lastWriter!.at > (f.waitingAt ?? 0))) return f.waitingBy
  if (recent) return recent
  if (f.pausedBy) return f.pausedBy
  if (f.brainCovers) return { kind: 'BRAIN', name: 'Brain', id: 'brain' }
  if (f.rule) return { kind: 'RULE', name: f.rule.name, id: f.rule.id }
  if (f.lastWriter && now - f.lastWriter.at <= 30 * 86_400_000) return f.lastWriter.owner
  return { ...NO_OWNER }
}

/**
 * NWRITE's stored author of a negative (`AdTarget.negativeOrigin`, ads-negative-kw.service.ts NEGATIVE_ORIGINS: HARVEST ·
 * BRAIN_FUNNEL · BRAIN · PLAYBOOK · RULE · CLAUDE · PERSON), as this page names it. It wins over every derivation.
 */
const ORIGINS: Record<string, Owner> = {
  HARVEST: { ...HARVEST_OWNER },
  BRAIN_FUNNEL: { kind: 'BRAIN', name: 'Brain funnel', id: 'brain' },
  BRAIN: { kind: 'BRAIN', name: 'Brain', id: 'brain' },
  PLAYBOOK: { kind: 'PERSON', name: 'Playbook', id: 'playbook' },
  CLAUDE: { kind: 'CLAUDE', name: 'Claude', id: null },
  PERSON: { kind: 'PERSON', name: 'You', id: null },
  AMAZON: { kind: 'NONE', name: 'Amazon', id: null },
}

export interface NegativeFacts {
  /** NWRITE's `AdTarget.negativeOrigin`; null/absent until that column exists and is filled. */
  origin?: string | null
  /** A harvest pair's source negative (AdsBrainHarvest.sources[].negativeTargetId). */
  harvestSource?: boolean
  /** The brain's own log of it (AdsBrainNegative.reason by adTargetId). */
  brainReason?: string | null
  /** The create record (AdvertisingActionLog create_negative_*): null when there is none (made at Amazon, or before records). */
  create?: { actor: string | null; executionId: string | null; evidence: unknown } | null
}

/** Who made a standing negative (one owner, the names of the contract: Brain funnel, Brain, Harvest, Playbook, a rule, You, Claude, Amazon, Unknown). */
export function negativeOwner(f: NegativeFacts, names: OwnerNames): Owner {
  const origin = String(f.origin ?? '').trim().toUpperCase()
  if (origin === 'RULE') {
    // The rule by name from its create record; the stored author alone still says a rule made it.
    const o = f.create?.actor ? ownerOfActor(f.create.actor, names, f.create.executionId) : null
    return o?.kind === 'RULE' ? o : { kind: 'RULE', name: 'Rule', id: null }
  }
  if (origin && ORIGINS[origin]) {
    const o = { ...ORIGINS[origin] }
    if (origin === 'CLAUDE' && f.create?.executionId) o.id = f.create.executionId
    if (origin === 'PERSON' && f.create?.actor) o.id = String(f.create.actor).replace(/^user:/, '')
    return o
  }
  if (f.harvestSource) return { ...HARVEST_OWNER }
  if (f.brainReason) return f.brainReason === 'funnel' ? { ...ORIGINS.BRAIN_FUNNEL } : { ...ORIGINS.BRAIN }
  if (f.create) {
    const key = String((f.create.evidence as { targetKey?: unknown } | null)?.targetKey ?? '')
    if (/harvest/i.test(key)) return { ...HARVEST_OWNER }
    if (/^(playbook|isolation)/i.test(key)) return { ...ORIGINS.PLAYBOOK }
    const o = ownerOfActor(f.create.actor, names, f.create.executionId)
    return o
  }
  return { ...UNKNOWN }
}

/** A negative another writer keeps: lifting it here is refused, with why in plain words (PLAN: "never fight Harvest", the funnel). */
export function negativeKeptBy(o: Owner): string | null {
  if (o.kind === 'HARVEST') return 'Harvest keeps this negative: it stops the search where Harvest moved it from.'
  if (o.kind === 'BRAIN' && o.name === 'Brain funnel') return 'The Brain keeps this negative.'
  return null
}

/** The held label of a kept negative's verb: "Harvest keeps it", "The Brain keeps it". */
export const keptLabel = (o: Owner): string => (o.kind === 'HARVEST' ? 'Harvest keeps it' : 'The Brain keeps it')
