'use client'

/**
 * AX3.5 — preflight and launch.
 *
 * The last screen before real campaigns exist. It states what will be created,
 * what will NOT be (the copy scope's exclusions, and anything the gate is still
 * refusing), what it commits per day, and how it goes out.
 *
 * The launch-mode control is the money decision. Landing at Amazon's 2c floor is
 * the default because spending should be the thing you opt into, not the thing
 * you forget to opt out of — and it is a floor, never a pause, because pausing
 * disrupts Amazon's optimisation and forces re-learning.
 */
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, TrendingUp, Save } from 'lucide-react'
import { Modal } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import type { Plan, CopyScope } from './replicate-types'
import { COPY_ITEMS } from './replicate-types'

export interface LaunchResult {
  applicationId: string
  status: 'PLANNED' | 'APPLIED' | 'PARTIAL' | 'FAILED'
  created: { campaigns: number; adGroups: number; targets: number; negatives: number; productAds: number }
  skippedNonKeyword: number
  notOnAmazon: string[]
  errors: string[]
}

export function LaunchStep({
  plan, scope, market, launchMode, setLaunchMode, launching, result, err,
  onLaunch, onRollback, onRaise, onSaveBlueprint, busy,
}: {
  plan: Plan | null
  scope: CopyScope
  market: string
  launchMode: 'live' | 'floor'
  setLaunchMode: (m: 'live' | 'floor') => void
  launching: boolean
  result: LaunchResult | null
  err: string | null
  onLaunch: () => void
  onRollback: () => void
  onRaise: () => void
  onSaveBlueprint: (name: string) => void
  busy: boolean
}) {
  const [saveOpen, setSaveOpen] = useState(false)
  const [bpName, setBpName] = useState('')

  if (!plan) {
    return <div className="h10-spw-card h10-rep-todo">Finish step 1 first — a source, both product tokens, and at least one product.</div>
  }

  const t = plan.totals
  const unresolved = plan.conflicts.filter((c) => c.resolution === 'UNRESOLVED')
  const excludedItems = COPY_ITEMS.filter((i) => !scope[i.key])
  const ex = plan.excluded

  if (result) {
    return (
      <ResultPanel
        result={result} launchMode={launchMode} busy={busy}
        onRollback={onRollback} onRaise={onRaise}
        onSave={() => setSaveOpen(true)}
        saveOpen={saveOpen} setSaveOpen={setSaveOpen}
        bpName={bpName} setBpName={setBpName} onSaveBlueprint={onSaveBlueprint}
      />
    )
  }

  return (
    <div className="h10-rep-launch">
      <div className="h10-spw-card">
        <div className="h10-rep-tot">
          <Tot n={t.campaigns} l="campaigns" />
          <Tot n={t.adGroups} l="ad groups" />
          <Tot n={t.positives} l="targets" />
          <Tot n={t.negatives} l="negatives" />
          <Tot n={t.productAds} l="product ads" />
          <div className="spend">
            <span className="n">€{t.dailyBudgetTotal.toFixed(2)}</span>
            <span className="l">per day, if every campaign runs</span>
          </div>
        </div>
      </div>

      {plan.blockers.length > 0 && (
        <div className="h10-rep-note bad">
          <b><AlertTriangle size={14} aria-hidden /> Blocked — {plan.blockers.length} thing{plan.blockers.length === 1 ? '' : 's'} to resolve first</b>
          <ul>{plan.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          {unresolved.length > 0 && <p className="hint">The keyword conflicts are resolved in step 2, on the keywords themselves.</p>}
        </div>
      )}

      {plan.warnings.map((w) => (
        <div className="h10-rep-note warn" key={w}><AlertTriangle size={14} aria-hidden /> {w}</div>
      ))}

      {(excludedItems.length > 0 || ex.keywords + ex.negatives + ex.productTargets + ex.autoClauses > 0) && (
        <div className="h10-rep-note">
          <b>What will not be copied</b>
          <ul>
            {excludedItems.map((i) => <li key={i.key}>{i.label}</li>)}
            {ex.keywords > 0 && <li>{ex.keywords} keyword(s) from the source</li>}
            {ex.negatives > 0 && <li>{ex.negatives} negative(s) from the source</li>}
            {ex.productTargets > 0 && <li>{ex.productTargets} product/category target(s)</li>}
            {ex.autoClauses > 0 && <li>{ex.autoClauses} auto-targeting clause(s)</li>}
          </ul>
        </div>
      )}

      <div className="h10-spw-card h10-rep-mode">
        <b className="hd">How this goes out</b>
        <div className="opts">
          <label className={`opt ${launchMode === 'floor' ? 'on' : ''}`}>
            <input type="radio" name="launchmode" checked={launchMode === 'floor'} onChange={() => setLaunchMode('floor')} />
            <span className="t">
              <b>Land at the bid floor</b>
              <span className="h">
                Created and enabled at Amazon’s €0.02 minimum, with every planned bid remembered.
                The structure exists and syncs normally but cannot meaningfully spend. One click
                raises it to the planned bids when you are ready. <b>Never paused</b> — pausing
                disrupts Amazon’s optimisation.
              </span>
            </span>
          </label>
          <label className={`opt ${launchMode === 'live' ? 'on' : ''}`}>
            <input type="radio" name="launchmode" checked={launchMode === 'live'} onChange={() => setLaunchMode('live')} />
            <span className="t">
              <b>Go live now</b>
              <span className="h">
                Created at the planned bids and budgets. This commits{' '}
                <b>€{t.dailyBudgetTotal.toFixed(2)}/day</b> in {market} from the moment it lands.
              </span>
            </span>
          </label>
        </div>
      </div>

      {err && <div className="h10-rep-note bad"><b>Couldn’t launch:</b> {err}</div>}

      <div className="h10-rep-launchbar">
        {plan.allowed
          ? <span className="ok"><CheckCircle2 size={14} aria-hidden /> Ready to create in {market}</span>
          : <span className="bad"><AlertTriangle size={14} aria-hidden /> Resolve the items above first</span>}
        <span className="grow" />
        <button type="button" className="h10-spw-next" disabled={!plan.allowed || launching} onClick={onLaunch}>
          {launching
            ? <><Loader2 size={14} className="spin" aria-hidden /> Creating…</>
            : launchMode === 'floor'
              ? `Create ${t.campaigns} campaign${t.campaigns === 1 ? '' : 's'} at the bid floor`
              : `Create ${t.campaigns} campaign${t.campaigns === 1 ? '' : 's'} — €${t.dailyBudgetTotal.toFixed(2)}/day`}
        </button>
      </div>
    </div>
  )
}

function Tot({ n, l }: { n: number; l: string }) {
  return <div className="tot"><span className="n">{n}</span><span className="l">{l}</span></div>
}

function ResultPanel({
  result, launchMode, busy, onRollback, onRaise, onSave, saveOpen, setSaveOpen, bpName, setBpName, onSaveBlueprint,
}: {
  result: LaunchResult; launchMode: 'live' | 'floor'; busy: boolean
  onRollback: () => void; onRaise: () => void; onSave: () => void
  saveOpen: boolean; setSaveOpen: (v: boolean) => void
  bpName: string; setBpName: (v: string) => void; onSaveBlueprint: (n: string) => void
}) {
  const c = result.created
  const ok = result.status === 'APPLIED'
  return (
    <div className="h10-rep-launch">
      <div className={`h10-rep-note ${ok ? 'ok' : result.status === 'FAILED' ? 'bad' : 'warn'}`}>
        <b>
          {ok ? <CheckCircle2 size={14} aria-hidden /> : <AlertTriangle size={14} aria-hidden />}
          {ok ? 'Created' : result.status === 'FAILED' ? 'Nothing was created' : 'Created, with problems'}
        </b>
        <p>
          {c.campaigns} campaigns · {c.adGroups} ad groups · {c.targets} targets · {c.negatives} negatives · {c.productAds} product ads.
          {launchMode === 'floor' && ' Bids are at the €0.02 floor — this is not spending yet.'}
        </p>
      </div>

      {result.notOnAmazon.length > 0 && (
        <div className="h10-rep-note bad">
          <b>{result.notOnAmazon.length} campaign(s) never reached Amazon</b>
          <p>They exist locally and are inert — the write gate was closed for this market. Nothing is live.</p>
          <ul>{result.notOnAmazon.slice(0, 8).map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
      {result.skippedNonKeyword > 0 && (
        <div className="h10-rep-note warn">{result.skippedNonKeyword} target(s) could not be created — add those by hand.</div>
      )}
      {result.errors.length > 0 && (
        <div className="h10-rep-note bad"><b>{result.errors.length} error(s)</b><ul>{result.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul></div>
      )}

      <div className="h10-rep-launchbar">
        {launchMode === 'floor' && c.campaigns > 0 && (
          <button type="button" className="h10-rep-bulkbtn" disabled={busy} onClick={onRaise}>
            <TrendingUp size={13} aria-hidden /> Raise to the planned bids
          </button>
        )}
        <button type="button" className="h10-rep-bulkbtn" disabled={busy} onClick={onSave}>
          <Save size={13} aria-hidden /> Save this structure as a blueprint
        </button>
        <span className="grow" />
        {c.campaigns > 0 && (
          <button type="button" className="h10-rep-bulkbtn danger" disabled={busy} onClick={onRollback}>
            <RotateCcw size={13} aria-hidden /> Roll the whole run back
          </button>
        )}
      </div>

      {saveOpen && (
        <Modal open onClose={() => setSaveOpen(false)} size="sm" title="Save as a blueprint"
          footer={<><Button onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!bpName.trim()} onClick={() => { onSaveBlueprint(bpName.trim()); setSaveOpen(false) }}>Save</Button></>}>
          <p className="h10-spw-bulk-note">Stores this structure so you can replicate it again without rebuilding the selection.</p>
          <label className="h10-spw-bulk-field"><span className="l">Name</span>
            <Input value={bpName} onChange={(e) => setBpName(e.target.value)} placeholder="e.g. SP Jacket Standard" autoFocus aria-label="Blueprint name" fieldClassName="h10-spw-bulk-txtfield" /></label>
        </Modal>
      )}
    </div>
  )
}
