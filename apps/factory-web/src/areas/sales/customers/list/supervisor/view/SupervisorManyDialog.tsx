'use client'

import Link from 'next/link' // F-CL-301
import { Minus, UserRound } from 'lucide-react' // F-CL-301
import { Banner, Field } from '@nexus/ui/components'
import { Button, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { BulkReceipt, type ReceiptLine } from '../../../../../parties/_shared/view/dialogs'
import { supervisorPlanOf, supervisorRestOf, supervisorSummaryOf, type SupervisorManyActions, type SupervisorManyModel, type SupervisorPlan, type SupervisorWhy } from '../model'
import '../../list.css'

/** "Nobody yet" in the pick list. */
const NOBODY = ''

/**
 * F-CL-104 (10-design §8, 13-backend §8.5): "Set production supervisor for N…" — the shared P2 window's parts (Runs on · Not on with
 * why, the receipt with doors and "Run the rest again"), never a copy: 1 · the customers are read, then ONE pick from the first
 * customer's list ("the server judges each of the others"), who gets the notices, and that the customer is not told who; 2 · it runs
 * one customer at a time ("2 of 3 done…", Stop after this one); 3 · the receipt. Draws what it is given; fetches nothing.
 */
export function SupervisorManyDialog({ model, actions, hrefOf }: { model: SupervisorManyModel | null; actions: SupervisorManyActions; hrefOf?: ((id: string) => string | null) | null }) {
  if (!model) return null
  return (
    <WithMessages namespaces={['customers-list', 'production-supervisor', 'portal-access', 'orders-sheet', 'parties']}>
      <Dialog model={model} actions={actions} hrefOf={hrefOf ?? null} />
    </WithMessages>
  )
}

function Dialog({ model, actions, hrefOf }: { model: SupervisorManyModel; actions: SupervisorManyActions; hrefOf: ((id: string) => string | null) | null }) {
  const c = useT('customers-list')
  const ps = useT('production-supervisor')
  const pa = useT('portal-access')
  const sheet = useT('orders-sheet')
  const t = useT('parties')
  const words = (why: SupervisorWhy) => (why.ns === 'customers-list' ? c(why.key, why.params) : why.ns === 'production-supervisor' ? ps(why.key, why.params) : pa(why.key, why.params))
  const plan = supervisorPlanOf(model.targets, model.picked)
  const people = model.people.status === 'ready' ? model.people.people : []
  const person = people.find((entry) => entry.id === model.picked) ?? null
  const read = model.targets.filter((target) => target.state !== 'reading').length
  const total = model.targets.length

  const heldGo = !model.picked ? c('supervisor.held.pick') : plan.runs.length === 0 ? sheet('commands.many.nothing') : null
  const footer =
    model.step === 'done' ? (
      <Button variant="primary" onClick={actions.onClose}>
        {ps('close')}
      </Button>
    ) : model.step === 'running' ? (
      <Button onClick={actions.onStop} heldReason={model.stopping ? c('supervisor.stopping') : null}>
        {c('supervisor.stop')}
      </Button>
    ) : (
      <>
        <span className="grow" />
        <Button onClick={actions.onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={actions.onGo} heldReason={model.step === 'read' ? c('supervisor.held.reading') : heldGo}>
          {c('supervisor.go', { count: plan.runs.length })}
        </Button>
      </>
    )

  return (
    <Modal open onClose={actions.onClose} title={c('supervisor.title', { count: total })} size="md" footer={footer}>
      <div className="fw-pty-modal-body">
        {model.step === 'read' && (
          <p className="fw-pty-loading" role="status">
            <Spinner size={14} /> {c('supervisor.reading', { done: read, count: total })}
          </p>
        )}
        {model.step === 'pick' && (
          <>
            {/* F-CL-301 (walk W-6): "Runs on 3 · Not on 3: why is beside each" before the pick too; the customers under the pick. */}
            <p className="fw-pty-pop-title">
              {sheet('commands.runs', { count: plan.runs.length })}
              {plan.notOn.length > 0 ? ` · ${sheet('commands.notOn', { count: plan.notOn.length })}` : ''}
            </p>
            <Field label={c('supervisor.pick')} hint={c('supervisor.listHint')}>
              {model.people.status === 'loading' ? (
                <Skeleton height={32} />
              ) : model.people.status === 'error' ? (
                <Banner tone="warning" title={words(model.people.why)} />
              ) : people.length === 0 ? (
                <Banner tone="info" title={ps('dialog.nobody')} />
              ) : (
                <Select value={model.picked ?? NOBODY} onChange={(event) => actions.onPick(event.target.value === NOBODY ? null : event.target.value)}>
                  <option value={NOBODY}>{c('supervisor.choose')}</option>
                  {people.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.me ? ps('dialog.me', { name: entry.name }) : entry.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {model.people.status === 'ready' && !model.people.complete && <p className="fw-pty-hint">{ps('dialog.partial')}</p>}
            <SupervisorLines plan={plan} hrefOf={hrefOf} words={words} />
            {person && plan.runs.length > 0 && <p className="fw-pty-hint">{c('supervisor.notices', { name: person.name, count: plan.runs.length })}</p>}
            <p className="fw-pty-hint">{c('supervisor.notTold')}</p>
          </>
        )}
        {model.step === 'running' && (
          <p className="fw-pty-loading" role="status">
            <Spinner size={14} /> {sheet('commands.many.running', { done: model.done, count: plan.runs.length })}
          </p>
        )}
        {model.step === 'done' && <Receipt model={model} hrefOf={hrefOf} words={words} name={person?.name ?? '—'} onRunRest={actions.onRunRest} />}
      </div>
    </Modal>
  )
}

/**
 * F-CL-301 (walk W-6; 10-design §8): every ticked customer before the run — the ones it runs on (its orders without a supervisor of
 * their own follow the pick; "now: …" its supervisor today, an office person) and the ones it leaves out, each with why. A name
 * opens the customer in a new tab (this window stays).
 */
function SupervisorLines({ plan, hrefOf, words }: { plan: SupervisorPlan; hrefOf: ((id: string) => string | null) | null; words: (why: SupervisorWhy) => string }) {
  const c = useT('customers-list')
  if (plan.runs.length + plan.notOn.length === 0) return null
  const name = (id: string, text: string) => {
    const href = hrefOf?.(id) ?? null
    return href ? (
      <Link href={href} target="_blank" rel="noopener noreferrer">
        {text}
      </Link>
    ) : (
      <b>{text}</b>
    )
  }
  return (
    <ul className="fw-cl-sup-lines" aria-label={c('p2.each.customers')}>
      {plan.runs.map((target) => (
        <li key={target.id}>
          <UserRound size={14} aria-hidden />
          <span className="fw-cl-sup-who">
            {name(target.id, target.name)}
            <span className="fw-pty-hint">{c('supervisor.follows')}</span>
          </span>
          <span className="fw-cl-sup-now">{target.supervisor ? c('supervisor.now', { name: target.supervisor.name }) : c('supervisor.nowNone')}</span>
        </li>
      ))}
      {plan.notOn.map((line) => (
        <li key={line.id} className="is-out">
          <Minus size={14} aria-hidden />
          <span className="fw-cl-sup-who">
            {name(line.id, line.name)}
            <span className="fw-pty-hint">{words(line.why)}</span>
          </span>
          <span className="fw-cl-sup-now">{c('supervisor.leftOut')}</span>
        </li>
      ))}
    </ul>
  )
}

/** Step 3: who supervises them now, and one line per customer (Done / Already so / Not run / Not done: why / left out: why). */
function Receipt({ model, hrefOf, words, name, onRunRest }: { model: SupervisorManyModel; hrefOf: ((id: string) => string | null) | null; words: (why: SupervisorWhy) => string; name: string; onRunRest: () => void }) {
  const c = useT('customers-list')
  const ps = useT('production-supervisor')
  const plan = supervisorPlanOf(model.targets, model.picked)
  const summary = supervisorSummaryOf(plan, model.outcomes)
  const rest = supervisorRestOf(plan, model.outcomes)
  const lines: ReceiptLine[] = [
    ...plan.runs.map((target): ReceiptLine => {
      const outcome = model.outcomes[target.id]
      if (outcome?.kind === 'done') return { id: target.id, name: target.name, outcome: ps('result.changed'), tone: 'success' }
      if (outcome?.kind === 'failed') return { id: target.id, name: target.name, outcome: ps('result.notDone', { why: words(outcome.why) }), tone: 'danger' }
      return { id: target.id, name: target.name, outcome: c('supervisor.notRun'), tone: 'warning' }
    }),
    ...plan.notOn.map((line): ReceiptLine => ({ id: line.id, name: line.name, outcome: line.already ? ps('result.unchanged') : words(line.why), tone: line.already ? 'neutral' : 'warning' })),
  ]
  return (
    <>
      <Banner tone={summary.left + summary.notRun === 0 ? 'success' : 'warning'} title={c('supervisor.summary', { name, done: summary.done, same: summary.same, notRun: summary.notRun, left: summary.left })} />
      <BulkReceipt lines={lines} label={c('p2.each.customers')} hrefOf={hrefOf} door={c('p2.door.customers')} runRest={rest.length > 0 ? { count: rest.length, onRun: onRunRest } : null} />
    </>
  )
}
