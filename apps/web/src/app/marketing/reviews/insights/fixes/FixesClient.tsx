'use client'

/**
 * Reviews › Insights › Fixes (`/marketing/reviews/insights/fixes`, build spec §3.4 + ruling 7, the Fixes board): what to
 * change because of what buyers say — bullets, A+ content, a recall check, a size guide, a task.
 *
 *   Banner   a fix never changes a listing by itself
 *   Tabs     Open · Sent for approval · Applied · Dismissed (`?status=`), kind chips (`?kind=`), one product (`?product=`)
 *   Cards    why (the theme, the alert or the reviews it came from), what it proposes (and in English), a size guide's
 *            evidence per size (fit by size, made by Nexus, never the AI), where it goes, and
 *            per status: Send for approval / Create task / Edit the proposal / Dismiss (Open; a held Send says why and
 *            offers the way out) · Withdraw and Open Approvals (Sent) · its change plan (Applied) · Bring back (Dismissed)
 *   Bulk     Open tab: tick fixes (or Select all): "Send N for approval" = ONE change plan a person approves on the
 *            Approvals page (ticked tasks are created without approval), held while a ticked fix cannot be sent — the tip
 *            names it; Dismiss; Clear
 * No direct Apply: the API refuses one. Every change is the call, then every open Reviews page reads again, then a toast
 * in the server's count. Without "Manage reviews" every action is held and says so.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Ban, ClipboardList, PencilLine, RotateCcw, Send, Undo2, Wrench } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, ToastProvider, useToast } from '@/design-system/components'
import { GridSelectionActions, SelectionLabel } from '@/design-system/grid'
import { GridToolbar } from '@/design-system/patterns'
import { Button, Checkbox, FilterChip, Pill, Tag, TokenChip } from '@/design-system/primitives'
import { APPROVALS_HREF } from '@/app/fleet/_shared/approvals-waiting-words'
import { useAuth } from '@/lib/auth/AuthProvider'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { inboxHref, insightsHref } from '../../_lib/reviewsLinks'
import { InsightsHeader } from '../_shared/InsightsHeader'
import { useAddressSync, useInsightsRead, useInsightsScope, useScopeChoices } from '../_shared/useInsights'
import { FixEditModal } from './FixEditModal'
import {
  FIXES_READ_LIMIT,
  KIND_CHIPS,
  MANAGE_FIXES,
  SIZE_GUIDE_PERIOD,
  STATUS_PILL,
  STATUS_TABS,
  WAY_OUT_LABEL,
  dismissBulkHeld,
  dismissResultWords,
  doneWords,
  emptyHelp,
  emptyTitle,
  englishLines,
  evidenceLines,
  evidenceLink,
  filterFixes,
  fixesApiParams,
  metaWords,
  parseFixStatus,
  parseKinds,
  proposalLines,
  proposeResultWords,
  sendBulkHeld,
  sendBulkLabel,
  sendBulkTip,
  sendLabel,
  sendPlan,
  sentWords,
  tabCounts,
  targetWords,
  toggleKind,
  wayOut,
  withdrawHeld,
  type FixItem,
  type FixKind,
  type FixStatus,
  type FixesAnswer,
  type ProposeAnswer,
} from './fixesModel'
import shared from '../_shared/insights.module.css'
import s from './fixes.module.css'

const EVENTS = ['review.fix.changed', 'review.alert.changed'] as const

interface DismissAnswer { changed: number; held: Array<{ id: string; words: string }> }

export function FixesClient() {
  return (
    <ToastProvider>
      <Fixes />
    </ToastProvider>
  )
}

function Fixes() {
  const { status: authStatus, has } = useAuth()
  const canManage = authStatus !== 'authed' || has('reviews.manage')
  const { toast } = useToast()
  const { scope, initial, setScope } = useInsightsScope()

  // ── The address: tab, kinds, product ──
  const [tab, setTab] = useState<FixStatus | null>(null)
  const [kinds, setKinds] = useState<FixKind[]>([])
  const [product, setProduct] = useState<string | null>(null)
  useEffect(() => {
    if (!initial) return
    setTab(parseFixStatus(initial.get('status')))
    setKinds(parseKinds(initial.get('kind')))
    setProduct((initial.get('product') ?? '').trim() || null)
  }, [initial])
  useAddressSync(tab ? scope : null, { status: tab && tab !== 'OPEN' ? tab : null, kind: kinds.length ? kinds.join(',') : null, product })

  const read = useInsightsRead<FixesAnswer>(scope && tab ? '/reviews/action-items' : null, fixesApiParams(product), [...EVENTS])
  const choices = useScopeChoices(scope?.period ?? null)
  const data = read.data
  const all = useMemo(() => data?.items ?? [], [data])
  const view = { status: tab ?? 'OPEN', kinds, market: scope?.market ?? null }
  const items = useMemo(() => filterFixes(all, view), [all, view.status, view.kinds, view.market]) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = tabCounts(all, view)
  const productName = product ? all.find((f) => f.product?.id === product)?.product?.name ?? 'one product' : null

  // ── Ticks (Open tab only), cleared when what shows changes ──
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const showKey = `${tab}|${kinds.join(',')}|${product}|${scope?.market}`
  useEffect(() => { setTicked(new Set()) }, [showKey])
  useEffect(() => {
    setTicked((prev) => {
      const next = new Set([...prev].filter((id) => items.some((f) => f.id === id && f.status === 'OPEN')))
      return next.size === prev.size ? prev : next
    })
  }, [items])
  const selected = useMemo(() => items.filter((f) => ticked.has(f.id)), [items, ticked])
  const allTicked = items.length > 0 && selected.length === items.length
  const tick = (id: string, on: boolean) => setTicked((prev) => {
    const next = new Set(prev)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })

  // ── Changes ──
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<FixItem | null>(null)
  const changed = useCallback((id?: string) => emitInvalidation({ type: 'review.fix.changed', id }), [])

  const propose = useCallback(async (ids: string[], tasks: string[]) => {
    setBusy('propose')
    const chosen = [...ids, ...tasks]
    const res = chosen.length === 1
      ? await reviewsSend<ProposeAnswer>('POST', `/reviews/action-items/${encodeURIComponent(chosen[0])}/propose`, undefined, { idempotent: true, what: 'request' })
      : await reviewsSend<ProposeAnswer>('POST', '/reviews/action-items/bulk', { ids: chosen, action: 'propose' }, { idempotent: true, what: 'request' })
    setBusy(null)
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not send the fixes.', 'danger')
    changed()
    toast(proposeResultWords(res.data), res.data.sent || res.data.tasks ? 'success' : 'warning')
    setTicked(new Set())
  }, [toast, changed])

  const makeTask = useCallback(async (f: FixItem) => {
    setBusy(`task:${f.id}`)
    const res = await reviewsSend<unknown>('POST', `/reviews/action-items/${encodeURIComponent(f.id)}/task`, {})
    setBusy(null)
    if (res.error) return toast(res.error, 'danger')
    changed(f.id)
    toast(`Task created: “${f.title}”. Nothing changes on a channel.`, 'success')
  }, [toast, changed])

  const setStatus = useCallback(async (f: FixItem, status: 'OPEN' | 'DISMISSED') => {
    setBusy(`status:${f.id}`)
    const res = await reviewsSend<unknown>('PATCH', `/reviews/action-items/${encodeURIComponent(f.id)}`, { status })
    setBusy(null)
    if (res.error) return toast(res.error, 'danger')
    changed(f.id)
    toast(status === 'DISMISSED' ? `Dismissed: “${f.title}”. Nothing was sent.` : `Brought back: “${f.title}” is open again.`, 'success')
  }, [toast, changed])

  const withdraw = useCallback(async (f: FixItem) => {
    setBusy(`withdraw:${f.id}`)
    const res = await reviewsSend<{ fixes: number }>('POST', `/reviews/action-items/${encodeURIComponent(f.id)}/withdraw`, {})
    setBusy(null)
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not withdraw it.', 'danger')
    changed(f.id)
    toast(`Change plan withdrawn: ${res.data.fixes} ${res.data.fixes === 1 ? 'fix is' : 'fixes are'} open again. Nothing was changed.`, 'success')
  }, [toast, changed])

  const dismissMany = useCallback(async (ids: string[]) => {
    setBusy('dismiss')
    const res = await reviewsSend<DismissAnswer>('POST', '/reviews/action-items/bulk', { ids, action: 'dismiss' }, { idempotent: true, what: 'change' })
    setBusy(null)
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not dismiss them.', 'danger')
    changed()
    toast(dismissResultWords(res.data.changed, res.data.held), res.data.changed ? 'success' : 'warning')
    setTicked(new Set())
  }, [toast, changed])

  // ── Bulk bar ──
  const plan = sendPlan(selected)
  const busyHeld = busy ? 'Wait for the change on its way.' : null
  const sendHeld = busyHeld ?? sendBulkHeld(canManage, plan)
  const dismissHeld = busyHeld ?? dismissBulkHeld(canManage, selected)
  const bulkBar = selected.length > 0 ? (
    <GridSelectionActions>
      <Button size="sm" variant="primary" heldReason={sendHeld} title={sendHeld ? undefined : sendBulkTip(plan)} onClick={() => void propose(plan.send, plan.tasks)}>
        <Send size={13} aria-hidden /> <SelectionLabel>{sendBulkLabel(plan)}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={dismissHeld} onClick={() => void dismissMany(selected.filter((f) => f.status === 'OPEN').map((f) => f.id))}>
        <Ban size={13} aria-hidden /> <SelectionLabel>Dismiss {selected.length}</SelectionLabel>
      </Button>
      <Button size="sm" variant="link" onClick={() => setTicked(new Set())}>Clear</Button>
    </GridSelectionActions>
  ) : null

  const subtitle = !scope || read.loading
    ? 'Loading…'
    : `What to change because of what buyers say · ${counts.OPEN} open · ${counts.SENT} waiting for approval${scope.market ? ` · fixes for this market and for every market` : ''}`
  const filtered = kinds.length > 0
  const empty = emptyHelp(tab ?? 'OPEN', kinds)

  return (
    <div className={shared.page}>
      <InsightsHeader scope={scope} onScope={setScope} subtitle={subtitle} choices={choices.data?.options ?? []} />

      <Banner tone="info" title="A fix never changes a listing by itself.">
        “Send for approval” turns the fix into a Nexus change plan. A person who may approve changes checks it on the Approvals page; only
        then does Nexus change the listing on Amazon, eBay or Shopify. An applied change can be undone from its change plan.
      </Banner>

      <div className={s.tabsRow}>
        <Tabs
          ariaLabel="Fix status"
          tabs={STATUS_TABS.map((t) => ({ id: t.id, label: t.label, count: data ? counts[t.id] : null }))}
          active={tab ?? 'OPEN'}
          onChange={(id) => setTab(parseFixStatus(id))}
          overflow="scroll"
        />
        <div className={shared.chips} role="group" aria-label="Kind of fix">
          {KIND_CHIPS.map((k) => (
            <FilterChip key={k.kind} pressed={kinds.includes(k.kind)} onClick={() => setKinds((prev) => toggleKind(prev, k.kind))}>{k.label}</FilterChip>
          ))}
        </div>
      </div>

      {productName && (
        <div className={shared.chips} role="group" aria-label="This page shows only">
          <TokenChip removeLabel={`Remove: ${productName} only — show every product`} onRemove={() => setProduct(null)}>Product: {productName}</TokenChip>
        </div>
      )}

      {read.error && !data ? (
        <Banner tone="danger" title="Couldn’t read the fixes" action={<Button size="sm" onClick={read.reload}>Try again</Button>}>
          {read.error} This is not an empty list.
        </Banner>
      ) : (
        <>
          {tab === 'OPEN' && items.length > 0 && (
            <div className={s.toolbar}>
              <GridToolbar
                count={selected.length ? <><b>{selected.length}</b> selected</> : <><b>{items.length}</b> open {items.length === 1 ? 'fix' : 'fixes'}</>}
              >
                <Checkbox
                  label="Select all"
                  checked={allTicked}
                  aria-label={allTicked ? 'Untick every open fix' : 'Select all open fixes'}
                  onChange={(e) => setTicked(e.target.checked ? new Set(items.map((f) => f.id)) : new Set())}
                />
                {bulkBar}
              </GridToolbar>
            </div>
          )}
          {read.loading ? (
            <p className={shared.muted}>Reading the fixes…</p>
          ) : items.length === 0 ? (
            <Card padded>
              <EmptyState
                icon={<Wrench size={20} aria-hidden />}
                title={emptyTitle(tab ?? 'OPEN', filtered, kinds)}
                description={empty.description}
                action={empty.link === 'themes' ? (
                  <Button asChild size="sm">
                    <Link href={insightsHref('themes', { period: SIZE_GUIDE_PERIOD })}>Open fit by size</Link>
                  </Button>
                ) : (
                  <Button asChild size="sm">
                    <Link href={insightsHref('alerts', { channel: scope?.channel, market: scope?.market, period: scope?.period })}>Open alerts</Link>
                  </Button>
                )}
              />
            </Card>
          ) : (
            <ul className={s.list} aria-label={`${STATUS_TABS.find((t) => t.id === tab)?.label ?? 'Open'} fixes`}>
              {items.map((f) => (
                <FixCard
                  key={f.id}
                  fix={f}
                  ticked={ticked.has(f.id)}
                  onTick={(on) => tick(f.id, on)}
                  canManage={canManage}
                  busy={busy}
                  evidence={scope ? evidenceLink(f, scope) : null}
                  themeHref={f.theme ? inboxHref({ theme: f.theme.key, market: f.market, q: f.product?.sku ?? null, period: scope?.period }) : null}
                  onSend={() => void (f.kind === 'TASK' ? makeTask(f) : propose([f.id], []))}
                  onTask={() => void makeTask(f)}
                  onEdit={() => setEditing(f)}
                  onDismiss={() => void setStatus(f, 'DISMISSED')}
                  onRestore={() => void setStatus(f, 'OPEN')}
                  onWithdraw={() => void withdraw(f)}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {read.error && data && <p className={shared.muted} role="status">Not updating: {read.error}</p>}
      {data && data.count >= FIXES_READ_LIMIT && <p className={shared.muted}>Showing the newest {FIXES_READ_LIMIT} fixes: the tabs and kind counts cover those {FIXES_READ_LIMIT} only.</p>}
      {/* Audit A10: a fix belongs to a product and a market, never to a channel — say so instead of filtering silently. */}
      {scope?.channel && <p className={shared.muted}>Fixes are per product and market, not per channel: every channel’s fixes{scope.market ? ' of this market' : ''} are listed.</p>}

      <p className={shared.footnote}>
        Fixes are written by AI from the reviews and Amazon topics shown under “Why”. Read them before you send them: translations into the
        market’s language are made when you send, and show in the change plan. Size-guide fixes are not written by AI: Nexus makes them from
        fit by size, keeps one open per product and direction, and closes it when the evidence is gone. A recall check holds stock in your own
        warehouses only, never Amazon FBA stock.
      </p>

      {editing && <FixEditModal fix={editing} canManage={canManage} onClose={() => setEditing(null)} />}
    </div>
  )
}

