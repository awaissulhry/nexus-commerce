'use client'

/**
 * NAF.AQ.1 — the Approvals page.
 *
 * Study: docs/2026-08-07-naf-aq-approvals-page.md. The page's whole reason to
 * be a page rather than the panel it grew out of is AQ-S2, the gate state: an
 * empty approvals queue and a broken approvals pipe look identical, and today
 * it is the pipe. Three independent walls stop anything arriving —
 *
 *   1. the three fleet propose-tools are preview-only, so `runOrQueueTool`
 *      creates no row and an approve could not reach Amazon either;
 *   2. six of seven charters cap below PROPOSE, the only dial that queues;
 *   3. `executeCharter` never calls the queueing path at all, so only the
 *      weekly council can produce a request — not a sweep, not an `ask`, not
 *      an assignment.
 *
 * — and none of them is visible anywhere in the product. S2 is the section
 * that says so, and it is deliberately the first thing under the promise.
 *
 * AQ.3 retired the borrowed `<ApprovalInbox>`: the card and the lists now live
 * in this directory (`ApprovalCard`, `ApprovalLists`), so the page has exactly
 * one card design and the outside queue and the fleet queue cannot drift apart.
 * The AP.1–AP.8 BEHAVIOURS are reproduced deliberately rather than reinvented —
 * three views, grouping by worker name, the server-written blast-radius
 * sentence, reject-all, the parked row with its inline undo. The Overview still
 * renders the original from its own directory; the two retire together when it
 * moves. Only the tool VOCABULARY is still imported, because copying it would
 * create two dictionaries that drift — the defect AP.3 was written to fix.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  MinusCircle,
  ShieldCheck,
  Undo2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { FleetPageShell } from '../_shell/FleetPageShell'
import { HowApprovalsWork } from './HowApprovalsWork'
import { toolCardFor } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { ApprovalCard, type FleetLabels } from './ApprovalCard'
import {
  PrecedentPanel,
  RecordList,
  ViewTabs,
  WaitingList,
  type ApprovalRow,
  type InboxCounts,
  type InboxView,
  type PrecedentRow,
} from './ApprovalLists'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'

/* ── the gate-state contract (agent-fleet-approvals.routes.ts) ─────────── */

interface GateWorker {
  key: string
  name: string
  autonomyLevel: string
  autonomyCap: string
  enabled: boolean
  provisioned: boolean
  couldEverPropose: boolean
  proposesNow: boolean
}

interface GateTool {
  name: string
  canExecute: boolean
  requiresApproval: boolean
  riskTier: string
  isFleetTool: boolean
}

/**
 * AQ-S2R — one enumerated precondition, composed server-side.
 *
 * Mirrors `GateCondition` in `agent-fleet-approvals.routes.ts`. It is a
 * hand-written mirror rather than a shared type because web does not import
 * from api — which means **tsc cannot catch a drift between them**, and the
 * only thing that can is the browser. Worth knowing before changing either.
 */
interface GateCondition {
  key: 'worker-may-ask' | 'action-can-run' | 'something-scheduled'
  met: boolean
  requirement: string
  detail: string
  owner: 'operator' | 'engineering' | 'automatic'
  href: string | null
  at: string | null
}

interface GateState {
  halted: boolean
  haltReason: string | null
  canAnythingArrive: boolean
  conditions: GateCondition[]
  workers: GateWorker[]
  tools: GateTool[]
  arrival: {
    councilNext: string | null
    councilEnabled: boolean
    councilSchedule: string | null
    sweepNext: string | null
    sweepEnabled: boolean
    sweepCanQueue: boolean
  }
  expiry: {
    hours: number
    maintenanceSeconds: number
    runsWhileFleetIsOff: boolean
    lastMaintenance: { startedAt: string; status: string; outputSummary: string | null } | null
  }
  outside: {
    pending: number
    byTool: Array<{ toolName: string; count: number }>
    /* OPTIONAL on purpose. Railway and Vercel deploy separately and neither
       order is guaranteed, so between the two deploys this client runs against
       an API that has never heard of `producers`. S2.a took production down by
       assuming the opposite. Every read below is guarded. */
    producers?: Array<{ key: string; enabled: boolean }>
  }
}

interface CharterRow {
  key: string
  name: string
}

const humanTool = (s: string) => s.replace(/-/g, ' ')

/* Where a WORKER'S NAME is expected — the first two words of a card — a bare
   de-hyphenated key reads as a database column, not as somebody who wants to
   do something. Only the leading letter: "Listing quality keeper", matching
   the charters' own house style ("Bid tuner", "Keyword harvester"). */
const sentenceCase = (s: string) => s.replace(/^./, (c) => c.toUpperCase())

/**
 * S5.1 — who actually asked, said truthfully.
 *
 * The page shipped one sentence for all of these: *"an agent from before the
 * fleet"*. It is wrong about every one of them, and about `manual-action` it is
 * wrong three times over — that key is minted by `requestApproval()`
 * (`approval-gate.service.ts:114`) when **a person** presses "Request approval"
 * in the copilot. Not an agent, not from before the fleet, and the phrasing
 * erased the one fact worth knowing: a human asked for this.
 *
 * The other two are live registered crons — `pricing-watchdog` runs 07:00 UTC
 * daily, `listing-quality-keeper` on its own schedule. Both are switched off
 * today (§1.2) and one Control Center toggle from minting real rows. "Legacy"
 * is the opposite of true.
 *
 * The root confusion, named so it does not come back: the page was treating
 * *"not a charter"* as *"not part of the fleet"*. A charter is a governed
 * worker with a dial and a track record. These are producers that are not
 * charters. **"Outside the fleet" is true and sufficient; "from before the
 * fleet" was an invention.**
 *
 * `what` completes the sentence "Asked by NAME — …", and every branch ends by
 * saying what is missing, because that is the honest part of the old copy and
 * the reason these rows are thinner than a fleet worker's.
 */
