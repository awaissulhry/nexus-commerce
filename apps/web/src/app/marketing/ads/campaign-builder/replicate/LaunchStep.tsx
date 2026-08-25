'use client'

/**
 * AX3.5 / AX3.7 — step 3: preflight and launch.
 *
 * The last screen before real campaigns exist. It has to answer four questions
 * without the operator going looking: what will be created, what will NOT be,
 * what it commits per day, and — when something is blocking — where to go to
 * clear it.
 *
 * That last one is why this was rebuilt. A blocker used to be a sentence in a
 * red box with a footnote saying the fix lived on the previous step; the
 * previous step then opened on a collapsed tree showing none of it. Every
 * blocker here carries the control that resolves it, and the destination
 * settings that can cause one — the daily cap, the portfolio — are editable in
 * place rather than two steps back.
 *
 * The launch-mode control is the money decision. Landing at Amazon's 2c floor is
 * the default because spending should be the thing you opt into, not the thing
 * you forget to opt out of — and it is a floor, never a pause, because pausing
 * disrupts Amazon's optimisation and forces re-learning.
 */
import { useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Loader2, RotateCcw, TrendingUp, Save,
  ArrowRight, Pencil, Info,
} from 'lucide-react'
import { Modal } from '@/design-system/components'
import { Button, Input, RadioCard } from '@/design-system/primitives'
import type { Plan, CopyScope, PlanEdits } from './replicate-types'
import { COPY_ITEMS, BIDDING_STRATEGIES } from './replicate-types'
import { describeChanges } from './edit-model'
import { InfoTip } from '../../campaigns/InfoTip'

/** AX3.8 — where a detached run has got to. */
export interface RunProgress {
  done: number
  total: number
  campaign: string | null
  created: { campaigns: number; adGroups: number; targets: number; negatives: number; productAds: number }
}

export interface LaunchResult {
  applicationId: string
  status: 'PLANNED' | 'APPLIED' | 'PARTIAL' | 'FAILED'
  created: { campaigns: number; adGroups: number; targets: number; negatives: number; productAds: number }
  skippedNonKeyword: number
  notOnAmazon: string[]
  errors: string[]
}

/** Where a blocker gets resolved, and what to call the button that goes there. */
export type Resolution =
  | { kind: 'conflicts'; label: string }
  | { kind: 'campaign'; label: string; campaignId?: string }
  | { kind: 'cap'; label: string }
  | { kind: 'products'; label: string }
  | null

/**
 * Match a blocker to its cure.
 *
 * The gate returns prose, deliberately — it is written for a human. Rather than
 * restructure it into codes on both sides, this reads the sentence it produced.
 * A blocker with no match still renders; it just carries no shortcut, which is
 * the same place the whole screen used to be.
 */
export function resolutionFor(blocker: string): Resolution {
  if (/bid against campaigns you already run/i.test(blocker)) return { kind: 'conflicts', label: 'Resolve them in step 2' }
  if (/already exist in this marketplace|duplicate campaign name/i.test(blocker)) return { kind: 'campaign', label: 'Rename them in step 2' }
  if (/over the €.*cap|commits €.*over the/i.test(blocker)) return { kind: 'cap', label: 'Change the cap' }
  if (/no ASINs supplied/i.test(blocker)) return { kind: 'products', label: 'Pick products in step 1' }
  if (/no longer in this plan/i.test(blocker)) return { kind: 'campaign', label: 'Review step 2' }
  return null
}

