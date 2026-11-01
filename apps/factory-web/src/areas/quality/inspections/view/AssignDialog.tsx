'use client'

import { useEffect } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Kbd, Radio, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { inspectorHeld, type AssignState } from '../model'
import '../inspections.css'

/**
 * Assign inspector (design quality.inspections qi-assign; a row verb, the selection's "Assign 6 inspections", the record's
 * band): the people who record inspections at the site — office users, and the site's floor inspectors for whoever sees
 * them — each held with the reason when they made some of these garments ("Made garments of WO-0142"); "Nobody" clears it.
 * A worker is named here (a picker), never in a list (Owner answer W1). Draws one state; the page assigns.
 */
export function AssignDialog({ state, onValue, onSave, onClose }: { state: AssignState | null; onValue?: (value: string) => void; onSave?: () => void; onClose: () => void }) {
  const t = useT('quality')
  const open = state !== null
  const people = state?.people.value ?? null
  const picked = people?.inspectors.find((person) => `${person.kind}:${person.id}` === state?.value) ?? null
  const pickedHeld = picked ? inspectorHeld(picked) : null
  const count = state?.ids.length ?? 0
  const held = !state ? null : state.busy ? t('common.working') : people === null ? t('common.loading') : pickedHeld ? t(pickedHeld.key, pickedHeld.params) : null
  const submit = () => {
    if (!held) onSave?.()
  }
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('assign.title', { count })}
      subtitle={t('assign.subtitle')}
      size="md"
      footer={
        <>
          <span className="fw-q-hint">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> {t('assign.keyHint')}
          </span>
          <span className="grow" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={held}>
            {state?.value ? t('assign.confirm', { count }) : t('assign.clear', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        {state?.problem && (
          <Banner tone="warning" title={t(state.problem)}>
            {state.lines.length > 0 && (
              <ul className="fw-q-lines">
                {state.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        {state?.people.problem ? (
          <Banner tone="danger" title={t('assign.peopleFailed')}>
            {t(state.people.problem)}
          </Banner>
        ) : people === null ? (
          <Skeleton height={140} />
        ) : (
          <Field label={t('assign.who')} hint={people.floorListed ? t('assign.whoHintFloor') : t('assign.whoHint')}>
            <ul className="fw-q-pick" role="radiogroup" aria-label={t('assign.who')}>
              <li className="fw-q-pick-row">
                <Radio name="assignee" checked={state?.value === ''} onChange={() => onValue?.('')} label={t('assign.nobodyPick')} />
              </li>
              {people.inspectors.map((person) => {
                const value = `${person.kind}:${person.id}`
                const made = inspectorHeld(person)
                return (
                  <li key={value} className="fw-q-pick-row">
                    <Radio
                      name="assignee"
                      checked={state?.value === value}
                      disabled={made !== null}
                      onChange={() => onValue?.(value)}
                      label={person.me ? t('assign.meNamed', { name: person.name }) : person.kind === 'WORKER' ? t('assign.benchNamed', { name: person.name }) : person.name}
                    />
                    {made && <span className="fw-q-hint">{t(made.key, made.params)}</span>}
                  </li>
                )
              })}
            </ul>
            {people.inspectors.length === 0 && <p className="fw-q-hint">{t('assign.nobodyAtSite')}</p>}
          </Field>
        )}
      </div>
    </Modal>
  )
}
