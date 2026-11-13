'use client'

import { useId } from 'react'
import { FilePlus2 } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Kbd, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { brokenRules, quoteHeld, ruleWords, type MtmCan } from '../model'
import { MtmMessages, NoticeLine, useSubmitKey, useWords } from '../parts'
import type { QuoteDialogActions, QuoteDialogModel } from '../view-model'

/**
 * Use in a new quote (design mtm.grid#2 row verb, the Orders tab's empty state): a made-to-measure unit of a style flagged made
 * to measure, in a colourway, on a new DRAFT quote of the rider's customer, on the rider's newest revision; its base size the one
 * the measures suggest against the style (or typed). The style's check is read first: made-to-measure not started for its
 * template (GATE-MTM), a style not made to measure or measured with another template hold Create with the reason. Create makes
 * the quote, adds the unit and opens the quote. ⌘↵ creates. Fetches nothing.
 */
export function QuoteDialog({ model, can, companyId, actions }: { model: QuoteDialogModel; can: MtmCan; companyId: string | null; actions?: QuoteDialogActions }) {
  return (
    <MtmMessages>
      <Dialog model={model} can={can} companyId={companyId} actions={actions} />
    </MtmMessages>
  )
}

function Dialog({ model, can, companyId, actions }: { model: QuoteDialogModel; can: MtmCan; companyId: string | null; actions?: QuoteDialogActions }) {
  const { t, say, locale } = useWords()
  const ids = { style: useId(), colourway: useId(), base: useId() }
  const held = say(quoteHeld(model.draft, model.check, { can, offline: model.offline, companyId })) ?? (model.busy ? t('common.working') : model.checking ? t('quote.held.checking') : null)
  const onKey = useSubmitKey(true, !!held, () => actions?.onCreate?.())
  const suggested = model.check?.baseSize.size ?? null
  const broken = brokenRules(model.check)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('quote.title')}
      subtitle={t('quote.sub', { rider: model.riderName, customer: model.customer, revision: model.revision })}
      footer={
        <span className="fw-mtm-actions">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onCreate?.()} aria-keyshortcuts="Meta+Enter">
            {model.busy ? <Spinner size={12} /> : <FilePlus2 size={14} aria-hidden />} {t('quote.create')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-mtm-stack" onKeyDown={onKey}>
        <NoticeLine notice={model.notice} />
        <Field label={t('quote.style')} required htmlFor={ids.style} hint={model.styles.problem ? t(model.styles.problem) : t('quote.styleHint')}>
          <Select id={ids.style} size="sm" value={model.draft.styleId} onChange={(event) => actions?.onDraft?.({ styleId: event.target.value, colourwayId: '', baseSize: '' })}>
            <option value="">{model.styles.items === null && !model.styles.problem ? t('common.reading') : t('quote.stylePick', { count: model.styles.items?.length ?? 0 })}</option>
            {(model.styles.items ?? []).map((style) => (
              <option key={style.id} value={style.id}>
                {style.code} · {style.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('quote.colourway')} required htmlFor={ids.colourway}>
          <Select id={ids.colourway} size="sm" disabled={!model.style} value={model.draft.colourwayId} onChange={(event) => actions?.onDraft?.({ colourwayId: event.target.value })}>
            <option value="">{model.draft.styleId && !model.style ? t('common.reading') : t('quote.colourwayPick')}</option>
            {(model.style?.colourways ?? [])
              .filter((colourway) => colourway.status === 'ACTIVE')
              .map((colourway) => (
                <option key={colourway.id} value={colourway.id}>
                  {colourway.code} · {colourway.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label={t('quote.baseSize')} htmlFor={ids.base} hint={suggested ? t(model.check?.baseSize.how === 'INSIDE' ? 'new.suggestedInside' : 'new.suggestedNearest', { size: suggested }) : t('quote.baseSizeHint')}>
          <Input id={ids.base} size="sm" value={model.draft.baseSize} placeholder={suggested ?? ''} onChange={(event) => actions?.onDraft?.({ baseSize: event.target.value })} />
        </Field>
        {model.checking && (
          <p className="fw-mtm-hint" role="status">
            <Spinner size={12} /> {t('quote.checking')}
          </p>
        )}
        {model.check && model.check.rulesOn && broken.length > 0 && (
          <Banner tone={broken.some((rule) => rule.severity === 'BLOCK') ? 'danger' : 'warning'} title={t('form.flags', { count: broken.length })}>
            <ul className="fw-mtm-lines">
              {broken.map((rule) => (
                <li key={rule.code}>{ruleWords(rule.words, locale, rule.code)}</li>
              ))}
            </ul>
          </Banner>
        )}
        {model.check && model.check.rulesOn && model.check.insideCertifiedRange === false && <Banner tone="danger" title={t('range.outsideQuote')} />}
        <p className="fw-mtm-hint">{t('quote.after')}</p>
      </div>
    </Modal>
  )
}
