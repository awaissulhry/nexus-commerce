'use client'

/**
 * Approvals grid — the details of one request (docs/approvals-grid/PLAN.md §2, §5, §6; build agent D2, 2026-10-05).
 *
 * A DS `Drawer` (slide-over, like the publish history's PublishRunDrawer): focus moves in on open and back to the row
 * that opened it on close; Esc closes it; a question asked inside it (reject with a reason, undo a change) is a
 * `DrawerOverlayCard`, never a modal behind it. `fleet-portal` keeps it light like the fleet pages (it portals to
 * <body>, outside `.fleet-surface`). The page owns which request is open (`?item=` deep links included).
 *
 * Top to bottom: status · product · where → the row's verbs (through `actions` only, so a decision behaves the same as
 * in the grid) → why it waits / why it failed → every change → a plan's steps → what the asker said (plain text) →
 * the timeline and the channel's answer → Undo after it ran → edit, then approve → the request's facts (footer).
 *
 * Honest by construction: nothing here invents a result. A channel answer Nexus cannot see says so; a field the API
 * sent as null is "not known"; an edit is checked by the tool's own rules and REPLACES the request, which the person
 * then approves. After an edit (or an undo it asked for) the drawer follows the new request.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import type { QueueDetail, QueueRow } from '@nexus/shared/approval-queue'
import {
  AsOf, Banner, Countdown, Drawer, DrawerOverlayCard, EmptyState, Field, KeyValue, ProgressBar, Timeline,
  type KeyValueItem, type TimelineStep,
} from '@/design-system/components'
import { ChangeValue } from '@/design-system/grid'
import { Button, Pill, Textarea, type Tone } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { claudeApi } from '@/app/settings/ai/claude/claudeApi'
import type { ApprovalActions, ApprovalDrawerProps } from './contracts'
import {
  TARGET_LABEL, askerSaysLabel, changesView, consequenceWords, drawerVerbs, shortId, statusWords, targetWords, timelineSteps, whereLine, whyView,
} from './drawerWords'
import { EditValue } from './EditValue'
import { PlanSection } from './PlanSteps'
import { NOT_FOUND_WORDS, useApprovalDetail } from './useApprovalDetail'
import styles from './ApprovalDrawer.module.css'

/** The slide-over's width; it is never wider than the viewport (a phone gets the full width). */
export const APPROVAL_DRAWER_WIDTH = 640

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const clock = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ApprovalDrawer({ id: openId, row, actions, refreshKey, onClose, onFollow }: ApprovalDrawerProps) {
  /**
   * The request the drawer shows when it is not the one the page opened: the new request after an edit or a smaller
   * plan replaced it, or the undo this drawer asked for. It shows at once; the page is told (`onFollow`) and, when it
   * makes that id the open one, this is dropped, as it is when the page opens another row or closes.
   */
  const [followed, setFollowed] = useState<{ from: string; to: string } | null>(null)
  useEffect(() => { setFollowed(null) }, [openId])
  const id = openId && followed?.from === openId ? followed.to : openId
  const follow = useCallback((to: string) => {
    if (!openId || to === openId) return
    setFollowed({ from: openId, to })
    onFollow?.(to)
  }, [openId, onFollow])

  const { state, detail, reload } = useApprovalDetail(id, refreshKey)
  /** The freshest row: the detail once read (it IS a QueueRow), else the grid's row while it loads. */
  const current: QueueRow | null = detail ?? (id === openId ? row : null)

  const [confirming, setConfirming] = useState<null | 'reject' | 'undo-change'>(null)
  const [reason, setReason] = useState('')
  const [overlayBusy, setOverlayBusy] = useState(false)
  const [overlayError, setOverlayError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; openId?: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')

  // Every request opens clean: no leftover question, note or announcement.
  useEffect(() => {
    setConfirming(null); setReason(''); setOverlayError(null); setNotice(null); setAnnouncement('')
  }, [id])

  const status = current ? statusWords(current, detail?.channelResult) : null
  const statusLabel = status?.label ?? null
  const detailId = detail?.id ?? null

  // A change of status while it is open is told once to a screen reader ("Now: Done · reached eBay IT").
  const previous = useRef<{ id: string; label: string } | null>(null)
  useEffect(() => {
    if (!detailId || !statusLabel) return
    const before = previous.current
    previous.current = { id: detailId, label: statusLabel }
    if (before && before.id === detailId && before.label !== statusLabel) setAnnouncement(`Now: ${statusLabel}`)
  }, [detailId, statusLabel])

  const busy = !!id && actions.busyIds.has(id)
  const cancelOverlay = useCallback(() => { setConfirming(null); setOverlayError(null) }, [])

  const reject = async () => {
    if (!current) return
    setOverlayBusy(true)
    try {
      await actions.reject(current, reason.trim() || undefined)
      setConfirming(null)
      setReason('')
    } finally {
      setOverlayBusy(false)
    }
  }

  const undoChange = async () => {
    if (!detail?.change) return
    setOverlayBusy(true)
    setOverlayError(null)
    try {
      const out = await claudeApi.undo(detail.change.id)
      setConfirming(null)
      setNotice({ text: `Undo approved: it runs at ${clock(out.executeAfter)}, unless someone stops it in Approvals.`, openId: out.approvalId })
      actions.refresh()
    } catch (error) {
      setOverlayError(error instanceof Error ? error.message : 'The undo could not be asked for.')
    } finally {
      setOverlayBusy(false)
    }
  }

  const overlay = confirming === 'reject' && current ? (
    <RejectCard
      row={current}
      reason={reason}
      busy={overlayBusy}
      onReason={setReason}
      onCancel={cancelOverlay}
      onReject={() => void reject()}
    />
  ) : confirming === 'undo-change' && detail?.change ? (
    <UndoChangeCard detail={detail} busy={overlayBusy} error={overlayError} onCancel={cancelOverlay} onUndo={() => void undoChange()} />
  ) : undefined

  return (
    <Drawer
      open={!!openId}
      mode="modal"
      onClose={onClose}
      title={current?.title ?? 'Request'}
      subtitle={current ? `Asked by ${current.asker.label}` : undefined}
      footer={current && state.kind !== 'not-found' ? <Facts row={current} detail={detail} /> : undefined}
      overlay={overlay}
      width={APPROVAL_DRAWER_WIDTH}
      closeLabel="Close request details"
      className={`fleet-portal ${styles.drawer}`}
    >
      <div className={styles.body}>
        <p className="nds-vh" role="status" aria-live="polite">{announcement}</p>
        {state.kind === 'not-found' && <EmptyState title={NOT_FOUND_WORDS} description="It was removed, or it belongs to another business." />}
        {state.kind === 'error' && !current && (
          <Banner tone="danger" title="This request could not be read." action={<Button size="sm" onClick={reload}>Try again</Button>}>{state.message}</Banner>
        )}
        {state.kind !== 'not-found' && current && status && (
          <>
            {state.kind === 'ready' && state.stale && (
              <Banner tone="warning" title="Showing what Nexus read last." action={<Button size="sm" onClick={reload}>Try again</Button>}>
                The newest read failed: {state.stale}
              </Banner>
            )}
            {state.kind === 'error' && (
              <Banner tone="danger" title="The details could not be read." action={<Button size="sm" onClick={reload}>Try again</Button>}>{state.message}</Banner>
            )}
            {notice && (
              <Banner
                tone="success"
                onDismiss={() => setNotice(null)}
                action={notice.openId ? <Button size="sm" onClick={() => { follow(notice.openId!); setNotice(null) }}>Show the undo</Button> : undefined}
              >
                {notice.text}
              </Banner>
            )}
            <Summary row={current} status={status} refresh={actions.refresh} />
            <Verbs row={current} actions={actions} busy={busy} onReject={() => { setConfirming('reject'); setOverlayError(null) }} />
            <Why row={current} detail={detail} />
            {state.kind === 'loading' && <ProgressBar indeterminate ariaLabel="Reading this request" />}
            {detail && <DetailSections detail={detail} busy={busy} onFollow={follow} onRefresh={actions.refresh} onUndoChange={() => { setConfirming('undo-change'); setOverlayError(null) }} />}
          </>
        )}
        {state.kind === 'loading' && !current && <ProgressBar indeterminate ariaLabel="Reading this request" />}
      </div>
    </Drawer>
  )
}

/* ── 1. status, product, where ───────────────────────────────────────────────────────────────── */

function Summary({ row, status, refresh }: { row: QueueRow; status: { label: string; tone: Tone }; refresh: () => void }) {
  const target = targetWords(row.target)
  const product = target ? (
    <span className={styles.target}>
      {target.href
        ? <Link href={target.href} className={styles.link}><span className={styles.mono}>{target.main}</span></Link>
        : <span className={styles.mono}>{target.main}</span>}
      {target.name && <span className={styles.text}>{target.name}</span>}
      {target.more && <span className={styles.muted}>{target.more}</span>}
    </span>
  ) : <span className={styles.muted}>The request names no single item</span>
  const facts: KeyValueItem[] = [
    { label: TARGET_LABEL[row.target?.kind ?? 'product'] ?? 'About', value: product },
    { label: 'Where', value: whereLine(row) },
    { label: 'What it means', value: consequenceWords(row) },
  ]
  const runsAt = row.executeAfter && (row.state === 'starting' || row.state === 'on_hold') ? row.executeAfter : null
  return (
    <>
      <section className={styles.status} aria-label="Status">
        <Pill tone={status.tone}>{status.label}</Pill>
        {runsAt && <Countdown to={runsAt} label={(left) => `Runs in ${left}`} doneLabel="Starting…" onDone={refresh} />}
      </section>
      <KeyValue items={facts} columns={2} dense />
    </>
  )
}

/* ── 2. the row's verbs ──────────────────────────────────────────────────────────────────────── */

function Verbs({ row, actions, busy, onReject }: { row: QueueRow; actions: ApprovalActions; busy: boolean; onReject: () => void }) {
  const verbs = drawerVerbs(row.state)
  const whyId = useId()
  const error = actions.errors.get(row.id) ?? null
  // Approve (and approve-again) is HELD, not disabled, when this person may not approve: it stays focusable and says why.
  const held = !row.canApprove
  const approveLabel = row.plan ? `Approve ${plural(row.plan.steps, 'change')}` : 'Approve'
  return (
    <section className={styles.section} aria-label="Decide">
      {error && <Banner tone="danger" title="That did not work" onDismiss={() => actions.dismissError(row.id)}>{error}</Banner>}
      <div className={styles.actions}>
        {verbs.approve && (
          <Button
            variant="primary"
            disabled={busy}
            aria-disabled={held || undefined}
            aria-describedby={held ? whyId : undefined}
            onClick={() => { if (!held) void actions.approve(row) }}
          >
            {approveLabel}
          </Button>
        )}
        {verbs.retry && (
          <Button
            variant="primary"
            disabled={busy}
            aria-disabled={held || undefined}
            aria-describedby={held ? whyId : undefined}
            onClick={() => { if (!held) void actions.retry(row) }}
          >
            {verbs.retry}
          </Button>
        )}
        {verbs.reject && <Button disabled={busy} onClick={onReject}>Reject…</Button>}
        {verbs.undo && <Button variant="primary" disabled={busy} onClick={() => void actions.undo(row)}>Undo</Button>}
        {verbs.hold && <Button disabled={busy} onClick={() => void actions.hold(row)}>Hold 10 min</Button>}
        <Button variant="quiet" disabled={busy} onClick={() => actions.openAutomate(row)}>Automate this kind…</Button>
        <span className={styles.muted} role="status">{busy ? 'Working…' : ''}</span>
      </div>
      {held && (verbs.approve || verbs.retry) && (
        <p id={whyId} className={styles.muted}>You cannot approve this: {row.cannotApproveWhy ?? 'Nexus did not say why.'} You can still reject it.</p>
      )}
      {row.state === 'starting' && <p className={styles.muted}>Approved. It waits a short stop window first: Undo takes the approve back.</p>}
    </section>
  )
}

/* ── 3. why it waits, why it failed or came back ─────────────────────────────────────────────── */

function Why({ row, detail }: { row: QueueRow; detail: QueueDetail | null }) {
  const view = whyView({ state: row.state, note: row.note, reason: detail?.reason ?? null, automation: row.automation })
  if (!view) return null
  if (view.banner) return <Banner tone={view.tone} title={view.title}>{view.text}</Banner>
  return (
    <section className={styles.section} aria-label={view.title}>
      <span className={styles.label}>{view.title}</span>
      <p className={styles.text}>{view.text}</p>
      {row.state === 'rejected' && detail?.operatorNote && detail.operatorNote !== view.text && (
        <p className={styles.text}><span className={styles.label}>Their note: </span>{detail.operatorNote}</p>
      )}
    </section>
  )
}

/* ── 4–9: what only the detail carries ───────────────────────────────────────────────────────── */

function DetailSections({ detail, busy, onFollow, onRefresh, onUndoChange }: {
  detail: QueueDetail
  busy: boolean
  onFollow: (id: string) => void
  onRefresh: () => void
  onUndoChange: () => void
}) {
  const base = useId()
  const steps: TimelineStep[] = timelineSteps(detail)
  return (
    <>
      {detail.plan
        ? <PlanSection key={detail.id} detail={detail} busy={busy} onReplaced={onFollow} />
        : <Changes detail={detail} titleId={`${base}-changes`} />}

      {detail.askerReason && (
        <section className={styles.section} aria-labelledby={`${base}-says`}>
          <h3 id={`${base}-says`} className={styles.sectionTitle}>{askerSaysLabel(detail.asker)}</h3>
          {/* Plain text, as written: never Markdown, never HTML. */}
          <p className={styles.quote}>{detail.askerReason}</p>
        </section>
      )}

      <section className={styles.section} aria-labelledby={`${base}-timeline`}>
        <h3 id={`${base}-timeline`} className={styles.sectionTitle}>What happened</h3>
        {steps.length ? <Timeline steps={steps} label="What happened to this request" /> : <p className={styles.muted}>Nothing recorded yet.</p>}
      </section>

      {detail.change && <UndoSection detail={detail} titleId={`${base}-undo`} onUndo={onUndoChange} />}

      <EditValue
        key={detail.id}
        detail={detail}
        busy={busy}
        onReplaced={(newId) => {
          onRefresh()
          if (newId) onFollow(newId)
        }}
      />
    </>
  )
}

function Changes({ detail, titleId }: { detail: QueueDetail; titleId: string }) {
  const view = changesView(detail)
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.sectionTitle}>{detail.changeCount > 1 ? `Changes (${detail.changeCount})` : 'Change'}</h3>
      {detail.summary && <p className={styles.text}>{detail.summary}</p>}
      {view.mode === 'lines' ? (
        view.lines.length || view.more
          ? <ChangeValue changes={view.lines} more={view.more} />
          : <p className={styles.muted}>The request shows no before and after.</p>
      ) : (
        <>
          <ul className={styles.items} aria-label="Items in this request">
            {view.items.map((item, index) => (
              <li key={`${item.sku ?? ''}:${index}`} className={styles.item}>
                <span className={styles.itemName}>
                  <span className={styles.mono}>{item.sku ?? '—'}</span>
                  {item.name && <span className={styles.muted}>{item.name}</span>}
                </span>
                {item.change ? <ChangeValue changes={[item.change]} /> : <span className={styles.muted}>No change shown</span>}
              </li>
            ))}
          </ul>
          {view.more > 0 && <p className={styles.muted}>and {view.more} more</p>}
        </>
      )}
    </section>
  )
}

