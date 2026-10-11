'use client'

/**
 * "Harvest to…" — ONE window from the terms to Amazon (Keyword Harvest page, lane HTO, 2026-10-11). The Owner's liked
 * pattern: a default for every choice, one summary + one table, a counted primary, Done with Undo. Review is a STEP in
 * this window (DS `ReviewChangesPanel`), never a dialog on a dialog. On a phone the window is a full-screen sheet.
 *
 *   Set up   To (DS-lane `DestinationPicker`, read for one of the terms so its "Suggested" is theirs; held places say
 *            why; "New campaign…" = Portfolio · Name · Budget here, "New portfolio…" = the same Portfolio field as a name +
 *            a monthly cap). A market that cannot build a new campaign (no daily spend limit, …) holds both up front, in
 *            plain words with where to fix it — a probe preview asks before anything is filled (M7). As (Exact | Phrase),
 *            Block where found (a saved "keep the source" shows off, with why), the terms with CPC and bid ("Bid all €x",
 *            "CPC +x %"; the bid's hover says why it is what it is), held terms say why.
 *   Review   POST /preview: Keywords (Now = CPC) · Negatives · New campaign, the terms left out one line per reason in
 *            words, "Harvest 3 · create 1".
 *   Done     POST /apply with the person's approval in the same click (one request, one approval; it goes to Amazon after
 *            the short undo window): "3 keywords · 6 blocks · goes to Amazon in 18 s", Undo, Open campaign. A new
 *            campaign needs the approver's authenticator code (code rule A): the DS code dialog asks for it. A plan that
 *            moved since the review (409) is read again with a plain note.
 *   Undo     before it ran: taken back (nothing sent). After: its harvests put back — each keyword paused (never
 *            archived), each block removed — reviewed first, one request.
 *
 * Mode 'suggested' opens at the review (every term to its own suggested place; "Change…" opens Set up); 'choose' opens
 * at Set up. Keys: everything is a DS control in tab order; Esc closes the top layer only (a list, then the window);
 * the focus goes back to `returnFocusTo` (else the control that opened it). Nothing here writes to Amazon directly.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button, Checkbox, Input, SegmentedControl, Skeleton, Tag, Tooltip } from '@/design-system/primitives'
import {
  Banner, Countdown, EntityPath, Field, Listbox, Modal, SummaryTable, useNarrow,
  type EntityLinkComponent, type ListboxPanelAction, type ListboxPanelOption,
} from '@/design-system/components'
import { ReviewChangesPanel, StepUpModal, type ReviewPanelChange, type ReviewPanelResult, type ReviewState } from '@/design-system/patterns'
import Link from '@/lib/workspaces/Link'
import { Plus } from 'lucide-react'

import { currencySymbol } from '../../bid/_shared/format'
import { DestinationPicker } from '../../_shared/DestinationPicker'
import { applyHarvest, decideWaiting, previewHarvest, readDestinations, readHistory, undoHarvests } from '../_shared/harvestApi'
import type {
  ApplyAnswer, HarvestCandidateRow, HarvestDestinations, HarvestMatch, HarvestTo, HarvestToWindowProps, HistoryRow, PreviewAnswer,
  PreviewBody, UndoAnswer,
} from '../_shared/types'
import { takeBack } from './harvestToApi'
import {
  MAX_TERMS, NEW_CAMPAIGN_KEY, NEW_PORTFOLIO_KEY, REVIEW_GROUPS, TAKEN_BACK, anchorRow, bidsAllTo, bidsFromCpc, buildPreviewBody,
  canTakeBack, currencyOfRows, defaultTo, doneViewOf, draftProblem, keptBySaved, limitWordsOf, oneCurrency, sourceChoice, harvestButtonWords, harvestDoneLine, harvestsOf,
  isLocalPortfolio, leftOutOf, newCampaignDefaults, newCampaignHold, openCampaignOf, parseMoney, parsePercent, probeBody, reviewHeld,
  reviewRowsOf, reviewSummary, scopeOf, setupHeld, sourceSwitch, termList, termRowsOf, undoButtonWords, undoDoneLine, undoPlanOf,
  type HarvestReviewRow, type NewCampaignDraft, type NewPortfolioDraft, type TermRow, type UndoPlan,
} from './harvestToModel'
import styles from './harvestTo.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const MATCHES = [{ value: 'EXACT', label: 'Exact' }, { value: 'PHRASE', label: 'Phrase' }]
/** The approve that needs the approver's authenticator code (the DS code dialog asks for it). */
const CODE_NEEDED = new Set(['mfa_required', 'mfa_invalid'])

// The contract (TERMS → HTO, `_shared/types.ts`): what the page passes.
export type { HarvestToWindowProps } from '../_shared/types'

type Step = 'setup' | 'review' | 'done' | 'undo'

/** The change set's approval takes the approver's authenticator code (a new campaign: code rule A). */
function needsCode(p: PreviewAnswer | null): boolean {
  return !!p && (p.approvals.codes > 0 || !!(p as PreviewAnswer & { stepUp?: unknown }).stepUp)
}

