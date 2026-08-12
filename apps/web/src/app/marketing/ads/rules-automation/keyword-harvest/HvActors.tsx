'use client'

/**
 * HV.6 — the actors: who else can do this, and what will they actually do?
 *
 * The page's third question. HV.1–HV.4 answer *which terms have earned a keyword*; HV.5 answers
 * *did the last batch work*. This answers the one an operator asks before trusting either.
 *
 * 🔴 **READ-ONLY.** It renders a governance truth and changes no level, no rule and no code path.
 * That is deliberate: HV.4's first live write is still pending, and this panel's whole value is
 * that it can be trusted about what happens without itself making anything happen. It therefore
 * renders NO dial and NO ceiling control — `ModeNotches` takes an `onSet` and is an editor; it
 * lives on Automations, which owns all three (C1, C2, C3). Every row links out to it.
 *
 * ── The two halves ──────────────────────────────────────────────────────────────────────────
 *
 * The census is straightforward and no surface has it: nine actors, their level beside their
 * ceiling, and what each has actually written. The second half is the differentiating one —
 * **what a rule says, beside what will actually be evaluated** — and no surface in this system
 * has ever rendered it.
 *
 * ── The sentence this panel exists for ──────────────────────────────────────────────────────
 *
 * Every RULE carrying `promote_to_exact` or `harvest_and_negate` is capped at PROPOSE by
 * `ads-graduation.ts`, whose own comment says these actions create things that "must be reaped by
 * someone". **The ENGINE performing the identical action had no ceiling applied to it at all** —
 * it was gated only by a global switch on another page, shared with every other engine, until HV.0
 * added a flag on 2026-08-12. Seven rules held at Propose; one engine that was not.
 *
 * ── Three things it must never do ───────────────────────────────────────────────────────────
 *
 *  1. **Never render `dryRun` or `enabled` as a mode.** Four words, from `resolveAutonomy` (C1),
 *     and never a level without its ceiling (C2).
 *  2. **Never render a daily cap as a live brake.** `maxExecutionsPerDay` is not enforced and the
 *     693,704 `DAILY_CAP_EXCEEDED` rows are residue — newest 2026-08-03. They render as history.
 *  3. **Never read a success counter as a write count.** `neg=8/8 grad=14/14` counts candidates
 *     PROCESSED. `wrote` comes from the audit log; `landed` from an Amazon id.
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Info, ExternalLink } from 'lucide-react'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { getBackendUrl } from '@/lib/backend-url'
import type { HvSlotProps } from './slot-contract'

type Level = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'
type ActorType = 'engine' | 'rule' | 'operator'

/** The four words, and nothing else may render as a mode. Same labels as `ModeNotches`. */
const LEVEL_LABEL: Record<Level, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Propose', AUTO: 'Auto' }
const RANK: Level[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']

interface Gap {
  id: string; title: string; detail: string
  affected: number | null; affectedLabel: string | null; defersTo: string
}
interface Actor {
  id: string; type: ActorType; name: string; what: string
  level: Level; ceiling: Level; ceilingReason: string; blockedBy: string[]
  heldBy: { flag: string; set: boolean; effect: string } | null
  registryDisagrees: { says: string; why: string } | null
  trigger: string | null; schedule: string | null
  actionTypes: string[]; writes: boolean
  scope: { kind: string; name: string | null }
  found: { n: number; label: string; caveat: string } | null
  wrote: number; landed: number | null
  outcomes: { acted: number; proposed: number; refused: number; failed: number; refusedIsHistorical: boolean; refusedNewest: string | null }
  stated: string | null
  executed: Array<{ text: string; source: string }>
  gaps: Gap[]
  lastRunAt: string | null; lastRunSummary: string | null; href: string | null
}
interface ActorsPayload {
  accountDial: { level: Level; halted: boolean; note: string }
  actors: Actor[]
  reach: { campaigns: number; writable: number; unreachable: number; note: string }
  conflicts: { available: false; why: string }
  latent: Gap[]
  window: { since: string | null; note: string }
}

const num = (n: number) => n.toLocaleString('en-IE')
const day = (iso: string) => { const d = new Date(iso); return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}` }

const TYPE_LABEL: Record<ActorType, string> = { engine: 'engine', rule: 'rule', operator: 'you' }

/**
 * A number that has never been anything else renders as a dash with its reason, not as 0.
 *
 * House law, and it is load-bearing here: `acted = 0` on a rule that has proposed 6,529 times means
 * something completely different from `acted = 0` on the engine, which has no execution rows at all
 * because it is a cron. Four zeroes on the engine's row would be a lie in the other direction.
 */
function Count({ n, dash }: { n: number | null; dash?: string }) {
  if (n == null) return <span className="h10-hva-dash" title={dash}>—</span>
  return <b className="h10-hva-n">{num(n)}</b>
}

/** Level beside ceiling, always together (C2). Never a control — this panel writes nothing. */
function LevelCell({ a }: { a: Actor }) {
  const capped = RANK.indexOf(a.level) >= RANK.indexOf(a.ceiling) && a.ceiling !== 'AUTO'
  return (
    <span className="h10-hva-lvl">
      <b className={`lv ${a.level.toLowerCase()}`}>{LEVEL_LABEL[a.level]}</b>
      <i title={a.ceilingReason}>{capped ? 'at its ceiling' : `ceiling ${LEVEL_LABEL[a.ceiling]}`}</i>
    </span>
  )
}

export function HvActors({ scope, push }: HvSlotProps) {
  const open = scope.actors === true
  const focused = scope.actor ?? null
  const [data, setData] = useState<ActorsPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let dead = false
    setLoading(true); setErr(null)
    const url = `${getBackendUrl()}/api/advertising/keyword-harvest?market=${encodeURIComponent(scope.market)}&actors=1`
    // 🔴 `no-store`. This route serves up to 60s stale, and a cached body made six probes report
    // failures that were not there.
    fetch(url, { credentials: 'include', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (!dead) setData(j.actors ?? null) })
      .catch((e) => { if (!dead) setErr(e instanceof Error ? e.message : 'failed') })
      .finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true }
  }, [open, scope.market])

  const summary = useMemo(() => {
    if (!data) return null
    const auto = data.actors.filter((a) => a.level === 'AUTO' && a.type !== 'operator').length
    const wrote = data.actors.filter((a) => a.wrote > 0).length
    return { total: data.actors.length, auto, wrote }
  }, [data])

  /** Not an automation rule ⇒ no execution record. A dash with its reason, never four zeroes. */
  const noRecord = 'Not an automation rule, so it has no execution record. Its record is what it wrote.'

  const columns: GridColumn<Actor>[] = useMemo(() => [
    { key: 'level', label: 'Level', metric: false, sortValue: (a) => RANK.indexOf(a.level), render: (a) => <LevelCell a={a} /> },
    {
      key: 'scope', label: 'Scope', metric: false, sortValue: (a) => a.scope.kind,
      render: (a) => <span className="h10-hva-scope">{a.scope.kind === 'account' ? 'whole account' : `${a.scope.kind}${a.scope.name ? ` \u00b7 ${a.scope.name}` : ''}`}</span>,
    },
    {
      key: 'found', label: 'Found', tip: 'Candidates its last run processed \u2014 never writes made.',
      sortValue: (a) => a.found?.n ?? null,
      render: (a) => (a.found
        ? <span className="h10-hva-found" title={a.found.caveat}><b>{num(a.found.n)}</b><i>{a.found.label}</i></span>
        : <Count n={null} dash="This actor keeps no candidate count of its own." />),
    },
    {
      key: 'wrote', label: 'Wrote', tip: 'Keywords and negatives it has created, counted from the audit log \u2014 never from a handler\u2019s success counter.',
      sortValue: (a) => a.wrote, render: (a) => <Count n={a.wrote} />,
    },
    {
      key: 'landed', label: 'Landed', tip: 'Of those, how many carry an Amazon id. The rest exist only in our database.',
      sortValue: (a) => a.landed ?? null,
      render: (a) => (a.landed == null
        ? <Count n={null} dash="It has written nothing, so there is nothing that could have landed." />
        : <span className={`h10-hva-landed${a.landed < a.wrote ? ' short' : ''}`} title={a.landed < a.wrote ? `${num(a.wrote - a.landed)} exist only in our database and will never do anything` : undefined}>{num(a.landed)}</span>),
    },
    // \ud83d\udd34 C7 \u2014 four columns, not one. A percentage or a merged "activity" figure would be the
    // defect this contract exists to prevent: a refusal is not a failure, and a proposal is not
    // an action.
    { key: 'acted', label: 'Acted', tip: 'Executions that succeeded. Not the same as writes \u2014 see Wrote.', sortValue: (a) => (a.type === 'rule' ? a.outcomes.acted : null), render: (a) => (a.type === 'rule' ? <Count n={a.outcomes.acted} /> : <Count n={null} dash={noRecord} />) },
    { key: 'proposed', label: 'Proposed', tip: 'A proposal is not an action.', sortValue: (a) => (a.type === 'rule' ? a.outcomes.proposed : null), render: (a) => (a.type === 'rule' ? <Count n={a.outcomes.proposed} /> : <Count n={null} dash={noRecord} />) },
    {
      key: 'refused', label: 'Refused', tip: 'Its own daily cap declining to run it. A refusal is not a failure, and this cap is not enforced \u2014 these are historical rows.',
      sortValue: (a) => (a.type === 'rule' ? a.outcomes.refused : null),
      render: (a) => {
        if (a.type !== 'rule') return <Count n={null} dash={noRecord} />
        if (a.outcomes.refused === 0) return <Count n={0} />
        return (
          <span className="h10-hva-ref" title={a.outcomes.refusedIsHistorical ? `Nothing since ${a.outcomes.refusedNewest ? day(a.outcomes.refusedNewest) : 'weeks ago'} \u2014 this is history, not a brake in force.` : 'Refused recently.'}>
            {num(a.outcomes.refused)}{a.outcomes.refusedIsHistorical ? <i>historical</i> : null}
          </span>
        )
      },
    },
    { key: 'failed', label: 'Failed', tip: 'Executions that errored, with the cap refusals taken out.', sortValue: (a) => (a.type === 'rule' ? a.outcomes.failed : null), render: (a) => (a.type === 'rule' ? <Count n={a.outcomes.failed} /> : <Count n={null} dash={noRecord} />) },
    {
      key: 'gaps', label: 'What it runs', metric: false, sortValue: (a) => a.gaps.length,
      render: (a) => (
        <button type="button" className={`h10-hva-open${focused === a.id ? ' on' : ''}`} onClick={() => push({ actor: focused === a.id ? '' : a.id })}>
          {focused === a.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {a.gaps.length > 0 ? <><AlertTriangle size={11} /> {a.gaps.length} gap{a.gaps.length === 1 ? '' : 's'}</> : 'what it runs'}
        </button>
      ),
    },
  ], [focused, push])

  // Hidden, not disabled. Closed, it is one line the operator can open — never a control that
  // looks live and is not.
  if (!open) {
    return (
      <div className="h10-hva-shut">
        <button type="button" className="h10-hva-toggle" onClick={() => push({ actors: '1' })}>
          <ChevronRight size={13} /> Who else can harvest here
        </button>
        <span>Every actor that can create a keyword or a negative in this scope, what holds it there, and what it has actually written.</span>
      </div>
    )
  }

  return (
    <section className="h10-am-card h10-hva-wrap">
      <header className="h10-hva-head">
        <div>
          <button type="button" className="h10-hva-toggle on" onClick={() => push({ actors: '', actor: '' })}>
            <ChevronDown size={13} /> Who else can harvest here
          </button>
          {summary ? (
            <p className="h10-hva-lede">
              <b>{summary.total} actors</b> can create a keyword or a negative in this scope.{' '}
              {summary.auto === 0
                ? <>None of them is on <b>Auto</b>.</>
                : <><b>{summary.auto}</b> {summary.auto === 1 ? 'is' : 'are'} on <b>Auto</b>.</>}{' '}
              {summary.wrote === 0
                ? 'None has ever written anything.'
                : <><b>{summary.wrote}</b> of them {summary.wrote === 1 ? 'has' : 'have'} ever written anything.</>}
            </p>
          ) : null}
        </div>
        {data ? (
          <span className="h10-hva-dial" title={data.accountDial.note}>
            <i>account dial</i>
            <b>{LEVEL_LABEL[data.accountDial.level]}</b>
            {data.accountDial.halted ? <em>halted</em> : null}
          </span>
        ) : null}
      </header>

      {/* 🔴 The finding the panel exists for, stated once and at the top. */}
      {data ? (
        <p className="h10-hva-thesis">
          <AlertTriangle size={13} />
          <span>
            Every <b>rule</b> here is held at <b>Propose</b> by the same ceiling, because creating a
            keyword or a negative leaves something behind that a person has to reap. The{' '}
            <b>engine</b> doing the identical thing had no ceiling applied to it at all — it was
            gated only by a global switch shared with every other engine, until{' '}
            <code>NEXUS_ADS_AUTO_HARVEST_ARMED</code> was added on 12 Aug 2026.
          </span>
        </p>
      ) : null}

      <AdsDataGrid<Actor>
        rows={data?.actors ?? []}
        columns={columns}
        rowId={(a) => a.id}
        noun="Actor"
        firstColLabel="Actor"
        firstSortValue={(a) => a.name}
        renderFirst={(a) => (
          <span className="h10-hva-name">
            <b>{a.name}</b>
            <span className={`tag ${a.type}`}>{TYPE_LABEL[a.type]}</span>
            {a.what ? <i>{a.what}</i> : null}
          </span>
        )}
        loading={loading}
        defaultSort={{ key: 'wrote', dir: 'desc' }}
        // 🔴 The grid selects by default. This panel writes nothing and has no selection action, so
        // a checkbox on every row is a control that looks live and is not — the exact defect the
        // closed state of this section was shaped to avoid.
        selectable={false}
        emptyNode={<ActorsEmpty loading={loading} err={err} data={data} />}
      />

      {focused && data ? <ActorDetail actor={data.actors.find((a) => a.id === focused) ?? null} /> : null}

      {data ? (
        <div className="h10-hva-foot">
          <p className="h10-hva-reach"><Info size={12} /> {data.reach.note}</p>
          <p className="h10-hva-note">{data.window.note}{data.window.since ? ` Oldest execution on record: ${day(data.window.since)}.` : ''}</p>

          <h4 className="h10-hva-h4">Conflicts</h4>
          <p className="h10-hva-note">{data.conflicts.why}</p>

          <h4 className="h10-hva-h4">Not firing yet</h4>
          <p className="h10-hva-note">
            Real in the code, no victim in this account today. Each is counted rather than assumed,
            so a zero here is a measurement and not an omission.
          </p>
          <ul className="h10-hva-latent">
            {data.latent.map((g) => (
              <li key={g.id}>
                <b>{g.title}</b>
                {g.affected != null ? <span className="n">{num(g.affected)} {g.affectedLabel}</span> : null}
                <i>{g.detail}</i>
                <em>{g.defersTo} closes it. This panel changes nothing.</em>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

/** What a rule says, beside what will actually be evaluated. The half nothing has ever rendered. */
function ActorDetail({ actor }: { actor: Actor | null }) {
  if (!actor) return null
  return (
    <div className="h10-hva-detail">
      <div className="cols">
        <div className="col">
          <h5>What it says</h5>
          {actor.stated
            ? <code className="h10-hva-code">{actor.stated}</code>
            : <p className="h10-hva-none">Nothing. Its stored criteria are empty — there is no sentence here to read.</p>}
        </div>
        <div className="col">
          <h5>What actually bounds the run</h5>
          {actor.executed.length === 0
            ? <p className="h10-hva-none">Nothing beyond what it says.</p>
            : (
              <ul className="h10-hva-exec">
                {actor.executed.map((e, i) => (
                  <li key={i}><span>{e.text}</span><i>{e.source}</i></li>
                ))}
              </ul>
            )}
        </div>
      </div>

      {actor.heldBy ? (
        <p className="h10-hva-held">
          <b>{actor.heldBy.flag}</b> is {actor.heldBy.effect}. The account dial is a ceiling over
          every actor, and it is not what is holding this one down — this flag is.
        </p>
      ) : null}

      {actor.registryDisagrees ? (
        <p className="h10-hva-clash">
          <AlertTriangle size={13} />
          <span>
            The Control Room lists this engine as <b>{actor.registryDisagrees.says}</b>.{' '}
            {actor.registryDisagrees.why} Handed to that programme — this page changes nothing.
          </span>
        </p>
      ) : null}

      {actor.lastRunSummary ? (
        <p className="h10-hva-note">
          Its last run reported <code>{actor.lastRunSummary}</code>
          {actor.lastRunAt ? ` on ${day(actor.lastRunAt)}` : ''}. Those are candidates{' '}
          <b>processed</b>, not writes made — the engine&rsquo;s own summary counts both the same way.
        </p>
      ) : null}

      {actor.gaps.length > 0 ? (
        <ul className="h10-hva-gaps">
          {actor.gaps.map((g) => (
            <li key={g.id}>
              <b>{g.title}</b>
              {g.affected != null ? <span className="n">{num(g.affected)} {g.affectedLabel}</span> : null}
              <i>{g.detail}</i>
              <em>{g.defersTo} closes it. This panel changes nothing.</em>
            </li>
          ))}
        </ul>
      ) : null}

      {actor.href ? (
        <a className="h10-hva-link" href={actor.href}>
          Change its level on Automations <ExternalLink size={11} />
        </a>
      ) : null}
    </div>
  )
}

/**
 * Four empty states, never one string (D4).
 *
 * "It failed", "it is still loading", "there is nothing to show" and "nothing matched" are four
 * different facts, and the first two must never render as the third.
 */
function ActorsEmpty({ loading, err, data }: { loading: boolean; err: string | null; data: ActorsPayload | null }) {
  if (err) {
    return (
      <span className="h10-rr-empty">
        <AlertTriangle size={26} />
        <b>The actor list could not be read.</b>
        <i>{err} — this is a failure to load, not an empty account. Nothing below it has been measured.</i>
      </span>
    )
  }
  if (loading) return <span className="h10-rr-empty"><i>Reading the rules, the engine and the audit log…</i></span>
  if (!data) return <span className="h10-rr-empty"><i>Not loaded yet.</i></span>
  return (
    <span className="h10-rr-empty">
      <b>No actor can create a keyword or a negative here.</b>
      <i>Every harvest rule is scoped away from this market, and the engine is off. Nothing will
        appear in the Candidates view from automation.</i>
    </span>
  )
}
