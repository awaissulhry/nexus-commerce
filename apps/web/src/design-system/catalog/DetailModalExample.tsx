'use client'

import { useRef, useState } from 'react'

import { Button, Input, Tag } from '../primitives'
import { Field, KeyValue, type TabItem } from '../components'
import { DetailModal, ReviewChangesModal, type ReviewState } from '../patterns'
import { NexusGrid, textColumn, type ColDef } from '../grid'

/*
 * 2026-10-10 — bid page polish round 2: a row's detail in a centered dialog. Made-up rules. Verify:
 *  - Open a rule: 1160 px wide, header + tabs fixed, the body scrolls (Settings is long); on a phone (≤ 760 px) a
 *    full-screen sheet. The dialog has the focus first (its title is read), Tab goes to Archive…, ▲, ▼, Close, the tabs.
 *  - ▲ / ▼ and K / J walk the rules ("2 of 4"); ▲ on the first and ▼ on the last are held and say why. J typed in the
 *    Note field stays a letter. Rule D's read fails: the body says so with Try again.
 *  - Archive… opens the review ABOVE the detail; Esc closes only the review and the focus is back on Archive…. Save →
 *    Done says "1 archived"; Undo → "1 undone" (never "1 saved").
 *  - Esc closes the detail; the focus goes to the rule button of the rule on show (after ▼, the next one).
 *  - History is a `plain` grid: no ⋮ on its headers, columns to the edge, no empty band under its three rows.
 *  - The dialog is as tall as its tab (Overview is short); Settings grows it, going back keeps that height (no jump);
 *    the header never moves. Overview's labels are sentence case (`KeyValue labelCase="sentence"`).
 */
interface Rule { id: string; name: string; line: string; mode: string; fails?: boolean }
const RULES: Rule[] = [
  { id: 'a', name: 'Rule A', line: 'If ACoS > 30 % over 14 d → lower the bid 10 %', mode: 'Watch' },
  { id: 'b', name: 'Rule B', line: 'If no orders after 20 clicks → bid to the floor', mode: 'Ask me' },
  { id: 'c', name: 'Rule C', line: 'If ACoS < 10 % over 7 d → raise the bid 5 %', mode: 'Auto' },
  { id: 'd', name: 'Rule D', line: 'If spend > budget by noon → lower bids 20 %', mode: 'Off', fails: true },
]
interface Change { id: string; when: string; what: string; change: string }
const HISTORY: Change[] = [
  { id: 'h1', when: '10 Oct, 06:00', what: 'Keyword A', change: 'Bid lowered 10 %' },
  { id: 'h2', when: '9 Oct, 06:00', what: 'Keyword B', change: 'Bid lowered 10 %' },
  { id: 'h3', when: '8 Oct, 06:00', what: 'Keyword A', change: 'Bid lowered 10 %' },
]
// `plain` (polish round 2, S11): no header ⋮, the columns fill the width, as tall as its three rows.
const HISTORY_COLUMNS: ColDef<Change>[] = [
  { colId: 'when', headerName: 'When', width: 140, ...textColumn<Change>('when') },
  { colId: 'what', headerName: 'Keyword', width: 160, ...textColumn<Change>('what') },
  { colId: 'change', headerName: 'Change', width: 180, ...textColumn<Change>('change') },
]
/** A stable row id (GDS §8.5: no inline callbacks on NexusGrid). */
const historyRowId = (p: { data: Change }) => p.data.id

const TABS: TabItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'history', label: 'History', count: 3 },
  { id: 'settings', label: 'Settings' },
]

export function DetailModalExample() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [tab, setTab] = useState('overview')
  const [loading, setLoading] = useState(false)
  const [review, setReview] = useState<ReviewState | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undone, setUndone] = useState(false)
  const [note, setNote] = useState('')
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const rule = RULES.find((r) => r.id === openId)

  const show = (id: string) => {
    setOpenId(id)
    setLoading(true)
    setTimeout(() => setLoading(false), 350)
  }
  const save = () => {
    setReview({ phase: 'saving' })
    setTimeout(() => setReview({ phase: 'done', results: { [openId ?? '']: { ok: true, words: 'Archived' } } }), 500)
  }
  const undo = () => {
    setUndoing(true)
    setTimeout(() => { setUndoing(false); setUndone(true); setReview({ phase: 'done', results: { [openId ?? '']: { ok: true, words: `Undone: ${rule?.mode ?? ''}` } } }) }, 500)
  }

  return (
    <section id="detail-modal-example" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-8)' }}>
      {RULES.map((r) => (
        <Button key={r.id} ref={(el) => { if (el) buttons.current.set(r.id, el); else buttons.current.delete(r.id) }} onClick={() => { setTab('overview'); show(r.id) }}>
          {r.name}
        </Button>
      ))}
      <DetailModal
        open={!!rule}
        onClose={() => setOpenId(null)}
        title={rule?.name ?? ''}
        subtitle={rule?.line}
        meta={rule && <><Tag tone="info">{rule.mode}</Tag><Tag>IT</Tag></>}
        actions={<Button size="sm" onClick={() => { setUndone(false); setReview({ phase: 'ready' }) }}>Archive…</Button>}
        tabs={TABS}
        activeTab={tab}
        onTabChange={setTab}
        nav={rule ? { ids: RULES.map((r) => r.id), current: rule.id, onGo: show, noun: 'rule' } : undefined}
        loading={loading}
        error={!loading && rule?.fails ? 'Rule D could not be read.' : undefined}
        onRetry={() => rule && show(rule.id)}
        returnFocusTo={() => (openId ? buttons.current.get(openId) : null)}
      >
        {tab === 'overview' && (
          <KeyValue labelCase="sentence" items={[{ label: 'Mode', value: rule?.mode }, { label: 'Runs', value: 'Daily · 06:00' }, { label: 'Bids changed · 7 d', value: '4' }]} />
        )}
        {tab === 'history' && <NexusGrid<Change> plain rowData={HISTORY} columnDefs={HISTORY_COLUMNS} getRowId={historyRowId} />}
        {tab === 'settings' && (
          <div style={{ display: 'grid', gap: 'var(--nds-space-8)' }}>
            <Field label="Note" hint="Type J or K here: it stays a letter.">
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            {Array.from({ length: 24 }, (_, i) => <p key={i} style={{ margin: 0 }}>Setting {i + 1}</p>)}
          </div>
        )}
      </DetailModal>
      <ReviewChangesModal
        open={!!review}
        onClose={() => setReview(null)}
        title="Archive"
        changes={rule ? [{ id: rule.id, where: rule.name, what: 'Status', now: 'Active', next: 'Archived' }] : []}
        state={review ?? { phase: 'ready' }}
        saveLabel="Archive 1 rule"
        doneVerb="archived"
        onSave={save}
        onUndo={review?.phase === 'done' && !undone ? undo : undefined}
        undoing={undoing}
      />
    </section>
  )
}
