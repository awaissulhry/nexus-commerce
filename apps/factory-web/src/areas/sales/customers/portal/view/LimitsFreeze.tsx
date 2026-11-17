'use client'

import { Snowflake } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { FreezeRule } from '../limits/api'
import { freezeDraftProblem, freezeRows, ORDER_FREEZE_ACTIONS, ORDER_FREEZE_STAGES, type FreezeRow, type LimitsActions, type LimitsModel, type OrderFreezeAction, type OrderFreezeStage } from '../limits/model'
import { heldWords, usePortalT } from './parts'

/** The API's field words are lower case ("sizes and quantities"): a table's first column starts with a capital. */
const sentenceCase = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1)

/**
 * F-PR-07 — the limits card's freeze points (06-tree §C S-LIM-freeze; B-PR-14): per field of their orders, the company's rules
 * beside the customer's own ("Company: from Cutting" / "Brand Alpha: from Sewing"); their own replace the company's for that
 * field. "Set for …" opens one field's dialog: its rules on both sides, a rule of their own added (saved at once), "Back to the
 * company's" switches their own off. Kept with sales.settings.manage or partners.production.manage (the read's `mayManage`).
 */
export function FreezeBlock({ model, partyName, actions }: { model: LimitsModel; partyName: string; actions?: LimitsActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const freeze = model.freeze
  const say = (words: { readonly it: string; readonly en: string }) => (locale === 'en' ? words.en : words.it)
  const rulesWords = (rules: readonly FreezeRule[], none: string) =>
    rules.length === 0 ? <span className="fw-pa-hint">{none}</span> : (
      <span className="fw-pa-lim-rules">
        {rules.map((rule) => (
          <span key={rule.id}>{t('limits.freeze.rule', { stage: t(`limits.freeze.stage.${rule.frozenFrom}`), action: t(`limits.freeze.action.${rule.action}`) })}</span>
        ))}
      </span>
    )
  return (
    <fieldset className="fw-pa-fieldset">
      <legend className="fw-pa-legend">{t('limits.freeze.title')}</legend>
      <p className="fw-pa-hint">{t('limits.freeze.intro', { company: model.companyName ?? '—' })}</p>
      {freeze.status === 'loading' && (
        <div role="status" aria-label={t('limits.freeze.reading')}>
          <Skeleton height={120} />
        </div>
      )}
      {freeze.status === 'error' && (
        <Banner
          tone="danger"
          title={t('limits.freeze.failed')}
          action={
            freeze.key === 'limits.freeze.noCompany' ? undefined : (
              <Button size="sm" onClick={() => actions?.onRetryFreeze?.()}>
                {t('common.retry')}
              </Button>
            )
          }
        >
          {t(freeze.key)}
        </Banner>
      )}
      {freeze.status === 'ready' && (
        <>
          {!freeze.list.mayManage && <p className="fw-pa-hint">{heldWords(t, 'right.productionManage')}</p>}
          <SummaryTable
            label={t('limits.freeze.title')}
            density="roomy"
            stackOnPhone
            widths={['22%', '30%', '30%', undefined]}
            columns={[t('limits.freeze.col.field'), t('limits.freeze.col.company'), partyName, t('limits.freeze.col.more')]}
            rows={freezeRows(freeze.list).map((row) => ({
              id: row.field,
              cells: [
                <span key="field" className="fw-pa-strong">{sentenceCase(say(row.words))}</span>,
                rulesWords(row.company, t('limits.freeze.open')),
                <span key="own" className="fw-pa-cell">
                  {rulesWords(row.own, t('limits.freeze.follows'))}
                  {row.set === 'CUSTOMER' && <Tag tone="info">{t('limits.freeze.theirs')}</Tag>}
                </span>,
                <Button key="set" size="sm" variant="quiet" heldReason={freeze.list.mayManage ? null : heldWords(t, 'right.productionManage')} aria-haspopup="dialog" aria-label={t('limits.freeze.setFor', { name: partyName, field: say(row.words) })} onClick={() => actions?.onFreezeDialog?.(row.field)}>
                  <Snowflake size={13} aria-hidden /> {t('limits.freeze.set')}
                </Button>,
              ],
            }))}
          />
        </>
      )}
    </fieldset>
  )
}

/** One field's freeze for the customer: the company's rules, their own (Back to the company's), a rule of their own added. */
export function FreezeDialogView({ model, partyName, actions }: { model: LimitsModel; partyName: string; actions?: LimitsActions }) {
  const dialog = model.freezeDialog
  const freeze = model.freeze
  if (!dialog || freeze.status !== 'ready') return null
  const row = freezeRows(freeze.list).find((entry) => entry.field === dialog.field)
  if (!row) return null
  return <FreezeDialogOpen model={model} row={row} partyName={partyName} actions={actions} />
}

function FreezeDialogOpen({ model, row, partyName, actions }: { model: LimitsModel; row: FreezeRow; partyName: string; actions?: LimitsActions }) {
  const t = usePortalT()
  const locale = useLocale()
  const dialog = model.freezeDialog!
  const draft = dialog.draft
  const say = (words: { readonly it: string; readonly en: string }) => (locale === 'en' ? words.en : words.it)
  const problem = dialog.problem ?? freezeDraftProblem(row, draft)
  const listed = (rules: readonly FreezeRule[], none: string) =>
    rules.length === 0 ? (
      <p className="fw-pa-hint">{none}</p>
    ) : (
      <ul className="fw-pa-list">
        {rules.map((rule) => (
          <li key={rule.id}>
            {t('limits.freeze.rule', { stage: t(`limits.freeze.stage.${rule.frozenFrom}`), action: t(`limits.freeze.action.${rule.action}`) })}
            {rule.note ? ` · ${rule.note}` : ''}
          </li>
        ))}
      </ul>
    )
  return (
    <Modal
      open
      size="md"
      onClose={() => actions?.onFreezeDialog?.(null)}
      title={t('limits.freeze.dialog.title', { field: say(row.words), name: partyName })}
      footer={
        <>
          {row.own.length > 0 && (
            <Button size="sm" variant="danger-outline" heldReason={dialog.busy ? t('common.saving') : null} onClick={() => actions?.onFreezeReset?.(row.own)}>
              {t('limits.freeze.dialog.reset')}
            </Button>
          )}
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onFreezeDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={dialog.busy ? t('common.saving') : dialog.problem === null && problem ? t(problem) : null} onClick={() => actions?.onFreezeAdd?.()}>
            {t('limits.freeze.dialog.save')}
          </Button>
        </>
      }
    >
      <div className="fw-pa-form">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <div className="fw-pa-lim-two">
          <div>
            <span className="fw-pa-strong">{t('limits.freeze.dialog.company', { company: model.companyName ?? '—' })}</span>
            {listed(row.company, t('limits.freeze.open'))}
          </div>
          <div>
            <span className="fw-pa-strong">{t('limits.freeze.dialog.own', { name: partyName })}</span>
            {listed(row.own, t('limits.freeze.follows'))}
            {row.own.length > 0 && <p className="fw-pa-hint">{t('limits.freeze.dialog.resetHint')}</p>}
          </div>
        </div>
        <fieldset className="fw-pa-fieldset">
          <legend className="fw-pa-legend">{t('limits.freeze.dialog.add', { name: partyName })}</legend>
          <div className="fw-pa-row">
            <Field label={t('limits.freeze.dialog.stage')}>
              <Select value={draft.frozenFrom} onChange={(event) => actions?.onFreezeDraft?.({ ...draft, frozenFrom: event.target.value as OrderFreezeStage })}>
                {ORDER_FREEZE_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {t(`limits.freeze.stage.${stage}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('limits.freeze.dialog.action')}>
              <Select value={draft.action} onChange={(event) => actions?.onFreezeDraft?.({ ...draft, action: event.target.value as OrderFreezeAction })}>
                {ORDER_FREEZE_ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {t(`limits.freeze.action.${action}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={t('limits.freeze.dialog.note')} hint={t('limits.freeze.dialog.noteHint')}>
            <Input value={draft.note} maxLength={200} onChange={(event) => actions?.onFreezeDraft?.({ ...draft, note: event.target.value })} />
          </Field>
          {problem && dialog.problem === null && <p className="fw-pa-error">{t(problem)}</p>}
          <p className="fw-pa-hint">{t('limits.freeze.dialog.atOnce')}</p>
        </fieldset>
      </div>
    </Modal>
  )
}
