'use client'

/**
 * ADS AUTONOMY W1-4 — the Control Room's Strategy tab: the Owner's Amazon Ads strategy, per market (Owner decision
 * 2026-10-06: a tab beside the dial, the engines and the guardrails it steers).
 *
 *   where     the market, then the categories and products that have their own row in it; add one by search.
 *             The most specific wins: a product (then its parent) over its category, a category over the market.
 *   editor    every field with its value here, what is in force and where it comes from, its unit, and who reads it —
 *             or "Stored only" while no engine does (the API's registry decides; StrategyEditor).
 *   save      the pattern the Owner liked (product sheet import, 2026-09-26): the API previews every edit as it is
 *             typed (raise or lower is the API's judgement, never this screen's); one summary, one table, a counted
 *             button; a raise asks for the authenticator code (the DS StepUpModal); Done with Undo, which writes the
 *             previous version back. A version saved meanwhile (409) says so and offers a reload.
 *
 * The ads console is pinned light (ControlRoomClient); this tab uses semantic tokens only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { Banner, Disclosure, PressableRow, useActionConfirm } from '@/design-system/components'
import { Button, SegmentedControl, Skeleton, Tag } from '@/design-system/primitives'
import { EditModeBar, StepUpModal } from '@/design-system/patterns'
import { usePermission } from '@/lib/auth/AuthProvider'
import { usePathname, useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { useAdsMarketplace, useSharedAdsMarket } from '../../../_shell/MarketplaceContext'
import { FLAG } from '../../../_shell/adsMarkets'
import { StrategyEditor } from './StrategyEditor'
import { StrategyReview, type ReviewPhase } from './StrategyReview'
import { AddScopeDialog } from './AddScopeDialog'
import {
  strategyApi,
  StrategyError,
  type Effective,
  type HistoryVersion,
  type RowsMarket,
  type SavedStrategy,
  type StrategyChangeBody,
  type StrategyPreview,
  type StrategyRowOut,
} from './strategyApi'
import {
  EDITABLE,
  barWords,
  diffDraft,
  draftOf,
  fieldAllowed,
  historyLine,
  leaveImpact,
  plainLabel,
  raiseList,
  rowSummary,
  scopeWhat,
  serverError,
  stepUpSentence,
  type Draft,
  type FieldKey,
  type Scope,
} from './strategyWords'
import styles from './strategy.module.css'

const PREVIEW_DELAY_MS = 400

const scopeKey = (scope: Scope) => (scope.level === 'MARKET' ? 'MARKET' : `${scope.level}:${scope.id}`)
const scopeArgs = (scope: Scope) =>
  scope.level === 'CATEGORY' ? { categoryId: scope.id } : scope.level === 'PRODUCT' ? { productId: scope.id } : {}
const rowOf = (rows: RowsMarket | null, scope: Scope): StrategyRowOut | null =>
  rows?.rows.find((r) => (scope.level === 'MARKET' ? r.level === 'MARKET' : r.level === scope.level && r.scopeId === scope.id)) ?? null
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface CodeAsk { purpose: 'save' | 'undo'; sentence: string; body: StrategyChangeBody; error: string | null; busy: boolean }

export function StrategyTab() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [market, setSharedMarket] = useSharedAdsMarket({ allowAll: false, raw: params?.get('market') ?? null })
  const { readMarkets, currencyOf } = useAdsMarketplace()
  const currency = currencyOf(market)
  const canManage = usePermission(FEATURES.adsAutomationManage)
  const canSeeMoney = usePermission(FIELDS.financialsAdspendView)
  const readOnly = !canManage || !canSeeMoney
  const confirm = useActionConfirm()

  const [scope, setScope] = useState<Scope>({ level: 'MARKET' })
  const [rows, setRows] = useState<RowsMarket | null>(null)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [effective, setEffective] = useState<Effective | null>(null)
  const [effectiveError, setEffectiveError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryVersion[] | null>(null)
  const [base, setBase] = useState<Draft>(() => draftOf(null))
  const [draft, setDraft] = useState<Draft>(() => draftOf(null))
  const [clearTargets, setClearTargets] = useState(false)
  const [adding, setAdding] = useState<'CATEGORY' | 'PRODUCT' | null>(null)

  const [preview, setPreview] = useState<StrategyPreview | null>(null)
  const [previewError, setPreviewError] = useState<{ field: FieldKey | null; text: string; moved?: boolean } | null>(null)
  const [checking, setChecking] = useState(false)

  const [review, setReview] = useState<{ preview: StrategyPreview; body: StrategyChangeBody } | null>(null)
  const [phase, setPhase] = useState<ReviewPhase>('review')
  const [flowError, setFlowError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saved, setSaved] = useState<SavedStrategy | null>(null)
  const [undone, setUndone] = useState<{ version: number; changes: SavedStrategy['changes'] } | null>(null)
  const [code, setCode] = useState<CodeAsk | null>(null)

  // ── Reads ──────────────────────────────────────────────────────────────────────────────────────

  const loadRows = useCallback(async () => {
    try {
      setRows(await strategyApi.rows(market))
      setRowsError(null)
    } catch (e) { setRowsError(message(e)) }
  }, [market])

  const loadScope = useCallback(async () => {
    const args = scopeArgs(scope)
    const [eff, hist] = await Promise.allSettled([strategyApi.effective(market, args), strategyApi.history(market, args)])
    if (eff.status === 'fulfilled') { setEffective(eff.value); setEffectiveError(null) } else setEffectiveError(message(eff.reason))
    setHistory(hist.status === 'fulfilled' ? hist.value.filter((v) => scope.level !== 'MARKET' || v.level === 'MARKET') : [])
  }, [market, scope])

  const reload = useCallback(async () => { await Promise.all([loadRows(), loadScope()]) }, [loadRows, loadScope])

  useEffect(() => { setRows(null); setScope({ level: 'MARKET' }); void loadRows() }, [market, loadRows])
  useEffect(() => { setEffective(null); setHistory(null); void loadScope() }, [loadScope])

  const own = rowOf(rows, scope)
  const version = own?.version ?? 0
  // A new scope, a new market or a new version (a save, a reload): the draft starts again from what is stored.
  const ownKey = `${market}|${scopeKey(scope)}|${version}|${rows ? 'loaded' : 'loading'}`
  useEffect(() => {
    const fresh = draftOf(own)
    setBase(fresh)
    setDraft(fresh)
    setClearTargets(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownKey])

  // ── The draft and its preview ──────────────────────────────────────────────────────────────────

  const diff = useMemo(() => diffDraft(draft, base, scope.level, currency), [draft, base, scope.level, currency])
  const dirty = diff.changed.length > 0 || clearTargets
  const body = useMemo<StrategyChangeBody>(() => ({
    channel: 'AMAZON',
    market,
    level: scope.level === 'MARKET' ? 'market' : scope.level === 'CATEGORY' ? 'category' : 'product',
    ...scopeArgs(scope),
    values: diff.values,
    ...(clearTargets && scope.level === 'MARKET' ? { clearCampaignTargets: true } : {}),
    expectVersion: version,
  }), [market, scope, diff.values, clearTargets, version])
  const bodyKey = JSON.stringify(body)
  const clientProblems = Object.keys(diff.errors).length

  // The API judges every edit as it is typed: raise or lower, and its own refusals (a 0 cap) at the field.
  const seq = useRef(0)
  useEffect(() => {
    const mine = ++seq.current
    setPreview(null)
    setPreviewError(null)
    if (!dirty || clientProblems || readOnly) { setChecking(false); return }
    setChecking(true)
    const timer = setTimeout(() => {
      strategyApi.preview(JSON.parse(bodyKey) as StrategyChangeBody)
        .then((p) => { if (seq.current === mine) setPreview(p) })
        .catch((e: unknown) => {
          if (seq.current !== mine) return
          // Saved meanwhile by someone else (409): say so, with a reload, never as a fault of what was typed.
          setPreviewError(e instanceof StrategyError && e.code === 'version_moved' ? { field: null, text: e.message, moved: true } : serverError(message(e)))
        })
        .finally(() => { if (seq.current === mine) setChecking(false) })
    }, PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [bodyKey, dirty, clientProblems, readOnly])

  const errors: Partial<Record<FieldKey, string>> = { ...diff.errors, ...(previewError?.field ? { [previewError.field]: previewError.text } : {}) }
  const problems = Object.keys(errors).length + (previewError && !previewError.field ? 1 : 0)
  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), [])
  const what = scopeWhat(scope, market)

  /** Leave unsaved edits only after asking. */
  const leave = async (next: () => void) => {
    if (dirty && !(await confirm.ask(leaveImpact(diff.changed.length + (clearTargets ? 1 : 0), what)))) return
    next()
  }
  const pickMarket = (code: string) => void leave(() => {
    setSharedMarket(code)
    const next = new URLSearchParams(params?.toString() ?? '')
    next.set('market', code)
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  })
  const pickScope = (next: Scope) => { if (scopeKey(next) !== scopeKey(scope)) void leave(() => setScope(next)) }

  // ── Save, undo ─────────────────────────────────────────────────────────────────────────────────

  const openReview = (p: StrategyPreview, b: StrategyChangeBody) => {
    setReview({ preview: p, body: b }); setPhase('review'); setFlowError(null); setConflict(false); setSaved(null); setUndone(null)
  }

  const fail = (e: unknown, purpose: 'save' | 'undo', ask: CodeAsk | null) => {
    const err = e instanceof StrategyError ? e : null
    if (err?.code && err.code.startsWith('mfa') && ask) {
      // The code itself was refused: its dialog says so and stays open; the save behind it waits again.
      setCode({ ...ask, error: err.message, busy: false })
      if (purpose === 'save') setPhase('review')
      return
    }
    setCode(null)
    if (err?.code === 'version_moved') {
      if (purpose === 'save') { setConflict(true); setPhase('review') } else { setFlowError('It changed again since you saved, so nothing was undone. Close this and look at the strategy again.'); setPhase('done') }
      return
    }
    setFlowError(message(e))
    setPhase(purpose === 'save' ? 'review' : 'done')
  }

  const doSave = async (b: StrategyChangeBody, codeValue?: string, ask: CodeAsk | null = null) => {
    setPhase('saving'); setFlowError(null)
    if (ask) setCode({ ...ask, busy: true, error: null })
    try {
      const out = await strategyApi.save(b, codeValue)
      setCode(null); setSaved(out); setPhase('done')
      await reload()
    } catch (e) { fail(e, 'save', ask) }
  }

  const doUndo = async (b: StrategyChangeBody, codeValue?: string, ask: CodeAsk | null = null) => {
    setPhase('undoing'); setFlowError(null)
    if (ask) setCode({ ...ask, busy: true, error: null })
    try {
      const out = await strategyApi.save(b, codeValue)
      setCode(null); setUndone({ version: out.version, changes: out.changes }); setPhase('undone')
      await reload()
    } catch (e) { fail(e, 'undo', ask) }
  }

  const onSave = () => {
    if (!review) return
    if (review.preview.direction === 'raise') {
      setCode({ purpose: 'save', sentence: stepUpSentence(raiseList(review.preview.changes), what), body: review.body, error: null, busy: false })
      return
    }
    void doSave(review.body)
  }

  const onUndo = async () => {
    if (!saved) return
    setPhase('undoing'); setFlowError(null)
    try {
      // Putting a higher number back is a raise like any other: the API says so, and then the code is asked.
      const p = await strategyApi.preview(saved.undo)
      if (p.direction !== 'raise') { await doUndo(saved.undo); return }
      if (!p.mayRaise) { setFlowError('Undoing puts back a higher number, which counts as a raise: it needs the settings.security.manage permission.'); setPhase('done'); return }
      setCode({ purpose: 'undo', sentence: stepUpSentence(raiseList(p.changes), what, true), body: saved.undo, error: null, busy: false })
    } catch (e) { fail(e, 'undo', null) }
  }

  const onRemove = async () => {
    if (scope.level === 'MARKET' || !own) return
    try {
      const b: StrategyChangeBody = { channel: 'AMAZON', market, level: scope.level === 'CATEGORY' ? 'category' : 'product', ...scopeArgs(scope), op: 'remove', expectVersion: version }
      openReview(await strategyApi.preview(b), b)
    } catch (e) { setPreviewError({ field: null, text: message(e) }) }
  }

  const closeReview = () => {
    setReview(null); setCode(null)
  }

  // ── What is shown ──────────────────────────────────────────────────────────────────────────────

  const em = effective?.markets[0] ?? null
  const notReadYet = effective?.notReadYet ?? []
  const storedOnly = EDITABLE.filter((f) => fieldAllowed(f, scope.level) && notReadYet.includes(f)).length
  const categories = (rows?.rows ?? []).filter((r) => r.level === 'CATEGORY')
  const products = (rows?.rows ?? []).filter((r) => r.level === 'PRODUCT')
  const taken = useMemo(() => new Set((rows?.rows ?? []).filter((r) => r.level !== 'MARKET').map((r) => r.scopeId)), [rows])
  const newScope = scope.level !== 'MARKET' && rows && !own ? scope : null
  const marketRow = rows?.rows.find((r) => r.level === 'MARKET') ?? null
  const latest = history?.[0] ?? null
  const shadows = scope.level === 'MARKET'
    ? { list: rows?.shadowedBy ?? [], count: rows?.shadowedCount ?? 0 }
    : { list: em?.shadowedBy ?? [], count: em?.shadowedCount ?? 0 }
  const markets = readMarkets.includes(market) ? readMarkets : [market, ...readMarkets]
  const raises = preview ? raiseList(preview.changes) : null

  const whereRow = (r: StrategyRowOut, level: 'CATEGORY' | 'PRODUCT') => (
    <PressableRow
      key={r.strategyId} stacked current={scope.level === level && scope.id === r.scopeId}
      label={plainLabel(r.label)} onClick={() => pickScope({ level, id: r.scopeId, label: plainLabel(r.label) })}
    >
      <span className={styles.whereSub}>{rowSummary(r, currency)}</span>
      {r.orphan && <Tag tone="warning">{r.orphan}</Tag>}
    </PressableRow>
  )

  return (
    <div className={styles.tab}>
      <div className={styles.head}>
        <div className={styles.headText}>
          <h2 className={styles.title}>Strategy</h2>
          <p className={styles.lead}>
            What your Amazon ads aim at and the limits engines and Claude keep, per market. The most specific wins: a product
            over its category, a category over the market. A campaign&apos;s own target ACoS still wins over all of them.
          </p>
        </div>
        <div className={styles.market}>
          <span className={styles.marketLabel} id="strategy-market">Market</span>
          <SegmentedControl
            ariaLabel="Market" size="sm" wrap value={market} onChange={pickMarket}
            options={markets.map((code) => ({ value: code, label: `${FLAG[code] ?? ''} ${code}`.trim() }))}
          />
        </div>
      </div>

      {!canManage && <Banner tone="info" title="You can see the strategy.">Changing it needs permission to manage ads automation.</Banner>}
      {canManage && !canSeeMoney && (
        <Banner tone="info" title="Its money is hidden from you.">Targets, bids and caps are ad-spend money: seeing and setting them needs permission to see ad spend.</Banner>
      )}
      {rowsError && <Banner tone="danger" title="The strategy could not be read." action={<Button size="sm" variant="secondary" onClick={() => void loadRows()}>Try again</Button>}>{rowsError}</Banner>}

      <div className={styles.body}>
        <nav className={styles.where} aria-label="Where the strategy applies">
          <div className={styles.whereGroup}>
            <p className={styles.whereHead}>Market</p>
            <PressableRow stacked current={scope.level === 'MARKET'} label={`${market} market`} onClick={() => pickScope({ level: 'MARKET' })}>
              <span className={styles.whereSub}>{rows ? (marketRow ? rowSummary(marketRow, currency) : 'Not set yet') : 'Loading…'}</span>
            </PressableRow>
          </div>
          <div className={styles.whereGroup}>
            <p className={styles.whereHead}>Categories</p>
            {categories.map((r) => whereRow(r, 'CATEGORY'))}
            {newScope?.level === 'CATEGORY' && (
              <PressableRow stacked current label={newScope.label} onClick={() => undefined}><span className={styles.whereSub}>New — not saved yet</span></PressableRow>
            )}
            {rows && !categories.length && newScope?.level !== 'CATEGORY' && <p className={styles.whereNone}>None with their own strategy.</p>}
          </div>
          <div className={styles.whereGroup}>
            <p className={styles.whereHead}>Products</p>
            {products.map((r) => whereRow(r, 'PRODUCT'))}
            {newScope?.level === 'PRODUCT' && (
              <PressableRow stacked current label={newScope.label} onClick={() => undefined}><span className={styles.whereSub}>New — not saved yet</span></PressableRow>
            )}
            {rows && !products.length && newScope?.level !== 'PRODUCT' && <p className={styles.whereNone}>None with their own strategy.</p>}
          </div>
          {!readOnly && (
            <div className={styles.whereAdd}>
              <Button size="sm" variant="secondary" onClick={() => void leave(() => setAdding('CATEGORY'))}>Add a category…</Button>
              <Button size="sm" variant="secondary" onClick={() => void leave(() => setAdding('PRODUCT'))}>Add a product…</Button>
            </div>
          )}
        </nav>

        <section className={styles.editor} aria-labelledby="strategy-scope-title">
          <div className={styles.scopeHead}>
            <h3 className={styles.scopeTitle} id="strategy-scope-title">
              {scope.level === 'MARKET' ? `${market} market` : `${scope.label} · ${scope.level === 'CATEGORY' ? 'category' : 'product'} in ${market}`}
            </h3>
            <span className={styles.scopeMeta}>
              {!rows ? '' : own
                ? `Version ${own.version}${latest ? ` · changed ${new Date(latest.at ?? own.updatedAt ?? '').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} by ${latest.actor}` : ''}`
                : scope.level === 'MARKET' ? 'Not set yet: every engine works as it does today' : 'Not saved yet: every field inherits'}
            </span>
          </div>

          {effectiveError && <Banner tone="danger" title="What is in force here could not be read." action={<Button size="sm" variant="secondary" onClick={() => void loadScope()}>Try again</Button>}>{effectiveError}</Banner>}
          {em && storedOnly > 0 && (
            <Banner tone="info" title={`${storedOnly} of these settings are saved, but no engine uses them yet.`}>
              They move no bid and no budget. Claude reads them. Each one says whether something uses it.
            </Banner>
          )}
          {previewError?.moved && (
            <Banner tone="warning" title="This strategy changed since you opened it." action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Reload</Button>}>
              Someone saved a newer version meanwhile. Reload to see it; your unsaved edits here are dropped.
            </Banner>
          )}
          {previewError && !previewError.field && !previewError.moved && <Banner tone="danger" title="This change cannot be saved as it is.">{previewError.text}</Banner>}

          {!em || !rows ? (
            <div aria-busy="true" aria-label="Loading the strategy"><Skeleton height={140} /><Skeleton height={140} /></div>
          ) : (
            <StrategyEditor
              scope={scope} draft={draft} onDraft={patch} effective={em} errors={errors} currency={currency}
              readOnly={readOnly} canSeeMoney={canSeeMoney} notReadYet={notReadYet}
              shadows={shadows} clearTargets={clearTargets} onClearTargets={setClearTargets}
            />
          )}

          {scope.level !== 'MARKET' && own && !readOnly && (
            <div className={styles.footerActions}>
              <Button size="sm" variant="danger-outline" disabled={dirty} onClick={() => void onRemove()}>Remove this {scope.level === 'CATEGORY' ? 'category' : 'product'}&apos;s strategy…</Button>
            </div>
          )}

          {history && (
            <Disclosure summary={`History · ${history.length ? `${history.length} ${history.length === 1 ? 'version' : 'versions'}${history.length === 20 ? ' (the last 20)' : ''}` : 'nothing saved yet'}`}>
              {history.length ? (
                <ol className={styles.historyList}>
                  {history.map((v) => {
                    const line = historyLine(v, currency)
                    return (
                      <li key={`${v.strategyId}:${v.version}`} className={styles.historyItem}>
                        <span className={styles.historyHead}>{line.head}</span>
                        {line.changes.length > 0 && <ul className={styles.historyChanges}>{line.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                      </li>
                    )
                  })}
                </ol>
              ) : <p className={styles.note}>No version yet: the first save makes version 1.</p>}
            </Disclosure>
          )}
        </section>
      </div>

      {dirty && !readOnly && (
        <EditModeBar
          message={barWords({ changes: diff.changed.length, problems, checking, raises, clears: clearTargets ? shadows.count : 0 })}
          onDiscard={() => { setDraft(base); setClearTargets(false) }}
          onApply={() => { if (preview) openReview(preview, body) }}
          applyDisabled={!preview || checking || problems > 0}
          applyLabel={`Review ${preview ? preview.changes.length : diff.changed.length} ${(preview ? preview.changes.length : diff.changed.length) === 1 ? 'change' : 'changes'}…`}
        />
      )}

      <StrategyReview
        open={!!review} what={what} preview={review?.preview ?? null} currency={currency} phase={phase} error={flowError}
        conflict={conflict} saved={saved} undone={undone} onSave={onSave} onUndo={() => void onUndo()}
        onReload={() => { closeReview(); void reload() }} onClose={closeReview}
      />
      <StepUpModal
        open={!!code} title="Your authenticator code" sentence={code?.sentence ?? ''} busy={!!code?.busy} error={code?.error ?? null}
        confirmLabel={code?.purpose === 'undo' ? 'Undo' : 'Save'}
        onSubmit={(value) => { if (!code) return; const ask = code; void (ask.purpose === 'save' ? doSave(ask.body, value, ask) : doUndo(ask.body, value, ask)) }}
        onClose={() => { if (code?.busy) return; setCode(null); setPhase((ph) => (ph === 'undoing' ? 'done' : ph)) }}
      />
      <AddScopeDialog
        kind={adding} market={market} taken={taken} onClose={() => setAdding(null)}
        onPick={(next) => { setAdding(null); setScope(next) }}
      />
      {confirm.element}
    </div>
  )
}
