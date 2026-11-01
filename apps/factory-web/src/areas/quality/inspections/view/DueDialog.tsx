'use client'

import { useEffect, useId, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Kbd } from '@nexus/ui/primitives'
import { DateTimeField, Modal } from '../../../../lib/i18n/ds-parts'
import { useDsLabels } from '../../../../lib/i18n/ds-labels'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { DUE_MAX_DAYS, dueDialogHeld, type DueState } from '../model'

/**
 * Set due date (B-W2b-17; design quality.inspections qi-grid inline "Due", the list's selection): one time for the open
 * inspections picked (≤ 50), or none ("No due time"), sent in ONE call (POST /quality/inspections/due: every one or none;
 * a refusal names the inspection in the API's words under ours). The DS DateTimeField in the reader's language; a time
 * later than now and at most a year ahead. Fetches nothing: InspectionsPage saves.
 */
export function DueDialog({ state, onValue, onSave, onClose }: { state: DueState | null; onValue: (value: string) => void; onSave: () => void; onClose: () => void }) {
  return (
    <WithMessages namespaces={['ds-words']}>
      <Due state={state} onValue={onValue} onSave={onSave} onClose={onClose} />
    </WithMessages>
  )
}

function Due({ state, onValue, onSave, onClose }: Parameters<typeof DueDialog>[0]) {
  const t = useT('quality')
  const locale = useLocale()
  const ds = useDsLabels()
  const fieldId = useId()
  const [now] = useState(() => new Date())
  const held = state ? dueDialogHeld(state, new Date()) : null
  useEffect(() => {
    if (!state) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        onSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  if (!state) return null
  const count = state.ids.length
  const max = new Date(now.getTime() + DUE_MAX_DAYS * 86_400_000).toISOString()
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('due.title', { count })}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={onSave}>
            <CalendarClock size={14} aria-hidden /> {state.value ? t('due.save', { count }) : t('due.clear', { count })} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-q-stack">
        <Field label={t('due.when')} hint={t('due.whenHint')} htmlFor={fieldId}>
          <DateTimeField id={fieldId} value={state.value} onChange={onValue} min={now.toISOString()} max={max} defaultTime="16:00" locale={INTL_LOCALE[locale]} ariaLabel={t('due.when')} labels={ds.dateTimeField} disabled={state.busy} />
        </Field>
        <Checkbox checked={state.value === ''} onChange={(event) => onValue(event.target.checked ? '' : new Date(now.getTime() + 86_400_000).toISOString())} label={t('due.none')} disabled={state.busy} />
        <p className="fw-q-hint">{t('due.oneCall')}</p>
        {state.problem && (
          <Banner tone="danger" title={t(state.problem)}>
            {state.lines.length > 0 && (
              <ul className="fw-q-lines">
                {state.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
      </div>
    </Modal>
  )
}
