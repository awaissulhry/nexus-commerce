'use client'

/**
 * RA.AUTO — Automations: every rule you have, and one honest mode control.
 *
 * Replaces what `ads-console/automation?tab=active` and the five rule-type tabs were each doing
 * half of, and fixes what both were doing wrongly:
 *
 *   · The mode control writes `autonomyLevel` through `PATCH /advertising/autonomy/rules/:id`
 *     and never touches `dryRun`. `resolveAutonomy()` reads `dryRun` only when `autonomyLevel`
 *     is null or OFF, and all 51 rules carry an explicit level — so the console's dry-run⇄LIVE
 *     toggle cannot change what any of them does. (Plan Part 2.)
 *   · The type filter uses the SERVER's 8-family taxonomy, not the client's 13-action-type tab
 *     map. Measured: the two disagree — the tab bar reads "Keyword Harvest 5" while the server
 *     says harvest 0 — and 17 of 51 rules have no tab home at all.
 *   · The census counts rules that can WRITE (8), not rules on AUTO (9). "Alert: ACOS spike" is
 *     on AUTO and only notifies.
 *   · Every control here changes something. The five tabs' Automation switch, Criteria edit,
 *     Frequency edit and bulk Delete were all local state — bulk Delete said "this cannot be
 *     undone" and deleted nothing.
 *
 * One read (`GET /advertising/autonomy/rules`) carries the census, the categories, the resolved
 * scope names, the ceilings and the week counts. The graduation board is a second, independent
 * read: a rule you cannot judge is still a rule you must be able to switch off.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, GraduationCap, Info, ShieldAlert, Sliders, Trash2, Zap } from 'lucide-react'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { HistoryDrawer } from '../tabs/RuleListTab'
import { getBackendUrl } from '@/lib/backend-url'
import { ModeNotches, RANK, type Level } from './ModeNotches'
import { RuleDetail, type Campaign, type Portfolio, type Readiness, type DetailRule } from './RuleDetail'
import { detectConflicts, triggerText } from './ruleText'

interface Rule extends DetailRule {
  category: string
}

/** Stable order for the type filter, matching `rule-category.ts`'s own family order. */
const CATEGORY_ORDER = ['bid', 'budget', 'harvest', 'negative', 'placement', 'guard', 'alert', 'other'] as const

const num = (n: number) => n.toLocaleString('en-IE')
const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000)
  if (h < 1) return 'just now'
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}
const LEVEL_WORD: Record<Level, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Propose', AUTO: 'Auto' }

