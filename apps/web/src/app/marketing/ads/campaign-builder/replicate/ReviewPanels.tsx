'use client'

/**
 * AX3.7 — the settings surfaces, and the change ledger.
 *
 * `applyBlueprint` sends nine things to Amazon that step 2 had no control over:
 * the bidding strategy, the three placement multipliers, per-ad-group products,
 * keyword text and match type. A campaign whose placement modifiers you cannot
 * see is not really being reviewed — every campaign in the source structure
 * carries top-of-search +75%, which is a large part of why it performs, and a
 * replica of it was being created sight-unseen.
 */
import { useState } from 'react'
import { Trash2, RotateCcw, Undo2, Plus, Layers } from 'lucide-react'
import { Modal, Drawer } from '@/design-system/components'
import { Button, Input, Radio, Textarea, Checkbox, Select } from '@/design-system/primitives'
import type { CampaignView, AdGroupView, Change } from './edit-model'
import type { PlanEdits } from './replicate-types'
import { PLACEMENTS, MAX_PLACEMENT_PCT, BIDDING_STRATEGIES } from './replicate-types'
import { InfoTip } from '../../campaigns/InfoTip'

const eur = (cents: number | null) => ((cents ?? 0) / 100).toFixed(2)

// ── campaign settings ─────────────────────────────────────────────────────

