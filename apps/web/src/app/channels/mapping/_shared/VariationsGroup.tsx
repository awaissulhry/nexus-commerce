'use client'

/**
 * VT.3 — the `Variations` group on `/channels/mapping`.
 *
 * Where it sits: inside the mapping page's main column, under the selected category, AFTER the
 * field groups — `docs/2026-09-13-variation-theme-column-design.md` §3.7 and
 * `docs/2026-09-12-variation-projection-design.md` §11.1. Screen truth: canvas artboard 6
 * (`MappingRules.dc.html`) — a 44px group header over eight label/control rows on a 140px label
 * column, every control on the 28px `sm` tier.
 *
 * The rules this file is built to keep:
 *
 *  1. **DS only.** `Listbox sm`, `OrderedList`, `MappingChip`, `Radio`, `Tag`, `Button sm`,
 *     `Banner`, `Drawer` — no page-local control, no hand-rolled select, no local colour map. The
 *     row geometry is page CSS in `mapping.module.css` (`--nds-*` tokens only), exactly as this
 *     page's own `.contextBar` / `.filterRow` bands already are.
 *  2. **Every count comes from the wire.** `VariationRuleView` carries `follow`, `override`,
 *     `collide`, the value-map counts, the enum size and the blast radius. This component adds up
 *     nothing — see `variations.ts`.
 *  3. **Copy is verbatim** from the design's Appendix A and VX's Appendix C, and it lives in
 *     `variations.ts` where a test can name it.
 *  4. **One component, two sources.** The live read and the fixture read produce the same
 *     `VariationRuleView` and render through the same tree; the header says which is on screen.
 *     `GET/PUT …/variations` is not served yet (measured, with a positive control — see
 *     `variations-fixtures.ts`), so the live arm shows the honest unavailable state naming the
 *     route instead of a plausible-looking rule.
 *  5. **Save is ONE PUT, twice.** `dryRun: true` is the blast-radius simulation that must answer
 *     before the same route commits; the commit hands back the impact job the page's existing
 *     `ImpactReview` already knows how to review and activate.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'

import { Button, MappingChip, Radio, Tag } from '@/design-system/primitives'
import { Banner, Drawer, Listbox, OrderedList } from '@/design-system/components'

import styles from '../mapping.module.css'
import type {
  ListingSplitMode, VariationRuleSimulation, VariationRuleView,
} from './contracts'
import * as api from './api'
import { VARIATION_FIXTURES } from './variations-fixtures'
import {
  RESOLVER_COPY, RESOLVER_ORDER, SPLIT_COPY, SPLIT_ORDER, VARIATIONS_COPY, applyAxisOrder,
  applyTheme, axisOrderIsThemeDriven, blastRadiusSentence, buildVariationWrite, derivationSentence,
  droppedText, headerCounts, includedAxes, isDirty, resolverAvailability, ruleLineText,
  themeHintText, themeOptionLabel, valueMapText, variationMappingListHref, writeRuleLabel,
} from './variations'

interface Props {
  channel: string
  market: string
  /** The selected marketplace category (Amazon product type / eBay category), or null for the market default. */
  category: string | null
  /**
   * A fixture key from `?variationsFixture=` — the measurement instrument that renders the designed
   * group before VT.1's route answers. Absent in normal use.
   */
  fixtureKey?: string | null
}

