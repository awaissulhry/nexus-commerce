'use client'

/**
 * Negative Targeting page, Rules view — New rule (2026-10-11). One dialog, one decision at a time, a default for each:
 *   1. what it stops: our keywords (pause, keep paused) or shoppers' search terms (negative exact) — the two starters
 *      the API serves (GET /waste/rules/starters, the PLAN §2 defaults);
 *   2. its one sentence (the API's own words) with the live "would change N" (POST /waste/rules/preview: nothing written);
 *   3. where it acts: a market, then the whole market or one portfolio, campaign or ad group (one searchable list);
 *   4. its mode: Watch (the default: a new rule is born at Watch), Ask me, or Auto — Auto held until it has run;
 *   5. More: its few fields (window, clicks, spend, fixed bar, exact or phrase, ad group or campaign, run time, name).
 * "Review" hands it to the view, which reviews it in the DS `ReviewChangesModal` stacked on this dialog, creates it and
 * offers Undo (archive) and Open. "Builder…" opens the shared rule builder for any other shape.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, RotateCw, TextSearch } from 'lucide-react'
import { Button, RadioCard, Tag, ToolbarButton } from '@/design-system/primitives'
import { Disclosure, EntityPath, Field, Listbox, Modal, type EntityLinkComponent, type EntityRef, type ListboxPanelOption } from '@/design-system/components'
import Link from '@/lib/workspaces/Link'
import { currencyOf } from '../../bid/_shared/format'
import { MODE_WORD, type BidMode } from '../../bid/rules/bidRulesModel'
import { fetchAdGroups, fetchScopeOptions, fetchStarters, fetchWastePreview } from './wasteRulesApi'
import {
  NEW_RULE_AUTO_HELD, NEW_RULE_MODES, WHOLE_MARKET, bodyOf, fieldProblems, fieldsOfStarter, marketsOf, pathOfPick, scopeOfPick, scopeOptions,
  type RuleFields, type ScopeData, type Starter, type WasteScope,
} from './newRuleModel'
import { KIND_WORD, WASTE_MODE_MEANS, plural, readError, type WastePreview, type WasteKind } from './wasteRulesModel'
import { RuleFieldsForm } from './RuleFieldsForm'
import { HintTag, Loading, NotRead } from './parts'
import styles from './rules.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const KIND_ICON: Readonly<Record<WasteKind, typeof Crosshair>> = { PAUSE_KEYWORD: Crosshair, NEGATE_TERM: TextSearch }
const KIND_DOES: Readonly<Record<WasteKind, string>> = { PAUSE_KEYWORD: 'Pause · keep paused', NEGATE_TERM: 'Negative exact' }
const MODE_OPTIONS: ListboxPanelOption[] = NEW_RULE_MODES.map((m) => (m === 'AUTO'
  ? { value: m, label: MODE_WORD[m], note: NEW_RULE_AUTO_HELD, heldReason: NEW_RULE_AUTO_HELD }
  : { value: m, label: MODE_WORD[m], note: WASTE_MODE_MEANS[m] }))

/** What the dialog hands the view to review and create. */
export interface NewRuleDraft {
  kind: WasteKind
  fields: RuleFields
  scope: WasteScope
  /** The place in words, for the review's Where. */
  where: string
  /** The place as links (the review's Where). */
  path: EntityRef[]
  mode: BidMode
  /** The live count when it was read; null when it was not. */
  wouldChange: number | null
}