export function CampaignSettings({ c, onBudget, onStrategy, onPlacement, onRename, onRemove }: {
  c: CampaignView
  onBudget: (v: number) => void
  onStrategy: (v: string) => void
  onPlacement: (placement: string, pct: number) => void
  onRename: () => void
  onRemove: () => void
}) {
  const pct = (key: string) => c.placementBidding.find((p) => p.placement === key)?.percentage ?? 0
  return (
    <div className="h10-rep-settings">
      <div className="hd">
        <div className="ttl">
          <InfoTip tip="Click to rename. Amazon refuses two campaigns with the same name — the preflight checks this before anything is created.">
            <button type="button" className="nm" onClick={onRename}>{c.name}</button>
          </InfoTip>
          <InfoTip tip={c.targetingType === 'AUTO'
            ? 'Amazon chooses what this campaign targets. It comes from the source structure and cannot be changed by a copy.'
            : 'You choose what this campaign targets — the keywords and product targets below.'}>
            <span className={`tag ${c.targetingType === 'AUTO' ? 'auto' : ''}`}>{c.targetingType === 'AUTO' ? 'auto' : 'manual'}</span>
          </InfoTip>
        </div>
        <InfoTip tip={c.removed
          ? 'Put this campaign back into the plan.'
          : 'Leave this campaign out of the replication — its ad groups, targets and product ads with it. Reversible until you launch.'}>
          <button type="button" className={`cutbtn ${c.removed ? 'on' : ''}`} onClick={onRemove}>
            {c.removed ? <><RotateCcw size={13} /> Restore campaign</> : <><Trash2 size={13} /> Don’t create this campaign</>}
          </button>
        </InfoTip>
      </div>

      <div className="grid">
        <label className="fld">
          <span className="l">Daily budget <InfoTip tip="What this one campaign may spend per day." /></span>
          <Input inputMode="decimal" prefix="€" value={String(c.dailyBudget)} aria-label={`Daily budget for ${c.name}`}
            onChange={(e) => onBudget(Number(e.target.value) || 0)} fieldClassName="h10-rep-numfield" />
        </label>
        <label className="fld">
          <span className="l">Bidding strategy <InfoTip tip="How Amazon is allowed to move your bid in the auction." /></span>
          <Select value={c.biddingStrategy} aria-label={`Bidding strategy for ${c.name}`} onChange={(e) => onStrategy(e.target.value)}>
            {BIDDING_STRATEGIES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
          <span className="h">{BIDDING_STRATEGIES.find((s) => s.key === c.biddingStrategy)?.hint}</span>
        </label>
      </div>

      <div className="plc">
        <span className="l">
          Placement modifiers
          <InfoTip tip="A percentage on top of your bid for that placement. Copied from the source — and, until now, invisible here." />
        </span>
        <div className="row">
          {PLACEMENTS.map((p) => (
            <label className="fld" key={p.key}>
              <span className="l2">{p.label} <InfoTip tip={p.hint} /></span>
              <Input inputMode="numeric" suffix="%" value={String(pct(p.key))} aria-label={`${p.label} modifier for ${c.name}`}
                onChange={(e) => onPlacement(p.key, Math.max(0, Math.min(MAX_PLACEMENT_PCT, Number(e.target.value) || 0)))}
                fieldClassName="h10-rep-numfield" />
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── ad group settings ─────────────────────────────────────────────────────

export function AdGroupSettings({ g, allAsins, onBid, onAsins, onRename, onRemove, onAdd }: {
  g: AdGroupView
  allAsins: string[]
  onBid: (cents: number) => void
  onAsins: (asins: string[]) => void
  onRename: () => void
  onRemove: () => void
  onAdd: () => void
}) {
  const [prodOpen, setProdOpen] = useState(false)
  const on = new Set(g.asins)
  return (
    <div className="h10-rep-settings">
      <div className="hd">
        <div className="ttl">
          <Layers size={14} aria-hidden />
          <InfoTip tip="Click to rename this ad group."><button type="button" className="nm" onClick={onRename}>{g.name}</button></InfoTip>
        </div>
        <div className="acts">
          <InfoTip tip="Add keywords or negatives of your own to this ad group. Anything you add goes through the same self-competition check as a copied keyword.">
            <button type="button" className="ghost" onClick={onAdd}><Plus size={13} /> Add targets</button>
          </InfoTip>
          <InfoTip tip={g.removed
            ? 'Put this ad group back into the plan.'
            : 'Leave this ad group out. If it is the campaign’s only one, the campaign will not be created either.'}>
            <button type="button" className={`cutbtn ${g.removed ? 'on' : ''}`} onClick={onRemove}>
              {g.removed ? <><RotateCcw size={13} /> Restore</> : <><Trash2 size={13} /> Don’t create</>}
            </button>
          </InfoTip>
        </div>
      </div>

      <div className="grid">
        <label className="fld">
          <span className="l">Default bid <InfoTip tip="What a target in this ad group bids when it carries no bid of its own." /></span>
          <Input inputMode="decimal" prefix="€" value={eur(g.defaultBidCents)} aria-label={`Default bid for ${g.name}`}
            onChange={(e) => onBid(Math.round((Number(e.target.value) || 0) * 100))} fieldClassName="h10-rep-numfield" />
        </label>
        <div className="fld">
          <span className="l">Products advertised here <InfoTip tip="One product ad per product. Narrow this when an ad group should not carry the whole selection." /></span>
          <InfoTip tip="Choose which of the products you picked in step 1 this ad group advertises. One product ad per product. An ad group with none is created with nothing to advertise.">
            <button type="button" className="prodbtn" onClick={() => setProdOpen((o) => !o)}>
              {g.asins.length} of {allAsins.length} selected products
            </button>
          </InfoTip>
        </div>
      </div>

      {prodOpen && (
        <div className="prodlist">
          <div className="top">
            <button type="button" onClick={() => onAsins([...allAsins])}>All</button>
            <button type="button" onClick={() => onAsins([])}>None</button>
          </div>
          <div className="items">
            {allAsins.map((a) => (
              <Checkbox key={a} label={a} checked={on.has(a)}
                onChange={() => onAsins(on.has(a) ? g.asins.filter((x) => x !== a) : [...g.asins, a])} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── the change ledger ─────────────────────────────────────────────────────

export function ChangesDrawer({ open, onClose, changes, setEdits, onClearAll }: {
  open: boolean
  onClose: () => void
  changes: Change[]
  setEdits: (e: PlanEdits) => void
  onClearAll: () => void
}) {
  return (
    <Drawer open={open} onClose={onClose} title="Your changes"
      subtitle={changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'} to the copied structure` : undefined}
      footer={changes.length ? (
        <InfoTip tip="Throw away every edit and every conflict decision, returning the plan to the source structure as it was copied.">
          <Button onClick={onClearAll}><Undo2 size={14} /> Undo everything</Button>
        </InfoTip>
      ) : undefined}>
      {!changes.length ? (
        <p className="h10-rep-drawer-empty">
          Nothing changed yet — this replication would create the source structure exactly as it is,
          with the new product’s name and products.
        </p>
      ) : (
        <ul className="h10-rep-changes">
          {changes.map((c) => (
            <li key={c.key}>
              <div className="t">
                <span className="sc">{c.scope}</span>
                <span className="sb" title={c.subject}>{c.subject}</span>
              </div>
              <div className="d">{c.detail}</div>
              <InfoTip tip="Reverse just this one change and leave the rest as they are.">
                <button type="button" className="un" onClick={() => setEdits(c.undo)} aria-label={`Undo: ${c.subject} ${c.detail}`}>
                  <Undo2 size={12} aria-hidden /> Undo
                </button>
              </InfoTip>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  )
}

// ── modals ────────────────────────────────────────────────────────────────

export function RenameModal({ current, what, onClose, onSave }: {
  current: string; what: string; onClose: () => void; onSave: (v: string) => void
}) {
  const [v, setV] = useState(current)
  return (
    <Modal open onClose={onClose} size="sm" title={`Rename ${what}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Save</Button></>}>
      <label className="h10-spw-bulk-field"><span className="l">Name</span>
        <Input value={v} onChange={(e) => setV(e.target.value)} autoFocus aria-label="Name" fieldClassName="h10-spw-bulk-txtfield" /></label>
      <p className="h10-spw-bulk-hint">Amazon will refuse a name that already exists — the preflight checks this before anything is created.</p>
    </Modal>
  )
}

export function BulkValueModal({ title, label, hint, onClose, onApply }: {
  title: string; label: string; hint: string; onClose: () => void; onApply: (v: string) => void
}) {
  const [v, setV] = useState('')
  return (
    <Modal open onClose={onClose} size="sm" title={title}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!v.trim()} onClick={() => onApply(v)}>Apply</Button></>}>
      <label className="h10-spw-bulk-field"><span className="l">{label}</span>
        <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="0.00" autoFocus aria-label={label} prefix="€" fieldClassName="h10-spw-bulk-numfield" /></label>
      <p className="h10-spw-bulk-hint">{hint}</p>
    </Modal>
  )
}

export function AddTargetsModal({ adGroupName, onClose, onAdd }: {
  adGroupName: string
  onClose: () => void
  onAdd: (rows: Array<{ expression: string; expressionType: string; isNegative: boolean }>) => void
}) {
  const [text, setText] = useState('')
  const [mt, setMt] = useState<'EXACT' | 'PHRASE' | 'BROAD'>('EXACT')
  const [neg, setNeg] = useState(false)
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
  return (
    <Modal open onClose={onClose} size="md" title={neg ? 'Add negative keywords' : 'Add keywords'}
      footer={<><Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!lines.length}
          onClick={() => onAdd(lines.map((expression) => ({ expression, expressionType: neg && mt === 'BROAD' ? 'EXACT' : mt, isNegative: neg })))}>
          Add {lines.length || ''}
        </Button></>}>
      <p className="h10-spw-bulk-note">
        Into <b>{adGroupName}</b>. Added keywords go through the <b>same self-competition check</b> as copied
        ones — anything that is not specific to this product and is already being bid on will surface as a conflict.
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

export function MatchTypeModal({ count, onClose, onApply }: {
  count: number; onClose: () => void; onApply: (mt: string) => void
}) {
  const [mt, setMt] = useState<'EXACT' | 'PHRASE' | 'BROAD'>('EXACT')
  return (
    <Modal open onClose={onClose} size="sm" title={`Match type for ${count} target${count === 1 ? '' : 's'}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onApply(mt)}>Apply</Button></>}>
      <div className="h10-spw-bulk-mt">
        <Radio name="bulkmt" label="Exact" checked={mt === 'EXACT'} onChange={() => setMt('EXACT')} />
        <Radio name="bulkmt" label="Phrase" checked={mt === 'PHRASE'} onChange={() => setMt('PHRASE')} />
        <Radio name="bulkmt" label="Broad" checked={mt === 'BROAD'} onChange={() => setMt('BROAD')} />
      </div>
      <p className="h10-spw-bulk-hint">
        Negatives in the selection stay exact or phrase — Amazon does not accept a broad negative, and one
        set that way is dropped at create time rather than rejected.
      </p>
    </Modal>
  )
}