function UndoSection({ detail, titleId, onUndo }: { detail: QueueDetail; titleId: string; onUndo: () => void }) {
  const change = detail.change!
  return (
    <section className={styles.section} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.sectionTitle}>Undo</h3>
      {change.undoneAt ? (
        <p className={styles.text}>It was put back <AsOf at={change.undoneAt} kind="event" />.</p>
      ) : change.undoable ? (
        <div className={styles.actions}>
          <p className={styles.text}>
            {detail.reversibility === 'partial' ? 'It can be partly put back.' : 'It can be put back.'} Undo asks for the opposite change; it waits the same
            stop window and is checked again when it runs.
          </p>
          <Button onClick={onUndo}>Undo this change…</Button>
        </div>
      ) : (
        <p className={styles.muted}>{change.whyNotUndoable ?? 'This change cannot be undone from here.'}</p>
      )}
    </section>
  )
}

/* ── questions asked inside the drawer ───────────────────────────────────────────────────────── */

function RejectCard({ row, reason, busy, onReason, onCancel, onReject }: {
  row: QueueRow
  reason: string
  busy: boolean
  onReason: (reason: string) => void
  onCancel: () => void
  onReject: () => void
}) {
  const titleId = useId()
  const goesBack = row.asker.kind === 'claude' ? 'Claude sees that you rejected it, with your reason if you give one.' : 'Your reason is kept with the request.'
  return (
    <DrawerOverlayCard labelledBy={titleId} onCancel={busy ? undefined : onCancel}>
      <form
        className={styles.overlay}
        onSubmit={(event) => {
          event.preventDefault()
          onReject()
        }}
      >
        <h3 id={titleId} className={styles.overlayTitle}>Reject this request?</h3>
        <p className={styles.text}>Nothing changes. {goesBack}</p>
        <Field label="Reason (optional)" hint="500 characters at most.">
          {/* The one input of this question: focused so it can be answered without hunting. */}
          <Textarea value={reason} maxLength={500} rows={3} autoFocus disabled={busy} onChange={(event) => onReason(event.target.value)} />
        </Field>
        <div className={styles.overlayActions}>
          <Button size="md" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="md" variant="primary" type="submit" disabled={busy}>{busy ? 'Rejecting…' : 'Reject'}</Button>
        </div>
      </form>
    </DrawerOverlayCard>
  )
}

