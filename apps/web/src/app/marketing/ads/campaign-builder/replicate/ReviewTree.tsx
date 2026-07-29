'use client'

/**
 * AX3.4 — the review step: every campaign, ad group and target, editable.
 *
 * Nothing here mutates a plan. The plan belongs to the server; this collects an
 * EDIT SET addressed by plan id, which the server replays onto a freshly-built
 * plan and re-gates. So the screen always shows the server's current answer, and
 * an edit can never smuggle a keyword past the self-competition check.
 *
 * Conflicts are shown INLINE on the offending keyword rather than in a separate
 * table, because that is where the decision actually gets made — you are looking
 * at the keyword, its bid and the campaign it would fight, at the same time.
 */
import { useMemo, useState } from 'react'
import {
  ChevronDown, ChevronRight, Layers, Trash2, RotateCcw, Plus, AlertTriangle, Undo2, Search,
} from 'lucide-react'
import { Modal } from '@/design-system/components'
import { Button, Input, Radio, Textarea } from '@/design-system/primitives'
import type { Plan, PlanEdits } from './replicate-types'

/** A target's match type, without the negative marker the blueprint carries. */
const matchOf = (t: { expressionType: string; kind: string; autoClause?: string | null }) =>
  t.kind?.toUpperCase() === 'AUTO'
    ? (t.autoClause ?? 'auto').replace(/_/g, ' ').toLowerCase()
    : (t.expressionType ?? '').toUpperCase().replace(/^_/, '').toLowerCase()

