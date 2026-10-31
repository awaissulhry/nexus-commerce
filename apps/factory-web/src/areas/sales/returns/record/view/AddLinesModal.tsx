'use client'

import { useEffect } from 'react'
import { Banner, EmptyState, Modal } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { addLinesProblems, takenOf } from '../../model'
import type { AddLinesModel, RmaActions, RmaModel } from '../../view-model'
import { ReturnLinePicker } from '../../view/ReturnLinePicker'
import { say, useWords } from '../../view/parts'

/**
 * Add lines (B-W2b-16; design rma.lines "Add lines by picking from the customer's invoiced lines"): on an open RMA, before
 * the goods arrive, more of what the customer may send back — the same rows as New return (sold, left, the pieces never
 * above what is left, the reason, the customer's words); a line already on the return says its number (its pieces change
 * on the Lines tab). Add N lines (⌘↵) is held with the first thing missing; a refusal is said by place. Esc closes.
 */
export function AddLinesModal({ model, add, actions }: { model: RmaModel; add: AddLinesModel; actions?: RmaActions }) {
  const t = useWords()
  const { rma } = model
  const taken = takenOf(rma)
  const returnable = add.returnable.value
  const problems = addLinesProblems(add.lines, returnable?.lines ?? null, taken)
  const count = Object.values(add.lines).filter((line) => line.quantity.trim() !== '' && line.quantity.trim() !== '0').length
  const refused = add.problem ? [add.problem] : []
  const held = add.busy ? t('quality:common.working') : model.offline ? t('held.offline') : problems[0] ? say(t, problems[0]) : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        actions?.onAddLinesSubmit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  return (
    <Modal
      open
      onClose={() => actions?.onAddLinesClose?.()}
      title={t('addLines.title', { number: rma.number })}
      subtitle={t('addLines.sub')}
      size="xl"
      footer={
        <>
          <span className="fw-q-hint">{t('newReturn.foot')}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onAddLinesClose?.()}>
            {t('quality:common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onAddLinesSubmit?.()} aria-keyshortcuts="Meta+Enter">
            {add.busy ? <Spinner size={12} /> : null} {t('addLines.submit', { count })}
          </Button>
        </>
      }
    >
      <form
        className="fw-q-stack"
        onSubmit={(event) => {
          event.preventDefault()
          actions?.onAddLinesSubmit?.()
        }}
      >
        {refused.map((words) => (
          <Banner key={words.key} tone="danger" title={say(t, words)} />
        ))}
        {add.returnable.loading ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {t('newReturn.reading')}
          </p>
        ) : add.returnable.problem ? (
          <Banner tone="danger" title={t(add.returnable.problem)} />
        ) : !returnable || returnable.lines.length === 0 ? (
          <EmptyState title={t('newReturn.nothing')} description={t('newReturn.nothingBody')} />
        ) : (
          <ReturnLinePicker lines={returnable.lines} drafts={add.lines} reasons={model.reasons} price={model.can.price} windowDays={returnable.policy.windowDays ?? null} today={model.today} showProblems={add.showProblems} taken={taken} onLine={(key, patch) => actions?.onAddLinesLine?.(key, patch)} />
        )}
        {add.showProblems && problems.length > 0 && (
          <Banner tone="warning" title={t('newReturn.fix')}>
            <ul className="fw-q-lines">
              {problems.map((words) => (
                <li key={`${words.key}${JSON.stringify(words.params ?? {})}`}>{say(t, words)}</li>
              ))}
            </ul>
          </Banner>
        )}
      </form>
    </Modal>
  )
}