function UndoChangeCard({ detail, busy, error, onCancel, onUndo }: {
  detail: QueueDetail
  busy: boolean
  error: string | null
  onCancel: () => void
  onUndo: () => void
}) {
  const titleId = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  // A question that changes something: Cancel takes focus first.
  useEffect(() => { cancel.current?.focus() }, [])
  return (
    <DrawerOverlayCard labelledBy={titleId} role="alertdialog" onCancel={busy ? undefined : onCancel}>
      <div className={styles.overlay}>
        <h3 id={titleId} className={styles.overlayTitle}>Undo this {detail.title} change?</h3>
        <ul className={styles.consequences}>
          <li>It asks for the opposite change, approved by this click: it puts back what the change replaced.</li>
          <li>It waits the same short stop window, and it is refused when it runs if the value moved again meanwhile.</li>
          {detail.reachesOutside && <li>The old value is sent to the channel again.</li>}
          {detail.reversibility === 'partial' && <li>It can be only partly undone: what already happened on the channel stays.</li>}
        </ul>
        {error && <Banner tone="danger" title="Not undone">{error}</Banner>}
        <div className={styles.overlayActions}>
          <Button ref={cancel} size="md" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="md" variant="primary" onClick={onUndo} disabled={busy}>{busy ? 'Asking…' : 'Undo the change'}</Button>
        </div>
      </div>
    </DrawerOverlayCard>
  )
}

