'use client'

import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Pencil } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Skeleton, Spinner, Textarea } from '@nexus/ui/primitives'
import type { Translate } from '../../../../lib/i18n/messages'
import { useT } from '../../../../lib/i18n/provider'
import type { LiveState, Tone } from '../../../quality/_shared/model'
import { Freshness, NoAccess, PageHead, QualityMessages, Section } from '../../../quality/_shared/parts'
import type { StepUpState } from '../../../quality/_shared/hooks'
import { StepUpModal } from '@nexus/ui/patterns'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { FREIGHT_PAYERS, type FreightPayer, type PolicyAnswer, type SalesSettings, type Series } from '../api'
import { policyProblems, quoteProblems, ruleSentence, salesSeries, sourceWords, type PolicyDraft, type QuoteDraft, type Scope, type SettingsCan, type Words } from '../model'
import '../settings.css'

/**
 * SCR-235 Sales settings (Sales › Settings; design sales.settings, a settings form): which settings (this company's own or
 * the group-wide ones), then cards each edited on its own and applied explicitly (⌘S): Quote approval rules (the margin
 * floor — the margin grain — and the discount limit, read back as a sentence before saving), Quote defaults (validity,
 * deposit), Return policy and reasons (window, goods due, freight, the handling fee as recorded, conditions; then the
 * RETURN and CANCEL reason lists in the shared editor) and Numbering (the series of quotes, orders, RMAs and repairs,
 * read-only, kept in Admin › Documents & numbering). Read-only roles see the values as text with why. Fetches nothing.
 */

export type SettingsCard = 'approval' | 'quote' | 'policy'

export interface Read<T> {
  readonly value: T | null
  readonly problem: string | null
}

export interface SalesSettingsModel {
  readonly prefix: string
  readonly can: SettingsCan
  readonly company: { readonly code: string; readonly name: string } | null
  readonly scope: Scope
  readonly settings: Read<SalesSettings>
  readonly policy: Read<PolicyAnswer>
  readonly series: Read<readonly Series[]> | null
  readonly edit: { readonly card: SettingsCard; readonly quote: QuoteDraft; readonly policy: PolicyDraft; readonly busy: boolean; readonly problem: Words | null; readonly showProblems: boolean } | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly offline: boolean
  readonly changedAt: string | null
  readonly receipt: { readonly tone: Tone; readonly words: Words } | null
  /** B-W2b-16: the fresh code a raised approval limit asks for (closed: none asked). */
  readonly stepUp?: StepUpState
}

export interface SalesSettingsActions {
  onScope?: (scope: Scope) => void
  onEdit?: (card: SettingsCard | null) => void
  onQuoteDraft?: (patch: Partial<QuoteDraft>) => void
  onPolicyDraft?: (patch: Partial<PolicyDraft>) => void
  onSave?: () => void
  onOwnSettings?: () => void
  onReload?: () => void
  onRetry?: () => void
  onDismissReceipt?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

export function SalesSettingsView({ model, actions, reasons }: { model: SalesSettingsModel; actions?: SalesSettingsActions; reasons?: ReactNode }) {
  return (
    <QualityMessages namespaces={['sales-settings']}>
      <Settings model={model} actions={actions} reasons={reasons} />
    </QualityMessages>
  )
}

function useWords(): Translate {
  const t = useT('sales-settings')
  const q = useT('quality')
  return useMemo<Translate>(() => (key, params) => (key.startsWith('quality:') ? q(key.slice(8), params) : t(key, params)), [t, q])
}

const say = (t: Translate, words: Words | null | undefined): string => (words ? t(words.key, words.params) : '')

function Settings({ model, actions, reasons }: { model: SalesSettingsModel; actions?: SalesSettingsActions; reasons?: ReactNode }) {
  const t = useWords()
  const { can } = model

  // ⌘S applies the card being edited.
  const latest = useRef({ actions, editing: !!model.edit })
  latest.current = { actions, editing: !!model.edit }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && latest.current.editing) {
        event.preventDefault()
        latest.current.actions?.onSave?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!can.quotesView && !can.returnsView) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  return (
    <div className="fw-q">
      {model.stepUp && <RaiseStepUp state={model.stepUp} actions={actions} />}
      <PageHead intro={t('intro')} status={<Freshness asOf={model.asOf} live={model.live} />} />
      <div className="fw-ss-scope">
        <span className="fw-q-hint" id="fw-ss-scope-label">
          {t('scope.label')}
        </span>
        <SegmentedControl
          ariaLabel={t('scope.label')}
          value={model.scope}
          onChange={(value) => actions?.onScope?.(value as Scope)}
          options={[
            { value: 'company', label: model.company ? t('scope.company', { code: model.company.code }) : t('scope.companyNone'), disabled: !model.company },
            { value: 'group', label: t('scope.group') },
          ]}
          disabled={!!model.edit}
        />
        <span className="fw-q-hint">{t(model.scope === 'company' ? 'scope.companyHint' : 'scope.groupHint')}</span>
      </div>
      {model.offline && (
        <Banner tone="warning" title={t('offline.title')}>
          {t('offline.body')}
        </Banner>
      )}
      {model.changedAt && (
        <Banner
          tone="info"
          title={t('changed.title')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('changed.reload')}
            </Button>
          }
        />
      )}
      {model.receipt && (
        <Banner
          tone={model.receipt.tone}
          title={say(t, model.receipt.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissReceipt?.()}>
              {t('quality:common.dismiss')}
            </Button>
          }
        />
      )}
      <div className="fw-ss-grid">
        <ApprovalCard model={model} actions={actions} />
        <QuoteCard model={model} actions={actions} />
        <PolicyCard model={model} actions={actions} />
        <NumberingCard model={model} />
      </div>
      <Section title={t('reasons.title')} sub={t('reasons.sub')} id="fw-ss-reasons">
        {can.reasonsView ? (reasons ?? <p className="fw-q-hint">{t('reasons.none')}</p>) : <p className="fw-q-hint">{t('reasons.noRight')}</p>}
      </Section>
    </div>
  )
}

