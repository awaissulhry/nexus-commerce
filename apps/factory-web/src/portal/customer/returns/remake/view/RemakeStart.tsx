'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Input, RadioCard } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { ReturnableItem, ReturnableRead } from '../../api'
import { itemFacts, type StartDraft } from '../../model'
import { useReturnWords } from '../../words'
import { remakeChoices, REMAKE_FIT_MAX } from '../model'

/**
 * SCR-187 › Start › A remake (B-W2b-346; design links.claim "Remake (made-to-measure fit)", the same form by the portal):
 * the details (ONE item of what we delivered that may come back, its serial, what is wrong with the fit, your reference)
 * and its part of Check and send. Words: `returns-remake` (portal.*), the start's own `portal-returns` for what both share.
 */

const nameOf = (item: ReturnableItem) => (item.style ? `${item.style.code} ${item.style.name}` : item.description)

export function RemakeStartDetails({ draft, read, problems, onDraft }: { draft: StartDraft; read: ReturnableRead; problems: Readonly<Record<string, string>>; onDraft?: (patch: Partial<StartDraft>) => void }) {
  const { t } = useReturnWords()
  const tr = useT('returns-remake')
  const problem = (field: string) => (problems[field] ? tr(problems[field]!) : undefined)
  const choices = remakeChoices(read)
  return (
    <div className="fw-pret-dialog">
      <fieldset className="fw-pret-choices" aria-describedby={problem('remakeItem') ? 'fw-pret-remake-error' : undefined}>
        <legend className="fw-pret-h3">{tr('portal.item')}</legend>
        <p className="fw-pret-hint">{tr('portal.itemHint')}</p>
        {choices.length === 0 ? (
          <Banner tone="info" title={tr('portal.none')}>
            {tr('portal.noneBody')}
          </Banner>
        ) : null}
        {choices.map((item) => (
          <RadioCard
            key={item.key}
            variant="row"
            name="fw-pret-remake-item"
            value={item.key}
            checked={draft.remakeKey === item.key}
            selected={draft.remakeKey === item.key}
            onChange={() => onDraft?.({ remakeKey: item.key })}
            title={nameOf(item)}
            description={itemFacts(item, t).join(' · ')}
          />
        ))}
        {problem('remakeItem') ? (
          <p id="fw-pret-remake-error" className="fw-pret-error">
            {problem('remakeItem')}
          </p>
        ) : null}
      </fieldset>
      <Field label={tr('portal.fit')} hint={tr('portal.fitHint')} error={problem('fit')} required>
        <Textarea className="fw-pret-note" limit={REMAKE_FIT_MAX} value={draft.fit} onChange={(event) => onDraft?.({ fit: event.target.value })} />
      </Field>
      <div className="fw-pret-fields">
        <Field label={t('start.serial')} hint={t('start.serialHint')} error={problem('serial')}>
          <Input value={draft.serial} onChange={(event) => onDraft?.({ serial: event.target.value })} />
        </Field>
        <Field label={t('start.yourRef')} hint={t('start.yourRefHint')} error={problem('customerRef')}>
          <Input value={draft.customerRef} onChange={(event) => onDraft?.({ customerRef: event.target.value })} />
        </Field>
      </div>
      <p className="fw-pret-hint">{tr('portal.photosNext')}</p>
    </div>
  )
}

export function RemakeStartReview({ draft, read }: { draft: StartDraft; read: ReturnableRead }) {
  const { t } = useReturnWords()
  const tr = useT('returns-remake')
  const item = read.items.find((entry) => entry.key === draft.remakeKey) ?? null
  return (
    <div className="fw-pret-dialog">
      <h3 className="fw-pret-h3">{tr('portal.review')}</h3>
      <dl className="fw-pret-facts">
        <dt>{tr('portal.item')}</dt>
        <dd>{item ? [nameOf(item), ...itemFacts(item, t)].join(' · ') : '—'}</dd>
        <dt>{t('start.serial')}</dt>
        <dd>{draft.serial.trim() || '—'}</dd>
        <dt>{tr('portal.fit')}</dt>
        <dd className="fw-pret-pre">{draft.fit.trim()}</dd>
        <dt>{t('start.yourRef')}</dt>
        <dd>{draft.customerRef.trim() || '—'}</dd>
      </dl>
      <p className="fw-pret-hint">{tr('portal.photosNext')}</p>
    </div>
  )
}