/* ── 10. footer: the request's facts ─────────────────────────────────────────────────────────── */

function Facts({ row, detail }: { row: QueueRow; detail: QueueDetail | null }) {
  const open = row.state === 'waiting' || row.state === 'back_to_you' || row.state === 'failed'
  return (
    <dl className={styles.facts}>
      <div className={styles.fact}>
        <dt>Request</dt>
        <dd><CopyId id={row.id} /></dd>
      </div>
      <div className={styles.fact}>
        <dt>Asked</dt>
        <dd><AsOf at={row.requestedAt} kind="event" />{row.asker.connection ? ` · ${row.asker.connection}` : ''}</dd>
      </div>
      {open && row.expiresAt && (
        <div className={styles.fact}>
          <dt>Expires</dt>
          <dd><Countdown to={row.expiresAt} label={(left) => `in ${left}`} doneLabel="now" announce={false} /></dd>
        </div>
      )}
      {row.decider && (
        <div className={styles.fact}>
          <dt>Decided by</dt>
          <dd>{row.decider.label}{row.decidedAt ? <> · <AsOf at={row.decidedAt} kind="event" /></> : null}</dd>
        </div>
      )}
      {detail?.operatorNote && row.state !== 'rejected' && (
        <div className={styles.fact}>
          <dt>Note</dt>
          <dd>{detail.operatorNote}</dd>
        </div>
      )}
    </dl>
  )
}

function CopyId({ id }: { id: string }) {
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (!said) return
    const clear = window.setTimeout(() => setSaid(''), 2500)
    return () => window.clearTimeout(clear)
  }, [said])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setSaid('Copied')
    } catch {
      setSaid('The browser did not allow copying')
    }
  }
  return (
    <span className={styles.copy}>
      <span className={styles.mono} title={id}>{shortId(id)}</span>
      <Button size="sm" variant="quiet" aria-label="Copy the request id" onClick={() => void copy()}><Copy size={14} aria-hidden /></Button>
      <span role="status" className={styles.muted}>{said}</span>
    </span>
  )
}
