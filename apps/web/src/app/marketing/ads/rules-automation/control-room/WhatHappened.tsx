'use client'

/**
 * CR rebuild 6 — History › What happened (was the Activity tab), on the design system.
 *
 * Three questions, in the order a weekly reviewer asks them: what did automation do this week (the same builder as the
 * Monday e-mail, so the screen and the inbox cannot disagree) · the weekly e-mail itself · each automated change, with
 * the reason, the evidence and Undo. Every write asks first: Undo and Send now open the design system's confirmation.
 *
 * Not a second change log: the full account log (with every person's changes, filters and export) is one link away.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, Search, Send, Undo2 } from 'lucide-react'
import { Button, Input, Pill, type Tone } from '@/design-system/primitives'
import { Banner, Card, Disclosure, KeyValue, Listbox, MetricStrip, useActionConfirm, type ListboxOption } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { ChangeValue } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import Link from '@/lib/workspaces/Link'
import {
  changeLine, changeMatches, changedOn, controlChangeWords, declinedNote, deliveryWords, digestSendImpact, digestSendResult, digestState, evidenceWords,
  makersOf, ruleLevelWord, spendLimitWords, undoImpact, undoResult, weekTiles, whoMade,
  ALL_MAKERS, type Change, type ChangeFilter, type ControlChange, type Digest, type DigestRule,
} from './historyWords'
import { agoWords, whenWords } from './timeWords'
import { tabHref } from './roomTabs'
import styles from './history.module.css'

const ACCENT: Record<Tone, string> = {
  success: 'var(--nds-success)', info: 'var(--nds-info)', warning: 'var(--nds-warning)', danger: 'var(--nds-danger)', neutral: 'var(--nds-border-strong)',
}

const dash = (n: number) => (n ? n.toLocaleString('en-IE') : '—')

const CONTROL_COLUMNS: Array<Column<ControlChange>> = [
  { key: 'when', label: 'When', render: (c) => <>{whenWords(c.at)}</> },
  { key: 'who', label: 'Who', render: (c) => <>{c.by}</> },
  { key: 'what', label: 'What', render: (c) => <>{c.what}</> },
  { key: 'change', label: 'Change', render: (c) => <>{controlChangeWords(c)}</> },
]

const RULE_COLUMNS: Array<Column<DigestRule>> = [
  { key: 'rule', label: 'Rule', render: (r) => <>{r.name}</> },
  { key: 'level', label: 'Level', render: (r) => <>{ruleLevelWord(r.level)}</> },
  { key: 'acted', label: 'Acted', numeric: true, render: (r) => <>{dash(r.acted)}</> },
  { key: 'proposed', label: 'Asked you', numeric: true, render: (r) => <>{dash(r.proposed)}</> },
  { key: 'applied', label: 'You applied', numeric: true, render: (r) => <>{dash(r.applied)}</> },
  { key: 'denied', label: 'You declined', numeric: true, render: (r) => <>{dash(r.denied)}</> },
  { key: 'failed', label: 'Failed', numeric: true, render: (r) => (r.failed > 0 ? <Pill tone="danger" size="sm">{r.failed}</Pill> : <>—</>) },
]

/** The week's summary: tiles, the breaker, graduation, the busiest rules. */
function ThisWeek({ d }: { d: Digest }) {
  const g = d.graduation
  const declined = declinedNote(d.totals.declined)
  const spend = spendLimitWords(d.breaker)
  return (
    <div className={styles.stack}>
      <MetricStrip metrics={weekTiles(d).map((t) => ({ label: t.label, value: t.value, hint: t.hint, accent: ACCENT[t.tone] }))} />
      {/* Bid moves are counted, never priced: said once, so the budget figure is not read as the whole effect. */}
      <p className={`${styles.para} ${styles.muted}`}>{d.effect.note}</p>

      {d.breaker.tripsThisWeek.length > 0 && (
        <Banner tone="danger" title={`The breaker stopped automation ${d.breaker.tripsThisWeek.length === 1 ? 'once' : `${d.breaker.tripsThisWeek.length} times`} this week`}>
          <ul className={styles.list}>
            {d.breaker.tripsThisWeek.map((t) => <li key={t.at}>{whenWords(t.at)} — {t.reason}</li>)}
          </ul>
          <p className={styles.para}>{d.breaker.tripNote}</p>
        </Banner>
      )}
      {spend && (
        <Banner
          tone="info"
          title={spend.title}
          action={<Button asChild size="sm" variant="secondary"><Link href={tabHref('limits', 'brakes')}>Open Account brakes</Link></Button>}
        >
          {spend.text}
        </Banner>
      )}

      {g.ready > 0 && <Banner tone="success" title={`${g.ready} ${g.ready === 1 ? 'rule is' : 'rules are'} ready for Auto`}>{g.readyNames.join(' · ')}</Banner>}
      {g.ready === 0 && g.unseen > 0 && (
        <Banner tone="neutral" title={`${g.unseen} ${g.unseen === 1 ? 'rule never asked' : 'rules never asked'} you anything`}>
          {g.unseenNames.join(' · ')} — so no evidence can build up for Auto.
        </Banner>
      )}

      {d.rules.length > 0 && (
        <DataGrid<DigestRule> ariaLabel="The busiest rules this week" rows={d.rules.slice(0, 12)} rowKey={(r) => r.ruleId} columns={RULE_COLUMNS} />
      )}
      {d.rules.length > 12 && <p className={`${styles.para} ${styles.muted}`}>{d.rules.length - 12} more rules ran this week. The 12 busiest are shown.</p>}
      {declined && <p className={`${styles.para} ${styles.muted}`}>{declined}</p>}
    </div>
  )
}