/** A card's read state (loading, failed with Try again) before its content. */
function ReadFirst({ read, failedKey, onRetry, children }: { read: Read<unknown>; failedKey: string; onRetry?: () => void; children: ReactNode }) {
  const t = useWords()
  if (read.problem)
    return (
      <Banner
        tone="danger"
        title={t(failedKey)}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t('quality:common.retry')}
            </Button>
          ) : undefined
        }
      >
        {t(read.problem)}
      </Banner>
    )
  if (read.value === null)
    return (
      <div className="fw-q-stack" aria-busy="true">
        <Skeleton height={20} width="60%" />
        <Skeleton height={20} width="40%" />
        <Skeleton height={20} width="50%" />
      </div>
    )
  return <>{children}</>
}

/** Why the card is read-only (the reason in words), or null when it may be changed. */
function heldOf(model: SalesSettingsModel, card: SettingsCard): Words | null {
  if (!model.can.manage) return { key: 'held.manage' }
  if (model.offline) return { key: 'held.offline' }
  if (card !== 'policy' && !model.can.margin) return { key: 'held.margin' }
  if (card === 'policy' && model.policy.value && !model.policy.value.canManage) return { key: model.scope === 'group' ? 'held.group' : 'held.manage' }
  if (model.edit && model.edit.card !== card) return { key: 'held.otherCard' }
  return null
}

function CardHead({ model, card, actions }: { model: SalesSettingsModel; card: SettingsCard; actions?: SalesSettingsActions }) {
  const t = useWords()
  const held = heldOf(model, card)
  const editing = model.edit?.card === card
  if (editing) return null
  return (
    <Button size="sm" heldReason={held ? say(t, held) : null} onClick={() => actions?.onEdit?.(card)}>
      <Pencil size={14} aria-hidden /> {t('card.edit')}
    </Button>
  )
}

function EditBar({ model, actions, problems }: { model: SalesSettingsModel; actions?: SalesSettingsActions; problems: number }) {
  const t = useWords()
  const edit = model.edit!
  const held = edit.busy ? t('quality:common.working') : edit.showProblems && problems > 0 ? t('card.fixFirst', { count: problems }) : null
  return (
    <div className="nds-actionbar" role="region" aria-label={t('card.editBar')}>
      <span className="lbl">{t('card.unsaved')}</span>
      <span className="grow" />
      <span className="acts">
        <Button onClick={() => actions?.onEdit?.(null)} disabled={edit.busy}>
          {t('card.discard')}
        </Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onSave?.()} aria-keyshortcuts="Meta+S">
          {edit.busy ? <Spinner size={12} /> : null} {t('card.apply')}
        </Button>
      </span>
    </div>
  )
}

