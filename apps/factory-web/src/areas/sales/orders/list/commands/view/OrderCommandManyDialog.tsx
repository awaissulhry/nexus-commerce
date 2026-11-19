'use client'

import { CheckCircle2, CircleSlash, XCircle } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { Modal, StepUpModal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { NAMESPACE as SHEET } from '../../sheet/model'
import { manyGoHeld, manyNeedsReason, manyPreview, manyReceipt, manyTargetLabel, wordsText, type ManyLine, type ManyResult, type OrderCommandManyActions, type OrderCommandManyModel, type Words } from '../model'
import '../commands.css'

/**
 * F-CP-109 (customer page plan C2b, D8; 10-customer-page §3.2; picture 20's bar): Mark {count} ready… · Close {count}… · Confirm {count}…
 * — a DS Modal (lg) over the ticked orders. The preview names each order ("Runs on 6 · Not on 2: why is beside each", the order page's
 * held words beside each one that does not run; an order out of reach is counted, never named), ONE reason when one is needed, Confirm N
 * says that ONE code confirms each order named, and Cancel is one order at a time. While it runs: "3 of 6". The result: "5 done · 1 not
 * done", each order's line (done, or not with why: "SO-0150 changed meanwhile: open it and try again.", "the code ran out: run the rest
 * again") and Run the rest again. No amount anywhere: a Close of an order not settled says so in words only. Draws its model.
 */
export function OrderCommandManyDialog(props: { model: OrderCommandManyModel; actions?: OrderCommandManyActions }) {
  return (
    <WithMessages namespaces={['orders', SHEET]}>
      <Dialog {...props} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: OrderCommandManyModel; actions?: OrderCommandManyActions }) {
  const t = useT('orders')
  const s = useT(SHEET)
  const locale = useLocale()
  const say = (words: Words) => wordsText(words, t, s, locale)
  const preview = manyPreview(model.command, model.targets, model.reads, model.can)
  const receipt = manyReceipt(model.targets, model.results)
  const goHeld = manyGoHeld(model.command, preview, model.reason, model.phase !== 'preview')
  const close = () => actions?.onClose?.()
  return (
    <>
      <Modal
        open
        size="lg"
        onClose={close}
        title={s(`commands.many.title.${model.command}`, { count: model.targets.length })}
        footer={
          model.phase === 'done' ? (
            <>
              <span className="grow" />
              {receipt.again.length > 0 && (
                <Button size="sm" onClick={() => actions?.onAgain?.()}>
                  {s('commands.many.runRest', { count: receipt.again.length })}
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={close}>
                {t('common.done')}
              </Button>
            </>
          ) : (
            <>
              <span className="grow" />
              <Button size="sm" heldReason={model.phase === 'running' ? t('held.busy') : null} onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" heldReason={goHeld ? say(goHeld) : null} onClick={() => actions?.onRun?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
                {s(`commands.many.go.${model.command}`, { count: preview.runs.length })}
              </Button>
            </>
          )
        }
      >
        <OrderCommandManyBody model={model} actions={actions} />
      </Modal>
      {/* Confirm N: ONE fresh code (the order page's words). */}
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </>
  )
}

/** The window's content (also drawn on its own by the tests and the design cases: the DS Modal draws nothing before hydration). */
export function OrderCommandManyBody({ model, actions }: { model: OrderCommandManyModel; actions?: OrderCommandManyActions }) {
  const t = useT('orders')
  const s = useT(SHEET)
  const locale = useLocale()
  const say = (words: Words) => wordsText(words, t, s, locale)
  const preview = manyPreview(model.command, model.targets, model.reads, model.can)
  const read = model.targets.length - preview.reading
  const outOfReach = (count: number) => (count > 0 ? <p className="fw-cmd-hint">{s('commands.many.outOfReach', { count })}</p> : null)
  const notOn = preview.notOn.length > 0 && (
    <section className="fw-cmd" aria-label={s('commands.notOn', { count: preview.notOn.length })}>
      <p className="fw-cmd-heading">{s('commands.notOn', { count: preview.notOn.length })}</p>
      <ul className="fw-cmd-list">
        {preview.notOn.map((line) => (
          <li key={line.target.id} className="fw-cmd-line">
            <CircleSlash size={14} aria-hidden />
            <b>{manyTargetLabel(line.target)}</b>
            {line.why && <span className="fw-cmd-why">{say(line.why)}</span>}
          </li>
        ))}
      </ul>
    </section>
  )

  if (model.phase === 'done') {
    const receipt = manyReceipt(model.targets, model.results)
    return (
      <div className="fw-cmd">
        <Banner tone={receipt.left === 0 && receipt.done > 0 ? 'success' : 'warning'} title={s('commands.many.result', { done: receipt.done, left: receipt.left })} />
        <ul className="fw-cmd-list" aria-label={s('commands.many.label')}>
          {receipt.lines.map((line) => (
            <li key={line.target.id} className="fw-cmd-line">
              {line.result.state === 'done' ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}
              <b>{manyTargetLabel(line.target)}</b>
              <span className="fw-cmd-why">{resultWords(line.result, t, s, say)}</span>
            </li>
          ))}
        </ul>
        {outOfReach(receipt.gone)}
        {notOn}
      </div>
    )
  }

  const running = model.phase === 'running'
  const needsReason = manyNeedsReason(model.command, preview.runs)
  return (
    <div className="fw-cmd">
      {preview.reading > 0 && (
        <p className="fw-cmd-hint" role="status">
          <Spinner size={14} /> {s('commands.many.reading', { done: read, count: model.targets.length })}
        </p>
      )}
      {running && model.progress && (
        <p className="fw-cmd-hint" role="status">
          <Spinner size={14} /> {s('commands.many.running', { done: model.progress.done, count: model.progress.count })}
        </p>
      )}
      <section className="fw-cmd" aria-label={s('commands.runs', { count: preview.runs.length })}>
        <p className="fw-cmd-heading">
          {s('commands.runs', { count: preview.runs.length })}
          {preview.notOn.length > 0 ? ` · ${s('commands.notOn', { count: preview.notOn.length })}` : ''}
        </p>
        <ul className="fw-cmd-list">
          {preview.runs.map((line: ManyLine) => {
            const result = model.results[line.target.id]
            return (
              <li key={line.target.id} className="fw-cmd-line">
                {result ? result.state === 'done' ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden /> : null}
                <b>{manyTargetLabel(line.target)}</b>
                {line.note && <span className="fw-cmd-why">{say(line.note)}</span>}
                {result && result.state !== 'done' && <span className="fw-cmd-why">{resultWords(result, t, s, say)}</span>}
              </li>
            )
          })}
        </ul>
      </section>
      {outOfReach(preview.gone)}
      {notOn}
      {needsReason && (
        <Field label={t(model.command === 'ready' ? 'ready.reason' : 'close.reason')} hint={s('commands.many.reasonAll')}>
          <Textarea value={model.reason} onChange={(event) => actions?.onReason?.(event.target.value)} rows={3} maxLength={1000} readOnly={running} />
        </Field>
      )}
      {model.command === 'confirm' && <p className="fw-cmd-hint">{s('commands.many.oneCode')}</p>}
      <p className="fw-cmd-hint">{s('commands.cancelOne')}</p>
    </div>
  )
}

/** One order's answer in words: done; not done with why; the code ran out (run the rest again). */
function resultWords(result: ManyResult, t: (key: string, params?: Record<string, string | number>) => string, s: (key: string, params?: Record<string, string | number>) => string, say: (words: Words) => string): string {
  if (result.state === 'done') return t('common.done')
  if (result.state === 'codeExpired') return s('commands.many.codeExpired')
  if (result.state === 'notDone') return s('commands.many.notDone', { why: say(result.why) })
  return ''
}
