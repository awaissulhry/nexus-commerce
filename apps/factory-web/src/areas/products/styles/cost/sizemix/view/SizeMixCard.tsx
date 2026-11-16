'use client'

import { useState } from 'react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { decimalText } from '../../../model'
import type { VersionRow } from '../../versions/api'
import { CS_NS, type CostSheetAbilities, type Phrase, type Read } from '../../versions/model'
import { mixDraft, mixHeld, mixProblems, mixShares, seasonChoices, setOf, type MixDraft, type SizeWeightsView } from '../model'

export interface SizeMixModel {
  readonly sizes: readonly string[]
  readonly baseSize: string | null
  /** The version in view (its season is offered first). */
  readonly inView: VersionRow | null
  readonly can: CostSheetAbilities
  readonly mixes: Read<SizeWeightsView>
  /** The mix being edited ('' = every season), or null when the dialog is closed. */
  readonly editing: string | null
  readonly busy: boolean
  readonly problem: Phrase | null
  readonly notice: Phrase | null
  /** Design cases: what the dialog starts with. */
  readonly draft?: MixDraft
}

export interface SizeMixActions {
  onEdit?: (seasonId: string | null) => void
  onSave?: (draft: MixDraft) => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * B-W2b-GB02 (G054; B-W2b-430 gap 4; design products.styles › Cost "Cost by size", FIN-016) — the style's size mix: every
 * season's and each season's own (its weights and shares), edited in a dialog (a weight per size; blank leaves a size out;
 * all blank clears the mix). A version keeps the mix it was made with: a draft reads it again with "Read the size mix again"
 * on the version in view. A weight is no money. The view fetches nothing.
 */
export function SizeMixCard({ model, actions }: { model: SizeMixModel; actions?: SizeMixActions }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const header = t('mix.title')
  const part = model.mixes
  const held = mixHeld(model.can, model.busy)
  if (part.status === 'idle' || part.status === 'loading')
    return (
      <Card header={header} aria-busy="true">
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('mix.loading')}
        </p>
      </Card>
    )
  if (part.status === 'error')
    return (
      <Card header={header}>
        <EmptyState title={t('mix.failed')} description={t(part.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('csCommon.retry')}</Button>} />
      </Card>
    )
  const view = part.value
  const sets = [...view.sets].sort((a, b) => (a.seasonId === null ? -1 : b.seasonId === null ? 1 : (a.season?.code ?? '').localeCompare(b.season?.code ?? '')))
  const say = (phrase: Phrase | null) => (phrase ? t(phrase.key, phrase.params) : null)
  const share = (value: string) => `${decimalText(value, locale, 1)} %`
  return (
    <Card
      header={header}
      description={t('mix.intro')}
      headerAction={
        <Button size="sm" variant="secondary" heldReason={say(held)} onClick={() => actions?.onEdit?.(model.inView?.season?.status === 'OPEN' ? model.inView.season.id : '')}>
          {t('mix.edit')}
        </Button>
      }
    >
      <div className="fw-st-stack">
        {model.notice && (
          <Banner
            tone="success"
            title={t(model.notice.key, model.notice.params)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('csCommon.dismiss')}
              </Button>
            }
          />
        )}
        {sets.length === 0 ? (
          <p className="fw-st-hint">{t('mix.none')}</p>
        ) : (
          <SummaryTable
            label={header}
            stackOnPhone
            columns={[t('mix.col.for'), ...model.sizes.map((size) => (size === model.baseSize ? t('steps.baseSizeOption', { size }) : size)), t('mix.col.actions')]}
            align={[undefined, ...model.sizes.map(() => 'right' as const), 'right']}
            rows={sets.map((set) => ({
              id: set.seasonId ?? 'every',
              cells: [
                set.seasonId === null ? (
                  <b key="f">{t('mix.everySeason')}</b>
                ) : (
                  <span key="f" className="fw-st-inline">
                    <b>{set.season?.code ?? '—'}</b>
                    {set.season?.status === 'CLOSED' && <Tag tone="neutral">{t('verView.seasonClosed')}</Tag>}
                  </span>
                ),
                ...model.sizes.map((size) => {
                  const entry = set.shares.find((row) => row.size === size)
                  return entry ? share(entry.sharePct) : '—'
                }),
                <Button key="e" size="sm" variant="quiet" heldReason={say(held)} aria-label={t('mix.editLabel', { for: set.seasonId === null ? t('mix.everySeason') : (set.season?.code ?? '') })} onClick={() => actions?.onEdit?.(set.seasonId ?? '')}>
                  {t('mix.change')}
                </Button>,
              ],
            }))}
          />
        )}
        <p className="fw-st-hint">{t('mix.versionsKeep')}</p>
      </div>
      {model.editing !== null && <MixDialog key={model.editing} view={view} model={model} actions={actions} seasonId={model.editing} />}
    </Card>
  )
}

function MixDialog({ view, model, actions, seasonId }: { view: SizeWeightsView; model: SizeMixModel; actions?: SizeMixActions; seasonId: string }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const [draft, setDraft] = useState<MixDraft>(() => model.draft ?? mixDraft(view, seasonId))
  const problems = mixProblems(draft)
  const shares = mixShares(draft)
  const choices = seasonChoices(view, model.inView)
  const kept = setOf(view, draft.seasonId)
  const firstProblem = Object.values(problems.sizes)[0]
  const held = mixHeld(model.can, model.busy)
  const reason = held ? t(held.key, held.params) : firstProblem ? t(firstProblem) : problems.empty && !kept ? t('mix.held.nothing') : null
  const close = () => actions?.onEdit?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('mix.dialogTitle')}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant={problems.empty ? 'danger' : 'primary'} heldReason={reason} onClick={() => actions?.onSave?.(draft)}>
            {model.busy ? t('csCommon.working') : problems.empty ? t('mix.clear') : t('mix.save')}
          </Button>
        </>
      }
    >
      <div className="fw-st-form">
        <p className="fw-st-hint">{t('mix.dialogIntro')}</p>
        <Field label={t('mix.for')}>
          <Select value={draft.seasonId} onChange={(event) => setDraft(mixDraft(view, event.target.value))}>
            <option value="">{t('mix.everySeason')}</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.code}
              </option>
            ))}
          </Select>
        </Field>
        <div className="fw-st-form-grid">
          {view.style.sizes.map((size) => (
            <Field key={size} label={size === model.baseSize ? t('steps.baseSizeOption', { size }) : t('mix.size', { size })} error={problems.sizes[size] ? t(problems.sizes[size]!) : undefined}>
              <Input inputMode="decimal" value={draft.weights[size] ?? ''} onChange={(event) => setDraft((current) => ({ ...current, weights: { ...current.weights, [size]: event.target.value } }))} />
            </Field>
          ))}
        </div>
        {shares.length > 0 ? (
          <p className="fw-st-hint">{t('mix.shares', { shares: shares.map((entry) => `${entry.size} ${decimalText(entry.sharePct, locale, 1)} %`).join(' · ') })}</p>
        ) : (
          kept && <Banner tone="warning" title={t('mix.clearWarning')} />
        )}
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
      </div>
    </Modal>
  )
}