export function WhatHappened() {
  const [rows, setRows] = useState<Change[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [digest, setDigest] = useState<Digest | null>(null)
  const [digestErr, setDigestErr] = useState<string | null>(null)
  const [filter, setFilter] = useState<ChangeFilter>({ search: '', who: ALL_MAKERS })
  const [busy, setBusy] = useState<string | null>(null)
  const [results, setResults] = useState<ReadonlyMap<string, { ok: boolean; text: string }>>(new Map())
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<{ ok: boolean; text: string } | null>(null)
  // CR — who moved the controls (levels, Stop, brakes, "Automation may change it"): a person's moves, not automation's.
  const [controls, setControls] = useState<ControlChange[] | null>(null)
  const [controlsErr, setControlsErr] = useState<string | null>(null)
  const confirm = useActionConfirm()

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes?source=automation&limit=60`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`The changes could not be read (${r.status}).`)
      const j = await r.json()
      setRows(Array.isArray(j?.items) ? (j.items as Change[]) : [])
      setErr(null)
    } catch (e) { setErr((e as Error).message) }
    try {
      const c = await fetch(`${getBackendUrl()}/api/advertising/control-room/control-changes?days=7&limit=60`, { cache: 'no-store' })
      if (!c.ok) throw new Error(`The changes to the controls could not be read (${c.status}).`)
      const j = await c.json()
      setControls(Array.isArray(j?.rows) ? (j.rows as ControlChange[]) : [])
      setControlsErr(null)
    } catch (e) { setControlsErr((e as Error).message) }
    // The summary is a separate read and fails soft: the change list must show whether or not the week can be summed.
    try {
      const w = await fetch(`${getBackendUrl()}/api/advertising/digest/weekly?mode=current`, { cache: 'no-store' })
      if (!w.ok) throw new Error(`(${w.status})`)
      setDigest((await w.json()) as Digest)
      setDigestErr(null)
    } catch (e) { setDigest(null); setDigestErr((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])

  const sendNow = useCallback(async (gates: Digest['gates']) => {
    if (sending || !(await confirm.ask(digestSendImpact(gates)))) return
    setSending(true); setSent(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/digest/weekly/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'previous' }),
      })
      setSent(digestSendResult(await r.json().catch(() => null), r.status))
    } catch (e) { setSent({ ok: false, text: (e as Error).message }) } finally { setSending(false) }
  }, [confirm, sending])

  /** The server re-checks everything (window, already undone, whether it reached Amazon); its words are shown as said. */
  const undo = useCallback(async (c: Change) => {
    if (!c.undoActionLogId || busy || !(await confirm.ask(undoImpact(c)))) return
    setBusy(c.id)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes/${c.undoActionLogId}/undo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'undone from the Control Room history' }),
      })
      const result = undoResult(r.ok, r.status, await r.json().catch(() => null))
      setResults((m) => new Map(m).set(c.id, result))
      if (result.ok) await load()
    } catch (e) {
      setResults((m) => new Map(m).set(c.id, { ok: false, text: (e as Error).message }))
    } finally { setBusy(null) }
  }, [busy, confirm, load])

  const shown = useMemo(() => (rows ?? []).filter((c) => changeMatches(c, filter)), [rows, filter])
  const makerOptions = useMemo<ListboxOption[]>(
    () => [{ value: ALL_MAKERS, label: 'Made by anyone' }, ...makersOf(rows ?? []).map((m) => ({ value: m, label: m }))],
    [rows],
  )

  const columns = useMemo<Array<Column<Change>>>(() => [
    { key: 'when', label: 'When', render: (c) => <span title={whenWords(c.at)}>{agoWords(c.at)}</span> },
    { key: 'who', label: 'Made by', render: (c) => <>{whoMade(c)}</> },
    { key: 'on', label: 'On', render: (c) => <span className={styles.wrap}>{changedOn(c)}</span> },
    { key: 'change', label: 'Change', render: (c) => <ChangeValue changes={[changeLine(c)]} /> },
    {
      key: 'amazon', label: 'Amazon',
      render: (c) => {
        const d = deliveryWords(c.delivery)
        return d ? <span title={c.delivery?.lastError ?? undefined}><Pill tone={d.tone} size="sm">{d.label}</Pill></span> : <>—</>
      },
    },
    {
      key: 'why', label: 'Why',
      render: (c) => {
        const ev = evidenceWords(c.evidence)
        return (
          <span className={styles.wrap}>
            {c.reason ?? '—'}
            {ev && <span className={styles.sub}>{ev.text}{ev.thin && <> <Pill tone="warning" size="sm">thin</Pill></>}</span>}
          </span>
        )
      },
    },
    {
      key: 'undo', label: 'Undo', className: styles.undoCol,
      render: (c) => {
        const result = results.get(c.id)
        return (
          <span className={styles.wrap}>
            {c.undoable && c.undoActionLogId
              ? <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => void undo(c)}><Undo2 size={13} aria-hidden /> {busy === c.id ? 'Undoing…' : 'Undo…'}</Button>
              : <span className={styles.muted}>{c.undoBlockedReason ?? 'Cannot be undone here'}</span>}
            {result && <span className={styles.sub}><Pill tone={result.ok ? 'success' : 'danger'} size="sm">{result.text}</Pill></span>}
          </span>
        )
      },
    },
  ], [busy, results, undo])

  return (
    <div className={styles.stack}>
      {confirm.element}

      <Card header="This week" description={digest ? `${digest.window.label}${digest.window.complete ? '' : ' · still running'}` : undefined}>
        {digest
          ? <ThisWeek d={digest} />
          : digestErr
            ? <Banner tone="warning" title="This week’s summary could not be built" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>
              {digestErr} The list of changes below does not depend on it.
            </Banner>
            : <span className={styles.muted}>Summing up this week…</span>}
      </Card>

      {digest && (() => {
        const state = digestState(digest.gates)
        return (
          <Card header={state.title} description={state.text}>
            <div className={styles.stack}>
              <div className={styles.row}>
                <Button asChild size="sm" variant="secondary">
                  <a href={`${getBackendUrl()}/api/advertising/digest/weekly/preview?mode=previous`} target="_blank" rel="noopener noreferrer">
                    <Eye size={13} aria-hidden /> Preview last week’s e-mail
                  </a>
                </Button>
                <Button size="sm" variant="secondary" disabled={sending} onClick={() => void sendNow(digest.gates)}>
                  <Send size={13} aria-hidden /> {sending ? 'Working…' : state.sendWords}
                </Button>
              </div>
              {sent && <Banner tone={sent.ok ? 'success' : 'danger'} title={sent.text} />}
              <Disclosure summary="Technical details">
                <KeyValue
                  items={[
                    { label: digest.gates.cronFlag, value: digest.gates.cronEnabled ? 'on' : 'not set' },
                    { label: digest.gates.outboundFlag, value: digest.gates.outboundEnabled ? 'on' : 'not on' },
                    { label: 'What the server says', value: digest.gates.explanation },
                  ]}
                />
              </Disclosure>
            </div>
          </Card>
        )
      })()}

      <Card
        header="Changes to the controls"
        description="Who moved a level, Stop now, the brakes or a campaign’s “Automation may change it” — the last 7 days."
      >
        {controlsErr
          ? (
            <Banner tone="danger" title="The changes to the controls could not be read" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>
              {controlsErr}
            </Banner>
          )
          : !controls
            ? <span className={styles.muted}>Reading…</span>
            : controls.length === 0
              ? <span className={styles.muted}>No one changed the controls in the last 7 days.</span>
              : <DataGrid<ControlChange> ariaLabel="Changes to the controls" rows={controls} rowKey={(c) => c.id} columns={CONTROL_COLUMNS} />}
      </Card>

      <Card
        header="What automation did"
        description={rows ? (rows.length === 0 ? 'No automated changes yet' : `The last ${rows.length} automated ${rows.length === 1 ? 'change' : 'changes'}`) : undefined}
      >
        <div className={styles.stack}>
          {err && (
            <Banner tone="danger" title="The changes could not be read" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>
              {err}
            </Banner>
          )}
          {rows && rows.length > 0 && (
            <div className={styles.row}>
              <Input
                size="sm"
                type="search"
                aria-label="Search the changes"
                placeholder="Search the changes"
                leadingIcon={<Search size={14} aria-hidden />}
                value={filter.search}
                onChange={(e) => setFilter({ ...filter, search: e.target.value })}
              />
              <Listbox size="sm" width={220} ariaLabel="Made by" options={makerOptions} value={filter.who} onChange={(v) => setFilter({ ...filter, who: v })} />
              {(filter.search || filter.who !== ALL_MAKERS) && <span className={styles.muted}>Showing {shown.length} of {rows.length}</span>}
            </div>
          )}
          {rows === null && !err
            ? <span className={styles.muted}>Reading…</span>
            : rows && (
              <DataGrid<Change>
                ariaLabel="What automation did"
                rows={shown}
                rowKey={(c) => c.id}
                columns={columns}
                emptyState={rows.length === 0
                  ? 'No automated changes yet. That is a real state, not an error: every engine may be off, or have nothing to change.'
                  : 'No change matches. Clear the search to see them all.'}
              />
            )}
        </div>
      </Card>

      <p className={`${styles.para} ${styles.muted}`}>
        This list shows automated changes only. The{' '}
        <Link href="/marketing/ads/changelog">full account change log</Link>{' '}
        also has every person’s changes, filters, Undo and export.
      </p>
    </div>
  )
}
