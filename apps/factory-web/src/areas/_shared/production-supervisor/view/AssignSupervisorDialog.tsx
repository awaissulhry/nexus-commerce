'use client'

import { useState } from 'react'
import { CheckCircle2, MinusCircle, XCircle } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { ListboxPanel, Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { customersOf, SUPERVISOR_NS, type AssignSupervisorActions, type AssignSupervisorModel, type SupervisorTarget } from '../model'
import '../production-supervisor.css'

/**
 * F-PR-21 — THE assign dialog (DS Modal size sm + ListboxPanel, the Inquiries Assign pattern; 17-web-r2 §1.1): "Production supervisor
 * for 9 orders", the orders it sets named (the first three, Show all), how many customers, who it is now (one work order), the people
 * who may take it on every customer of the selection — the reader first as "Me (…)" — and "Customer default", which takes each
 * order's own away. Type to search, ↑ ↓, Enter sets, Esc closes. After Send: one result per order (Done / Already so / Not done: why),
 * the orders the API did not name to this reader only counted. The band's Change…, Work orders' "Assign supervisor…" and later the
 * Customer card and the limits card mount this one dialog.
 */

const DEFAULT = '__customer-default__'
const SHOWN = 3

export function AssignSupervisorDialog(props: { model: AssignSupervisorModel; actions?: AssignSupervisorActions }) {
  return (
    <WithMessages namespaces={[SUPERVISOR_NS]}>
      <Dialog {...props} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: AssignSupervisorModel; actions?: AssignSupervisorActions }) {
  const t = useT(SUPERVISOR_NS)
  const title = model.targets.length === 1 ? t('dialog.titleOne', { number: model.targets[0]!.number }) : t('dialog.titleMany', { count: model.targets.length })
  return (
    <Modal
      open
      size="sm"
      onClose={() => actions?.onClose?.()}
      title={title}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {t('close')}
          </Button>
        </>
      }
    >
      <AssignSupervisorBody model={model} actions={actions} />
    </Modal>
  )
}

function orderLabel(t: ReturnType<typeof useT>, target: SupervisorTarget): string {
  return target.customerRef ? t('dialog.orderWithPo', { number: target.number, po: target.customerRef }) : target.number
}

/** The dialog's content (also drawn on its own by the tests: the DS Modal draws nothing before the page is hydrated). */
export function AssignSupervisorBody({ model, actions }: { model: AssignSupervisorModel; actions?: AssignSupervisorActions }) {
  const t = useT(SUPERVISOR_NS)
  const [all, setAll] = useState(false)
  const customers = customersOf(model.targets)
  const shown = all ? model.targets : model.targets.slice(0, SHOWN)
  const people = model.people.status === 'ready' ? model.people.people : []
  const options = [
    ...people.map((person) => ({ value: person.id, label: person.me ? t('dialog.me', { name: person.name }) : person.name })),
    { value: DEFAULT, label: t('dialog.default') },
  ]

  if (model.result) {
    const result = model.result
    return (
      <div className="fw-psv-dialog">
        <Banner tone="success" title={result.supervisor ? t('result.person', { name: result.supervisor.name }) : t('result.default')}>
          {result.supervisor && !result.supervisor.active ? t('fact.inactive') : null}
        </Banner>
        <ul className="fw-psv-results" aria-label={t('result.label')}>
          {result.lines.map((line) => (
            <li key={line.orderId} className="fw-psv-result">
              {line.state === 'changed' ? <CheckCircle2 size={14} aria-hidden /> : line.state === 'unchanged' ? <MinusCircle size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}
              <span>
                <b>{line.number}</b> · {line.state === 'skipped' ? t('result.notDone', { why: t(line.key) }) : t(`result.${line.state}`)}
              </span>
            </li>
          ))}
        </ul>
        {result.unknown > 0 && <p className="fw-psv-hint">{t('result.unknown', { count: result.unknown })}</p>}
      </div>
    )
  }

  return (
    <div className="fw-psv-dialog">
      <p className="fw-psv-orders">
        {shown.map((target) => orderLabel(t, target)).join(', ')}
        {model.targets.length > SHOWN && (
          <>
            {' '}
            <Button size="sm" variant="quiet" aria-expanded={all} onClick={() => setAll((open) => !open)}>
              {all ? t('dialog.showFewer') : t('dialog.showAll', { count: model.targets.length })}
            </Button>
          </>
        )}
        {' · '}
        {customers.length === 1 ? customers[0] : t('dialog.customers', { count: customers.length })}
      </p>
      {model.leftOut > 0 && <p className="fw-psv-hint">{t('dialog.leftOut', { count: model.leftOut })}</p>}
      <p className="fw-psv-hint">{model.current ? t('dialog.now', { name: model.current.name, from: t(`fact.from.${model.current.from}`) }) : t('dialog.nowNone')}</p>
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      {model.people.status === 'loading' && (
        <div role="status" aria-label={t('dialog.reading')}>
          <Skeleton height={120} />
        </div>
      )}
      {model.people.status === 'error' && (
        <Banner
          tone="danger"
          title={t(model.people.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('retry')}
            </Button>
          }
        />
      )}
      {model.people.status === 'ready' && people.length === 0 && <p className="fw-psv-hint">{customers.length > 1 ? t('dialog.nobodyMany') : t('dialog.nobody')}</p>}
      {model.people.status === 'ready' && (
        <div className="fw-psv-people">
          <ListboxPanel
            options={options}
            onCommit={(value) => {
              if (model.busy) return
              actions?.onAssign?.(value === DEFAULT ? null : value)
            }}
            onCancel={() => actions?.onClose?.()}
            ariaLabel={t('dialog.listLabel')}
            searchPlaceholder={t('dialog.search')}
            style={{ position: 'relative', width: '100%' }}
          />
        </div>
      )}
      {model.busy && (
        <p className="fw-psv-hint" role="status">
          {t('dialog.busy')}
        </p>
      )}
      {model.people.status === 'ready' && !model.people.complete && <p className="fw-psv-hint">{t('dialog.partial')}</p>}
      <p className="fw-psv-hint">{t('dialog.hint')}</p>
    </div>
  )
}