export function ReviewTree({
  plan, edits, setEdits, conflictDecisions, setConflictDecisions,
}: {
  plan: Plan
  edits: PlanEdits
  setEdits: (e: PlanEdits) => void
  conflictDecisions: Record<string, 'skip' | 'accept'>
  setConflictDecisions: (d: Record<string, 'skip' | 'accept'>) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [openAg, setOpenAg] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [addTo, setAddTo] = useState<string | null>(null)
  const [rename, setRename] = useState<{ kind: 'campaign' | 'adGroup'; id: string; current: string } | null>(null)
  const [bulk, setBulk] = useState<null | 'bid' | 'budget'>(null)

  const rmC = new Set(edits.removedCampaigns ?? [])
  const rmG = new Set(edits.removedAdGroups ?? [])
  const rmT = new Set(edits.removedTargets ?? [])
  const renC = new Map((edits.renamedCampaigns ?? []).map((e) => [e.id, e.name]))
  const renG = new Map((edits.renamedAdGroups ?? []).map((e) => [e.id, e.name]))
  const budC = new Map((edits.campaignBudgets ?? []).map((e) => [e.id, e.dailyBudget]))
  const bidG = new Map((edits.adGroupBids ?? []).map((e) => [e.id, e.defaultBidCents]))
  const bidT = new Map((edits.targetBids ?? []).map((e) => [e.id, e.bidCents]))
  const addedFor = useMemo(() => {
    const m = new Map<string, NonNullable<PlanEdits['addedTargets']>>()
    for (const a of edits.addedTargets ?? []) { const l = m.get(a.adGroupId) ?? []; l.push(a); m.set(a.adGroupId, l) }
    return m
  }, [edits.addedTargets])

  const touched =
    rmC.size + rmG.size + rmT.size + renC.size + renG.size + budC.size + bidG.size + bidT.size + (edits.addedTargets?.length ?? 0)

  const toggle = (s: Set<string>, set: (n: Set<string>) => void, id: string) => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); set(n)
  }
  const push = <K extends keyof PlanEdits>(key: K, val: NonNullable<PlanEdits[K]>) => setEdits({ ...edits, [key]: val })
  const toggleIn = (key: 'removedCampaigns' | 'removedAdGroups' | 'removedTargets', id: string) => {
    const cur = new Set(edits[key] ?? [])
    if (cur.has(id)) cur.delete(id); else cur.add(id)
    push(key, [...cur])
  }
  const setNamed = (key: 'renamedCampaigns' | 'renamedAdGroups', id: string, name: string) =>
    push(key, [...(edits[key] ?? []).filter((e) => e.id !== id), { id, name }])
  const setNum = (key: 'campaignBudgets', id: string, dailyBudget: number) =>
    push(key, [...(edits[key] ?? []).filter((e) => e.id !== id), { id, dailyBudget }])
  const setAgBid = (id: string, defaultBidCents: number) =>
    push('adGroupBids', [...(edits.adGroupBids ?? []).filter((e) => e.id !== id), { id, defaultBidCents }])
  const setTBid = (id: string, bidCents: number) =>
    push('targetBids', [...(edits.targetBids ?? []).filter((e) => e.id !== id), { id, bidCents }])

  const needle = q.trim().toLowerCase()
  const matches = (s: string) => !needle || s.toLowerCase().includes(needle)

  const nameOfC = (c: Plan['campaigns'][number]) => renC.get(c.id) ?? c.name
  const budgetOfC = (c: Plan['campaigns'][number]) => (budC.has(c.id) ? budC.get(c.id)! : (c.dailyBudget ?? 0))

  return (
    <div className="h10-rep-review">
      <div className="h10-rep-review-top">
        <div className="h10-rep-search">
          <Search size={15} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by campaign, ad group or keyword" aria-label="Filter the plan" />
        </div>
        <button type="button" className="h10-rep-bulkbtn" onClick={() => setBulk('bid')}>Set all bids</button>
        <button type="button" className="h10-rep-bulkbtn" onClick={() => setBulk('budget')}>Set all budgets</button>
        {touched > 0 && (
          <button type="button" className="h10-rep-undo" onClick={() => setEdits({})}>
            <Undo2 size={13} aria-hidden /> Undo all {touched} change{touched === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <div className="h10-rep-tree rev">
        {plan.campaigns.map((c) => {
          const cut = rmC.has(c.id)
          const isOpen = open.has(c.id) || !!needle
          const kept = c.adGroups.filter((g) => !rmG.has(g.id)).length
          const visible = matches(nameOfC(c)) || c.adGroups.some((g) => matches(g.name) || g.targets.some((t) => matches(t.expression)))
          if (!visible) return null
          return (
            <div className={`h10-rep-cwrap ${cut ? 'cut' : ''}`} key={c.id}>
              <div className="h10-rep-row cmp">
                <button type="button" className="exp" onClick={() => toggle(open, setOpen, c.id)} aria-expanded={isOpen} aria-label={isOpen ? 'Collapse' : 'Expand'}>
                  {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <button type="button" className="nmbtn" onClick={() => setRename({ kind: 'campaign', id: c.id, current: nameOfC(c) })} title="Rename">
                  <b>{nameOfC(c)}</b>
                  {renC.has(c.id) && <span className="tag edited">renamed</span>}
                  {c.targetingType === 'AUTO' && <span className="tag auto">auto</span>}
                </button>
                <span className="meta">
                  {kept} ad group{kept === 1 ? '' : 's'}
                  <label className="inl">
                    <span>€</span>
                    <input inputMode="decimal" value={String(budgetOfC(c))} aria-label={`Daily budget for ${nameOfC(c)}`}
                      onChange={(e) => setNum('campaignBudgets', c.id, Number(e.target.value) || 0)} />
                    <span>/day</span>
                  </label>
                </span>
                <button type="button" className={`cutbtn ${cut ? 'on' : ''}`} onClick={() => toggleIn('removedCampaigns', c.id)}
                  aria-label={cut ? `Restore ${nameOfC(c)}` : `Remove ${nameOfC(c)}`}>
                  {cut ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                </button>
              </div>

              {isOpen && !cut && c.adGroups.map((g) => {
                const gcut = rmG.has(g.id)
                const gOpen = openAg.has(g.id) || !!needle
                const added = addedFor.get(g.id) ?? []
                const live = g.targets.filter((t) => !rmT.has(t.id)).length + added.length
                return (
                  <div key={g.id} className={gcut ? 'cut' : ''}>
                    <div className="h10-rep-row ag">
                      <button type="button" className="exp" onClick={() => toggle(openAg, setOpenAg, g.id)} aria-expanded={gOpen} aria-label={gOpen ? 'Collapse targets' : 'Expand targets'}>
                        {gOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <button type="button" className="nmbtn" onClick={() => setRename({ kind: 'adGroup', id: g.id, current: renG.get(g.id) ?? g.name })} title="Rename">
                        <Layers size={12} aria-hidden /> {renG.get(g.id) ?? g.name}
                        {renG.has(g.id) && <span className="tag edited">renamed</span>}
                      </button>
                      <span className="meta">
                        {live} target{live === 1 ? '' : 's'} · {g.asins.length} ads
                        <label className="inl">
                          <span>bid €</span>
                          <input inputMode="decimal" value={((bidG.get(g.id) ?? g.defaultBidCents ?? 0) / 100).toFixed(2)} aria-label={`Default bid for ${g.name}`}
                            onChange={(e) => setAgBid(g.id, Math.round((Number(e.target.value) || 0) * 100))} />
                        </label>
                      </span>
                      <button type="button" className="addbtn" onClick={() => setAddTo(g.id)} aria-label={`Add targets to ${g.name}`}><Plus size={13} /></button>
                      <button type="button" className={`cutbtn ${gcut ? 'on' : ''}`} onClick={() => toggleIn('removedAdGroups', g.id)}
                        aria-label={gcut ? `Restore ${g.name}` : `Remove ${g.name}`}>
                        {gcut ? <RotateCcw size={14} /> : <Trash2 size={14} />}
                      </button>
                    </div>

                    {gOpen && !gcut && (
                      <>
                        {g.targets.filter((t) => matches(t.expression)).map((t) => {
                          const tcut = rmT.has(t.id)
                          const conflict = t.conflictsWith?.length ? t.conflictsWith : null
                          const decision = conflictDecisions[t.expression.toLowerCase()]
                          return (
                            <div className={`h10-rep-row tgt ${tcut ? 'cut' : ''} ${conflict && !decision ? 'conflict' : ''}`} key={t.id}>
                              <span className="exp-sp" />
                              <span className="nm">
                                <code>{t.expression}</code>
                                <span className={`tag ${t.isNegative ? 'neg' : ''}`}>{t.isNegative ? 'negative ' : ''}{matchOf(t)}</span>
                              </span>
                              {conflict && (
                                <span className="cf">
                                  <AlertTriangle size={12} aria-hidden />
                                  competes with {conflict.slice(0, 1).map((e) => e.campaignName).join('')}{conflict.length > 1 ? ` +${conflict.length - 1}` : ''}
                                  <button type="button" className={decision === 'skip' ? 'on' : ''}
                                    onClick={() => { setConflictDecisions({ ...conflictDecisions, [t.expression.toLowerCase()]: 'skip' }); if (!rmT.has(t.id)) toggleIn('removedTargets', t.id) }}>Drop it</button>
                                  <button type="button" className={decision === 'accept' ? 'on' : ''}
                                    onClick={() => setConflictDecisions({ ...conflictDecisions, [t.expression.toLowerCase()]: 'accept' })}>Keep it</button>
                                </span>
                              )}
                              {!t.isNegative && !conflict && (
                                <label className="inl bid">
                                  <span>€</span>
                                  <input inputMode="decimal" value={((bidT.get(t.id) ?? t.bidCents ?? g.defaultBidCents ?? 0) / 100).toFixed(2)} aria-label={`Bid for ${t.expression}`}
                                    onChange={(e) => setTBid(t.id, Math.round((Number(e.target.value) || 0) * 100))} />
                                </label>
                              )}
                              <button type="button" className={`cutbtn ${tcut ? 'on' : ''}`} onClick={() => toggleIn('removedTargets', t.id)}
                                aria-label={tcut ? `Restore ${t.expression}` : `Remove ${t.expression}`}>
                                {tcut ? <RotateCcw size={13} /> : <Trash2 size={13} />}
                              </button>
                            </div>
                          )
                        })}
                        {added.map((a, i) => (
                          <div className="h10-rep-row tgt added" key={`${g.id}.a${i}`}>
                            <span className="exp-sp" />
                            <span className="nm"><code>{a.expression}</code><span className="tag new">added</span><span className={`tag ${a.isNegative ? 'neg' : ''}`}>{a.isNegative ? 'negative ' : ''}{a.expressionType.toLowerCase()}</span></span>
                            <button type="button" className="cutbtn" aria-label={`Remove ${a.expression}`}
                              onClick={() => push('addedTargets', (edits.addedTargets ?? []).filter((x) => !(x.adGroupId === a.adGroupId && x.expression === a.expression && x.expressionType === a.expressionType)))}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                        {g.targets.length === 0 && added.length === 0 && (
                          <div className="h10-rep-row tgt empty"><span className="exp-sp" /><span className="nm">No targets — this ad group will not be created.</span></div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {addTo && <AddTargetsModal adGroupId={addTo} onClose={() => setAddTo(null)} onAdd={(rows) => { push('addedTargets', [...(edits.addedTargets ?? []), ...rows]); setAddTo(null) }} />}
      {rename && (
        <RenameModal
          current={rename.current}
          onClose={() => setRename(null)}
          onSave={(name) => { setNamed(rename.kind === 'campaign' ? 'renamedCampaigns' : 'renamedAdGroups', rename.id, name); setRename(null) }}
        />
      )}
      {bulk && (
        <BulkValueModal
          title={bulk === 'bid' ? 'Set every bid' : 'Set every daily budget'}
          label={bulk === 'bid' ? 'Bid' : 'Daily budget'}
          onClose={() => setBulk(null)}
          onApply={(v) => {
            const n = Number(v) || 0
            if (bulk === 'bid') {
              const cents = Math.max(2, Math.round(n * 100))
              setEdits({
                ...edits,
                adGroupBids: plan.campaigns.flatMap((c) => c.adGroups.map((g) => ({ id: g.id, defaultBidCents: cents }))),
                targetBids: plan.campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.targets.filter((t) => !t.isNegative).map((t) => ({ id: t.id, bidCents: cents })))),
              })
            } else {
              setEdits({ ...edits, campaignBudgets: plan.campaigns.map((c) => ({ id: c.id, dailyBudget: Math.max(1, n) })) })
            }
            setBulk(null)
          }}
        />
      )}
    </div>
  )
}

function RenameModal({ current, onClose, onSave }: { current: string; onClose: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState(current)
  return (
    <Modal open onClose={onClose} size="sm" title="Rename"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Save</Button></>}>
      <label className="h10-spw-bulk-field"><span className="l">Name</span>
        <Input value={v} onChange={(e) => setV(e.target.value)} autoFocus aria-label="Name" fieldClassName="h10-spw-bulk-txtfield" /></label>
      <p className="h10-spw-bulk-hint">Amazon will refuse a name that already exists — the preflight checks this before anything is created.</p>
    </Modal>
  )
}

function BulkValueModal({ title, label, onClose, onApply }: { title: string; label: string; onClose: () => void; onApply: (v: string) => void }) {
  const [v, setV] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title={title}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.trim()} onClick={() => onApply(v)}>Apply</Button></>}>
      <label className="h10-spw-bulk-field"><span className="l">{label}</span>
        <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="0.00" autoFocus aria-label={label} prefix="€" fieldClassName="h10-spw-bulk-numfield" /></label>
      <p className="h10-spw-bulk-hint">Applies to everything in the plan. Floored at €0.02.</p>
    </Modal>
  )
}

function AddTargetsModal({ adGroupId, onClose, onAdd }: {
  adGroupId: string
  onClose: () => void
  onAdd: (rows: NonNullable<PlanEdits['addedTargets']>) => void
}) {
  const [text, setText] = useState('')
  const [mt, setMt] = useState<'EXACT' | 'PHRASE' | 'BROAD'>('EXACT')
  const [neg, setNeg] = useState(false)
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
  return (
    <Modal open onClose={onClose} size="md" title={neg ? 'Add negative keywords' : 'Add keywords'}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!lines.length}
          onClick={() => onAdd(lines.map((expression) => ({ adGroupId, expression, expressionType: neg && mt === 'BROAD' ? 'EXACT' : mt, isNegative: neg })))}>
          Add {lines.length || ''}
        </Button></>}>
      <p className="h10-spw-bulk-note">
        Added keywords go through the <b>same self-competition check</b> as copied ones — anything that
        is not specific to this product and is already being bid on will surface as a conflict.
      </p>
      <div className="h10-spw-bulk-mt">
        <span className="lbl">Match type:</span>
        <Radio name="addmt" label="Exact" checked={mt === 'EXACT'} onChange={() => setMt('EXACT')} />
        <Radio name="addmt" label="Phrase" checked={mt === 'PHRASE'} onChange={() => setMt('PHRASE')} />
        {!neg && <Radio name="addmt" label="Broad" checked={mt === 'BROAD'} onChange={() => setMt('BROAD')} />}
      </div>
      <div className="h10-spw-bulk-mt">
        <span className="lbl">Kind:</span>
        <Radio name="addneg" label="Positive" checked={!neg} onChange={() => setNeg(false)} />
        <Radio name="addneg" label="Negative" checked={neg} onChange={() => { setNeg(true); if (mt === 'BROAD') setMt('EXACT') }} />
      </div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="One keyword per line" autoFocus aria-label="Keywords to add" />
    </Modal>
  )
}