export function LaunchStep({
  plan, sourcePlan, edits, scope, market, portfolioName, cap, setCap,
  launchMode, setLaunchMode, launching, progress, result, err, busy,
  onLaunch, onRollback, onRaise, onSaveBlueprint, onResolve,
}: {
  plan: Plan | null
  /** The un-edited plan — the ledger needs the original names to describe a change. */
  sourcePlan: Plan | null
  edits: PlanEdits
  scope: CopyScope
  market: string
  portfolioName: string | null
  cap: string
  setCap: (v: string) => void
  launchMode: 'live' | 'floor'
  setLaunchMode: (m: 'live' | 'floor') => void
  launching: boolean
  progress: RunProgress | null
  result: LaunchResult | null
  err: string | null
  onLaunch: () => void
  onRollback: () => void
  onRaise: () => void
  onSaveBlueprint: (name: string) => void
  onResolve: (r: NonNullable<Resolution>) => void
  busy: boolean
}) {
  const [saveOpen, setSaveOpen] = useState(false)
  const [bpName, setBpName] = useState('')
  const [changesOpen, setChangesOpen] = useState(false)

  const changes = useMemo(() => (sourcePlan ? describeChanges(sourcePlan, edits) : []), [sourcePlan, edits])

  if (!plan) {
    return <div className="h10-spw-card h10-rep-todo">Finish step 1 first — a source, both product tokens, and at least one product.</div>
  }

  // AX3.8 — the run is detached, so this is a WATCHER, not a spinner. It keeps
  // showing what exists so far, which is the fact the old screen hid: campaigns
  // were being created while it said the launch had failed.
  if (launching) {
    const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
    const c = progress?.created
    return (
      <div className="h10-rep-launch">
        <div className="h10-spw-card h10-rep-running">
          <b className="hd"><Loader2 size={15} className="spin" aria-hidden /> Creating in {market}…</b>
          <p className="sub">
            {progress
              ? <>Campaign {Math.min(progress.done + 1, progress.total)} of {progress.total}{progress.campaign ? <> — <b>{progress.campaign}</b></> : null}</>
              : 'Starting the run…'}
          </p>
          <div className="bar"><span style={{ width: `${pct}%` }} /></div>
          {c && (
            <div className="tally">
              <span><b>{c.campaigns}</b> campaigns</span>
              <span><b>{c.adGroups}</b> ad groups</span>
              <span><b>{c.targets}</b> targets</span>
              <span><b>{c.negatives}</b> negatives</span>
              <span><b>{c.productAds}</b> product ads</span>
            </div>
          )}
          <p className="safe">
            This runs on the server. You can close this tab — the run keeps going, and
            <b> Past runs</b> in step 1 will show what it created.
          </p>
        </div>
      </div>
    )
  }

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

  const t = plan.totals
  const excludedItems = COPY_ITEMS.filter((i) => !scope[i.key])
  const ex = plan.excluded
  const droppedInScope = ex.keywords + ex.negatives + ex.productTargets + ex.autoClauses

  return (
    <div className="h10-rep-launch">
      {/* ── what will be created ─────────────────────────────────────────── */}
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

      {/* ── blockers, each with the control that clears it ───────────────── */}
      {plan.blockers.length > 0 && (
        <div className="h10-rep-blockers">
          <b className="hd"><AlertTriangle size={15} aria-hidden /> Blocked — {plan.blockers.length} thing{plan.blockers.length === 1 ? '' : 's'} to resolve first</b>
          {plan.blockers.map((b) => {
            const r = resolutionFor(b)
            return (
              <div className="bl" key={b}>
                <p>{b}</p>
                {r?.kind === 'cap' ? (
                  <label className="capfix">
                    <span>Daily cap</span>
                    <Input inputMode="decimal" prefix="€" value={cap} placeholder="none" aria-label="Daily budget cap"
                      onChange={(e) => setCap(e.target.value)} fieldClassName="h10-rep-numfield" />
                    <Button variant="link" size="sm" title="Drop the daily-spend ceiling so this replication is no longer refused for exceeding it" onClick={() => setCap('')}>Remove the cap</Button>
                  </label>
                ) : r ? (
                  <Button variant="primary" onClick={() => onResolve(r)}>{r.label} <ArrowRight size={13} /></Button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {plan.warnings.map((w) => (
        <div className="h10-rep-note warn" key={w}><AlertTriangle size={14} aria-hidden /> {w}</div>
      ))}

      {/* ── every campaign this will create ──────────────────────────────── */}
      <div className="h10-spw-card h10-rep-manifest">
        <h3>Every campaign this will create <InfoTip tip="Exactly what lands in Amazon, after your step-2 edits. Click one to go back and change it." /></h3>
        <div className="h10-rep-tblwrap">
          <table className="h10-rep-tbl camps">
            <thead>
              <tr>
                <th>Campaign</th><th className="ct">Type</th><th className="strat">Bidding</th><th className="ct">Targets</th>
                <th className="ct">Negatives</th><th className="ct">Ads</th><th className="plc">Placements</th><th className="bud">Daily budget</th><th className="act" />
              </tr>
            </thead>
            <tbody>
              {plan.campaigns.map((c) => {
                const targets = c.adGroups.flatMap((g) => g.targets)
                const plc = (c.placementBidding ?? []).filter((p) => p.percentage > 0)
                return (
                  <tr key={c.id}>
                    <td className="exp">
                      <b>{c.name}</b>
                      <span className="whrline">{c.adGroups.length} ad group{c.adGroups.length === 1 ? '' : 's'}</span>
                    </td>
                    <td className="ct"><span className={`tag ${c.targetingType === 'AUTO' ? 'auto' : ''}`}>{c.targetingType === 'AUTO' ? 'auto' : 'manual'}</span></td>
                    <td className="strat">
                      {/* Amazon's own words for these are LEGACY_FOR_SALES / AUTO_FOR_SALES,
                          which say nothing about what they do to your bid. */}
                      <span className="tag">{BIDDING_STRATEGIES.find((s) => s.key === (c.biddingStrategy ?? 'LEGACY_FOR_SALES'))?.label ?? 'Down only'}</span>
                    </td>
                    <td className="ct">{targets.filter((x) => !x.isNegative).length}</td>
                    <td className="ct">{targets.filter((x) => x.isNegative).length}</td>
                    <td className="ct">{c.adGroups.reduce((s, g) => s + g.asins.length, 0)}</td>
                    <td className="plc">
                      {plc.length
                        ? <span className="tag" title={plc.map((p) => `${p.placement.replace('PLACEMENT_', '').replace(/_/g, ' ').toLowerCase()} +${p.percentage}%`).join(', ')}>{plc.map((p) => `+${p.percentage}%`).join(' / ')}</span>
                        : <span className="dash">—</span>}
                    </td>
                    <td className="bud">€{Number(c.dailyBudget ?? 0).toFixed(2)}</td>
                    <td className="act">
                      <InfoTip tip={`Go back to step 2 with ${c.name} open, to change its budget, bidding, placements or targets.`}>
                        <button type="button" className="lnk" onClick={() => onResolve({ kind: 'campaign', label: '', campaignId: c.id })}
                          aria-label={`Edit ${c.name}`}>
                          <Pencil size={13} aria-hidden />
                        </button>
                      </InfoTip>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr><td colSpan={7} /><td className="bud"><b>€{t.dailyBudgetTotal.toFixed(2)}</b></td><td /></tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* ── what will NOT be created ─────────────────────────────────────── */}
      {(excludedItems.length > 0 || droppedInScope > 0) && (
        <div className="h10-rep-note">
          <b>What will not be copied</b>
          <ul>
            {excludedItems.map((i) => <li key={i.key}>{i.label} — you turned this off under “what to copy”</li>)}
            {ex.keywords > 0 && <li>{ex.keywords} keyword(s) from the source</li>}
            {ex.negatives > 0 && <li>{ex.negatives} negative(s) from the source</li>}
            {ex.productTargets > 0 && <li>{ex.productTargets} product/category target(s)</li>}
            {ex.autoClauses > 0 && <li>{ex.autoClauses} auto-targeting clause(s)</li>}
          </ul>
        </div>
      )}

      {/* ── your changes ─────────────────────────────────────────────────── */}
      <div className="h10-spw-card h10-rep-changesum">
        <div className="hd">
          <h3>Your changes</h3>
          <span className="n">{changes.length === 0 ? 'None — this is the source structure, re-pointed at the new product' : `${changes.length} change${changes.length === 1 ? '' : 's'}`}</span>
          {changes.length > 0 && (
            <Button variant="link" size="sm" title="List every edit you made in step 2" onClick={() => setChangesOpen((o) => !o)}>{changesOpen ? 'Hide' : 'Show all'}</Button>
          )}
        </div>
        {changesOpen && (
          <ul className="h10-rep-changesum-list">
            {changes.map((c) => (
              <li key={c.key}><span className="sc">{c.scope}</span> <b>{c.subject}</b> — {c.detail}</li>
            ))}
          </ul>
        )}
      </div>

      {/* ── where it lands ───────────────────────────────────────────────── */}
      <div className="h10-spw-card h10-rep-dest">
        <h3>Where it lands</h3>
        <div className="grid">
          <div className="f"><span className="l">Marketplace</span><span className="v">{market}</span></div>
          <div className="f"><span className="l">Portfolio</span><span className="v">{portfolioName ?? 'None — outside every portfolio'}</span></div>
          <label className="f">
            <span className="l">Daily cap <InfoTip tip="Refuse the whole replication if it would commit more than this per day. Optional." /></span>
            <Input inputMode="decimal" prefix="€" value={cap} placeholder="no cap" aria-label="Daily budget cap"
              onChange={(e) => setCap(e.target.value)} fieldClassName="h10-rep-numfield" />
          </label>
        </div>
        {!portfolioName && (
          <p className="hint"><Info size={12} aria-hidden /> Campaigns outside a portfolio are invisible to portfolio budgets and rollups. Set one in step 1 if that matters.</p>
        )}
      </div>

      {/* ── how it goes out ──────────────────────────────────────────────── */}
      <div className="h10-spw-card h10-rep-mode">
        <b className="hd">How this goes out</b>
        <div className="opts">
          <RadioCard
            name="launchmode"
            selected={launchMode === 'floor'}
            checked={launchMode === 'floor'}
            onChange={() => setLaunchMode('floor')}
            title="Land at the bid floor"
            description={<>
              Created and enabled at Amazon’s €0.02 minimum, with every planned bid remembered.
              The structure exists and syncs normally but cannot meaningfully spend. One click
              raises it to the planned bids when you are ready. <b>Never paused</b> — pausing
              disrupts Amazon’s optimisation.
            </>}
          />
          <RadioCard
            name="launchmode"
            selected={launchMode === 'live'}
            checked={launchMode === 'live'}
            onChange={() => setLaunchMode('live')}
            title="Go live now"
            description={<>
              Created at the planned bids and budgets. This commits{' '}
              <b>€{t.dailyBudgetTotal.toFixed(2)}/day</b> in {market} from the moment it lands.
            </>}
          />
        </div>
      </div>

      {err && <div className="h10-rep-note bad"><b>Couldn’t launch:</b> {err}</div>}

      <div className="h10-rep-launchbar sticky">
        {plan.allowed
          ? <span className="ok"><CheckCircle2 size={14} aria-hidden /> Ready to create in {market}</span>
          : <span className="bad"><AlertTriangle size={14} aria-hidden /> Resolve the {plan.blockers.length} item{plan.blockers.length === 1 ? '' : 's'} above first</span>}
        <span className="grow" />
        <InfoTip tip={!plan.allowed
          ? 'Blocked until the items above are resolved.'
          : launchMode === 'floor'
            ? `Creates all of this in Amazon ${market} at the €0.02 bid floor, so it exists and syncs but cannot meaningfully spend. Takes a few minutes; you can close the tab while it runs.`
            : `Creates all of this in Amazon ${market} at the planned bids and commits €${t.dailyBudgetTotal.toFixed(2)}/day from the moment it lands. Takes a few minutes; you can close the tab while it runs.`}>
          <Button variant="primary" disabled={!plan.allowed || launching} onClick={onLaunch}>
            {launching
              ? <><Loader2 size={14} className="spin" aria-hidden /> Creating…</>
              : launchMode === 'floor'
                ? `Create ${t.campaigns} campaign${t.campaigns === 1 ? '' : 's'} at the bid floor`
                : `Create ${t.campaigns} campaign${t.campaigns === 1 ? '' : 's'} — €${t.dailyBudgetTotal.toFixed(2)}/day`}
          </Button>
        </InfoTip>
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
          <InfoTip tip={`Takes all ${c.campaigns} campaigns off the €0.02 floor and up to the bids this run was planned at. This is the moment they start spending — there is no undo except rolling the run back.`}>
            <Button size="sm" disabled={busy} onClick={onRaise}>
              <TrendingUp size={13} aria-hidden /> Raise to the planned bids
            </Button>
          </InfoTip>
        )}
        <InfoTip tip="Stores this structure under a name so you can replicate it onto another product later without rebuilding the source selection. Saving changes nothing on Amazon.">
          <Button size="sm" disabled={busy} onClick={onSave}>
            <Save size={13} aria-hidden /> Save this structure as a blueprint
          </Button>
        </InfoTip>
        <span className="grow" />
        {c.campaigns > 0 && (
          <InfoTip tip={`Archives all ${c.campaigns} campaigns this run created, as one unit. Spending stops. Archived is Amazon's permanent state — they cannot be un-archived, so a rollback means re-running the replication from scratch, not undoing it.`}>
            <button type="button" className="h10-rep-bulkbtn danger" disabled={busy} onClick={onRollback}>
              <RotateCcw size={13} aria-hidden /> Roll the whole run back
            </button>
          </InfoTip>
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