/** One label + content row, on the canvas's 140px label column and 40px minimum height. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.varRow}>
      <span className={styles.varRowLabel}>{label}</span>
      <div className={styles.varRowMain}>{children}</div>
    </div>
  )
}

export function VariationsGroup({ channel, market, category, fixtureKey }: Props) {
  const fixture = fixtureKey ? VARIATION_FIXTURES[fixtureKey] ?? null : null
  const radioName = useId()

  const [open, setOpen] = useState(true)
  const [saved, setSaved] = useState<VariationRuleView | null>(null)
  const [draft, setDraft] = useState<VariationRuleView | null>(null)
  const [loading, setLoading] = useState(false)
  /** The server's own sentence when the read failed — never replaced by a friendlier guess. */
  const [readError, setReadError] = useState<{ message: string; status?: number } | null>(null)
  const [simulation, setSimulation] = useState<VariationRuleSimulation | null>(null)
  const [busy, setBusy] = useState<'simulate' | 'commit' | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)

  useEffect(() => {
    setSimulation(null); setWriteError(null); setJobId(null)
    if (fixture) { setSaved(fixture); setDraft(fixture); setReadError(null); setLoading(false); return }
    const controller = new AbortController()
    setLoading(true); setSaved(null); setDraft(null); setReadError(null)
    void api.fetchVariationRule(channel, market, category, controller.signal)
      .then((view) => { if (!controller.signal.aborted) { setSaved(view); setDraft(view) } })
      .catch((error: Error & { status?: number }) => {
        if (controller.signal.aborted) return
        setReadError({ message: error.message, status: error.status })
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
    // `fixture` is derived from `fixtureKey`, which is the dependency that actually changes.
  }, [channel, market, category, fixtureKey])

  const patch = useCallback((next: VariationRuleView) => {
    setDraft(next); setSimulation(null); setWriteError(null); setJobId(null)
  }, [])

  const dirty = saved != null && draft != null && isDirty(saved, draft)

  const runPut = useCallback(async (dryRun: boolean) => {
    if (!draft) return
    setBusy(dryRun ? 'simulate' : 'commit'); setWriteError(null)
    try {
      const result = await api.putVariationRule(channel, market, category, buildVariationWrite(draft, dryRun))
      if (dryRun) setSimulation(result)
      else { setJobId(result.jobId ?? null); setSaved(draft) }
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error))
    } finally { setBusy(null) }
  }, [draft, channel, market, category])

  const themeOptions = useMemo(
    () => (draft?.theme?.options ?? []).map((o) => ({ value: o.code, label: themeOptionLabel(o) })),
    [draft?.theme?.options],
  )

  const view = draft
  const blocked = view?.writeBlockedReason ?? null

  return (
    <section className={styles.varGroup} aria-label={VARIATIONS_COPY.title}>
      <div className={styles.varHead}>
        <Button
          variant="quiet"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className={styles.varHeadTitle}>{VARIATIONS_COPY.title}</span>
        </Button>
        <span className={styles.varHeadScope}>
          {channel === 'AMAZON' ? 'Amazon' : channel === 'EBAY' ? 'eBay' : channel === 'SHOPIFY' ? 'Shopify' : channel}
          {' · '}{market}{category ? ` · ${category}` : ''}
        </span>
        {fixture && <Tag tone="warning">fixture</Tag>}
        <span className={styles.spacer} />
        {view && (
          <span className={styles.varHeadCounts}>
            {headerCounts(view).map((part, index) => (
              <span key={part.word}>{index > 0 ? ' · ' : ''}<b>{part.n}</b> {part.word}</span>
            ))}
          </span>
        )}
        {view && (
          <Button asChild size="sm">
            <a href={variationMappingListHref(view)} title="Opens the catalogue filtered to the families this line counts — derived, follows rule, overridden.">
              {VARIATIONS_COPY.list}
            </a>
          </Button>
        )}
      </div>

      {open && (
        <div className={styles.varBody}>
          {readError && (
            <Banner
              tone={readError.status === 404 ? 'warning' : 'danger'}
              title={readError.status === 404 ? 'The variation rule route is not served yet' : 'The variation rule could not load'}
            >
              {readError.status === 404
                ? `GET /api/pim/channel-mapping/${channel}/${market}/variations answered 404. The rule block (VX §11.1 / design §3.7) is VT.1’s to serve; until it does, this group has nothing measured to show and shows nothing. Add ?variationsFixture=canvas to this page’s URL to see the designed group against the canvas.`
                : readError.message}
            </Banner>
          )}
          {loading && !view && <span className={styles.contextSub}>Loading the variation rule…</span>}
          {/* R-VT-2 (a): stored keys the server did not recognise, named. Before R-VT-2 an unknown key
              cost the marketplace its entire rule set silently; the rule now is that it is visible. */}
          {view && (view.mappingWarnings?.length ?? 0) > 0 && (
            <Banner tone="warning" title="This marketplace's stored mapping carries keys the reader does not recognise">
              {view.mappingWarnings!.join(' · ')}
            </Banner>
          )}

          {view && (
            <>
              <Row label={VARIATIONS_COPY.rowRule}>
                <span className={styles.varSentence}>{ruleLineText(view)}</span>
                {view.source !== 'rule' && <Tag tone="info">{VARIATIONS_COPY.derived}</Tag>}
                {/* design §3.7 puts this derivation sentence on the THEME row. Measured at a 1440
                    content width it made that row wrap to 68.25px beside the theme Listbox and the
                    canvas's own enum hint — two lines where the canvas draws one. It sits here
                    instead, next to the sentence that raised the question, and every row stays on
                    one line (41px). Recorded as a deviation, with its number, in the ledger. */}
                {derivationSentence(view) && (
                  <span className={styles.varHint} title={derivationSentence(view)!}>{derivationSentence(view)}</span>
                )}
                {view.source !== 'rule' && (
                  <Button variant="quiet" size="sm" disabled title={view.writeBlockedReason ?? 'A category rule is written by saving this group. The PUT route is VT.1’s.'}>
                    <Plus size={13} />{writeRuleLabel(view)}
                  </Button>
                )}
              </Row>

              {view.theme && (
                <Row label={VARIATIONS_COPY.rowTheme}>
                  <Listbox
                    size="sm"
                    width={280}
                    ariaLabel={`Variation theme on ${channel} ${market}`}
                    options={themeOptions}
                    value={view.theme.code ?? ''}
                    onChange={(code) => patch(applyTheme(view, code))}
                  />
                  <span className={styles.varHint} title={themeHintText(view) ?? undefined}>{themeHintText(view)}</span>
                </Row>
              )}

              <Row label={VARIATIONS_COPY.rowAxes}>
                {axisOrderIsThemeDriven(view) ? (
                  includedAxes(view).map((axis) => (
                    <MappingChip
                      key={axis.axisKey}
                      from={axis.label}
                      to={axis.target ?? axis.channelName}
                      title={`${axis.label} is delivered as ${axis.channelName}. The theme fixes this order — change the theme to change it.`}
                    />
                  ))
                ) : (
                  <OrderedList
                    compact
                    keyboardGrip
                    label={`Axis order on ${channel} ${market}`}
                    items={includedAxes(view).map((a) => a.axisKey)}
                    itemLabel={(key) => view.axes.find((a) => a.axisKey === key)?.label ?? key}
                    onChange={(keys) => patch(applyAxisOrder(view, [...keys, ...view.dropped]))}
                    renderItem={(key) => {
                      const axis = view.axes.find((a) => a.axisKey === key)
                      return <MappingChip from={axis?.label ?? key} to={axis?.target ?? axis?.channelName} />
                    }}
                  />
                )}
                <span className={styles.varHint} title={droppedText(view)}>{droppedText(view)}</span>
              </Row>

              <Row label={VARIATIONS_COPY.rowCollisions}>
                {RESOLVER_ORDER.map((kind) => {
                  const { available, reason } = resolverAvailability(view, kind)
                  const selected = view.collisions.resolver === kind
                  return (
                    <span key={kind} className={styles.varChoice}>
                      <Radio
                        name={`${radioName}-resolver`}
                        checked={selected}
                        disabled={!available}
                        title={reason ?? undefined}
                        label={RESOLVER_COPY[kind].label}
                        onChange={() => patch({ ...view, collisions: { ...view.collisions, resolver: kind } })}
                      />
                      {kind === 'fold' && (
                        <>
                          <Listbox
                            size="sm"
                            width={120}
                            ariaLabel="Fold into which axis"
                            options={includedAxes(view).map((a) => ({ value: a.axisKey, label: a.label }))}
                            value={view.collisions.foldInto ?? ''}
                            disabled={!selected || !available}
                            onChange={(axisKey) => patch({ ...view, collisions: { ...view.collisions, foldInto: axisKey } })}
                          />
                          <span className={styles.varSentence}>{RESOLVER_COPY.fold.suffix?.(view.collisions.foldSeparator)}</span>
                        </>
                      )}
                      {!available && reason && <Tag tone="warning">held</Tag>}
                    </span>
                  )
                })}
              </Row>

              <Row label={VARIATIONS_COPY.rowSplit}>
                {SPLIT_ORDER.map((mode: ListingSplitMode) => {
                  const available = mode === 'one' || view.split.available
                  return (
                    <span key={mode} className={styles.varChoice}>
                      <Radio
                        name={`${radioName}-split`}
                        checked={view.split.mode === mode}
                        disabled={!available}
                        title={available ? undefined : view.split.reason ?? undefined}
                        label={SPLIT_COPY[mode]}
                        onChange={() => patch({ ...view, split: { ...view.split, mode } })}
                      />
                      {mode === 'per-axis' && (
                        <Listbox
                          size="sm"
                          width={120}
                          ariaLabel="Split per which axis"
                          options={includedAxes(view).map((a) => ({ value: a.axisKey, label: a.label }))}
                          value={view.split.axisKey ?? ''}
                          placeholder="axis"
                          disabled={view.split.mode !== 'per-axis' || !available}
                          onChange={(axisKey) => patch({ ...view, split: { ...view.split, axisKey } })}
                        />
                      )}
                      {mode === 'per-axis' && !available && view.split.reason && <Tag tone="warning">held</Tag>}
                    </span>
                  )
                })}
              </Row>

              <Row label={VARIATIONS_COPY.rowValueMaps}>
                {view.valueMaps.map((map) => {
                  const text = valueMapText(map)
                  return (
                    <span key={map.axisKey} className={styles.varSentence}>
                      {text.label}: {text.mapped == null
                        ? VARIATIONS_COPY.noValueMap
                        : <><b>{text.mapped}</b> mapped{text.unreviewed > 0 && <> · <b className={styles.varWarnNumber}>{text.unreviewed}</b> unreviewed</>}</>}
                    </span>
                  )
                })}
                <Button variant="quiet" size="sm" asChild>
                  <a href={`/channels/mapping/value-maps?channel=${encodeURIComponent(channel)}&market=${encodeURIComponent(market)}`}>
                    {VARIATIONS_COPY.openValueMaps}
                  </a>
                </Button>
              </Row>

              <Row label={VARIATIONS_COPY.rowAxisNames}>
                <span className={styles.varSentence}>{view.axisNamesSentence}</span>
              </Row>

              <Row label={VARIATIONS_COPY.rowPreviewSku}>
                <Listbox
                  size="sm"
                  width={280}
                  ariaLabel="Preview SKU for this rule"
                  options={view.previewSkus.map((sku) => ({ value: sku.productId, label: sku.label }))}
                  value={view.previewSkus[0]?.productId ?? ''}
                  placeholder="Pick a SKU"
                  disabled={view.previewSkus.length === 0}
                  onChange={() => undefined}
                />
                <Button size="sm" disabled title="The preview dock is VX §8 / VT.4’s — nothing on this page composes a payload.">
                  {VARIATIONS_COPY.previewPayload}
                </Button>
                <span className={styles.varHint} title={VARIATIONS_COPY.previewHint}>{VARIATIONS_COPY.previewHint}</span>
              </Row>

              {(dirty || simulation || writeError) && (
                <div className={styles.varFoot}>
                  {writeError && <Banner tone="danger" title="This rule was not saved">{writeError}</Banner>}
                  {simulation && (
                    <Banner tone="info" title={VARIATIONS_COPY.blastRadiusTitle}>{blastRadiusSentence(simulation)}</Banner>
                  )}
                  <span className={styles.spacer} />
                  {simulation ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy != null || blocked != null}
                      title={blocked ?? undefined}
                      onClick={() => void runPut(false)}
                    >
                      {busy === 'commit' ? VARIATIONS_COPY.saving : VARIATIONS_COPY.activate}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!dirty || busy != null || blocked != null}
                      title={blocked ?? 'Simulates the blast radius first — a rule change touches every family that follows it.'}
                      onClick={() => void runPut(true)}
                    >
                      {busy === 'simulate' ? VARIATIONS_COPY.simulating : VARIATIONS_COPY.saveRule}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {jobId && (
        <Drawer open onClose={() => setJobId(null)} title="Review this variation rule" width={640}>
          <VariationImpact jobId={jobId} onApplied={() => setJobId(null)} />
        </Drawer>
      )}
    </section>
  )
}

/**
 * The review of a committed variation rule is the page's EXISTING impact review — the same job, the
 * same counts table, the same `Activate standing rule`. Lazily imported so the group's own module
 * does not pull the impact grid into every mapping page load.
 */
function VariationImpact({ jobId, onApplied }: { jobId: string; onApplied: () => void }) {
  const [Review, setReview] = useState<React.ComponentType<{ jobId: string; onApplied?: () => void }> | null>(null)
  useEffect(() => {
    void import('./ImpactReview').then((m) => setReview(() => m.ImpactReview))
  }, [])
  if (!Review) return <span className={styles.contextSub}>Loading the review…</span>
  return <Review jobId={jobId} onApplied={onApplied} />
}