export function NewWasteRule({ market, held, onClose, onReview, onBuilder }: {
  /** The page's market ('all' = every market): the first one offered. */
  market: string
  /** Why this person may not make a rule (permission), or null. */
  held: string | null
  onClose(): void
  onReview(draft: NewRuleDraft): void
  onBuilder(): void
}) {
  const [starters, setStarters] = useState<Starter[] | null>(null)
  const [startersErr, setStartersErr] = useState<string | null>(null)
  const [kind, setKind] = useState<WasteKind>('NEGATE_TERM')
  const [fields, setFields] = useState<RuleFields | null>(null)
  const [opts, setOpts] = useState<Pick<ScopeData, 'campaigns' | 'portfolios'> | null>(null)
  const [optsErr, setOptsErr] = useState<string | null>(null)
  const [pickMarket, setPickMarket] = useState<string>(market !== 'all' ? market : '')
  const [groups, setGroups] = useState<ScopeData['adGroups'] | null>(null)
  const [where, setWhere] = useState<string>(WHOLE_MARKET)
  const [mode, setMode] = useState<BidMode>('WATCH')
  const [tick, setTick] = useState(0)

  // The starters and the places, once.
  useEffect(() => {
    let alive = true
    fetchStarters().then((s) => { if (alive) setStarters(s) }, (e: unknown) => { if (alive) setStartersErr((e as Error).message) })
    fetchScopeOptions().then((o) => { if (alive) setOpts(o) }, (e: unknown) => { if (alive) setOptsErr((e as Error).message) })
    return () => { alive = false }
  }, [tick])
  const starter = starters?.find((s) => s.kind === kind) ?? null
  // A kind's defaults when it is picked (a name the person typed is kept only for the same kind).
  useEffect(() => { if (starter) { setFields(fieldsOfStarter(starter)); nameTouched.current = false } }, [starter])

  const markets = useMemo(() => (opts ? marketsOf(opts) : []), [opts])
  useEffect(() => { if (!pickMarket && markets.length) setPickMarket(markets[0]) }, [markets, pickMarket])
  // The ad groups of the picked market.
  useEffect(() => {
    if (!pickMarket) return
    let alive = true
    setGroups(null)
    fetchAdGroups(pickMarket).then((g) => { if (alive) setGroups(g) }, () => { if (alive) setGroups([]) })
    return () => { alive = false }
  }, [pickMarket])
  useEffect(() => { setWhere(WHOLE_MARKET) }, [pickMarket])

  const data: ScopeData | null = opts ? { ...opts, adGroups: groups ?? [] } : null
  const options = useMemo(() => (data && pickMarket ? scopeOptions(data, pickMarket) : []), [data, pickMarket]) // eslint-disable-line react-hooks/exhaustive-deps
  const scope = data && pickMarket ? scopeOfPick(data, pickMarket, where) : null
  const path = data && pickMarket ? pathOfPick(data, pickMarket, where) : []
  const currency = currencyOf(pickMarket || null)
  // Its name says where it acts ("Stop waste — keywords · Auto group") until the person types one.
  const nameTouched = useRef(false)
  const leaf = path.length > 1 ? path[path.length - 1].name : pickMarket
  useEffect(() => {
    if (!starter || nameTouched.current) return
    const name = leaf ? `${starter.name} · ${leaf}` : starter.name
    setFields((f) => (f && f.name !== name ? { ...f, name } : f))
  }, [starter, leaf])
  const editFields = (next: RuleFields) => { if (fields && next.name !== fields.name) nameTouched.current = true; setFields(next) }

  // The live sentence and count: the API's preview of the draft, read again 400 ms after the last change.
  const [preview, setPreview] = useState<{ data: WastePreview | null; error: string | null; reading: boolean }>({ data: null, error: null, reading: false })
  const [again, setAgain] = useState(0)
  const bodyKey = fields && scope ? JSON.stringify(bodyOf(kind, fields, scope)) : ''
  const lastOk = useRef<WastePreview | null>(null)
  useEffect(() => {
    if (!bodyKey || Object.keys(fieldProblems(fields!)).length) return
    const ctl = new AbortController()
    setPreview((p) => ({ ...p, error: null, reading: true }))
    const t = window.setTimeout(() => {
      fetchWastePreview({ rule: JSON.parse(bodyKey) }, 5, ctl.signal).then(
        (d) => { lastOk.current = d; setPreview({ data: d, error: null, reading: false }) },
        (e: unknown) => { if (!ctl.signal.aborted) setPreview({ data: null, error: (e as Error).message, reading: false }) },
      )
    }, 400)
    return () => { window.clearTimeout(t); ctl.abort() }
  }, [bodyKey, again]) // eslint-disable-line react-hooks/exhaustive-deps

  const problems = fields ? Object.keys(fieldProblems(fields)).length : 0
  const reviewHeld = held
    ?? (!starters ? 'Reading the starters…'
      : !fields ? 'Pick what it stops'
        : !scope ? (data ? 'Pick where it acts' : 'Reading the places…')
          : problems ? 'Fix the fields under More first' : null)
  const sentence = preview.data?.sentence ?? lastOk.current?.sentence ?? starter?.says ?? ''
  const review = () => {
    if (!fields || !scope) return
    onReview({ kind, fields, scope, where: path.map((s) => s.name).join(' › '), path, mode, wouldChange: preview.data ? preview.data.wouldChange : null })
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="New rule"
      footer={(
        <>
          <Button size="sm" variant="quiet" heldReason={held} onClick={onBuilder} title="Any other rule shape, in the rule builder">Builder…</Button>
          <span className={styles.footerGrow} />
          <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <span data-return="new-review"><Button size="sm" variant="primary" heldReason={reviewHeld} onClick={review}>Review…</Button></span>
        </>
      )}
    >
      <div className={styles.panelBody}>
        {startersErr && <NotRead what="Starters" error={startersErr} onRetry={() => { setStartersErr(null); setTick((t) => t + 1) }} />}
        <div className={styles.choices} role="radiogroup" aria-label="What it stops">
          {(['PAUSE_KEYWORD', 'NEGATE_TERM'] as const).map((k) => {
            const Icon = KIND_ICON[k]
            return (
              <RadioCard
                key={k}
                name="new-rule-kind"
                value={k}
                checked={kind === k}
                selected={kind === k}
                onChange={() => setKind(k)}
                title={<span className={styles.choiceTitle}><Icon size={16} aria-hidden />{KIND_WORD[k]}</span>}
                description={KIND_DOES[k]}
              />
            )
          })}
        </div>

        <div className={styles.sentence} aria-live="polite">
          <span>{sentence || '—'}</span>
          {preview.reading && <Tag>Reading…</Tag>}
          {!preview.reading && preview.data && (
            <HintTag
              label={`would change ${preview.data.wouldChange}`}
              hint={`Now, in this place: ${plural(preview.data.wouldChange, kind === 'PAUSE_KEYWORD' ? 'keyword' : 'search term')} pass its test${preview.data.wouldAsk ? `, ${preview.data.wouldAsk} of them would ask you` : ''}. Nothing is written.`}
              tone="info"
            />
          )}
          {!preview.reading && preview.data && preview.data.refused.length > 0 && <HintTag label={`${preview.data.refused.length} refused`} hint="Protected or sold where it would land: never stopped" tone="warning" />}
          {!preview.reading && preview.error && <HintTag label="Count not read" hint={readError(preview.error) ?? 'The preview could not be read'} tone="warning" />}
          <ToolbarButton icon={<RotateCw size={14} aria-hidden />} label="Count again (nothing is written)" onClick={() => setAgain((a) => a + 1)} />
        </div>

        {optsErr && <NotRead what="Places" error={optsErr} onRetry={() => { setOptsErr(null); setTick((t) => t + 1) }} />}
        <div className={styles.formRow}>
          <Field label="Market">
            <Listbox size="sm" width={110} ariaLabel="Market" options={markets.map((m) => ({ value: m, label: m }))} value={pickMarket} onChange={setPickMarket} placeholder={opts ? 'Market' : 'Reading…'} />
          </Field>
          <div className={styles.whereField}>
          <Field label="Where">
            <Listbox
              size="sm"
              width="100%"
              ariaLabel="Where it acts"
              searchable
              searchPlaceholder="Portfolio, campaign or ad group"
              options={options}
              value={where}
              onChange={setWhere}
              placeholder={groups ? 'Whole market' : 'Reading…'}
            />
          </Field>
          </div>
          <Field label="Mode">
            <Listbox size="sm" width={130} ariaLabel="Mode of the new rule" options={MODE_OPTIONS} value={mode} onChange={(v) => { if (v === 'WATCH' || v === 'ASK') setMode(v) }} />
          </Field>
        </div>
        {path.length > 1 && <EntityPath items={path} linkAs={WorkspaceLink} label="Where it acts" />}

        <Disclosure summary="More">
          {fields ? <RuleFieldsForm kind={kind} value={fields} onChange={editFields} currency={currency} idPrefix="new-rule" /> : <Loading />}
        </Disclosure>
      </div>
    </Modal>
  )
}
