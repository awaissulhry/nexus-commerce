'use client'

import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import { Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel } from '@nexus/ui/grid'
import { Button, Input } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { MANY_NAMESPACES, type Bar, type ManyWords } from '../model'
import type { ManyActActions, ManyActModel } from '../use-many-act'
import '../many-acts.css'

/** One translator per namespace the window and the bars speak (every hook called, always in the same order). */
function useSay(): (words: ManyWords | null | undefined) => string {
  const byNs: Record<string, (key: string, params?: Readonly<Record<string, string | number>>) => string> = {
    'before-order': useT('before-order'),
    'orders-sheet': useT('orders-sheet'),
    sales: useT('sales'),
    'sales-inquiries': useT('sales-inquiries'),
  }
  return (words) => (words ? (byNs[words.ns] ?? byNs['before-order']!)(words.key, words.params) : '')
}

/**
 * F-CQ-201 (customer page › Quotes & incoming, 10-design §8; settles C9, C12, C36): the ONE many-acts window — a centred modal (a
 * full-width sheet on a phone: the DS Modal's own). First the plan: "Runs on 5 · Not on 1: why is beside each", the records it runs on
 * (a field beside the one that needs one: a quote's PO number), the ones it does not with why; the text typed once. The button says
 * what it does and is held with words until it can run. While it runs: "Working: 3 of 5…". Then the receipt: "4 done · 1 not done",
 * EVERY record named (a button that docks its thread on the customer's tab, else its page) with what happened or "Not done. <why>",
 * and "Run the rest again (1)". It fetches nothing.
 */
export function ManyActDialog({ model, actions }: { model: ManyActModel | null; actions?: ManyActActions }) {
  if (!model) return null
  return (
    <WithMessages namespaces={[...MANY_NAMESPACES]}>
      <Window model={model} actions={actions} />
    </WithMessages>
  )
}

function Window({ model, actions }: { model: ManyActModel; actions?: ManyActActions }) {
  const say = useSay()
  const close = () => actions?.onClose?.()
  const running = model.phase === 'running'
  const receipt = model.receipt
  const name = (id: string, label: string, href: string | null) =>
    actions?.onName ? (
      <Button size="sm" variant="quiet" onClick={() => actions.onName?.(id)}>
        {label}
      </Button>
    ) : href ? (
      <Link className="fw-many-name" href={href}>
        {label}
      </Link>
    ) : (
      <span className="fw-many-name">{label}</span>
    )
  const footer =
    model.phase === 'receipt' && receipt ? (
      <>
        {receipt.left > 0 && <Button onClick={() => actions?.onRunRest?.()}>{say({ ns: 'orders-sheet', key: 'commands.many.runRest', params: { count: receipt.left } })}</Button>}
        <Button variant="primary" onClick={close}>
          {say({ ns: 'before-order', key: 'acts.close' })}
        </Button>
      </>
    ) : (
      <>
        <Button onClick={close} heldReason={running ? say({ ns: 'orders-sheet', key: 'commands.many.running', params: { done: model.progress.done, count: model.progress.count } }) : null}>
          {say({ ns: 'before-order', key: 'acts.back' })}
        </Button>
        <Button variant={model.danger ? 'danger' : 'primary'} heldReason={running ? say({ ns: 'orders-sheet', key: 'commands.many.running', params: { done: model.progress.done, count: model.progress.count } }) : model.held ? say(model.held) : null} onClick={() => actions?.onRun?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
          {say(model.go)}
        </Button>
      </>
    )
  return (
    <Modal open onClose={close} title={say(model.title)} size="md" footer={footer}>
      <div
        className="fw-many"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && model.phase === 'plan') {
            event.preventDefault()
            actions?.onRun?.()
          }
        }}
      >
        {model.body && <p className="fw-many-why">{say(model.body)}</p>}
        {model.phase !== 'receipt' ? (
          <>
            <p className="fw-many-plan" role="status">
              {say({ ns: 'orders-sheet', key: 'commands.runs', params: { count: model.plan.runs.length } })}
              {model.plan.notOn.length > 0 && ` · ${say({ ns: 'orders-sheet', key: 'commands.notOn', params: { count: model.plan.notOn.length } })}`}
            </p>
            <ul className="fw-many-list" aria-label={say({ ns: 'before-order', key: 'acts.records' })}>
              {model.plan.runs.map((record) => (
                <li key={record.id} className="fw-many-row">
                  <span className="fw-many-name">{record.label}</span>
                  {record.field && (
                    <span className="fw-many-field">
                      <Input size="sm" aria-label={`${say(record.field.label)} · ${record.label}`} placeholder={say(record.field.label)} maxLength={record.field.max} value={model.fields[record.id] ?? ''} readOnly={running} onChange={(event) => actions?.onField?.(record.id, event.target.value)} />
                    </span>
                  )}
                </li>
              ))}
              {model.plan.notOn.map((record) => (
                <li key={record.id} className="fw-many-row">
                  <span className="fw-many-name">{record.label}</span>
                  <span className="fw-many-why">{say({ ns: 'before-order', key: 'acts.notOnWhy', params: { why: say(record.why) } })}</span>
                </li>
              ))}
            </ul>
            {model.text && (
              <Field label={say(model.text.label)} hint={model.text.hint ? say(model.text.hint) : undefined} required={model.text.required}>
                <Textarea value={model.typed} onChange={(event) => actions?.onText?.(event.target.value)} rows={4} maxLength={model.text.max} readOnly={running} />
              </Field>
            )}
            {running && (
              <p className="fw-many-why" role="status">
                {say({ ns: 'orders-sheet', key: 'commands.many.running', params: { done: model.progress.done, count: model.progress.count } })}
              </p>
            )}
          </>
        ) : (
          receipt && (
            <>
              <p className="fw-many-plan" role="status">
                {say({ ns: 'orders-sheet', key: 'commands.many.result', params: { done: receipt.done, left: receipt.left } })}
              </p>
              <ul className="fw-many-list" aria-label={say({ ns: 'before-order', key: 'acts.records' })}>
                {model.results.map((result) => (
                  <li key={result.id} className="fw-many-row">
                    {name(result.id, result.label, result.href)}
                    <span className={result.done ? 'fw-many-why' : 'fw-many-why is-bad'}>{result.done ? say(result.words) : say({ ns: 'orders-sheet', key: 'commands.many.notDone', params: { why: say(result.words) } })}</span>
                  </li>
                ))}
              </ul>
            </>
          )
        )}
      </div>
    </Modal>
  )
}