interface Origin {
  /**
   * The MID-SENTENCE form, always — "the price watchdog", not "The price
   * watchdog". S5.6 shipped a list reading "The listing quality keeper and The
   * price watchdog": the strings were sentence-start forms and the list needed
   * them mid-sentence. Lower-casing at the call site is the fragile fix (it
   * mangles any proper noun that ever enters this map), so the map stores one
   * grammatical form and `sentenceCase()` derives the other where a sentence
   * actually begins.
   */
  name: string
  what: string
}
const NO_HISTORY = 'so there is no worker page and no track record for it'
const OUTSIDE_ORIGINS: Record<string, Origin> = {
  'manual-action': {
    name: 'someone using the copilot',
    what: `a person rather than a worker, ${NO_HISTORY}`,
  },
  'pricing-watchdog': {
    name: 'the price watchdog',
    what: `a scheduled check that watches your prices and runs outside the fleet, ${NO_HISTORY}`,
  },
  'listing-quality-keeper': {
    name: 'the listing quality keeper',
    what: `a scheduled check that watches listing quality and runs outside the fleet, ${NO_HISTORY}`,
  },
}
/* "A", "A and B", "A, B and C" — the count is never known ahead of time
   because the producer list is enumerated from the registry, not hand-written,
   so a third scheduled agent must read as English without a code change. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function originOf(key: string | null): Origin {
  if (!key)
    return {
      name: 'something we cannot identify',
      what: 'nothing on the run records which producer it was',
    }
  return (
    OUTSIDE_ORIGINS[key] ?? {
      /* Never the raw key. FX.1's rule for this section is names, not IDs, and
         S6 already closed two other doors onto the same defect. */
      name: humanTool(key),
      what: `a system that runs outside the fleet, ${NO_HISTORY}`,
    }
  )
}