interface FixCardProps {
  fix: FixItem
  ticked: boolean
  onTick: (on: boolean) => void
  canManage: boolean
  busy: string | null
  evidence: { label: string; href: string } | null
  themeHref: string | null
  onSend: () => void
  onTask: () => void
  onEdit: () => void
  onDismiss: () => void
  onRestore: () => void
  onWithdraw: () => void
}

function FixCard({ fix: f, ticked, onTick, canManage, busy, evidence, themeHref, onSend, onTask, onEdit, onDismiss, onRestore, onWithdraw }: FixCardProps) {
  const pill = STATUS_PILL[f.status]
  const proposal = proposalLines(f)
  const english = englishLines(f)
  const evidenceList = evidenceLines(f)
  const held = !canManage ? MANAGE_FIXES : busy ? 'Wait for the change on its way.' : null
  const out = f.held ? wayOut(f.held) : null
  return (
    <li>
      <Card padded>
        <div className={s.card}>
          <div className={s.head}>
            {f.status === 'OPEN' && <Checkbox checked={ticked} onChange={(e) => onTick(e.target.checked)} aria-label={`Select: ${f.title}`} />}
            <div className={`${shared.stack} ${s.headMain}`}>
              <span className={shared.line}><Tag tone="info">{f.kindWords}</Tag><span className={shared.sub}>{f.product ? `${f.product.name} · ${f.product.sku}` : 'No product'}{f.market ? ` · ${f.market}` : ''}</span></span>
              <h2 className={s.title}>{f.title}</h2>
            </div>
            <Pill tone={pill.tone}>{pill.word}</Pill>
          </div>

          <div className={shared.line}>
            <span className={shared.sub}>Why</span>
            {f.theme && themeHref && <Link href={themeHref}><Tag tone="danger">{f.theme.label}</Tag></Link>}
            {f.detail && f.kind !== 'TASK' && <span>{f.detail}</span>}
            {evidence && <Button asChild size="sm" variant="link"><Link href={evidence.href}>{evidence.label}</Link></Button>}
          </div>

          <div className={s.proposal}>
            <div>
              <div className={shared.sub}>{proposal.heading}</div>
              {proposal.lines.length > 1 && f.kind === 'BULLETS' ? (
                <ul className={s.bullets}>{proposal.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              ) : proposal.lines.map((l, i) => <p key={i}>{l}</p>)}
            </div>
            {english && (
              <div>
                <div className={shared.sub}>In English</div>
                {english.length > 1 ? <ul className={s.bullets}>{english.map((l, i) => <li key={i}>{l}</li>)}</ul> : <p>{english[0]}</p>}
              </div>
            )}
            {evidenceList && (
              <div>
                <div className={shared.sub}>{evidenceList.heading}</div>
                <ul className={s.bullets}>{evidenceList.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
              </div>
            )}
          </div>

          <div className={shared.line}>
            <span className={shared.sub}>Goes to</span>
            {targetWords(f).map((t) => <Tag key={t} tone="neutral">{t}</Tag>)}
          </div>
          <p className={shared.muted}>{metaWords(f, Date.now())}{f.lastSend ? ` · ${f.lastSend.words}` : ''}</p>

          <div className={s.actions}>
            {f.status === 'OPEN' && (
              <>
                <Button size="sm" variant="primary" heldReason={held ?? f.held} onClick={onSend}>
                  {f.kind === 'TASK' ? <ClipboardList size={13} aria-hidden /> : <Send size={13} aria-hidden />} {sendLabel(f)}
                </Button>
                {out === 'task' && <Button size="sm" heldReason={held} onClick={onTask}><ClipboardList size={13} aria-hidden /> {WAY_OUT_LABEL.task}</Button>}
                {f.kind !== 'TASK' && <Button size="sm" heldReason={held} onClick={onEdit}><PencilLine size={13} aria-hidden /> Edit the proposal</Button>}
                <span className={s.grow} />
                <Button size="sm" variant="ghost" heldReason={held} onClick={onDismiss}><Ban size={13} aria-hidden /> Dismiss</Button>
              </>
            )}
            {f.status === 'SENT' && (
              <>
                <span className={shared.sub}>{sentWords(f)}</span>
                <span className={s.grow} />
                <Button asChild size="sm" variant="link"><Link href={APPROVALS_HREF}>Open Approvals</Link></Button>
                <Button size="sm" variant="ghost" heldReason={held ?? withdrawHeld(f)} onClick={onWithdraw}><Undo2 size={13} aria-hidden /> Withdraw</Button>
              </>
            )}
            {f.status === 'APPLIED' && (
              <>
                <span className={shared.sub}>{doneWords(f)}</span>
                <span className={s.grow} />
                {f.applied?.approvalId && <Button asChild size="sm" variant="link"><Link href={APPROVALS_HREF}>Its change plan (undo there)</Link></Button>}
              </>
            )}
            {f.status === 'DISMISSED' && (
              <>
                <span className={shared.sub}>{doneWords(f)}</span>
                <span className={s.grow} />
                <Button size="sm" heldReason={held} onClick={onRestore}><RotateCcw size={13} aria-hidden /> Bring back</Button>
              </>
            )}
          </div>
        </div>
      </Card>
    </li>
  )
}
