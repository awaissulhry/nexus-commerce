'use client'

import { ShieldAlert } from 'lucide-react'
import { Banner, ChangeReview, EmptyState, Field, type ChangeReviewItem } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { ConfirmPhraseField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { ErasureGroup } from '../api'
import { eraseHeld, fieldKeys, sectionsOf, typeKey, type EraseModel, type EraseSection } from '../model'
import '../erase.css'

export interface EraseActions {
  onReason?: (reason: string) => void
  onTyped?: (typed: string) => void
  onConfirm?: () => void
  onRetry?: () => void
  onClose?: () => void
}

const METHOD_TONE = { ANONYMISED: 'warning', DELETED: 'danger', KEPT: 'info' } as const

/**
 * Anonymise <name>? (SCR-661, design admin.privacy pop:erase; GDPR art. 17; Platform rule W2b-6 "an erasure shows what stays and
 * why before the typed name"): what is erased (per record type, the person's columns blanked or replaced while the business
 * data stays), what is deleted, what stays because the law requires it (each with the law's why), the decision logged with a
 * reason (never the person's details), then the person's name typed exactly. Anonymise asks a fresh code every time (the
 * page's StepUpModal). Held with why while the erasure is blocked, nothing is left to erase, the reason or the name is missing.
 */
export function EraseDialog({ model, canErase, actions }: { model: EraseModel | null; canErase: boolean; actions?: EraseActions }) {
  const t = useT('admin-privacy-depth')
  if (!model) return null
  const preview = model.preview.value
  const name = preview ? (preview.person.erased ? t('dp.req.erasedPerson') : preview.person.name) : ''
  const held = eraseHeld(model, canErase)
  const close = () => actions?.onClose?.()

  if (model.done) {
    return (
      <Modal open onClose={close} title={t('dp.erase.doneTitle', { name })} size="md" footer={<Button variant="primary" onClick={close}>{t('dp.common.close')}</Button>}>
        <div className="fw-dper">
          <Banner tone="success" title={t('dp.erase.done', { anonymised: model.done.anonymised, deleted: model.done.deleted, kept: model.done.kept })}>
            {t('dp.erase.logged')}
          </Banner>
        </div>
      </Modal>
    )
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={close} disabled={model.busy}>
        {t('dp.common.cancel')}
      </Button>
      <Button variant="danger" onClick={() => actions?.onConfirm?.()} heldReason={model.busy ? t('dp.erase.erasing') : held ? t(held) : null}>
        {model.busy && <Spinner size={14} />}
        {t('dp.erase.confirm')}
      </Button>
    </>
  )

  return (
    <Modal open onClose={close} title={preview ? t('dp.erase.title', { name }) : t('dp.erase.titleLoading')} size="lg" footer={footer}>
      <div className="fw-dper">
        {model.preview.problem ? (
          <EmptyState
            title={t('dp.erase.failed')}
            description={t(model.preview.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('dp.common.retry')}
              </Button>
            }
          />
        ) : !preview ? (
          <p className="fw-dper-muted" role="status">
            <Spinner size={14} /> {t('dp.common.loading')}
          </p>
        ) : (
          <>
            <p className="fw-dper-intro">{t('dp.erase.intro')}</p>
            {preview.blocked && (
              <Banner tone="warning" icon={<ShieldAlert size={16} aria-hidden />} title={t('dp.erase.blockedTitle')}>
                {t(`dp.erase.blocked.${preview.blocked.code}`)}
              </Banner>
            )}
            {model.problem && <Banner tone="danger" title={t(model.problem)} />}
            {sectionsOf(preview).map(({ section, groups }) => (
              <section key={section} className="fw-dper-section" aria-labelledby={`fw-dper-${section}`}>
                <h3 id={`fw-dper-${section}`} className="fw-dper-h3">
                  {t(`dp.erase.section.${section}.title`)}
                </h3>
                <p className="fw-dper-muted">{t(`dp.erase.section.${section}.intro`)}</p>
                <ChangeReview label={t(`dp.erase.section.${section}.title`)} items={groups.map((group, index) => itemOf(group, section, index, t))} selectedIds={[]} onSelectionChange={() => undefined} tick={false} />
              </section>
            ))}
            {preview.anonymised.length === 0 && preview.deleted.length === 0 && <Banner tone="info" title={t('dp.erase.held.nothing')} />}
            {/* B-W2b-GF1 (F54, the Owner's decision of 15 Nov 2026): what the history covers, said before the erasure runs. */}
            <p className="fw-dper-muted">{t('dp.erase.historyScope')}</p>
            <Field label={t('dp.erase.reason')} hint={t('dp.erase.reasonHint')} required>
              <Textarea rows={3} value={model.reason} maxLength={1000} disabled={model.busy} onChange={(event) => actions?.onReason?.(event.target.value)} />
            </Field>
            <ConfirmPhraseField phrase={preview.person.name} value={model.typed} disabled={model.busy || !!preview.blocked} onChange={(value) => actions?.onTyped?.(value)} />
            <p className="fw-dper-muted">{t('dp.erase.code')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

function itemOf(group: ErasureGroup, section: EraseSection, index: number, t: ReturnType<typeof useT>): ChangeReviewItem {
  const erased = fieldKeys(group.erasedFields).map((key) => t(key))
  const kept = fieldKeys(group.keptFields).map((key) => t(key))
  return {
    id: `${section}-${group.recordType}-${index}`,
    label: t(typeKey(group.recordType)),
    status: (
      <span className="fw-dper-status">
        <Pill tone={METHOD_TONE[group.method]}>{t(`dp.erase.method.${group.method}`)}</Pill>
        <span>{t('dp.erase.records', { count: group.count })}</span>
      </span>
    ),
    note: group.why ? t(`dp.erase.why.${group.why.code}`) : t(`dp.erase.section.${section}.note`),
    selectable: false,
    values: [
      ...(erased.length > 0 ? [{ label: t('dp.erase.erasedFields'), value: erased.join(' · ') }] : []),
      ...(kept.length > 0 ? [{ label: t('dp.erase.keptFields'), value: kept.join(' · ') }] : []),
    ],
  }
}
