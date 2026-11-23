'use client'

import { CheckCircle2, Globe, XCircle } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { Composer } from '../../../../../lib/record-thread/composer/view/Composer'
import { WithMessages } from '../../../../../record-panels/i18n'
import { NAMESPACE as SHEET, type Phrase } from '../sheet/model'
import { languageInSentence, replyComposerContext, replyReceipt, replySendHeld, sentOf, targetLabel, toSend, type ReplyManyActions, type ReplyManyModel } from '../reply-many'
import { previewLabel } from '../reply-many' // B-SA-070b
// ---- F-CW-203: the to-do tick ("Ask <customer> about N…") ----
import { addDays } from '../../../../admin/users/partners/model'
import { romeToday } from '../../model'
import { todoHeld, todoLeft } from '../reply-many'
import './reply-todo.css'
// ---- end F-CW-203
import '../sheet/sheet.css'

/**
 * F-SA-282 (sales page plan N5, picks P10, R7; 11-customer-page §3.8; rule 7 / T11): Reply to <customer> on N… — a centred DS Modal
 * (a full-screen sheet on a phone) opened from the Orders sheet's bar on the ticked orders of ONE customer. It names who reads it and
 * in which language ("Brand Alpha reads Italian"), the orders it goes to ("Brand Alpha will read this on 6 orders: SO-0142 (PO 4711),
 * …"), that each order's conversation gets its own message, and that files go in each order's own conversation; then the thread's
 * composer in N mode (the portal only, no clip: rule 24, the same box). Send is held in words while the customer has no portal yet,
 * and when the API's check says the text names another customer of ours (the composer's own tick, F-SA-282a). After Send: one line
 * per order — posted, or not with why — and Try again for the orders a fault stopped. Draws its model; the hook sends.
 */
export function ReplyManyDialog(props: { model: ReplyManyModel; actions?: ReplyManyActions }) {
  return (
    // F-CP-162: 'record-thread-send' — the composer's price warning and its "Send anyway" (F-CP-147's words).
    <WithMessages namespaces={[SHEET, 'record-thread-composer', 'record-thread-send']}>
      <Dialog {...props} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: ReplyManyModel; actions?: ReplyManyActions }) {
  const s = useT(SHEET)
  const receipt = replyReceipt(model.targets, model.results)
  return (
    <Modal
      open
      size="md"
      onClose={() => actions?.onClose?.()}
      title={s(model.asked ? 'reply.askTitle' : 'reply.title', { customer: model.customer.name, count: model.targets.length }) /* F-CW-203: opened from Ask ▾ */}
      footer={
        model.done ? (
          <>
            <span className="grow" />
            {receipt.failed > 0 && (
              <Button size="sm" onClick={() => actions?.onSend?.()}>
                {s('reply.retry', { count: receipt.failed })}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => actions?.onClose?.()}>
              {s('reply.close')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" heldReason={model.sending ? s('reply.sending') : null} onClick={() => actions?.onClose?.()}>
              {s('reply.cancel')}
            </Button>
          </>
        )
      }
    >
      <ReplyManyBody model={model} actions={actions} />
    </Modal>
  )
}

/** The window's content (also drawn on its own by the tests and the design cases: the DS Modal draws nothing before hydration). */
export function ReplyManyBody({ model, actions }: { model: ReplyManyModel; actions?: ReplyManyActions }) {
  const s = useT(SHEET)
  const locale = useLocale()
  const say = (phrase: Phrase) => s(phrase.key, phrase.params)
  const customer = model.customer.name

  if (model.done) {
    const receipt = replyReceipt(model.targets, model.results)
    return (
      <div className="fw-srm">
        <Banner tone={receipt.sent > 0 ? 'success' : 'warning'} title={receipt.sent > 0 ? s('reply.result.title', { count: receipt.sent, customer }) : s('reply.result.none')} />
        <ul className="fw-srm-results" aria-label={s('reply.result.label')}>
          {receipt.lines.map((line) => (
            <li key={line.id} className="fw-srm-result">
              {line.result?.state === 'sent' ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}
              <span>
                <b>{line.label}</b> · {line.result?.state === 'sent' ? s('reply.result.sent') : s('reply.result.notSent', { why: say(line.result?.why ?? { key: 'reply.why.failed' }) })}
                {/* F-CW-203: what became of the customer's to-do, on the order's own line (never an amount, never a name). */}
                {line.result?.state === 'sent' && line.result.todo && (
                  <>
                    {' · '}
                    {line.result.todo.state === 'made' ? s('reply.result.todoMade') : s('reply.result.todoNot', { why: say(line.result.todo.why) })}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  const pending = toSend(model.targets, model.results)
  const sent = sentOf(model.targets, model.results)
  // F-CW-203: a to-do a fault stopped is still left to do; the tick's day may hold Send.
  const today = model.today ?? romeToday()
  const held = replySendHeld(model.portal, customer, pending.length + todoLeft(model.targets, model.results).length) ?? todoHeld(model.todo, today)
  const todo = model.todo ?? null
  const language = model.language ? languageInSentence(model.language, locale) : null
  return (
    <div className="fw-srm">
      {model.portal === 'off' && <Banner tone="warning" title={s('reply.portalOff', { customer })} />}
      {/* The customer's language: only when the reader may read the customer (never guessed); the composer says it is their portal. */}
      {language && (
        <p className="fw-srm-who">
          <Globe size={13} aria-hidden />
          <span>{s('reply.reads', { customer, language })}</span>
        </p>
      )}
      {sent.length > 0 && <p className="fw-srm-hint">{s('reply.already', { count: sent.length, orders: sent.map(targetLabel).join(', ') })}</p>}
      <div className="fw-srm-orders">
        <p className="fw-srm-heading">{s('reply.preview', { customer, count: pending.length })}</p>
        <p className="fw-srm-list">{pending.map((target) => previewLabel(target, s) /* B-SA-070b */).join(', ')}</p>
        <p className="fw-srm-hint">{s('reply.each')}</p>
      </div>
      {/* F-CW-203: ONE tick — a to-do "Answer our message" in the customer's list, one per order, after its message is posted. Drawn
          only for a reader who may make a customer's to-dos; ON when the window opens from Ask ▾, OFF from Reply to N. */}
      {todo && (
        <div className="fw-srm-todo">
          <div className="fw-srm-todo-row">
            <Checkbox checked={todo.on} disabled={model.sending} onChange={(event) => actions?.onTodo?.({ ...todo, on: event.target.checked })} label={s('reply.todo.tick')} />
            <DateField value={todo.due} onChange={(due) => actions?.onTodo?.({ ...todo, due })} locale={INTL_LOCALE[locale]} min={addDays(today, 1)} clearable clearLabel={s('reply.todo.noDate')} ariaLabel={s('reply.todo.date')} disabled={!todo.on || model.sending} />
          </div>
          <p className="fw-srm-hint">{s('reply.todo.hint', { customer })}</p>
        </div>
      )}
      <Composer
        context={replyComposerContext(customer)}
        draft={model.draft}
        notes={model.notes}
        sending={model.sending}
        extraHeld={held ? say(held) : null}
        lines={<p className="fw-srm-hint">{s('reply.noFiles')}</p>}
        hint={model.progress ? <span className="fw-srm-hint">{s('reply.progress', { done: model.progress.done, count: model.progress.count })}</span> : undefined}
        onDraft={(draft, notes) => actions?.onDraft?.(draft, notes)}
        onSend={() => actions?.onSend?.()}
      />
    </div>
  )
}