function ApprovalCard({ model, actions }: { model: SalesSettingsModel; actions?: SalesSettingsActions }) {
  const t = useWords()
  const ids = { margin: useId(), discount: useId() }
  const settings = model.settings.value
  const editing = model.edit?.card === 'approval' ? model.edit : null
  const held = heldOf(model, 'approval')
  const problems = editing ? quoteProblems(editing.quote, model.can.margin) : []
  const shown = (field: string) => (editing?.showProblems ? problems.find((entry) => entry.field === field)?.key : undefined)
  const row = settings ? (model.scope === 'company' ? settings.company : settings.tenant) ?? settings.inForce : null
  return (
    <Card padded>
      <section className="fw-q-section" aria-labelledby="fw-ss-approval">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id="fw-ss-approval">{t('approval.title')}</h2>
            <p className="fw-q-hint">{t('approval.sub')}</p>
          </div>
          <CardHead model={model} card="approval" actions={actions} />
        </div>
        {!model.can.quotesView ? (
          <p className="fw-q-hint">{t('held.quotesView')}</p>
        ) : (
          <ReadFirst read={model.settings} failedKey="approval.failed" onRetry={actions?.onRetry}>
            {settings && row && (
              <div className="fw-q-stack">
                {held && !editing && held.key !== 'held.otherCard' && <p className="fw-q-hint">{t('card.readOnly', { why: say(t, held) })}</p>}
                <p className="fw-q-hint">{say(t, sourceWords(settings, model.scope))}</p>
                {editing ? (
                  <div className="fw-q-stack">
                    {editing.problem && <Banner tone="danger" title={say(t, editing.problem)} />}
                    <div className="fw-q-form-two">
                      <Field label={t('approval.margin')} hint={t('approval.marginHint')} error={shown('marginFloorPct') ? t(shown('marginFloorPct')!) : undefined} htmlFor={ids.margin}>
                        <Input id={ids.margin} inputMode="decimal" value={editing.quote.marginFloorPct} onChange={(event) => actions?.onQuoteDraft?.({ marginFloorPct: event.target.value })} />
                      </Field>
                      <Field label={t('approval.discount')} hint={t('approval.discountHint')} error={shown('discountLimitPct') ? t(shown('discountLimitPct')!) : undefined} htmlFor={ids.discount}>
                        <Input id={ids.discount} inputMode="decimal" value={editing.quote.discountLimitPct} onChange={(event) => actions?.onQuoteDraft?.({ discountLimitPct: event.target.value })} />
                      </Field>
                    </div>
                    <p className="fw-ss-sentence" aria-live="polite">
                      {say(t, ruleSentence(editing.quote, model.can.margin))}
                    </p>
                    <p className="fw-q-hint">{t('approval.raiseStepUp')}</p>
                    <EditBar model={model} actions={actions} problems={problems.length} />
                  </div>
                ) : (
                  <>
                    <KeyValue
                      columns={2}
                      items={[
                        { label: t('approval.margin'), value: model.can.margin ? t('pct', { value: row.marginFloorPct ?? '—' }) : t('approval.marginNoGrain') },
                        { label: t('approval.discount'), value: t('pct', { value: row.discountLimitPct }) },
                      ]}
                    />
                    <p className="fw-ss-sentence">{say(t, ruleSentence({ marginFloorPct: row.marginFloorPct ?? '', discountLimitPct: row.discountLimitPct }, model.can.margin))}</p>
                  </>
                )}
                <p className="fw-q-hint">{t('approval.later')}</p>
              </div>
            )}
          </ReadFirst>
        )}
      </section>
    </Card>
  )
}