export function AutomationsClient() {
  const [rules, setRules] = useState<Rule[] | null>(null)
  const [protectedTerms, setProtectedTerms] = useState(0)
  const [grad, setGrad] = useState<Map<string, Readiness>>(new Map())
  const [weeksRequired, setWeeksRequired] = useState(3)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [market, setMarket] = useState('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [historyRule, setHistoryRule] = useState<{ id: string; name: string } | null>(null)
  const [bulk, setBulk] = useState<{ kind: 'mode'; level: Level } | { kind: 'delete' } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load automations (${r.status})`)
      const j = await r.json()
      setRules(Array.isArray(j?.items) ? (j.items as Rule[]) : [])
      setProtectedTerms(Number(j?.protectedTerms ?? 0))
      setErr(null)
    } catch (e) { setErr((e as Error).message); setRules([]) }
    // Independent of the above on purpose — see the file header.
    try {
      const g = await fetch(`${getBackendUrl()}/api/advertising/autonomy/graduation`, { cache: 'no-store' })
      if (!g.ok) throw new Error(String(g.status))
      const gj = await g.json()
      const all = [...(gj?.ready ?? []), ...(gj?.others ?? [])] as Array<Readiness & { ruleId: string }>
      setGrad(new Map(all.map((x) => [x.ruleId, x])))
      setWeeksRequired(Number(gj?.weeksRequired ?? 3))
    } catch { setGrad(new Map()) }
  }, [])

  useEffect(() => { void load() }, [load])

  // Campaigns and portfolios exist for ONE reason: to state a scope's reach before it is bound,
  // and to fill the header's market switch. Nothing else on the page reads them.
  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=500`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setCampaigns((Array.isArray(d?.items) ? d.items : []) as Campaign[]) })
      .catch(() => {})
    void fetch(`${getBackendUrl()}/api/advertising/portfolios`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive) setPortfolios((Array.isArray(d?.items) ? d.items : []) as Portfolio[]) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const markets = useMemo(
    () => Array.from(new Set(campaigns.map((c) => c.marketplace).filter(Boolean))) as string[],
    [campaigns],
  )

  const setLevel = async (rule: Rule, level: Level) => {
    if (busy || level === rule.level) return
    setBusy(rule.id); setErr(null); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${rule.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
      })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { message?: string; error?: string }
        // 409 is the ceiling refusing, which is policy rather than failure — so it gets the
        // policy's own words. The route returns them on `message`; reading `reason` here would
        // have fallen back to generic copy forever.
        throw new Error(r.status === 409
          ? (j.message ?? 'That mode is above this rule’s ceiling.')
          : (j.error ?? `Could not change mode (${r.status})`))
      }
      await load()
      setNote(`“${rule.name}” is now ${LEVEL_WORD[level]}.`)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const setScope = async (rule: Rule, scope: { scopePortfolioId?: string | null; scopeCampaignId?: string | null }) => {
    setBusy(rule.id); setErr(null); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${rule.id}/scope`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scope),
      })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!r.ok || j.ok === false) throw new Error(j.error ?? `Could not bind scope (${r.status})`)
      await load()
      setNote(`Scope updated for “${rule.name}”.`)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const all = rules ?? []

  /**
   * The market switch, wired. A rule with no `scopeMarketplace` can act in every market, so
   * narrowing to IT must keep it — an equality test would hide 43 of 51 rules and read as a
   * data bug. The pixel this control changes is the row count.
   */
  const rows = useMemo(
    () => (market === 'all' ? all : all.filter((r) => !r.marketplace || r.marketplace === market)),
    [all, market],
  )

  const conflicts = useMemo(() => detectConflicts(all), [all])

  const counts = useMemo(() => ({
    total: all.length,
    off: all.filter((r) => r.level === 'OFF').length,
    observe: all.filter((r) => r.level === 'OBSERVE').length,
    propose: all.filter((r) => r.level === 'PROPOSE').length,
    auto: all.filter((r) => r.level === 'AUTO').length,
    // The number that matters: on AUTO *and* able to reach Amazon.
    writing: all.filter((r) => r.level === 'AUTO' && r.writes).length,
    autoNotifyOnly: all.filter((r) => r.level === 'AUTO' && !r.writes).length,
    ready: [...grad.values()].filter((g) => g.canGraduate).length,
    // A rule can report completed executions while every action inside them failed, so the run
    // count alone reads as health. This is the state that has no surface anywhere today.
    allFailing: all.filter((r) => r.week.failed > 0 && r.week.acted === 0),
    neverRan: all.filter((r) => r.lifetime.evaluations === 0).length,
  }), [all, grad])

  const categoryOpts = useMemo(() => {
    const seen = new Map<string, { label: string; n: number }>()
    for (const r of all) {
      const e = seen.get(r.category) ?? { label: r.categoryLabel, n: 0 }
      e.n++; seen.set(r.category, e)
    }
    return CATEGORY_ORDER
      .filter((c) => seen.has(c))
      .map((c) => ({ value: c, label: `${seen.get(c)!.label} (${seen.get(c)!.n})` }))
  }, [all])

  const columns: GridColumn<Rule>[] = useMemo(() => [
    {
      key: 'mode', label: 'Mode', metric: false, sortable: true,
      sortValue: (r) => RANK[r.level],
      render: (r) => {
        const g = grad.get(r.id)
        return (
          <ModeNotches
            level={r.level}
            ceiling={r.ceiling}
            ceilingReason={r.ceilingReason}
            ruleName={r.name}
            busy={busy === r.id}
            earnedAuto={!!g?.canGraduate}
            earnedWhy={g?.summary}
            onSet={(lv) => void setLevel(r, lv)}
          />
        )
      },
    },
    {
      key: 'trigger', label: 'When', metric: false, sortable: true,
      sortValue: (r) => r.trigger,
      render: (r) => <span className="h10-au-trg">{triggerText(r.trigger)}</span>,
    },
    {
      key: 'scope', label: 'Scope', metric: false, sortable: true,
      sortValue: (r) => r.scope.kind,
      render: (r) => (
        <span className={`h10-au-scope ${r.scope.kind}`}>
          {r.scope.kind === 'account' ? 'Whole account' : `${r.scope.kind}: ${r.scope.name ?? r.scope.id}`}
          {r.marketplace && <em> · {r.marketplace}</em>}
        </span>
      ),
    },
    {
      key: 'week', label: 'This week', metric: false, sortable: true,
      sortValue: (r) => r.week.acted,
      render: (r) => (
        <span className="h10-au-week">
          <b>{num(r.week.acted)}</b> acted
          <em>{num(r.week.proposed)} proposed</em>
          {r.week.failed > 0 && <i className="bad">{num(r.week.failed)} failed</i>}
          {r.week.capped > 0 && (
            <i className="cap" title="Its own daily cap declined to run it. Not a failure — but it bounds how much of the account the rule reaches.">
              {num(r.week.capped)} capped
            </i>
          )}
        </span>
      ),
    },
    {
      key: 'lastRun', label: 'Last run', metric: false, sortable: true,
      sortValue: (r) => (r.lastExecutedAt ? new Date(r.lastExecutedAt).getTime() : 0),
      render: (r) => <span className={r.lastExecutedAt ? '' : 'h10-au-never'}>{ago(r.lastExecutedAt)}</span>,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [grad, busy])

  const renderFirst = (r: Rule) => {
    const conf = conflicts.get(r.id)
    const g = grad.get(r.id)
    return (
      <span className="h10-au-namew">
        <span className="h10-au-swatch" style={{ background: r.categoryColor }} title={r.categoryLabel} aria-hidden />
        <span className="h10-au-nm">
          <button type="button" className="h10-au-name" onClick={(e) => { e.stopPropagation(); setDetailId(r.id) }}>
            {r.name}
          </button>
          <em>{r.categoryLabel}{!r.writes && <> · reaches nothing</>}</em>
        </span>
        {r.level === 'AUTO' && r.writes && (
          <span className="h10-au-badge writes" title="On Auto and able to change your account">writes</span>
        )}
        {g?.canGraduate && (
          <span className="h10-au-badge ready" title={g.summary}><GraduationCap size={10} aria-hidden /> ready</span>
        )}
        {conf && (
          <span className="h10-au-badge conf" title={conf.join(' · ')}><AlertTriangle size={10} aria-hidden /> conflict</span>
        )}
        <button
          type="button"
          className="h10-au-open"
          onClick={(e) => { e.stopPropagation(); setDetailId(r.id) }}
          aria-label={`Open ${r.name}`}
        >
          <Sliders size={11} aria-hidden /> Details
        </button>
      </span>
    )
  }

  /** The ceiling is per rule, so a bulk mode change partially succeeds. Say so before it runs. */
  const bulkPreview = useMemo(() => {
    if (!bulk || bulk.kind !== 'mode') return null
    const chosen = all.filter((r) => sel.has(r.id))
    const refused = chosen.filter((r) => RANK[bulk.level] > RANK[r.ceiling])
    const willWrite = bulk.level === 'AUTO' ? chosen.filter((r) => r.writes && RANK.AUTO <= RANK[r.ceiling]).length : 0
    return { total: chosen.length, refused: refused.length, names: refused.map((r) => r.name), willWrite }
  }, [bulk, sel, all])

  const doBulk = async () => {
    if (!bulk) return
    const ids = [...sel]
    setBusy('bulk'); setErr(null); setNote(null)
    let ok = 0; let refused = 0; let failed = 0
    const refusedNames: string[] = []
    try {
      for (const id of ids) {
        const rule = all.find((r) => r.id === id)
        if (!rule) continue
        if (bulk.kind === 'delete') {
          // A real DELETE. The rule-type tabs' bulk delete said "this cannot be undone" and
          // removed the row from local state only — the rules came back on reload.
          const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${id}`, { method: 'DELETE' })
          if (r.ok) ok++; else failed++
        } else {
          const r = await fetch(`${getBackendUrl()}/api/advertising/autonomy/rules/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: bulk.level }),
          })
          if (r.ok) ok++
          else if (r.status === 409) { refused++; refusedNames.push(rule.name) }
          else failed++
        }
      }
      setSel(new Set()); setBulk(null); setDetailId(null)
      await load()
      setNote([
        `${ok} ${bulk.kind === 'delete' ? 'deleted' : 'updated'}`,
        refused ? `${refused} refused by their ceiling (${refusedNames.slice(0, 3).join(', ')}${refusedNames.length > 3 ? '…' : ''})` : null,
        failed ? `${failed} failed` : null,
      ].filter(Boolean).join(' · '))
    } finally { setBusy(null) }
  }

  /**
   * The bulk modal sits at z-index 140 and this drawer at 161, so the two must never be open
   * together — the modal would render underneath its own backdrop. Rather than fight the
   * stacking (raising the drawer above H10Select's portalled popover at 200 would clip every
   * dropdown inside it), the drawer simply yields.
   */
  const openBulk = (b: { kind: 'mode'; level: Level } | { kind: 'delete' }) => { setDetailId(null); setBulk(b) }

  const detail = detailId && !bulk ? all.find((r) => r.id === detailId) ?? null : null
  const subtitle = rulesTabByKey('automations')?.subtitle ?? ''

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Rules & Automation"
        subtitle={subtitle}
        markets={markets}
        market={market}
        onMarketChange={setMarket}
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
        primaryAction={{ label: 'Rule', icon: <Zap size={15} />, href: '/marketing/ads/rules-automation/builder' }}
      />
      <RulesTabs active="automations" />

      {/* ── Census ─────────────────────────────────────────────────────────────────────── */}
      <div className="h10-au-census">
        <div className="h10-au-stat">
          <div className="k">Automations</div>
          <div className="v">{rules === null ? '…' : num(counts.total)}</div>
          <div className="s">
            {counts.neverRan > 0 ? `${counts.neverRan} have never evaluated once` : 'all have evaluated at least once'}
          </div>
        </div>
        <div className="h10-au-stat">
          <div className="k">Off</div>
          <div className="v muted">{num(counts.off)}</div>
          <div className="s">do not evaluate at all</div>
        </div>
        <div className="h10-au-stat">
          <div className="k">Proposing</div>
          <div className="v">{num(counts.propose)}</div>
          <div className="s">
            {counts.observe > 0 ? `${counts.observe} observing · ` : ''}queue for you, never write
          </div>
        </div>
        {/* The emphasis, and it counts what can WRITE rather than what is on Auto. */}
        <div className="h10-au-stat writing">
          <div className="k">Writing to Amazon</div>
          <div className="v">{num(counts.writing)}</div>
          <div className="s">
            on Auto and able to change the account
            {counts.autoNotifyOnly > 0 && <> · {counts.autoNotifyOnly} more on Auto that only notifies</>}
          </div>
        </div>
        {counts.ready > 0 && (
          <div className="h10-au-stat ready">
            <div className="k">Ready to graduate</div>
            <div className="v">{num(counts.ready)}</div>
            <div className="s">you applied their proposals unchanged in {weeksRequired} weeks</div>
          </div>
        )}
      </div>

      {err && <div className="h10-au-banner err" role="alert"><AlertTriangle size={15} aria-hidden /><span>{err}</span></div>}
      {note && <div className="h10-au-banner ok" role="status"><Info size={15} aria-hidden /><span>{note}</span></div>}

      {counts.allFailing.length > 0 && (
        <div className="h10-au-banner warn">
          <AlertTriangle size={15} aria-hidden />
          <span>
            <b>{counts.allFailing.length} rule{counts.allFailing.length > 1 ? 's' : ''} failed every run this week and succeeded at nothing</b>
            {' '}— {counts.allFailing.slice(0, 2).map((r) => r.name).join(', ')}
            {counts.allFailing.length > 2 ? ` and ${counts.allFailing.length - 2} more` : ''}.
            A rule reports completed executions even when every action inside them fails, so the run
            count on its own reads as health.
          </span>
        </div>
      )}

      {protectedTerms === 0 && (
        <div className="h10-au-banner warn">
          <ShieldAlert size={15} aria-hidden />
          <span>
            No protected terms are configured, so every rule that negates search terms stays capped
            at Propose — otherwise a brand term could be negated with nothing to stop it.
          </span>
        </div>
      )}

      {conflicts.size > 0 && (
        <div className="h10-au-banner warn">
          <AlertTriangle size={15} aria-hidden />
          <span>
            <b>{conflicts.size} rule{conflicts.size > 1 ? 's' : ''} may conflict.</b>{' '}
            Rules that can run, share a trigger and carry duplicate or opposing actions can fight
            each other. Open a flagged rule to see which.
          </span>
        </div>
      )}

      {grad.size > 0 && (
        <p className="h10-au-gradrule">
          <GraduationCap size={13} aria-hidden />
          <span>
            A rule is offered the <b>Auto</b> notch only after you have applied its proposals{' '}
            <strong>unchanged</strong> in {weeksRequired} separate weeks with no failures. Running
            cleanly is not the same evidence and never earns it — nor does any ceiling move: rules
            that create or destroy things stay gated whatever their history.
          </span>
        </p>
      )}

      <AdsDataGrid<Rule>
        rows={rows}
        loading={rules === null}
        rowId={(r) => r.id}
        noun="Automation"
        firstColLabel="Automation"
        renderFirst={renderFirst}
        firstSortValue={(r) => r.name}
        columns={columns}
        customizable={false}
        searchable
        searchPlaceholder="Search automations…"
        searchValue={(r) => `${r.name} ${r.description ?? ''} ${r.trigger} ${r.categoryLabel} ${r.actionTypes.join(' ')}`}
        selectable
        selected={sel}
        onSelectedChange={setSel}
        defaultSort={{ key: 'mode', dir: 'desc' }}
        pagerCentered
        rowClassName={(r) => (conflicts.has(r.id) ? 'h10-au-rowconf' : undefined)}
        emptyLabel="No automations match this filter."
        filters={[
          { key: 'category', label: 'Type', kind: 'multiselect', options: categoryOpts, placeholder: 'All types', wide: true, value: (r) => (r as Rule).category },
          {
            key: 'mode', label: 'Mode', kind: 'multiselect', placeholder: 'All modes',
            options: [
              { value: 'AUTO', label: `Auto (${counts.auto})` },
              { value: 'PROPOSE', label: `Propose (${counts.propose})` },
              { value: 'OBSERVE', label: `Observe (${counts.observe})` },
              { value: 'OFF', label: `Off (${counts.off})` },
            ],
            value: (r) => (r as Rule).level,
          },
          {
            key: 'scopeKind', label: 'Scope', kind: 'select', placeholder: 'Any scope',
            options: [
              { value: 'account', label: 'Whole account' },
              { value: 'portfolio', label: 'One portfolio' },
              { value: 'campaign', label: 'One campaign' },
            ],
            value: (r) => (r as Rule).scope.kind,
          },
        ]}
        selectionActions={(ids, clear) => (
          <span className="h10-au-bulkrow">
            <span className="lbl">Set mode</span>
            {(['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as Level[]).map((lv) => (
              <button key={lv} type="button" className="h10-am-btn bulk" disabled={busy === 'bulk'} onClick={() => openBulk({ kind: 'mode', level: lv })}>
                {LEVEL_WORD[lv]}
              </button>
            ))}
            <button type="button" className="h10-am-btn bulk danger" disabled={busy === 'bulk'} onClick={() => openBulk({ kind: 'delete' })}>
              <Trash2 size={13} aria-hidden /> Delete
            </button>
            <button type="button" className="h10-am-link" onClick={clear}>Clear {ids.length}</button>
          </span>
        )}
      />

      {detail && (
        <RuleDetail
          rule={detail}
          campaigns={campaigns}
          portfolios={portfolios}
          readiness={grad.get(detail.id)}
          conflicts={conflicts.get(detail.id)}
          busy={busy === detail.id}
          onScope={(s) => void setScope(detail, s)}
          onHistory={() => { setHistoryRule({ id: detail.id, name: detail.name }); setDetailId(null) }}
          onClose={() => setDetailId(null)}
        />
      )}

      {historyRule && <HistoryDrawer rule={historyRule} onClose={() => setHistoryRule(null)} />}

      {bulk && (
        <div className="h10-ntm-back" onClick={() => setBulk(null)}>
          <div className="h10-ntm" role="dialog" aria-modal="true" aria-label={bulk.kind === 'delete' ? 'Delete automations' : 'Set mode'} onClick={(e) => e.stopPropagation()}>
            <div className="h10-ntm-h">
              <b>{bulk.kind === 'delete' ? `Delete ${sel.size} automation${sel.size === 1 ? '' : 's'}` : `Set ${sel.size} to ${LEVEL_WORD[bulk.level]}`}</b>
            </div>
            <div className="h10-ntm-sub">
              {bulk.kind === 'delete'
                ? 'Their execution history goes with them. This cannot be undone.'
                : bulkPreview && bulkPreview.refused > 0
                  ? `${bulkPreview.total - bulkPreview.refused} of ${bulkPreview.total} will change. ${bulkPreview.refused} sit above their graduation ceiling and the server will refuse them: ${bulkPreview.names.slice(0, 3).join(', ')}${bulkPreview.names.length > 3 ? '…' : ''}.`
                  : `All ${sel.size} will change. Each is checked against its own ceiling by the server.`}
            </div>
            {bulk.kind === 'mode' && bulk.level === 'AUTO' && bulkPreview && bulkPreview.willWrite > 0 && (
              <div className="h10-ntm-b">
                <p className="h10-au-note danger">
                  <ShieldAlert size={13} aria-hidden />
                  <span>
                    <b>{bulkPreview.willWrite} of these can change real campaigns.</b> On Auto they act
                    without asking, inside their daily caps and the account write gate.
                  </span>
                </p>
              </div>
            )}
            <div className="h10-ntm-f">
              <button type="button" className="cancel" onClick={() => setBulk(null)}>Cancel</button>
              <span className="grow" />
              <button type="button" className={`apply ${bulk.kind === 'delete' ? 'danger' : ''}`} disabled={busy === 'bulk'} onClick={() => void doBulk()}>
                {busy === 'bulk' ? 'Working…' : bulk.kind === 'delete' ? 'Delete' : `Set ${LEVEL_WORD[bulk.level]}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
