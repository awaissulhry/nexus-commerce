'use client'

/**
 * ACR.1 — the Control Room: every automation that can change this account's Amazon ads.
 *
 * CR rebuild 1 (Owner 2026-10-06, layout B): "keep it all extremely simple, just like the products page … and I have
 * control over each and everything". The frame is the products list's: a header, ONE top band that says whether
 * anything may act (the account level and the brake), number tiles, then four tabs that each answer one question —
 *   Who acts   every engine and rule (and, with W2, every kind of change Claude may make), one level scale
 *   Limits     the ads strategy per market, category and product, and the account's brakes
 *   Campaigns  what automation may touch on each campaign
 *   History    what happened, with Undo, and what is planned for the next 24 hours
 * The six old tabs' content sits inside the new tabs until each tab is redrawn on the design system (CR rebuild 2–6).
 *
 * Every move of the account level and the brake asks first (ActionConfirm). Nothing on the page writes on a plain click.
 *
 * Light only, like the rest of the ads console (`.h10-shell` sets `color-scheme: light`). Operator decision, 2026-08-05.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button, Pill, SegmentedControl, type Tone } from '@/design-system/primitives'
import { Banner, Card, MetricStrip, Tabs, tabPanelProps, useActionConfirm } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import { usePermission } from '@/lib/auth/AuthProvider'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { Gauge, Play, RefreshCw, Square } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignsTab } from './CampaignsTab'
import { LimitsTab } from './LimitsTab'
import { HistoryTab } from './HistoryTab'
import { WhoActsGrid } from './WhoActsGrid'
import { actorRows, rowCounts, NO_FILTER, type Engine, type Readiness, type Rule, type ShowFilter, type WhoFilter } from './whoActs'
import { NeedsYouDrawer, type NeedsYouView } from './NeedsYouDrawer'
import { accountStatus, dialMove, haltMove, resumeMove, DIAL_LABEL, DIAL_LEVELS, isDial, type AccountGlobal } from './dialState'
import { problemHint, problemRows, quietHint, suggestionsWaiting, waitingFor } from './roomCounts'
import { claudeRows } from './claudeKinds'
import { claudeApi } from '@/app/settings/ai/claude/claudeApi'
import type { ClaudeRules } from '@/app/settings/ai/claude/claudeWords'
import type { WatchSummary } from '@nexus/shared/approval-queue'
import { readLimitsView, readTab, tabHref, ROOM_TABS, type HistoryView, type LimitsView, type RoomTab } from './roomTabs'
import { TODAY_PATH, type Board } from './todayBoard'
import styles from './room.module.css'

const TABS_ID = 'control-room'

/** The colour of the state in the top band. */
function bandTone(g: AccountGlobal, runsAlone: number): Tone {
  if (g.envKill || g.halted) return 'danger'
  if (g.autonomy === 'OFF') return 'neutral'
  if (g.autonomy === 'SUGGEST') return 'info'
  return runsAlone > 0 ? 'success' : 'neutral'
}