function QuoteCard({ model, actions }: { model: SalesSettingsModel; actions?: SalesSettingsActions }) {
  const t = useWords()
  const ids = { validity: useId(), deposit: useId() }
  const settings = model.settings.value
  const editing = model.edit?.card === 'quote' ? model.edit : null
  const held = heldOf(model, 'quote')
  const problems = editing ? quoteProblems(editing.quote, model.can.margin) : []
  const shown = (field: string) => (editing?.showProblems ? problems.find((entry) => entry.field === field)?.key : undefined)
  const row = settings ? (model.scope === 'company' ? settings.company : settings.tenant) ?? settings.inForce : null
  return (
    <Card padded>
      <section className="fw-q-section" aria-labelledby="fw-ss-quote">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id="fw-ss-quote">{t('quote.title')}</h2>
            <p className="fw-q-hint">{t('quote.sub')}</p>
          </div>
          <CardHead model={model} card="quote" actions={actions} />
        </div>
        {!model.can.quotesView ? (
          <p className="fw-q-hint">{t('held.quotesView')}</p>
        ) : (
          <ReadFirst read={model.settings} failedKey="quote.failed" onRetry={actions?.onRetry}>
            {row && (
              <div className="fw-q-stack">
                {held && !editing && held.key !== 'held.otherCard' && <p className="fw-q-hint">{t('card.readOnly', { why: say(t, held) })}</p>}
                {editing ? (
                  <div className="fw-q-stack">
                    {editing.problem && <Banner tone="danger" title={say(t, editing.problem)} />}
                    <div className="fw-q-form-two">
                      <Field label={t('quote.validity')} hint={t('quote.validityHint')} error={shown('validityDays') ? t(shown('validityDays')!) : undefined} htmlFor={ids.validity}>
                        <Input id={ids.validity} inputMode="numeric" value={editing.quote.validityDays} onChange={(event) => actions?.onQuoteDraft?.({ validityDays: event.target.value })} />
                      </Field>
                      <Field label={t('quote.deposit')} hint={t('quote.depositHint')} error={shown('depositPct') ? t(shown('depositPct')!) : undefined} htmlFor={ids.deposit}>
                        <Input id={ids.deposit} inputMode="decimal" value={editing.quote.depositPct} onChange={(event) => actions?.onQuoteDraft?.({ depositPct: event.target.value })} />
                      </Field>
                    </div>
                    <EditBar model={model} actions={actions} problems={problems.length} />
                  </div>
                ) : (
                  <KeyValue
                    columns={2}
                    items={[
                      { label: t('quote.validity'), value: t('quote.days', { count: row.defaultValidityDays }) },
                      { label: t('quote.deposit'), value: row.defaultDepositPct === null ? t('quote.noDeposit') : t('pct', { value: row.defaultDepositPct }) },
                    ]}
                  />
                )}
                <p className="fw-q-hint">{t('quote.later')}</p>
              </div>
            )}
          </ReadFirst>
        )}
      </section>
    </Card>
  )
}