/** The person's own limits the change set goes past (the engine warns; approving sends it anyway). */
function pastLimits(p: PreviewAnswer | null): Array<{ limit: string; reason: string }> {
  const list = (p as (PreviewAnswer & { pastOwnLimits?: Array<{ limit: string; reason: string }> }) | null)?.pastOwnLimits
  return Array.isArray(list) ? list : []
}

export function HarvestToWindow(props: HarvestToWindowProps) {
  // A fresh window every time it opens: no draft from the last one.
  if (!props.open) return null
  return <HarvestToBody {...props} />
}

function HarvestToBody({ source, mode, market, productId, returnFocusTo, onClose, onDone }: HarvestToWindowProps) {
  const narrow = useNarrow()
  const bodyRef = useRef<HTMLDivElement>(null)
  const toId = useId()

  // ── the terms: the ticked rows as they were when the window opened (R7), at most MAX_TERMS in one change set ────────
  const [selected] = useState(source.rows.length)
  const [list] = useState<HarvestCandidateRow[]>(() => source.rows.slice(0, MAX_TERMS))
  const scope = useMemo(() => scopeOf(list), [list])
  const single = !scope.held && !!scope.productId && !!scope.market
  const currency = currencyOfRows(list, scope.market ?? market)
  const symbol = currencySymbol(currency)
  const markets = scope.markets.length ? scope.markets : [market]
  // One of the terms (one that can go, whose place most of them share): the tree is read for it, so "Suggested" is theirs.
  const anchor = useMemo(() => anchorRow(list), [list])

  // ── where they go ──────────────────────────────────────────────────────────────────────────────────────────────────
  const [match, setMatch] = useState<HarvestMatch>('EXACT')
  const [tree, setTree] = useState<HarvestDestinations | null>(null)
  const [treeErr, setTreeErr] = useState<string | null>(null)
  const [treeTick, setTreeTick] = useState(0)
  useEffect(() => {
    if (!single || !scope.market || !scope.productId) return
    let alive = true
    setTree(null); setTreeErr(null)
    readDestinations(anchor ? { candidateId: anchor.id, match } : { market: scope.market, productId: productId && productId === scope.productId ? productId : scope.productId, match })
      .then((t) => { if (alive) setTree(t) })
      .catch((e: Error) => { if (alive) setTreeErr(e.message) })
    return () => { alive = false }
  }, [single, scope.market, scope.productId, productId, match, treeTick, anchor])

  // M7 — can this market build a new campaign? Asked up front with a probe preview (writes nothing), so "New campaign…"
  // and "New portfolio…" are held, in words, before the person fills a field — never only at the review.
  const [probe, setProbe] = useState<ReturnType<typeof newCampaignHold>>(null)
  useEffect(() => {
    if (!single || !anchor) return
    let alive = true
    setProbe(null)
    void previewHarvest(probeBody(anchor, match)).then((out) => { if (alive && out.ok) setProbe(newCampaignHold(out.data, scope.market)) })
    return () => { alive = false }
  }, [single, anchor, match, scope.market])
  const campaignHold = useMemo(() => (
    tree?.newCampaign.held ? { label: tree.newCampaign.held.label, reason: tree.newCampaign.held.reason, fix: null } : probe
  ), [tree, probe])
  const heldTree = useMemo<HarvestDestinations | null>(() => (
    tree && campaignHold && !tree.newCampaign.held ? { ...tree, newCampaign: { ...tree.newCampaign, held: { label: campaignHold.label, reason: campaignHold.reason } } } : tree
  ), [tree, campaignHold])

  const [to, setTo] = useState<HarvestTo | null>(null)
  const toTouched = useRef(false)
  const [nc, setNc] = useState<NewCampaignDraft | null>(null)
  const ncNameTouched = useRef(false)
  const [np, setNp] = useState<NewPortfolioDraft | null>(null)
  // The terms' bids now (typed, else their start bids): a new campaign's default budget fits them (functional walk).
  const bidsRef = useRef<Record<string, string>>({})
  const bidsNow = () => list.map((r) => { const t = parseMoney(bidsRef.current[r.id]); return bidsRef.current[r.id] !== undefined && t.kind === 'ok' ? t.value : r.startBidCents })
  // 'choose': start on the suggested place, until the person picks one.
  useEffect(() => {
    if (mode !== 'choose' || !heldTree || toTouched.current) return
    const s = defaultTo(heldTree, list)
    setTo(s)
    if (s && 'newCampaign' in s) setNc((d) => d ?? newCampaignDefaults(heldTree, bidsNow()))
  }, [mode, heldTree, list])
  // The proposed name follows the match until the person types one.
  useEffect(() => { if (tree && nc && !ncNameTouched.current) setNc((d) => (d ? { ...d, name: tree.newCampaign.name } : d)) }, [tree]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (next: HarvestTo | null) => {
    toTouched.current = true
    setTo(next)
    if (next && 'newCampaign' in next) setNc((d) => d ?? newCampaignDefaults(tree, bidsNow()))
  }
  const startNewCampaign = () => { setNc((d) => d ?? newCampaignDefaults(tree, bidsNow())); pick({ newCampaign: NEW_CAMPAIGN_KEY }) }
  const startNewPortfolio = () => {
    const name = `${scope.productName ?? 'Product'} ${scope.market ?? market}`.trim()
    setNp((d) => d ?? { name, cap: '' })
    setNc((d) => ({ ...(d ?? newCampaignDefaults(tree, bidsNow())), portfolio: { newPortfolio: NEW_PORTFOLIO_KEY } }))
    pick({ newCampaign: NEW_CAMPAIGN_KEY })
  }
  const newCampaignChosen = !!to && 'newCampaign' in to
  const draft = newCampaignChosen ? nc : null
  const newPortfolioChosen = !!draft?.portfolio && 'newPortfolio' in draft.portfolio

  // ── in source, bids ────────────────────────────────────────────────────────────────────────────────────────────────
  const [negate, setNegate] = useState<boolean | null>(null)
  const source_ = sourceSwitch(tree, to, match, negate)
  const sourceDefault = sourceSwitch(tree, to, match, null)
  // R3 — each to its own place: where a saved place keeps its source, it stays kept unless the person unticks on purpose.
  const keptCount = !to && negate === null ? keptBySaved(list) : 0
  const sourceWhy = source_.why ?? (keptCount ? `Kept where your saved place says so: ${keptCount} ${keptCount === 1 ? 'term' : 'terms'}` : null)
  const [bids, setBids] = useState<Record<string, string>>({})
  bidsRef.current = bids
  const [allTo, setAllTo] = useState('')
  const [cpcPct, setCpcPct] = useState('')
  const termRows = useMemo(() => termRowsOf(list, bids), [list, bids])
  // R5 — every row in its own market's money; "Bid all" only when they share one.
  const bulkCurrency = useMemo(() => oneCurrency(list), [list])
  const moneyShown = termRows.some((r) => !r.moneyHidden)
  const firstBad = termRows.find((r) => r.bidProblem)
  const allToParsed = parseMoney(allTo)
  const cpcParsed = parsePercent(cpcPct)
  const setAll = () => { if (allToParsed.kind === 'ok') setBids((b) => ({ ...b, ...bidsAllTo(list, allToParsed.value) })) }
  const setCpc = () => { if (cpcParsed.kind === 'ok') setBids((b) => ({ ...b, ...bidsFromCpc(list, cpcParsed.value) })) }

  // ── steps ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const [step, setStepRaw] = useState<Step>(mode === 'suggested' ? 'review' : 'setup')
  const [sawSetup, setSawSetup] = useState(mode === 'choose')
  const setStep = useCallback((s: Step) => { if (s === 'setup') setSawSetup(true); setStepRaw(s) }, [])
  const [review, setReview] = useState<ReviewState>({ phase: 'reading' })
  const [preview, setPreview] = useState<PreviewAnswer | null>(null)
  const [sent, setSent] = useState<PreviewBody | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [ack, setAck] = useState(false)
  const [answer, setAnswer] = useState<ApplyAnswer | null>(null)
  const [takenBack, setTakenBack] = useState(false)
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoNote, setUndoNote] = useState<string | null>(null)
  const [undoPlan, setUndoPlan] = useState<UndoPlan | null>(null)
  const [undoState, setUndoState] = useState<ReviewState>({ phase: 'ready' })
  const [undoAnswer, setUndoAnswer] = useState<UndoAnswer | null>(null)
  const [, setClock] = useState(0)
  // A new campaign needs the approver's authenticator code (code rule A): the DS code dialog, stacked on this window.
  const [stepUp, setStepUp] = useState<{ busy: boolean; error: string | null } | null>(null)
  const asked = useRef(0)

  const body = useCallback((): PreviewBody => buildPreviewBody({ rows: list, to, match, negate, bids, newCampaign: draft, newPortfolio: newPortfolioChosen ? np : null }), [list, to, match, negate, bids, draft, newPortfolioChosen, np])

  const runPreview = useCallback(async (b: PreviewBody, why: string | null = null) => {
    const n = ++asked.current
    setStep('review'); setSent(b); setPreview(null); setProblem(null); setNote(why); setReview({ phase: 'reading' })
    const out = await previewHarvest(b)
    if (n !== asked.current) return
    if (!out.ok) { setReview({ phase: 'failed', error: out.words }); return }
    setPreview(out.data); setReview({ phase: 'ready' })
  }, [setStep])

  // 'suggested': the review is the first screen, read as soon as the terms are.
  const started = useRef(false)
  useEffect(() => {
    if (mode !== 'suggested' || started.current) return
    started.current = true
    if (!list.length) { setStep('setup'); return } // nothing to read: Set up says so
    void runPreview(buildPreviewBody({ rows: list, to: null, match: 'EXACT', negate: null, bids: {}, newCampaign: null, newPortfolio: null }))
  }, [mode, list, runPreview, setStep])

  const apply = async () => {
    if (!preview || !sent) return
    setReview({ phase: 'saving' })
    const out = await applyHarvest({ ...sent, planHash: preview.planHash, approve: true, why: 'Harvested on the Keyword Harvest page' })
    if (!out.ok) {
      if (out.status === 409) { await runPreview(sent, 'Something changed since this was read. Here it is again: check it, then harvest.'); return }
      setReview({ phase: 'ready' }); setProblem(out.words); return
    }
    setAnswer(out.data); setStep('done')
    const a = out.data.approve
    if (a && !a.ok && a.code && CODE_NEEDED.has(a.code)) setStepUp({ busy: false, error: null })
  }

  /** The code for an approve that needs one: it approves the same request; a wrong code keeps the dialog with its words. */
  const submitCode = async (code: string) => {
    if (!answer) return
    setStepUp({ busy: true, error: null })
    const out = await decideWaiting([{ approvalId: answer.changeSetId, decide: 'approve', code }])
    const r = out.ok ? out.data.results[0] : undefined
    if (r?.ok) {
      setAnswer((a) => (a ? { ...a, status: 'scheduled', executeAfter: r.executeAfter ?? null, approve: { ok: true } } : a))
      setStepUp(null)
      return
    }
    const words = r?.error ?? (out.ok ? 'Not approved' : out.words)
    if (r?.code === 'mfa_locked') { setStepUp(null); setUndoNote(words); return }
    setStepUp({ busy: false, error: words })
  }

  const startUndo = async () => {
    if (!answer) return
    setUndoBusy(true); setUndoNote(null)
    try {
      if (!canTakeBack(answer, Date.now())) {
        const history = await readHistory({ market: markets.join(','), productId: single ? scope.productId : null, days: 2 })
        const mine: HistoryRow[] = harvestsOf(history.rows, answer.changeSetId)
        if (mine.length) {
          setUndoPlan(undoPlanOf(mine)); setUndoState({ phase: 'ready' }); setUndoAnswer(null); setStep('undo')
          return
        }
      }
      // It has not run: take it back (nothing was sent).
      const back = await takeBack(answer.changeSetId, answer.status)
      if (back.ok) setTakenBack(true)
      else if (back.unapproved) {
        // Out of the run, but not rejected: it waits for approval again (never left reading "Approved").
        setAnswer((a) => (a ? { ...a, status: 'queued', executeAfter: null, approve: { ok: false, error: `Taken out of the run; it waits for approval again (${back.words})` } } : a))
      } else setUndoNote(back.words)
    } catch (e) {
      setUndoNote((e as Error).message)
    } finally {
      setUndoBusy(false)
    }
  }

  const sendUndo = async () => {
    if (!undoPlan || undoPlan.held) return
    setUndoState({ phase: 'saving' })
    const out = await undoHarvests({ harvestIds: undoPlan.harvestIds, approve: true, why: 'Undone on the Keyword Harvest page' })
    if (!out.ok) { setUndoState({ phase: 'ready' }); setUndoNote(out.words); return }
    setUndoAnswer(out.data)
  }

  // The window's own close: after a change set was asked the page hears it once (onDone), then it closes.
  const finished = useRef(false)
  const close = () => {
    if (answer && preview && !finished.current) {
      finished.current = true
      onDone()
    }
    onClose()
  }

  // Focus, step by step (a footer or a body re-drawn under the focus would drop it on <body>): Set up → its first
  // control; Review → the dialog (its title is read; Harvest is never one Enter away); Done → Done. Focus that got lost
  // (its control went away) comes back to the dialog.
  const focusNext = useRef<'first' | 'dialog' | 'primary' | null>(null)
  const focusKey = `${step}|${undoAnswer ? 1 : 0}|${takenBack ? 1 : 0}`
  const lastFocusKey = useRef(focusKey)
  useEffect(() => {
    if (lastFocusKey.current === focusKey) return
    lastFocusKey.current = focusKey
    focusNext.current = step === 'setup' ? 'first' : step === 'done' || (step === 'undo' && undoAnswer) ? 'primary' : 'dialog'
  }, [focusKey, step, undoAnswer])
  useEffect(() => {
    const dialog = bodyRef.current?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const want = focusNext.current
    const lost = !document.activeElement || document.activeElement === document.body
    if (!want && !lost) return
    focusNext.current = null
    const target = want === 'primary' ? dialog.querySelector<HTMLElement>('[data-hto-primary]')
      : want === 'first' ? bodyRef.current?.querySelector<HTMLElement>('button:not([aria-hidden="true"]), input, [tabindex="0"]') ?? null
        : null
    ;(target ?? dialog).focus()
  })

  // ── the review's rows (links where a page exists) ─────────────────────────────────────────────────────────────────
  const cpcById = useMemo(() => new Map(list.map((r) => [r.id, r.metrics.cpcCents])), [list])
  const currencyById = useMemo(() => new Map(termRows.map((r) => [r.id, r.currency])), [termRows])
  const reviewRows = useMemo(() => (preview ? reviewRowsOf(preview, currency, cpcById, currencyById) : []), [preview, currency, cpcById, currencyById])
  // Desktop: Where · What · Now · New · Note. Phone: the place is a second line under What (no Where column), and the new
  // value keeps its words on one line, so the table stays narrow.
  const toChanges = (list_: readonly HarvestReviewRow[], label: string): ReviewPanelChange[] => list_.map((r) => {
    const path = <span className={styles.where}><EntityPath items={r.where} linkAs={WorkspaceLink} label={label} /></span>
    return narrow
      ? { id: r.id, group: r.group, what: <span className={styles.term}><span>{r.what}</span><span className={styles.sub}>{path}</span></span>, now: <span className={styles.nowrap}>{r.now}</span>, next: <span className={styles.nowrap}>{r.next}</span>, note: r.note }
      : { id: r.id, group: r.group, what: r.what, now: r.now, next: r.next, note: r.note, where: path }
  })
  const changes = useMemo(() => toChanges(reviewRows, 'Where'), [reviewRows, narrow]) // eslint-disable-line react-hooks/exhaustive-deps
  const done = answer ? doneViewOf(answer, preview ? harvestDoneLine(preview) : '') : null
  const results = useMemo<Record<string, ReviewPanelResult>>(() => {
    if (!done) return {}
    const words = takenBack ? 'Taken back' : done.words
    const tone = takenBack ? 'neutral' : done.resultTone
    return Object.fromEntries(changes.map((c) => [c.id, { ok: true, words, tone }]))
  }, [changes, done, takenBack])

  const undoChanges = useMemo(() => (undoPlan ? toChanges(undoPlan.rows, 'Where') : []), [undoPlan, narrow]) // eslint-disable-line react-hooks/exhaustive-deps
  const undoDone = undoAnswer ? doneViewOf(undoAnswer, undoPlan ? undoDoneLine(undoPlan) : '') : null
  const undoResults = useMemo<Record<string, ReviewPanelResult>>(() => (
    undoDone ? Object.fromEntries(undoChanges.map((c) => [c.id, { ok: true, words: undoDone.words, tone: undoDone.resultTone }])) : {}
  ), [undoChanges, undoDone])

  // ── words ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const setupHold = setupHeld({
    rows: list.length, mode, single, to,
    draft: (draft && campaignHold ? campaignHold.reason : null) ?? draftProblem(draft, newPortfolioChosen ? np : null, currency),
    bid: firstBad ? { term: firstBad.term, problem: firstBad.bidProblem ?? '' } : null,
  })
  const harvestHold = reviewHeld(review.phase, preview, problem)
  const n = list.length
  const termsWord = `${n} ${n === 1 ? 'term' : 'terms'}`
  const title = step === 'setup' ? `Harvest ${termsWord}`
    : step === 'review' ? 'Review' : step === 'undo' ? (undoAnswer ? 'Done' : 'Undo') : 'Done'
  const amazon = `Amazon ${markets.join(', ')}`
  const statusWords = (a: { status: string } | null) => (!a ? amazon : a.status === 'queued' ? 'Waits for approval' : a.status === 'runs_by_rule' ? 'Runs by your rule' : 'Approved')
  const subtitle = step === 'setup' ? [scope.productName, markets.length === 1 ? amazon : null].filter(Boolean).join(' · ') || undefined
    : step === 'review' ? (preview ? `${reviewSummary(markets, preview)}${needsCode(preview) ? ' · takes your authenticator code' : ''}` : amazon)
      : step === 'done' ? (takenBack ? amazon : statusWords(answer))
        : undoAnswer ? statusWords(undoAnswer) : amazon
  const open = openCampaignOf(preview ?? { steps: [] })
  const saving = (step === 'review' && review.phase === 'saving') || (step === 'undo' && undoState.phase === 'saving')

  const limitWords = limitWordsOf(selected, list.length)

  // ── the term table ─────────────────────────────────────────────────────────────────────────────────────────────────
  const termCell = (r: TermRow) => (
    <span className={styles.term}>
      <span className={styles.termLine}>
        <span className={styles.ellipsis} title={r.term}>{r.term}</span>
        {r.held && (
          <Tooltip label={r.held.reason} portal>
            <span tabIndex={0} className={styles.chip} aria-label={`${r.held.label}: ${r.held.reason}`}><Tag tone="warning">{r.held.label}</Tag></span>
          </Tooltip>
        )}
      </span>
      {narrow && <span className={styles.sub}>{r.orders} · {r.acos} · CPC {r.cpc}</span>}
      {!to && r.goesTo && !narrow && <span className={styles.sub}><EntityPath items={r.goesTo} linkAs={WorkspaceLink} label="Goes to" /></span>}
    </span>
  )
  const bidCell = (r: TermRow) => {
    if (r.moneyHidden) return <span className={styles.muted}>—</span>
    const field = (
      <Input
        size="xs" affix="outside" prefix={currencySymbol(r.currency)} inputMode="decimal" value={r.bidText}
        aria-label={`Bid for ${r.term}`} aria-invalid={r.bidProblem ? true : undefined} aria-description={r.bidProblem ?? r.bidHint ?? undefined}
        className={styles.bid}
        onChange={(e) => { const v = e.target.value; setBids((b) => ({ ...b, [r.id]: v })) }}
      />
    )
    // S3 — why the start bid is what it is, in a few words, on hover and focus.
    return r.bidHint && !r.bidProblem ? <Tooltip label={r.bidHint} portal>{field}</Tooltip> : field
  }
  // A plain DS table, not a grid: a short form of up to 200 rows whose Tab order is the person's (term chip → bid →
  // next term), with no header stops and no grid keys in a dialog.
  const termColumns = narrow ? ['Term', ...(moneyShown ? ['Bid'] : [])] : ['Term', 'Orders', 'ACoS', ...(moneyShown ? ['CPC', 'Bid'] : [])]
  const termTableRows = termRows.map((r) => ({
    id: r.id,
    cells: narrow
      ? [termCell(r), ...(moneyShown ? [bidCell(r)] : [])]
      : [
        termCell(r), <span key="o" className={styles.num}>{r.orders}</span>, <span key="a" className={styles.num}>{r.acos}</span>,
        ...(moneyShown ? [<span key="c" className={styles.num}>{r.cpc}</span>, bidCell(r)] : []),
      ],
  }))

  // ── the body of each step ──────────────────────────────────────────────────────────────────────────────────────────
  const portfolioOptions = useMemo<ListboxPanelOption[]>(() => [
    { value: 'none', label: 'No portfolio' },
    ...(tree?.portfolios ?? []).map((p) => ({
      value: `pf:${p.id}`, label: p.name,
      ...(isLocalPortfolio(p.id) ? { heldReason: 'It lives in Nexus only: Amazon would refuse the campaign', note: 'Nexus only' } : {}),
    })),
  ], [tree])
  const portfolioActions = useMemo<ListboxPanelAction[]>(() => [{ id: 'new-portfolio', label: 'New portfolio…', icon: <Plus />, onSelect: startNewPortfolio }], [tree, scope.productName, scope.market]) // eslint-disable-line react-hooks/exhaustive-deps
  const portfolioValue = !draft?.portfolio || !('id' in draft.portfolio) ? 'none' : `pf:${draft.portfolio.id}`
  const setPortfolio = (v: string) => setNc((d) => (d ? { ...d, portfolio: v === 'none' ? null : { id: v.slice(3) } } : d))
  const fixLink = (fix: { label: string; href: string } | null, words: string) => (fix
    ? <Link href={fix.href} target="_blank" rel="noopener" className={styles.fix}>{words}</Link>
    : <span>{words}</span>)

  const setupBody = (
    <div className={styles.stack}>
      {limitWords && <Banner tone="warning">{limitWords}</Banner>}
      <Field label="To" htmlFor={toId}>
        {single ? (
          <div className={styles.toRow}>
            <div className={styles.grow}>
              <DestinationPicker
                id={toId} destinations={heldTree} value={to} onChange={pick} onNewCampaign={startNewCampaign} onNewPortfolio={startNewPortfolio}
                newPortfolioHeld={campaignHold?.reason ?? null}
                planned={draft ? [{ key: NEW_CAMPAIGN_KEY, name: draft.name || tree?.newCampaign.name || 'New campaign' }] : []}
                placeholder={tree ? (mode === 'suggested' ? 'Suggested places' : 'Choose where they go') : 'Reading…'}
              />
            </div>
            {mode === 'suggested' && to && <Button variant="link" size="sm" onClick={() => { toTouched.current = true; setTo(null) }}>Suggested places</Button>}
          </div>
        ) : (
          <p className={styles.muted}>{scope.held}</p>
        )}
      </Field>
      {/* M7 — said up front, with where to fix it: the list's "New campaign…" / "New portfolio…" are held for this. */}
      {single && campaignHold && <p className={styles.hold}><span className={styles.muted}>New campaign:</span> {fixLink(campaignHold.fix, campaignHold.reason)}</p>}
      {treeErr && <Banner tone="danger" title="Places not read" action={<Button size="sm" onClick={() => setTreeTick((t) => t + 1)}>Try again</Button>}>{treeErr}</Banner>}
      {draft && (
        <div className={styles.fields}>
          {/* S5 — one Portfolio field: a list, or (New portfolio…) its name in place, with its monthly cap beside it. */}
          {newPortfolioChosen && np ? (
            <>
              <Field label="New portfolio" hint={<Button variant="link" size="xs" inline onClick={() => setNc((d) => (d ? { ...d, portfolio: newCampaignDefaults(tree).portfolio } : d))}>Pick an existing one</Button>}>
                <Input value={np.name} onChange={(e) => { const v = e.target.value; setNp((d) => (d ? { ...d, name: v } : d)) }} />
              </Field>
              <Field label="Monthly cap">
                <Input prefix={symbol} inputMode="decimal" placeholder="None" value={np.cap} onChange={(e) => { const v = e.target.value; setNp((d) => (d ? { ...d, cap: v } : d)) }} />
              </Field>
            </>
          ) : (
            <Field label="Portfolio">
              <Listbox ariaLabel="Portfolio" options={portfolioOptions} value={portfolioValue} onChange={setPortfolio} actions={portfolioActions} width="100%" />
            </Field>
          )}
          <Field label="Name" className={styles.wide}>
            <Input value={draft.name} onChange={(e) => { ncNameTouched.current = true; const v = e.target.value; setNc((d) => (d ? { ...d, name: v } : d)) }} />
          </Field>
          <Field label="Budget a day">
            <Input prefix={symbol} inputMode="decimal" value={draft.budget} onChange={(e) => { const v = e.target.value; setNc((d) => (d ? { ...d, budget: v } : d)) }} />
          </Field>
        </div>
      )}
      <div className={styles.pair}>
        <Field label="As">
          <SegmentedControl ariaLabel="Match" options={MATCHES} value={match} onChange={(v) => setMatch(v === 'PHRASE' ? 'PHRASE' : 'EXACT')} size="sm" />
        </Field>
        <span className={styles.check}>
          <Checkbox checked={source_.on} onChange={(e) => setNegate(sourceChoice(e.target.checked, sourceDefault.on))} label="Block where found" aria-description={sourceWhy ?? undefined} />
          {sourceWhy && <span className={styles.sub}>{sourceWhy}</span>}
        </span>
      </div>
      {moneyShown && list.length > 0 && (
        <div className={styles.bulk}>
          <span className={styles.bulkPair}>
            <Input size="sm" affix="outside" prefix={`Bid all ${bulkCurrency ? currencySymbol(bulkCurrency) : ''}`.trim()} inputMode="decimal" value={allTo} aria-label="Bid all" className={styles.bulkInput}
              onChange={(e) => setAllTo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (bulkCurrency) setAll() } }} />
            <Button size="sm" heldReason={!bulkCurrency ? 'These terms bill in more than one currency: set their bids one by one' : allToParsed.kind === 'ok' ? null : 'Type an amount first'} onClick={setAll}>Set</Button>
          </span>
          <span className={styles.bulkPair}>
            <Input size="sm" affix="outside" prefix="CPC +" suffix="%" inputMode="decimal" value={cpcPct} aria-label="Bids: CPC plus percent" className={styles.bulkInput}
              onChange={(e) => setCpcPct(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setCpc() } }} />
            <Button size="sm" heldReason={cpcParsed.kind === 'ok' ? null : 'Type a percent first'} onClick={setCpc}>Set</Button>
          </span>
        </div>
      )}
      {list.length > 0 && (
        <div className={`nds-review-table ${styles.terms}`}>
          <SummaryTable label={`${termsWord} to harvest`} columns={termColumns} rows={termTableRows} />
        </div>
      )}
    </div>
  )

  // The terms the preview leaves out, one line per reason: its words (the plain ones where Nexus knows them, with where to
  // fix it), the terms, the server's sentence on hover and focus. Then the person's own limits it goes past (warned).
  const leftOut = [
    ...(preview ? leftOutOf(preview, scope.market) : []).map((t) => (
      <span key={t.key} className={styles.leftOut}>
        <Tooltip label={t.reason} portal>
          <span tabIndex={0} className={styles.chip} aria-label={`${t.label}: ${t.reason}`}><Tag tone="warning">{t.terms.length} left out</Tag></span>
        </Tooltip>
        {fixLink(t.fix, t.label)}
        <span className={styles.muted}>{termList(t.terms)}</span>
      </span>
    )),
    ...pastLimits(preview).map((l, k) => <span key={`limit-${k}`} className={styles.leftOut}><Tag tone="warning">Past your limit</Tag><span>{l.reason}</span></span>),
  ]
  const reviewBody = (
    <div className={styles.stack}>
      {note && <Banner tone="info">{note}</Banner>}
      {review.phase === 'reading' ? (
        <div className={styles.stack} aria-busy="true" aria-label="Reading the plan"><Skeleton height={16} /><Skeleton height={16} /><Skeleton height={16} /></div>
      ) : review.phase === 'failed' ? (
        <Banner tone="danger" title="Plan not read" action={sent ? <Button size="sm" onClick={() => void runPreview(sent)}>Try again</Button> : undefined}>{review.error}</Banner>
      ) : changes.length === 0 ? (
        // Nothing can go: no empty table, only why (one line per reason).
        <Banner tone="warning" title="Nothing can be harvested">
          {leftOut.length === 1 ? leftOut[0] : <ul className="nds-review-list">{leftOut.map((l, k) => <li key={k}>{l}</li>)}</ul>}
        </Banner>
      ) : (
        <ReviewChangesPanel
          changes={changes} state={review} label="The change set" groups={REVIEW_GROUPS} ack={ack} onAckChange={setAck}
          problems={problem ? [problem] : []} warnings={leftOut}
        />
      )}
    </div>
  )

  // S2 — the Done line says what was approved and when it goes, never "harvested" before it ran.
  const withTime = (line: string, runsAt: string | null) => (runsAt
    ? <>{line} · <Countdown to={runsAt} label={(t) => `goes to Amazon in ${t}`} doneLabel="going to Amazon" onDone={() => setClock((c) => c + 1)} /></>
    : line)
  const doneBody = (
    <div className={styles.stack}>
      {done?.approveError && !takenBack && <Banner tone="warning">{done.approveError}</Banner>}
      {undoNote && <Banner tone="warning">{undoNote}</Banner>}
      <ReviewChangesPanel
        changes={changes} state={{ phase: 'done', results }} groups={REVIEW_GROUPS} ack onAckChange={() => {}}
        doneVerb="approved" doneLine={takenBack ? { line: TAKEN_BACK, tone: 'success' } : done ? { line: withTime(done.line, done.runsAt), tone: done.tone } : undefined}
      />
    </div>
  )

  const undoBody = (
    <div className={styles.stack}>
      {undoNote && <Banner tone="warning">{undoNote}</Banner>}
      {undoDone?.approveError && <Banner tone="warning">{undoDone.approveError}</Banner>}
      <ReviewChangesPanel
        changes={undoChanges} state={undoAnswer ? { phase: 'done', results: undoResults } : undoState} label="What goes back" groups={REVIEW_GROUPS}
        ack onAckChange={() => {}} problems={undoPlan?.held ? [undoPlan.held] : []} doneVerb="undone"
        doneLine={undoDone ? { line: withTime(undoDone.line, undoDone.runsAt), tone: undoDone.tone } : undefined}
      />
    </div>
  )

  // ── the footer of each step (the primary keeps its place, so the focus stays on it from step to step) ────────────────
  const primary = (label: string, held: string | null, run: () => void) => (
    <Button variant="primary" data-hto-primary="" heldReason={held} onClick={run}>{label}</Button>
  )
  // R8 — a code that was not given (the dialog closed, or a wrong one) can be given again from Done.
  const codeWaits = !!answer && !takenBack && answer.status === 'queued' && !!answer.approve && !answer.approve.ok && CODE_NEEDED.has(answer.approve.code ?? '')
  const footer = step === 'setup' ? (
    <>
      <Button onClick={close}>Cancel</Button>
      <span className="grow" />
      {primary(`Review ${termsWord}`, setupHold, () => void runPreview(body()))}
    </>
  ) : step === 'review' ? (
    <>
      <Button heldReason={saving ? 'Sending' : null} onClick={() => { asked.current += 1; setStep('setup') }}>{sawSetup ? 'Back' : 'Change…'}</Button>
      <span className="grow" />
      {primary(review.phase === 'saving' ? 'Sending…' : preview ? harvestButtonWords(preview) : 'Harvest', harvestHold, () => void apply())}
    </>
  ) : step === 'done' ? (
    <>
      {!takenBack && answer && (
        <Button heldReason={undoBusy ? 'Reading' : null} onClick={() => void startUndo()}>{canTakeBack(answer, Date.now()) ? 'Undo' : 'Undo…'}</Button>
      )}
      {codeWaits && <Button onClick={() => setStepUp({ busy: false, error: null })}>Enter code…</Button>}
      {open && !takenBack && ('href' in open
        ? <Button asChild><Link href={open.href} onClick={close}>Open campaign</Link></Button>
        : <Button heldReason={open.held}>Open campaign</Button>)}
      <span className="grow" />
      {primary('Done', null, close)}
    </>
  ) : (
    <>
      {!undoAnswer && <Button heldReason={saving ? 'Sending' : null} onClick={() => { setUndoNote(null); setStep('done') }}>Back</Button>}
      <span className="grow" />
      {undoAnswer ? primary('Done', null, close) : primary(undoState.phase === 'saving' ? 'Sending…' : undoPlan ? undoButtonWords(undoPlan) : 'Undo', undoState.phase === 'saving' ? 'Sending' : undoPlan?.held ?? null, () => void sendUndo())}
    </>
  )

  return (
    <>
    {stepUp && (
      <StepUpModal
        open
        title="Authenticator code"
        sentence={preview && preview.totals.campaigns ? 'A new campaign takes the code from your authenticator app.' : 'This harvest takes the code from your authenticator app.'}
        busy={stepUp.busy}
        error={stepUp.error}
        confirmLabel="Approve"
        onSubmit={(code) => void submitCode(code)}
        onClose={() => setStepUp(null)}
      />
    )}
    <Modal
      open
      onClose={saving ? () => {} : close}
      size={narrow ? 'detail' : 'xl'}
      returnFocusTo={returnFocusTo}
      initialFocus="dialog"
      title={title}
      subtitle={subtitle}
      footer={footer}
      busy={review.phase === 'reading'}
    >
      <div ref={bodyRef} className={styles.body}>
        {step === 'setup' ? setupBody : step === 'review' ? reviewBody : step === 'done' ? doneBody : undoBody}
      </div>
    </Modal>
    </>
  )
}