/**
 * F-CQ-201 (10-design §6): a list's bar — at most three acts with their words (each counting only what it runs on), the rest under
 * More ▾; an act without its right is not here at all; one blocked by the state is held with words; a line under it when one is due
 * (a portal order is answered on its own; a role that changes none). It fetches nothing.
 */
// ---- cq fx5 W3-2: one phrase in the bars' words, where their catalogues are not loaded (a held row act's reason in a row's ⋯ menu).
export function ManySaid({ words }: { words: ManyWords }) {
  return (
    <WithMessages namespaces={[...MANY_NAMESPACES]}>
      <Said words={words} />
    </WithMessages>
  )
}
function Said({ words }: { words: ManyWords }) {
  const say = useSay()
  return <>{say(words)}</>
}
/** A row's ⋯ item held by state: disabled, its reason (the Reply window's own words) as the item's second line, the DS menu's place for it. */
export function heldRowItem(id: string, label: string, held: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null, onSelect: () => void): MenuItemDef {
  return held ? { id, label, disabled: true, description: <ManySaid words={{ ns: 'orders-sheet', key: held.key, ...(held.params ? { params: held.params } : {}) }} /> } : { id, label, onSelect }
}
// ---- end cq fx5 W3-2

export function ManyBar({ bar, onAct }: { bar: Bar; onAct: (id: string) => void }) {
  return (
    <WithMessages namespaces={[...MANY_NAMESPACES]}>
      <BarView bar={bar} onAct={onAct} />
    </WithMessages>
  )
}

function BarView({ bar, onAct }: { bar: Bar; onAct: (id: string) => void }) {
  const say = useSay()
  return (
    <span className="fw-many-bar">
      {bar.promoted.map((act) => (
        <Button key={act.id} size="sm" variant={act.danger ? 'danger-outline' : undefined} heldReason={act.held ? say(act.held) : null} aria-label={say(act.label)} onClick={() => onAct(act.id)}>
          <SelectionLabel>{say(act.label)}</SelectionLabel>
        </Button>
      ))}
      {bar.more.length > 0 && (
        <Menu
          label={
            <>
              {say({ ns: 'before-order', key: 'acts.more' })} <ChevronDown size={13} aria-hidden />
            </>
          }
          align="right"
          triggerProps={{ 'aria-label': say({ ns: 'before-order', key: 'acts.moreLabel', params: { count: bar.more.length } }) }}
          items={bar.more.map((act) => ({ id: act.id, label: say(act.label), ...(act.held ? { disabled: true, description: say(act.held) } : {}), ...(act.danger ? { tone: 'danger' as const } : {}), onSelect: () => onAct(act.id) }))}
        />
      )}
      {bar.note && <span className="fw-many-note">{say(bar.note)}</span>}
    </span>
  )
}