function PolicyCard({ model, actions }: { model: SalesSettingsModel; actions?: SalesSettingsActions }) {
  const t = useWords()
  const ids = { window: useId(), due: useId(), freight: useId(), fee: useId(), conditions: useId() }
  const policy = model.policy.value
  const editing = model.edit?.card === 'policy' ? model.edit : null
  const held = heldOf(model, 'policy')
  const problems = editing ? policyProblems(editing.policy) : []
  const shown = (field: string) => (editing?.showProblems ? problems.find((entry) => entry.field === field)?.key : undefined)
  const follows = model.scope === 'company' && !!policy?.followsTenant
  const shownPolicy = policy ? (model.scope === 'company' ? policy.inForce : (policy.tenant ?? policy.inForce)) : null
  const ownHeld = !model.can.manage ? t('held.manage') : !model.can.margin ? t('held.margin') : model.offline ? t('held.offline') : null
  return (
    <Card padded>
      <section className="fw-q-section" aria-labelledby="fw-ss-policy" id="returns">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id="fw-ss-policy">{t('policy.title')}</h2>
            <p className="fw-q-hint">{t('policy.sub')}</p>
          </div>
          {!follows && <CardHead model={model} card="policy" actions={actions} />}
        </div>
        {!model.can.returnsView ? (
          <p className="fw-q-hint">{t('held.returnsView')}</p>
        ) : (
          <ReadFirst read={model.policy} failedKey="policy.failed" onRetry={actions?.onRetry}>
            {shownPolicy && (
              <div className="fw-q-stack">
                {follows && (
                  <Banner
                    tone="info"
                    title={t('policy.follows')}
                    action={
                      <Button size="sm" heldReason={ownHeld} onClick={() => actions?.onOwnSettings?.()}>
                        {t('policy.own')}
                      </Button>
                    }
                  >
                    {t('policy.followsBody')}
                  </Banner>
                )}
                {held && !editing && !follows && held.key !== 'held.otherCard' && <p className="fw-q-hint">{t('card.readOnly', { why: say(t, held) })}</p>}
                {editing ? (
                  <div className="fw-q-stack">
                    {editing.problem && <Banner tone="danger" title={say(t, editing.problem)} />}
                    <div className="fw-q-form-two">
                      <Field label={t('policy.window')} hint={t('policy.windowHint')} error={shown('windowDays') ? t(shown('windowDays')!) : undefined} htmlFor={ids.window}>
                        <Input id={ids.window} inputMode="numeric" value={editing.policy.windowDays} onChange={(event) => actions?.onPolicyDraft?.({ windowDays: event.target.value })} />
                      </Field>
                      <Field label={t('policy.due')} hint={t('policy.dueHint')} error={shown('goodsDueDays') ? t(shown('goodsDueDays')!) : undefined} htmlFor={ids.due}>
                        <Input id={ids.due} inputMode="numeric" value={editing.policy.goodsDueDays} onChange={(event) => actions?.onPolicyDraft?.({ goodsDueDays: event.target.value })} />
                      </Field>
                      <Field label={t('policy.freight')} htmlFor={ids.freight}>
                        <Select id={ids.freight} value={editing.policy.freightPaidBy} onChange={(event) => actions?.onPolicyDraft?.({ freightPaidBy: event.target.value as FreightPayer | '' })}>
                          <option value="">{t('policy.notSet')}</option>
                          {FREIGHT_PAYERS.map((value) => (
                            <option key={value} value={value}>
                              {t(`freight.${value}`)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label={t('policy.fee')} hint={t('policy.feeHint')} error={shown('restockingFeePct') ? t(shown('restockingFeePct')!) : undefined} htmlFor={ids.fee}>
                        <Input id={ids.fee} inputMode="decimal" value={editing.policy.restockingFeePct} onChange={(event) => actions?.onPolicyDraft?.({ restockingFeePct: event.target.value })} />
                      </Field>
                    </div>
                    <Field label={t('policy.conditions')} hint={t('policy.conditionsHint')} error={shown('conditions') ? t(shown('conditions')!) : undefined} htmlFor={ids.conditions}>
                      <Textarea id={ids.conditions} rows={3} value={editing.policy.conditions} onChange={(event) => actions?.onPolicyDraft?.({ conditions: event.target.value })} />
                    </Field>
                    <EditBar model={model} actions={actions} problems={problems.length} />
                  </div>
                ) : (
                  <KeyValue
                    columns={2}
                    items={[
                      { label: t('policy.window'), value: shownPolicy.windowDays === null ? t('policy.notSet') : t('policy.days', { count: shownPolicy.windowDays }) },
                      { label: t('policy.due'), value: shownPolicy.goodsDueDays === null ? t('policy.notSet') : t('policy.days', { count: shownPolicy.goodsDueDays }) },
                      { label: t('policy.freight'), value: shownPolicy.freightPaidBy ? t(`freight.${shownPolicy.freightPaidBy}`) : t('policy.notSet') },
                      { label: t('policy.fee'), value: shownPolicy.restockingFeePct === null ? t('policy.notSet') : t('pct', { value: shownPolicy.restockingFeePct }) },
                      { label: t('policy.conditions'), value: shownPolicy.conditions ?? t('policy.notSet') },
                    ]}
                  />
                )}
                <p className="fw-q-hint">{t('policy.later')}</p>
                <a className="fw-q-link" href="#fw-ss-reasons">
                  {t('policy.toReasons')}
                </a>
              </div>
            )}
          </ReadFirst>
        )}
      </section>
    </Card>
  )
}

function NumberingCard({ model }: { model: SalesSettingsModel }) {
  const t = useWords()
  const series = model.series
  return (
    <Card padded>
      <section className="fw-q-section" aria-labelledby="fw-ss-numbering">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id="fw-ss-numbering">{t('numbering.title')}</h2>
            <p className="fw-q-hint">{t('numbering.sub')}</p>
          </div>
        </div>
        {series === null ? (
          <p className="fw-q-hint">{t(model.can.numberingView ? 'numbering.groupScope' : 'numbering.noRight')}</p>
        ) : (
          <ReadFirst read={series} failedKey="numbering.failed">
            {series.value && series.value.length === 0 ? (
              <EmptyState title={t('numbering.none')} />
            ) : (
              <KeyValue
                columns={2}
                items={salesSeries(series.value ?? []).map((entry) => ({
                  label: t(`numbering.kind.${entry.kind}`),
                  value: entry.series ? t('numbering.next', { code: entry.series.code, next: entry.series.nextNumber ?? '—' }) : t('numbering.missing'),
                }))}
              />
            )}
          </ReadFirst>
        )}
        <p>
          <Link className="fw-q-link fw-ss-link" href={`${model.prefix}/admin/documents`}>
            {t('numbering.link')} <ExternalLink size={12} aria-hidden />
          </Link>
        </p>
      </section>
    </Card>
  )
}

/**
 * B-W2b-16 (design ssettings.approval "Raising a limit asks for step-up"): a higher discount limit or a lower margin floor
 * lets more quotes through without an approver, so the API asks a fresh code; the DS StepUpModal in this page's words.
 */
function RaiseStepUp({ state, actions }: { state: StepUpState; actions?: SalesSettingsActions }) {
  const t = useWords()
  const labels = useDsLabels()
  return (
    <StepUpModal
      open={state.open}
      title={t('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? t(state.problem) : null}
      onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
      onClose={() => actions?.onStepUpCancel?.()}
      confirmLabel={t('stepUp.confirm')}
      labels={labels.stepUp}
    />
  )
}