function whenNext(iso: string | null): string {
  if (!iso) return 'not scheduled'
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'due now'
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`
  if (h < 48) return `in ${h}h`
  return `in ${Math.round(h / 24)} days`
}

/* ── S1 · the standing promise ─────────────────────────────────────────── */

/**
 * S1.a (study Part 12) — the promise IS the page description now, not a green
 * banner under it.
 *
 * Three measured reasons, all on production before the change:
 *
 *   1. It was said twice. `.acr-sub` read "Everything the fleet wants to do and
 *      cannot do until you say yes" and the banner 38px below it made the same
 *      guarantee at 171 characters per line. A reader who read both learned
 *      nothing from the second.
 *   2. It was GREEN — a success colour on a statement that is not a success —
 *      and it never changed. A never-changing element in notification clothing
 *      is the stimulus the habituation literature says is ignored fastest
 *      (visual processing collapses after the SECOND exposure). Helios,
 *      Atlassian and Carbon all reserve that treatment for state changes; a
 *      standing guarantee is page-level identity, and Helios is explicit that
 *      page-level information belongs at the top of the page.
 *   3. As a description it survives a full queue by construction — it is not
 *      inside the empty state, so it cannot vanish exactly when volume makes
 *      rubber-stamping tempting. That was the property the study wanted; the
 *      banner was one way of getting it, and not the good one.
 *
 * Hierarchy comes from WEIGHT, not colour: the lede is 13/600 at 14.3:1, which
 * is darker and heavier than the same words were inside the tinted box.
 *
 * "one of your workers", NOT "the fleet": `worker` has a glossary entry and
 * `fleet` does not, and this page will not mint a term in a shared append-only
 * file for a word it does not need.
 *
 * The second sentence stops at "unless you say yes" on purpose. The other half
 * — that today a yes writes nothing either — is state-dependent, and S2 and the
 * card both say it. An invariant that needs rewording the day Phase F lands is
 * not an invariant.
 */
function PageDescription() {
  return (
    <>
      <span className="aq-lede">Nothing on this page has happened yet.</span>
      Every card is a change one of your <Term k="worker">workers</Term> wants to make. It does
      not happen unless you say yes.
    </>
  )
}

/* ── S2 · can anything reach this queue? ───────────────────────────────── */

/**
 * NAF.AQ-S2R (study Part 13) — the readiness readout.
 *
 * The section only this page can host: Controls knows the dials, Overview knows
 * the schedule, and nothing anywhere knows whether the actions a worker can
 * propose are able to RUN. Joined here, they answer the question an empty queue
 * always raises — is this broken, or just quiet?
 *
 * It is a READOUT, not a checklist and not a status banner, and the distinction
 * is a safety property rather than a style preference:
 *
 * · Not a banner. Argo CD ranks `Suspended` ("waiting for some external event
 *   to resume") as a different STATUS from `Degraded`; LaunchDarkly frames OFF
 *   as deliberate configuration; Statuspage gives "Under Maintenance" the
 *   LOWEST precedence of any status. This fleet is off because the operator
 *   chose that, so painting it amber told them something was wrong every single
 *   day — and it was a FOURTH amber, when `.acr-banner.warn` already serves
 *   seven fleet surfaces.
 * · Not a checklist. A checklist invites completion, and two of the three
 *   conditions must NOT be completed by the operator: setting a worker to
 *   PROPOSE arms a fleet that is off by deliberate constraint, and the missing
 *   executors are Phase F work nobody here can act on.
 *
 * So every row carries an OWNER — yours, ours, or automatic. That is the half
 * of "what would have to change" the old design did not attempt, and it is why
 * there is no progress bar, no "2 of 3 complete", and no per-row action button.
 *
 * The four tiles are gone. Their contract needed a delta and a trend and none
 * of the four numbers could supply either: two were counts of configuration,
 * one a countdown, one a policy constant. Numbers live inside the sentences
 * they qualify now. The `24h` tile is deleted outright rather than restyled —
 * it is not a precondition at all, and S1's teaching drawer already states it.
 */

/**
 * S2.d — glossary terms inside SERVER-COMPOSED copy.
 *
 * A consequence of S2.a that I did not foresee and the tab-stop audit caught:
 * once `requirement` and `detail` are composed on the server, the client can no
 * longer wrap individual words in `<Term>`, so PROPOSE, council and sweep lost
 * the tooltips they had. Server composition was still the right call — it is
 * what removed the 22 duplicated words — but it moved the copy out of JSX, and
 * the tooltips went with it.
 *
 * So the sentence is tokenised on an EXPLICIT list, never on the whole glossary:
 * an automatic pass over every key would eventually wrap a word that merely
 * looks like jargon ("plan", "run", "target" all appear in ordinary sentences
 * here). First occurrence only — one tooltip per term per sentence is the
 * house rule S1 set, and repeating it turns prose into a minefield of dotted
 * underlines.
 */
const S2_TERMS: Array<[RegExp, string]> = [
  [/\bPROPOSE\b/, 'propose'],
  [/\bcouncil\b/, 'council'],
  [/\bsweep\b/, 'sweep'],
]

type Piece = string | ReactElement

function withTerms(text: string): Piece[] {
  /*
   * An explicit loop, not `flatMap`. `ReactNode` includes `Iterable<ReactNode>`,
   * so flatMap's return type collapses into something React's children type
   * will not accept — and `npx tsc --noEmit` accepts it anyway while
   * `next build`'s own TypeScript pass does not. That gap is documented in the
   * locks file and this is the second time it has bitten; the narrower `Piece`
   * type is what makes both agree.
   */
  let parts: Piece[] = [text]
  for (const [re, key] of S2_TERMS) {
    const next: Piece[] = []
    for (const part of parts) {
      if (typeof part !== 'string') {
        next.push(part)
        continue
      }
      const m = re.exec(part)
      if (!m) {
        next.push(part)
        continue
      }
      next.push(part.slice(0, m.index))
      next.push(
        <Term key={`${key}-${m.index}`} k={key as never}>
          {m[0]}
        </Term>,
      )
      next.push(part.slice(m.index + m[0].length))
    }
    parts = next
  }
  return parts
}

const OWNER_LINE: Record<GateCondition['owner'], string> = {
  operator: 'Yours to change',
  engineering: 'Ours to build — nothing you can do here',
  automatic: 'Automatic',
}

/**
 * The state word per condition. Colour is never the carrier: every state pairs
 * a distinct glyph WITH a word (the status-page convention, and WCAG 1.4.1,
 * which this stylesheet's own header already committed to).
 *
 * Note what is deliberately absent: any word implying fault. "Not yet" and
 * "Not built" are states, not failures.
 */
function stateWord(c: GateCondition): string {
  if (c.met) return 'Ready'
  if (c.owner === 'engineering') return 'Not built'
  if (c.owner === 'automatic') return 'Not set up'
  return 'Not yet'
}

function ConditionRow({
  condition,
  tools,
}: {
  condition: GateCondition
  /** Only the `action-can-run` row renders these — the evidence for its claim. */
  tools: GateTool[]
}) {
  const met = condition.met
  return (
    <li className={`aq-cond${met ? ' met' : ''}`}>
      <span className="aq-condstate">
        {met ? (
          <CheckCircle2 size={14} aria-hidden />
        ) : (
          <MinusCircle size={14} aria-hidden />
        )}
        {stateWord(condition)}
      </span>
      <div className="aq-condbody">
        {/* S2.c — the owner sits ON the requirement line, not under the detail.
            Right-aligning it put "Yours to change" ~1000px from the sentence it
            qualifies, which is both dead space in the middle of the row and a
            association the reader has to track across the width of the page.
            Inline and adjacent costs nothing and reads immediately. A <span>,
            not a <p>: a paragraph inside a paragraph is invalid HTML. */}
        <p className="aq-condreq">
          {withTerms(condition.requirement)}
          <span className="aq-condowner">
            {OWNER_LINE[condition.owner]}
            {condition.href ? (
              <>
                {' · '}
                <Link href={condition.href}>Controls →</Link>
              </>
            ) : null}
          </span>
        </p>
        <p className="aq-conddetail">
          {withTerms(condition.detail)}
          {condition.at ? (
            <>
              {' '}
              <time dateTime={condition.at} title={new Date(condition.at).toLocaleString()}>
                Next {whenNext(condition.at)}
              </time>
              .
            </>
          ) : null}
        </p>

        {tools.length > 0 ? (
          <ul className="aq-toollist">
            {tools.map((t) => (
              <li key={t.name}>
                <span className={t.canExecute ? 'aq-can' : 'aq-cannot'}>
                  {t.canExecute ? 'can run' : 'describes only'}
                </span>
                {/* FX.1: names, not identifiers. `toolCardFor` is the vocabulary
                    this page already imports for its card — copying it into a
                    second dictionary is the defect AP.3 was written to fix. */}
                {toolCardFor(t.name).shortAsk}
              </li>
            ))}
          </ul>
        ) : null}

      </div>
    </li>
  )
}

function GateStateSection({
  gate,
  waiting,
  loading,
  err,
}: {
  gate: GateState | null
  waiting: number
  loading: boolean
  err: string | null
}) {
  /*
   * S2.d — loading. This used to `return null`, which is why the queue card
   * painted at y=175 and landed at y=522 once the read resolved: 347px of the
   * page moving under the reader, measured in §12.7. A skeleton at the
   * readout's real height reserves the space instead.
   */
  if (!gate && loading) {
    return (
      <div className="aq-gate aq-gateskel" aria-busy="true" aria-label="Reading the fleet’s state" />
    )
  }

  /*
   * S2.d — the read FAILED, and silence is the wrong answer.
   *
   * `return null` here meant a failed gate-state read looked exactly like a
   * healthy page with an empty queue — on the one section whose entire job is
   * to tell those two apart.
   *
   * ⚠ A correction to the study (Part 13 §13.4.3f), found by implementing it:
   * it specified "the readout frame with `Unknown` on every row". That is not
   * possible. Every requirement sentence is COMPOSED SERVER-SIDE, so a failed
   * read has no rows to label — inventing three from a client-side constant
   * would be exactly the stale-constant class this page exists to stop. The
   * honest version is the frame, and one sentence admitting the page cannot
   * answer its own question.
   */
  if (!gate) {
    return (
      <section className="aq-gate aq-gateunknown">
        <div className="aq-gate-head">
          <AlertTriangle size={15} aria-hidden />
          <p>
            <strong>The fleet’s state could not be read.</strong>{' '}
            <span className="aq-gate-sub">
              So this page cannot tell you whether anything is able to reach you. The queue below
              may be empty for a reason it cannot currently see
              {err ? <> — {err}</> : null}.
            </span>
          </p>
        </div>
      </section>
    )
  }

  const conditions = gate.conditions ?? []
  const unmet = conditions.filter((c) => !c.met)
  const fleetTools = gate.tools.filter((t) => t.isFleetTool)

  /*
   * The halt is a FAULT, not an unmet precondition, so it is the one thing on
   * this surface that earns a danger colour — and it uses the fleet's existing
   * `.acr-banner`, read-only, exactly as Activity does, rather than a fifth
   * palette. Placed ABOVE the readout per GOV.UK's notification-banner rule;
   * the readout still renders beneath it, because a halt does not make the
   * other conditions unknowable.
   */
  const halt = gate.halted ? (
    <div className="acr-banner err aq-halt" role="alert">
      <AlertTriangle size={14} aria-hidden />
      <span>
        <strong>The whole fleet is halted.</strong>{' '}
        {gate.haltReason ?? 'No reason was recorded.'} No worker runs at all until it is released
        on <Link href="/fleet/controls">Controls</Link>.
      </span>
    </div>
  ) : null

  /*
   * S2 ⇄ S3, settled in the study rather than left half-written: S2's size is a
   * function of the QUEUE, never of a toggle. On the day something is waiting,
   * the operator's attention belongs on the request and this shrinks itself.
   * That is also why there is no chevron — a disclosure whose correct state is
   * always "open" is not a disclosure.
   */
  if (waiting > 0) {
    return (
      <>
        {halt}
        <p className="aq-gate-line">
          <MinusCircle size={13} aria-hidden />
          {conditions.length - unmet.length} of {conditions.length} conditions met — nothing NEW
          can reach this queue yet.
        </p>
      </>
    )
  }

  // The open pipe. Never rendered anywhere in this fleet's history; designed
  // as one line, because it is a fact rather than an event.
  if (gate.canAnythingArrive) {
    const scheduled = conditions.find((c) => c.at)
    return (
      <>
        {halt}
        <p className="aq-gate-line ok">
          <CheckCircle2 size={13} aria-hidden />
          Ready — a worker can ask you
          {scheduled?.at ? <>, and the next chance is the weekly council {whenNext(scheduled.at)}</> : null}.
        </p>
      </>
    )
  }

  return (
    <>
      {halt}
      <section className="aq-gate" aria-labelledby="aq-gate-h">
        <div className="aq-gate-head">
          <MinusCircle size={15} aria-hidden />
          <p id="aq-gate-h">
            <strong>Nothing can reach this queue yet — and nothing is broken.</strong>{' '}
            <span className="aq-gate-sub">
              {conditions.length} things have to be true before a worker can ask you for anything.{' '}
              {conditions.length - unmet.length === 0
                ? 'None of them is.'
                : conditions.length - unmet.length === 1
                  ? 'One of them is.'
                  : `${conditions.length - unmet.length} of them are.`}
            </span>
          </p>
        </div>

        <ol className="aq-conds">
          {conditions.map((c) => (
            <ConditionRow
              key={c.key}
              condition={c}
              tools={c.key === 'action-can-run' ? fleetTools : []}
            />
          ))}
        </ol>

        {gate.outside.pending > 0 ? (
          <p className="aq-gate-foot">
            Separately, {gate.outside.pending} request{gate.outside.pending === 1 ? '' : 's'} from
            outside the fleet {gate.outside.pending === 1 ? 'is' : 'are'} waiting — those can
            genuinely change something, and they are listed at the foot of this page.
          </p>
        ) : null}
      </section>
    </>
  )
}

/* ── S4 · the empty state, which is this page ───────────────────────────── */

/**
 * NAF.AQ-S4R (study Part 14) — the queue's empty state.
 *
 * It replaces two elements that said different things about the same fact and
 * were **separated by the entire precedent panel**: an `.acr-fl-empty` at the
 * top of the card and an `.aq-emptywhy` orphaned below `<PrecedentPanel>`.
 *
 * The one that came first was FALSE. It read "Approvals appear here when a plan
 * passes the critic", and Part 1.1 of the study proves a plan that passes the
 * critic queues nothing — three independent structural walls. The locks file
 * warns every stream about that exact sentence. It was on this page, written by
 * this stream, above a line that contradicted it, on the section an operator
 * reads every single day. NN/g's finding is the cost: an inaccurate status
 * message makes a reader distrust the surface or abandon the task, which is
 * precisely what S2 exists to prevent.
 *
 * The second clause is READ FROM S2's conditions rather than recomposed here.
 * Two composers over one set of facts is the defect S2.a fixed at the API, and
 * re-introducing it in the client would be the same mistake one layer up.
 */
/**
 * NAF.AQ-S4R S4.b — the worked example.
 *
 * The approved AQ-S4 spec listed this last; the research moved it to the
 * centre, and the reason is specific to this queue rather than general: it
 * **cannot fill** until Phase F, so without an example the operator's FIRST
 * real approval would also be the first time they had ever seen the interface
 * it arrives in. Everything the onboarding literature says about starting from
 * something real rather than a blank workspace applies with more force when
 * "blank" is the state for months.
 *
 * Three properties, each deliberate:
 *
 * · **It is the REAL `ApprovalCard`**, not a screenshot and not a simplified
 *   mock. A mock-up would drift from the component the day either changed, and
 *   the whole point is that the operator has read the thing they will actually
 *   be given.
 * · **It is inert by construction, not by instruction.** `busy` already
 *   disables every control on the card, so nothing here can be clicked and no
 *   new prop was added to a component the real queue depends on.
 * · **It disappears the moment the fleet can produce real ones.** An example
 *   sitting under a working queue is clutter; an example over a queue that
 *   cannot fill is the only thing on screen worth reading.
 *
 * The fixture is the shape AQ.3 verified on production, so the numbers, the
 * entity names and the reversibility class are all ones this card has really
 * rendered. Nothing is fetched and nothing is seeded.
 */
const EXAMPLE_LABELS: FleetLabels = {
  campaigns: {},
  targets: {
    'example-target': {
      text: 'casco integrale',
      matchType: 'EXACT',
      campaignName: 'AIREON-IT-Generic',
      marketplace: 'IT',
    },
  },
}

function exampleApproval() {
  return {
    id: 'example',
    toolName: 'set-target-bid',
    charterKey: 'amazon-bid-tuner',
    riskTier: 'high',
    status: 'pending',
    args: { targetId: 'example-target', proposedBidCents: 84 },
    preview: {
    currentBidCents: 31,
    proposedBidCents: 84,
    effect: 'Raises what you pay per click on one keyword.',
    },
    /* Relative, not fixed. `new Date(0)` rendered "20674d ago" on the example
     card, which undoes the credibility the example exists to build; a hardcoded
     date would drift into the same problem more slowly. Minute granularity, so
     the server and client renders produce the same string. */
    requestedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 18 * 3_600_000).toISOString(),
    reason: null,
    trackRecord: null,
    }
}

function ExampleCard() {
  return (
    <div className="aq-example" role="group" aria-label="Example of a request. Not real.">
      <p className="aq-examplenote">
        <span className="aq-examplechip">Example</span>
        This is what a request will look like. It is not real, and nothing here can be decided.
      </p>
      {/* A <fieldset disabled> rather than trusting `busy`: `busy` disables the
          BUTTONS, and prod showed one <input> still live inside a card whose
          own caption says nothing here can be decided. A fieldset disables
          every form control it contains, including ones added later, and
          leaves the text readable — which `inert` would not. */}
      <fieldset disabled className="aq-examplebody">
        <ApprovalCard
          approval={exampleApproval()}
          labels={EXAMPLE_LABELS}
          workerName="Bid tuner"
          /* Inert by construction: `busy` disables every control on the card. */
          busy
          canExecute={false}
          onDecide={() => {}}
          onRecheck={async () => ({ stale: false, why: null })}
          onAmend={async () => ({ ok: false })}
          onSnooze={() => {}}
        />
      </fieldset>
    </div>
  )
}

function EmptyWaiting({ gate }: { gate: GateState | null }) {
  const conditions = gate?.conditions ?? []
  const met = conditions.filter((c) => c.met).length
  const blocked = Boolean(gate) && !gate!.canAnythingArrive

  return (
    <div className="aq-empty">
      <p className="aq-emptylede">
        Nothing is waiting for you{blocked ? ', and nothing can arrive yet' : ''}.
      </p>
      {/* Silent when the gate could not be read: S2 already renders that, and a
          second guess at it here would be a claim this component cannot back. */}
      {gate ? (
        <p className="aq-emptywhy">
          {blocked ? (
            <>
              The {conditions.length} conditions above have to be true first —{' '}
              {met === 0 ? 'none of them is' : met === 1 ? 'one of them is' : `${met} of them are`}
              .
            </>
          ) : (
            <>The fleet is running and has not asked for anything. That is the normal, quiet state.</>
          )}
        </p>
      ) : null}

      {/* Only while nothing can arrive. Once the fleet can produce real
          requests the example is clutter, and it goes without being told to. */}
      {blocked ? <ExampleCard /> : null}
    </div>
  )
}

/* ── S5 · waiting from outside the fleet ───────────────────────────────── */

interface OutsideRow {
  id: string
  toolName: string
  riskTier: string
  status: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  executeAfter: string | null
  reason: string | null
  decidedBy: string | null
  originKey: string | null
  canExecute: boolean
  trackRecord: null
}

/**
 * A parked row for the outside queue.
 *
 * Deliberately a second, smaller implementation of the shipped `ScheduledRow`:
 * that one is not exported, and this stream committed not to edit the file it
 * lives in while the Overview still renders it. AQ.3 moves the card into this
 * directory and the two become one — recorded here so the duplication is a
 * decision with an end date rather than an accident.
 */
function OutsideParked({
  row,
  busy,
  onUndo,
  onCommit,
}: {
  row: OutsideRow
  busy: boolean
  onUndo: (id: string) => void
  onCommit: (id: string) => void
}) {
  const until = row.executeAfter ? new Date(row.executeAfter).getTime() : 0
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)))
  const fired = useRef(false)

  useEffect(() => {
    if (!until) return
    const t = setInterval(() => {
      const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setLeft(secs)
      if (secs === 0 && !fired.current) {
        fired.current = true
        onCommit(row.id)
      }
    }, 500)
    return () => clearInterval(t)
  }, [until, row.id, onCommit])

  return (
    <div className="aq-outparked">
      <span className="aq-outparkedbody">
        {/* FX.1 again: `humanTool` here de-hyphenated the TOOL KEY, so a parked
            row read "Approved — set price". `toolCardFor` is the vocabulary the
            rest of this page already decides with. */}
        <strong>Approved — {toolCardFor(row.toolName).shortAsk}</strong>
        <span>
          {left > 0 ? (
            <>
              Running in {left} second{left === 1 ? '' : 's'} — the{' '}
              <Term k="undo-window">undo window</Term>. Nothing has happened yet.
            </>
          ) : (
            'Running now…'
          )}
        </span>
      </span>
      {left > 0 ? (
        <button className="acr-btn" disabled={busy} onClick={() => onUndo(row.id)}>
          <Undo2 size={13} /> Undo
        </button>
      ) : null}
    </div>
  )
}

function OutsideQueue({
  rows,
  labels,
  busy,
  expiryHours,
  producers,
  state,
  onRetry,
  onDecide,
  onUndo,
  onCommit,
  onRecheck,
  onAmend,
  onSnooze,
}: {
  rows: OutsideRow[]
  labels: FleetLabels
  busy: boolean
  expiryHours: number
  producers?: Array<{ key: string; enabled: boolean }>
  state: 'loading' | 'ok' | 'failed'
  onRetry: () => void
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onUndo: (id: string) => void
  onCommit: (id: string) => void
  onRecheck: (id: string) => Promise<{ stale: boolean; why: string | null }>
  onAmend: (id: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  onSnooze: (id: string, until: Date | null) => void
}) {
  /*
   * S5.4 — empty is the NORMAL state, and it has to earn its line.
   *
   * "Nothing is waiting" is not information. What an operator cannot learn
   * anywhere else is *what could arrive here and whether anything is armed to
   * send it* — and this section's producers are not behind S2's checklist.
   * S2's three conditions gate the FLEET's ability to ask; these two are crons
   * with their own switch, so S2's "nothing NEW can reach this queue yet" is
   * true today for a reason S2 does not measure. This line measures it.
   *
   * Every claim below is read from `AgentDefinition.enabled` via the same call
   * the cron makes (S5.4a). Nothing is asserted: with no `producers` payload —
   * an older API during a split deploy — the armed sentence is simply omitted
   * rather than guessed.
   */
  /* Not looked yet, and could-not-look, are both distinct from nothing-there.
     Neither may borrow the reassuring sentence. */
  if (state === 'loading') {
    return (
      <p className="aq-outnone">
        <Clock size={12} aria-hidden />
        <span>Checking whether anything is waiting from outside the fleet…</span>
      </p>
    )
  }
  if (state === 'failed') {
    return (
      <p className="aq-outnone aq-outfailed">
        <AlertTriangle size={12} aria-hidden />
        <span>
          <strong>Could not check whether anything is waiting from outside the fleet.</strong> These
          are the only requests that can change something on Amazon, so this is not the same as
          nothing being there.{' '}
          <button className="aq-outretry" onClick={onRetry}>
            Try again
          </button>
        </span>
      </p>
    )
  }

  if (rows.length === 0) {
    const known = producers ?? []
    const armed = known.filter((p) => p.enabled)
    const names = known.map((p) => originOf(p.key).name)
    return (
      <p className="aq-outnone">
        <ShieldCheck size={12} aria-hidden />
        <span>
          Nothing is waiting from outside the fleet. These would be the only requests on this page
          that can change something on Amazon — the fleet&apos;s own actions are{' '}
          <Term k="preview-only">describes only</Term>.
          {known.length > 0 ? (
            <>
              {' '}
              {sentenceCase(listNames(names))} can send them, and{' '}
              {armed.length === 0
                ? known.length === 1
                  ? 'it is switched off.'
                  : known.length === 2
                    ? 'both are switched off.'
                    : 'all of them are switched off.'
                : `${listNames(armed.map((p) => originOf(p.key).name))} ${
                    armed.length === 1 ? 'is' : 'are'
                  } switched on.`}
            </>
          ) : null}
        </span>
      </p>
    )
  }

  return (
    <section className="acr-card aq-outside-card" aria-labelledby="aq-out-h">
      {/*
       * S5.3 — a heading, not a disclosure.
       *
       * This was a full-width chevron button, the pattern S1 and S2 were both
       * rebuilt to remove. Here it was worse than a style inconsistency: this
       * section renders ONLY when something that can reach Amazon is waiting,
       * so the one moment it exists is the one moment it must not be
       * collapsible. Its own `useState(true)` already conceded that — a
       * control whose correct value is always the same is not a control, it is
       * a way to get the wrong one.
       *
       * Collapsing it also cost the heading its semantics: a <button> is not a
       * heading, so `aria-labelledby` pointed screen readers at a control
       * rather than at a name, and the section had no heading in the document
       * outline at all.
       */}
      <div className="aq-outhead">
        <AlertTriangle size={14} aria-hidden />
        <div className="aq-outheadbody">
          <h3 id="aq-out-h">
            {rows.length} request{rows.length === 1 ? '' : 's'} can actually change something on
            Amazon
          </h3>
          {/* The contrast sentence, and the reason this section exists, in the
              header rather than in a separate tinted box below it. The box was
              a second red surface inside an already-red card, which spent the
              alarm twice to say one thing. */}
          <p className="aq-outwhy">
            Everything above only describes what it would do. These do not: deciding one here
            records your name, gives you the same twenty-second{' '}
            <Term k="undo-window">undo window</Term>, and re-checks the facts before it runs.
            {/* `{' '}` and not a plain space — the space after a closing tag is
                stripped here; this paragraph already needed the idiom twice. */}
            {' '}
            Until this section existed they reached{' '}
            <strong>no screen at all</strong>{' '}
            and were thrown away after {expiryHours} hours.
          </p>
        </div>
      </div>

      <div className="aq-outbody">
        {rows.map((a) =>
            a.status === 'scheduled' ? (
              <OutsideParked
                key={a.id}
                row={a}
                busy={busy}
                onUndo={onUndo}
                onCommit={onCommit}
              />
            ) : (
              /*
               * S8.4 — no checkbox here, and that is a RULE, not an oversight.
               *
               * These are the only rows on the page that can reach Amazon. S6's
               * read-and-understood tick is per card because the sentence it
               * gates is per card, so a bulk approve would either bypass it or
               * ask for one tick covering several different consequences. This
               * section is decided one row at a time, on purpose.
               *
               * The rule is enforced server-side in `previewBulk` as well —
               * an executable row blocks a bulk approve wherever the ids come
               * from — so adding a checkbox here would not quietly work. It
               * would produce a refusal, which is the correct failure.
               */
              <div key={a.id} className="aq-outrow">
                {/* The name leads the sentence, so its capital is correct by
                    construction rather than by lower-casing a display string
                    and hoping nothing in it was a proper noun. */}
                <p className="aq-outorigin">
                  <strong>{sentenceCase(originOf(a.originKey).name)}</strong> asked for this —{' '}
                  {originOf(a.originKey).what}.
                </p>
                <ApprovalCard
                  approval={{
                    id: a.id,
                    toolName: a.toolName,
                    charterKey: null,
                    riskTier: a.riskTier,
                    status: a.status,
                    args: a.args,
                    preview: a.preview,
                    requestedAt: a.requestedAt,
                    expiresAt: a.expiresAt,
                    reason: a.reason,
                    trackRecord: null,
                  }}
                  labels={labels}
                  /* One source for the name, so the origin line above the card
                     and the card's own first words can never disagree. */
                  workerName={sentenceCase(originOf(a.originKey).name)}
                  busy={busy}
                  canExecute={a.canExecute}
                  onDecide={onDecide}
                  onRecheck={onRecheck}
                  onAmend={onAmend}
                  onSnooze={onSnooze}
                />
              </div>
            ),
          )}
      </div>
    </section>
  )
}

/* ── the page ──────────────────────────────────────────────────────────── */

export function ApprovalsClient() {
  const backend = getBackendUrl()
  /**
   * Deep links, contracted with the Assignments stream and needed by any
   * notification: `?assignment=<id>` lands the queue filtered to what one
   * assignment produced, `?item=<id>` to a single request.
   */
  const params = useSearchParams()
  const focusAssignment = params.get('assignment')
  const focusItem = params.get('item')

  const [view, setView] = useState<InboxView>('waiting')
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [counts, setCounts] = useState<InboxCounts>({ waiting: 0, decided: 0, expired: 0 })
  const [precedents, setPrecedents] = useState<PrecedentRow[]>([])
  const [labels, setLabels] = useState<FleetLabels>({ campaigns: {}, targets: {} })
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [gate, setGate] = useState<GateState | null>(null)
  const [outside, setOutside] = useState<OutsideRow[]>([])
  /* null until the outside fetch has resolved once — "we have not looked yet"
     is a different statement from "we looked and there is nothing". */
  const [outsideOk, setOutsideOk] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  /**
   * What a bulk decision actually did. Both bulk endpoints have always
   * returned `{done, of, failed[]}` and every client discarded it, so a
   * partial failure looked identical to a success: the page just reloaded and
   * some rows were still there. Partial failure is the NORMAL case when
   * writing to a rate-limited third-party API, and it deserves a sentence.
   */
  const [bulkResult, setBulkResult] = useState<{
    done: number
    of: number
    failed: string[]
    error?: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [a, pr, c, g, o] = await Promise.all([
      fetch(`${backend}/api/agent/fleet/approvals?view=${view}`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/precedents?limit=25`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/approvals/gate-state`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/approvals/outside`, { cache: 'no-store' }),
    ])
    if (!a.ok) throw new Error(`approvals: ${a.status}`)
    const aj = (await a.json()) as {
      approvals: ApprovalRow[]
      counts: InboxCounts
      labels?: FleetLabels
    }
    setApprovals(aj.approvals)
    setCounts(aj.counts)
    // AQ.3 — the API has always resolved these and every client threw them
    // away, which is why no card ever said WHICH campaign.
    setLabels(aj.labels ?? { campaigns: {}, targets: {} })
    if (pr.ok) setPrecedents(((await pr.json()) as { precedents: PrecedentRow[] }).precedents)
    if (c.ok) setCharters(((await c.json()) as { charters: CharterRow[] }).charters)
    // The gate state is the page's reason to exist, but it must never be able
    // to take the queue down with it.
    if (g.ok) setGate((await g.json()) as GateState)
    /*
     * AQ.2 — the only rows on this page that can reach Amazon.
     *
     * S5.5 — this endpoint needs its OWN outcome, and the two lines below are
     * why. `if (o.ok)` leaves `outside` at its previous value on failure —
     * `[]` on a first load — and `setErr(null)` then runs unconditionally, so
     * a 500 here rendered "Nothing is waiting from outside the fleet" with no
     * error anywhere on the page.
     *
     * For the one section that exists because these rows were invisible, a
     * failure that looks exactly like "all clear" is the original bug wearing
     * a new hat. It is tracked separately from `err`, which belongs to S2's
     * readout and should not be repainted by this fetch.
     */
    if (o.ok) {
      setOutside(((await o.json()) as { approvals: OutsideRow[] }).approvals)
      setOutsideOk(true)
    } else {
      setOutsideOk(false)
    }
    setErr(null)
    setLoading(false)
  }, [backend, view])

  const { asOf, refresh } = useVisibilityPoll(
    useCallback(async () => {
      try {
        await load()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        setLoading(false)
        throw e
      }
    }, [load]),
  )

  // Switching tab must refetch immediately rather than waiting for the poll.
  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  const post = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true)
      try {
        /*
         * The content-type is set ONLY when there is a body.
         *
         * Sending `content-type: application/json` with no body makes Fastify
         * reject the request before the handler ever runs —
         * `FST_ERR_CTP_EMPTY_JSON_BODY`, a flat 400. Three calls on this page
         * pass no body: **undo, commit and unsnooze**. All three were failing
         * silently, because the client fires them with `void post(...)` and
         * nothing reads the result.
         *
         * Consequence while it lasted: the 20-second window could not be taken
         * back from the UI at all, and the browser could not commit early — a
         * parked action just sat there until the 30-second maintenance sweep
         * picked it up. The undo LOOKED present and did nothing, which is worse
         * than not offering one.
         */
        const r = await fetch(`${backend}/api/agent/fleet/${path}`, {
          method: 'POST',
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        })
        const d = (await r.json().catch(() => null)) as
          | { error?: string; sentence?: string }
          | null
        if (!r.ok) setErr(d?.error ?? `${path}: ${r.status}`)
        return d
      } finally {
        setBusy(false)
      }
    },
    [backend],
  )

  const after = useCallback(async () => {
    refresh()
  }, [refresh])

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'reject', reason?: string) => {
      await post(`approvals/${id}/decide`, { decision, reason })
      await after()
    },
    [post, after],
  )

  /** AQ.3 — ask the server whether this approval still describes reality. */
  const recheck = useCallback(
    async (id: string) => {
      const r = await fetch(`${backend}/api/agent/fleet/approvals/${id}/recheck`, {
        method: 'POST',
      })
      if (!r.ok) return { stale: true, why: `the check could not run (${r.status})` }
      return (await r.json()) as { stale: boolean; why: string | null }
    },
    [backend],
  )

  /**
   * AQ.8 — supersede a proposal with the operator's own number. The server
   * re-runs the tool's own handler, so a refusal here is the tool's words.
   */
  const amend = useCallback(
    async (id: string, args: Record<string, unknown>) => {
      const r = await fetch(`${backend}/api/agent/fleet/approvals/${id}/amend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args }),
      })
      const d = (await r.json().catch(() => null)) as { error?: string } | null
      if (!r.ok) return { ok: false, error: d?.error ?? `edit failed (${r.status})` }
      refresh()
      return { ok: true }
    },
    [backend, refresh],
  )

  /** NAF.AQ — set aside, or bring back. */
  const snooze = useCallback(
    (id: string, until: Date | null) => {
      void post(`approvals/${id}/${until ? 'snooze' : 'unsnooze'}`, until ? { until: until.toISOString() } : undefined).then(after)
    },
    [post, after],
  )

  /** Which tools can actually do something — straight from the gate state. */
  const canExecute = useCallback(
    (toolName: string) => gate?.tools.find((t) => t.name === toolName)?.canExecute ?? false,
    [gate],
  )

  /**
   * What the queue actually shows: the deep-link filter, then ORDER BY
   * CONSEQUENCE rather than by arrival.
   *
   * Creation order is the wrong default and the study says so plainly — it puts
   * a €2 bid nudge above a budget doubling. Ranked by what a wrong answer
   * costs: irreversible first, then high risk, then euro exposure, and only
   * then age as the tie-break.
   */
  const visible = useMemo(() => {
    let rows = approvals
    if (focusItem) rows = rows.filter((a) => a.id === focusItem)
    if (focusAssignment) rows = rows.filter((a) => a.assignmentId === focusAssignment)
    if (view !== 'waiting') return rows

    const exposure = (a: ApprovalRow) => {
      const p = (a.preview ?? {}) as Record<string, any>
      if (typeof p.currentBidCents === 'number' && typeof p.proposedBidCents === 'number') {
        return Math.abs(p.proposedBidCents - p.currentBidCents)
      }
      const ch = p.changes?.['base price']
      if (ch && typeof ch.from === 'number' && typeof ch.to === 'number') {
        return Math.abs(Math.round((ch.to - ch.from) * 100))
      }
      return 0
    }
    const irreversible = (a: ApprovalRow) =>
      a.toolName === 'send-customer-message' || a.toolName === 'publish-listing' ? 1 : 0

    return [...rows].sort(
      (x, y) =>
        irreversible(y) - irreversible(x) ||
        (y.riskTier === 'high' ? 1 : 0) - (x.riskTier === 'high' ? 1 : 0) ||
        exposure(y) - exposure(x) ||
        new Date(x.requestedAt).getTime() - new Date(y.requestedAt).getTime(),
    )
  }, [approvals, view, focusItem, focusAssignment])

  const nameByKey = useMemo(() => new Map(charters.map((c) => [c.key, c.name])), [charters])

  // Names, never raw keys — and an honest fallback rather than "unknown".
  const nameOf = useCallback(
    (key: string | null) =>
      key
        ? /* `nameByKey` covers the seven CHARTERS and nothing else, so an
             unmapped key would open a card with lowercase machine text where a
             worker's name belongs. Sentence-cased for that reason. (The
             lowercase name actually seen on prod came in by the OUTSIDE path
             below, not through here — this is the same defect's other door.) */
          (nameByKey.get(key) ?? sentenceCase(key.replace(/[_-]+/g, ' ')))
        : 'An agent we cannot identify',
    [nameByKey],
  )

  return (
    <FleetPageShell
      title="Approvals"
      sub={<PageDescription />}
      /* S1.b — the header's right-hand slot, which this page could not reach
         while it hand-rolled its own header. Measured before the change: the
         row was 1614px wide with a single 397px child, so 1217px of it — 75% —
         was dead, while the teaching control sat in the page flow below,
         costing a row forever. Helios and Primer both reserve this slot for
         exactly one secondary control; this is it. */
      aside={
        <HowApprovalsWork
          expiryHours={gate?.expiry.hours ?? null}
          maintenanceSeconds={gate?.expiry.maintenanceSeconds ?? null}
        />
      }
    >
      {err ? (
        <p className="acr-fl-empty aq-err" role="alert">
          <AlertTriangle size={13} aria-hidden /> {err}
        </p>
      ) : null}

      <GateStateSection gate={gate} waiting={counts.waiting} loading={loading} err={err} />

      <section className="acr-card aq-queue" aria-label="Approvals">
        <div className="acr-cardhead">
          <h3>
            {view === 'waiting'
              ? 'Waiting for you'
              : view === 'decided'
                ? /* NOT "what you already decided" — every row in there today says
                     "nobody recorded" and is labelled pre-fleet, so the heading would
                     credit the operator with 18 decisions they never took. That is the
                     exact trust hazard the study names for day one. */
                  'The decision record'
                : 'Ran out of time'}
          </h3>
          <span className="acr-fl-sub aq-asof">
            {asOf ? (
              <>
                <Clock size={11} aria-hidden /> as of {asOf.toLocaleTimeString()}
              </>
            ) : (
              'loading…'
            )}
          </span>
        </div>

        <ViewTabs view={view} counts={counts} onChange={setView} />

        {bulkResult ? (
          <p
            className={`aq-bulkresult${bulkResult.failed.length || bulkResult.error ? ' partial' : ''}`}
            role="status"
          >
            {bulkResult.error ? (
              <>{bulkResult.error}</>
            ) : bulkResult.failed.length === 0 ? (
              <>All {bulkResult.done} went through.</>
            ) : (
              <>
                <strong>
                  {bulkResult.done} of {bulkResult.of} went through — {bulkResult.failed.length}{' '}
                  did not.
                </strong>{' '}
                {/* The reasons verbatim: a count alone tells the operator
                    something is wrong and nothing about what. */}
                {bulkResult.failed.slice(0, 4).join('; ')}
                {bulkResult.failed.length > 4 ? ` (+${bulkResult.failed.length - 4} more)` : ''}. The
                ones that did not are still in the list below.
              </>
            )}
            <button className="aq-bulkdismiss" onClick={() => setBulkResult(null)}>
              Dismiss
            </button>
          </p>
        ) : null}

        {loading ? (
          <div aria-busy="true" aria-label="Loading approvals">
            {[70, 70].map((h, i) => (
              <div key={i} className="dt-skeleton" style={{ height: h, marginBottom: 6 }} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          view === 'waiting' ? (
            <EmptyWaiting gate={gate} />
          ) : (
            <p className="aq-empty">
              {view === 'decided'
                ? 'No decision has been taken yet.'
                : 'Nothing has expired. A request that goes unanswered too long ends up here.'}
            </p>
          )
        ) : view === 'waiting' ? (
          <WaitingList
            rows={visible}
            labels={labels}
            nameOf={nameOf}
            busy={busy}
            canExecute={canExecute}
            onDecide={(id, d, reason) => void decide(id, d, reason)}
            onRejectAll={(charterKey, reason) => {
              void post('approvals/reject-all', { charterKey, reason }).then(after)
            }}
            onUndo={(id) => void post(`approvals/${id}/undo`).then(after)}
            onCommit={(id) => void post(`approvals/${id}/commit`).then(after)}
            onBulkPreview={async (ids, d) => {
              const r = (await post('approvals/bulk-preview', { ids, decision: d })) as unknown as {
                sentence?: string
                count?: number
                blockedReason?: string | null
              } | null
              /* S8.3 — the COUNT and the refusal FLAG come back too.
                 The count is the server's tally of what is actually decidable,
                 not `ids.length`, so the typed confirmation cannot name one
                 number while the sentence names another. And `blockedReason`
                 replaces the client's old regex over the server's prose: a
                 client that re-derives a server decision by matching its
                 wording is one copy edit away from offering an impossible
                 button. */
              return {
                sentence: r?.sentence ?? `This affects ${ids.length} actions.`,
                count: typeof r?.count === 'number' ? r.count : ids.length,
                blocked: !!r?.blockedReason,
              }
            }}
            onBulkDecide={(ids, d, reason) => {
              void post('approvals/bulk-decide', { ids, decision: d, reason }).then((r) => {
                const res = r as unknown as {
                  done?: number
                  of?: number
                  failed?: string[]
                  error?: string
                } | null
                if (res) {
                  setBulkResult({
                    done: res.done ?? 0,
                    of: res.of ?? ids.length,
                    failed: res.failed ?? [],
                    error: res.error,
                  })
                }
                return after()
              })
            }}
            onRecheck={recheck}
            onAmend={amend}
            onSnooze={snooze}
          />
        ) : (
          <RecordList rows={visible} nameOf={nameOf} />
        )}

        <PrecedentPanel precedents={precedents} nameOf={nameOf} />

      </section>

      <OutsideQueue
        rows={outside}
        labels={labels}
        busy={busy}
        expiryHours={gate?.expiry.hours ?? 24}
        producers={gate?.outside.producers}
        state={outsideOk === null ? 'loading' : outsideOk ? 'ok' : 'failed'}
        onRetry={() => void refresh()}
        onDecide={(id, d, reason) => void decide(id, d, reason)}
        onUndo={(id) => void post(`approvals/${id}/undo`).then(after)}
        onCommit={(id) => void post(`approvals/${id}/commit`).then(after)}
        onRecheck={recheck}
        onAmend={amend}
        onSnooze={snooze}
      />
    </FleetPageShell>
  )
}