/** A read the page can live without: its failure leaves its tile unknown, never the page empty. */
async function readJson<T>(path: string): Promise<T> {
  const r = await fetch(`${getBackendUrl()}${path}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return (await r.json()) as T
}

export function ControlRoomClient() {
  const params = useSearchParams()
  const router = useRouter()
  const { tab, view } = readTab(params.get('tab'), params.get('view'))

  const [engines, setEngines] = useState<Engine[] | null>(null)
  const [leversErr, setLeversErr] = useState<string | null>(null)
  const [global, setGlobal] = useState<AccountGlobal | null>(null)
  // Where changes go: Amazon's live account, or its test account (the server's live/sandbox setting).
  const [adsMode, setAdsMode] = useState<string | null>(null)
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [rulesErr, setRulesErr] = useState<string | null>(null)
  const [protectedTerms, setProtectedTerms] = useState<number | null>(null)
  const [readiness, setReadiness] = useState<ReadonlyMap<string, Readiness>>(new Map())
  // CR rebuild 3 — Claude's ad kinds: the business's rule per tool (Settings › AI › Claude's own read) and the watch week.
  const [claude, setClaude] = useState<ClaudeRules | null>(null)
  const [claudeErr, setClaudeErr] = useState<string | null>(null)
  const [watch, setWatch] = useState<WatchSummary | null>(null)
  const [who, setWho] = useState<WhoFilter>(NO_FILTER)
  const [board, setBoard] = useState<Board | null>(null)
  const [boardErr, setBoardErr] = useState<string | null>(null)
  const [needsYou, setNeedsYou] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<NeedsYouView | null>(null)
  // The header's Refresh also re-reads the campaigns (the tab keeps its draft).
  const [campaignsRead, setCampaignsRead] = useState(0)
  const [lastViews, setLastViews] = useState<{ limits: LimitsView; history: HistoryView }>({ limits: 'strategy', history: 'done' })
  // A tab stays mounted once opened (hidden while another tab shows), so an unsaved draft — the strategy, the campaign
  // limits — is never thrown away by a click on another tab.
  const [opened, setOpened] = useState<ReadonlySet<RoomTab>>(() => new Set([tab]))
  useEffect(() => { setOpened((o) => (o.has(tab) ? o : new Set([...o, tab]))) }, [tab])

  // A failed re-read keeps the engines last read (and says it failed): an empty list would silently drop every engine
  // from the list, the tiles and the band.
  const loadLevers = useCallback(async () => {
    try {
      const j = await readJson<{ engines?: Engine[]; global?: AccountGlobal }>('/api/advertising/control-room/levers')
      setEngines(Array.isArray(j?.engines) ? j.engines : [])
      setGlobal(j?.global ?? null)
      setLeversErr(null)
    } catch (e) { setLeversErr(`The engines could not be read: ${(e as Error).message}`) }
    try {
      const gr = await readJson<{ adsMode?: string }>('/api/advertising/control-room/guardrails')
      setAdsMode(typeof gr?.adsMode === 'string' ? gr.adsMode : null)
    } catch { setAdsMode(null) }
  }, [])
  const loadRules = useCallback(async () => {
    try {
      const j = await readJson<{ items?: Rule[]; protectedTerms?: number }>('/api/advertising/autonomy/rules')
      setRules(Array.isArray(j?.items) ? j.items : [])
      setProtectedTerms(typeof j?.protectedTerms === 'number' ? j.protectedTerms : null)
      setRulesErr(null)
    } catch (e) { setRules(null); setRulesErr((e as Error).message) }
    // Graduation evidence is a separate read: a rule you cannot judge is still a rule you must be able to switch off.
    try {
      const g = await readJson<{ ready?: Readiness[]; others?: Readiness[] }>('/api/advertising/autonomy/graduation')
      setReadiness(new Map([...(g?.ready ?? []), ...(g?.others ?? [])].map((r) => [r.ruleId, r])))
    } catch { setReadiness(new Map()) }
  }, [])
  const loadChecks = useCallback(async () => {
    try { setBoard(await readJson<Board>(TODAY_PATH)); setBoardErr(null) } catch (e) { setBoard(null); setBoardErr((e as Error).message) }
    try {
      const c = await readJson<{ needsYou?: number }>('/api/agent/fleet/approvals/queue/counts')
      setNeedsYou(typeof c?.needsYou === 'number' ? c.needsYou : null)
    } catch { setNeedsYou(null) }
  }, [])
  const loadClaude = useCallback(async () => {
    try { setClaude(await claudeApi.rules()); setClaudeErr(null) } catch (e) { setClaude(null); setClaudeErr((e as Error).message) }
    // The watch report is part of Claude's activity read (no cursor = with the 7-day watch summary).
    try {
      const a = await readJson<{ watch?: WatchSummary | null }>('/api/claude/activity?limit=1')
      setWatch(a?.watch ?? null)
    } catch { setWatch(null) }
  }, [])
  const loadAll = useCallback(() => { void loadLevers(); void loadRules(); void loadChecks(); void loadClaude() }, [loadLevers, loadRules, loadChecks, loadClaude])
  useEffect(() => { loadAll() }, [loadAll])

  const canManage = usePermission('ads.automation.manage')
  const confirm = useActionConfirm()

  // The account level. Start again clears a stop only; a level at Off is raised here. Every move asks first.
  const setDial = async (to: string) => {
    if (busy || !global) return
    const move = dialMove(global, to)
    if (!move || !(await confirm.ask(move.impact))) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation/autonomy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: move.to }),
      })
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `Could not change the level (${r.status})`)
      // The server took it: say so even if the re-read below fails.
      setGlobal((g) => (g ? { ...g, autonomy: move.to } : g))
      await loadLevers(); void loadChecks()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  // Stop now / Start again. Both endpoints write the account's halt; both ask first now.
  const setHalt = async (halt: boolean) => {
    if (busy || !global) return
    if (!(await confirm.ask(halt ? haltMove() : resumeMove(global)))) return
    setBusy(true); setErr(null)
    try {
      const path = halt ? 'halt' : 'resume'
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(halt ? { reason: 'Stopped from the Control Room' } : {}),
      })
      if (!r.ok) throw new Error(halt ? `Could not stop (${r.status})` : `Could not start again (${r.status})`)
      setGlobal((g) => (g ? { ...g, halted: halt } : g))
      await loadLevers(); void loadChecks()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const rows = useMemo(
    () => (engines && rules && global ? actorRows(engines, rules, global, readiness, claudeRows(claude, watch, global)) : null),
    [engines, rules, global, readiness, claude, watch],
  )
  const counts = rows ? rowCounts(rows) : null
  const status = global ? accountStatus(global, counts?.runsAlone ?? null, canManage) : null
  const waiting = waitingFor(needsYou, suggestionsWaiting(board?.exceptions ?? null))
  const problems = problemRows(board?.exceptions ?? null)

  // Each tab keeps the view it was last on, so coming back to Limits or History opens where the person left it.
  const limitsView = tab === 'limits' ? readLimitsView(params.get('view')) : lastViews.limits
  const historyView = tab === 'history' ? view : lastViews.history
  useEffect(() => {
    setLastViews((v) => (v.limits === limitsView && v.history === historyView ? v : { limits: limitsView, history: historyView }))
  }, [limitsView, historyView])
  const goTab = (id: string) => {
    const next = ROOM_TABS.find((t) => t.id === id)?.id as RoomTab | undefined
    if (!next) return
    const remembered = next === 'limits' ? lastViews.limits : next === 'history' ? lastViews.history : undefined
    router.push(tabHref(next, remembered), { scroll: false })
  }
  const goView = (v: HistoryView) => router.push(tabHref('history', v), { scroll: false })
  const goLimits = (v: LimitsView) => router.push(tabHref('limits', v), { scroll: false })
  // A level tile is the Who acts list's Show filter: it opens the list showing only those rows; a second click clears it.
  const showTile = (show: ShowFilter) => {
    const on = tab === 'who' && who.show === show
    setWho(on ? { ...who, show: 'all' } : { ...NO_FILTER, show })
    if (tab !== 'who') router.push(tabHref('who'), { scroll: false })
  }
  const tileOn = (show: ShowFilter) => tab === 'who' && who.show === show

  return (
    <div className={styles.page}>
      <PageHeader
        title="Control Room"
        subtitle="Who may change your Amazon ads, inside which limits, and what they did."
        actions={(
          <div className={styles.actions}>
            {/* ACR.1.6 — Mission Control, the only view of the account's SHAPE; nothing else links to it. */}
            <Button asChild size="sm" variant="secondary">
              <Link href="/marketing/ads/autopilot"><Gauge size={14} aria-hidden /> Open the map</Link>
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { loadAll(); setCampaignsRead((n) => n + 1) }}>
              <RefreshCw size={14} aria-hidden /> Refresh
            </Button>
          </div>
        )}
      />

      {err && <Banner tone="danger" title="Something could not be read or saved">{err}</Banner>}

      {global && status && (
        <Card padded aria-label="Account automation state">
          <div className={styles.band}>
            <div className={styles.bandText}>
              <Pill tone={bandTone(global, counts?.runsAlone ?? 0)} dot size="md">{status.headline}</Pill>
              <span className={styles.muted}>{status.detail}</span>
            </div>
            <div className={styles.bandControls}>
              <span className={styles.label}>Account level</span>
              {status.dialLocked
                ? <span className={styles.muted}>
                  {!global.degraded && isDial(global.autonomy) ? `${DIAL_LABEL[global.autonomy]} — ` : ''}{status.dialLocked}
                </span>
                : <SegmentedControl
                  size="sm"
                  ariaLabel="Account level"
                  options={DIAL_LEVELS.map((l) => ({ value: l, label: DIAL_LABEL[l] }))}
                  value={global.autonomy}
                  disabled={busy}
                  onChange={(v) => void setDial(v)}
                />}
              {status.action === 'resume' && (
                <Button variant="success" size="sm" disabled={busy || !canManage} onClick={() => void setHalt(false)}>
                  <Play size={14} aria-hidden /> Start again…
                </Button>
              )}
              {status.action === 'halt' && (
                <Button variant="danger-outline" size="sm" disabled={busy || !canManage} onClick={() => void setHalt(true)}>
                  <Square size={14} aria-hidden /> Stop now…
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}
      {confirm.element}

      {adsMode && adsMode !== 'live' && (
        <Banner tone="info" title="Changes go to Amazon’s test account">
          Your real ads do not change, whatever the levels below say. Only a deploy changes this (Limits › Set on the server).
        </Banner>
      )}

      {global?.degraded && (
        <Banner tone="warning" title="The safety state could not be read">
          What you see is the safe assumption, not a setting anyone chose.
        </Banner>
      )}

      <MetricStrip
        metrics={[
          {
            label: 'Auto',
            value: counts ? counts.runsAlone : '—',
            hint: 'changes your ads by itself',
            accent: 'var(--nds-success)',
            onClick: () => showTile('alone'),
            active: tileOn('alone'),
          },
          {
            label: 'Ask me',
            value: counts ? counts.asksFirst : '—',
            hint: 'a person decides each change',
            accent: 'var(--nds-info)',
            onClick: () => showTile('asks'),
            active: tileOn('asks'),
          },
          {
            label: 'Off or Watch',
            value: counts ? counts.quiet : '—',
            hint: counts ? (counts.quiet > 0 ? `changes nothing · ${quietHint(counts.quietSplit)}` : 'changes nothing') : leversErr || rulesErr ? 'Could not be read' : 'Reading…',
            accent: 'var(--nds-border-strong)',
            onClick: () => showTile('quiet'),
            active: tileOn('quiet'),
          },
          {
            label: 'Waiting for you',
            value: waiting.value ?? '—',
            hint: waiting.hint,
            accent: 'var(--nds-warning)',
            onClick: () => setPanel(panel === 'waiting' ? null : 'waiting'),
            active: panel === 'waiting',
          },
          {
            label: 'Problems',
            value: problems ? problems.length : '—',
            hint: problems ? problemHint(problems) : boardErr ? 'Could not be read' : 'Reading…',
            accent: 'var(--nds-danger)',
            onClick: () => setPanel(panel === 'problems' ? null : 'problems'),
            active: panel === 'problems',
          },
        ]}
      />

      <div>
        <Tabs
          size="lg"
          overflow="scroll"
          ariaLabel="Control Room"
          idBase={TABS_ID}
          tabs={ROOM_TABS.map((t) => ({ id: t.id, label: t.label, count: t.id === 'who' ? counts?.total ?? null : undefined }))}
          active={tab}
          onChange={goTab}
        />
        {ROOM_TABS.filter((t) => t.id === tab || opened.has(t.id)).map(({ id }) => (
        <div key={id} {...tabPanelProps(TABS_ID, id)} hidden={id !== tab}>
          {id === 'who' && (
            <WhoActsGrid
              rows={rows}
              error={leversErr ?? rulesErr}
              claudeError={claudeErr}
              onRetry={loadAll}
              readiness={readiness}
              protectedTerms={protectedTerms}
              filter={who}
              onFilter={setWho}
              onEnginesChanged={() => { void loadLevers(); void loadChecks() }}
              onRulesChanged={() => { void loadRules(); void loadChecks() }}
              onClaudeChanged={() => { void loadClaude() }}
            />
          )}
          {id === 'limits' && <LimitsTab view={limitsView} onView={goLimits} />}
          {id === 'campaigns' && <CampaignsTab refreshKey={campaignsRead} />}
          {id === 'history' && <HistoryTab view={historyView} onView={goView} account={global} />}
        </div>
        ))}
      </div>

      <NeedsYouDrawer view={panel} onClose={() => setPanel(null)} board={board} boardError={boardErr} needsYou={needsYou} />
    </div>
  )
}
