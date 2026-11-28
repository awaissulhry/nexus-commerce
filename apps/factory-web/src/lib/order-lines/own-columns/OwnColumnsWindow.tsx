'use client'

import { useEffect, useState } from 'react'
import { Calendar, Check, Hash, Info, List, Pencil, Plus, ToggleLeft, Trash2 } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input } from '@nexus/ui/primitives'
import { WindowShell } from '../../window-shell/view/WindowShell'
import type { OwnColumn, OwnColumnKind, RecordOwnColumns } from '../schema'
import { useLinesWords } from '../words'
import { choicesOf, newColumnProblem, openColumns, OWN_COLUMN_NAME_MAX, OWN_COLUMNS_MAX, OWN_KINDS, QUICK_COLUMNS, roomForColumn, switchOff, type QuickColumn } from './rules'
import '../order-lines.css'

/**
 * owb-po3.3 (design § 5zi C; prototype oplus.js `lcolModal`) — the window "Columns of your own" (the office reads "The customer's own
 * columns"): the customer's columns, each on or off for THIS order; the often used ones in one press (Remake · Sizing · Name on the
 * piece · Comment · Needed by); a new one: a name and a kind (Text · Yes / No · Choice · Number · Date). Refusals in words, on leaving
 * the field: at most 8 on an order · the same name twice · a fixed column's name · a choice needs two choices · a column with a value
 * asks before it goes off this order (its values go with it only on "Take it off and clear the values"). A column is never deleted:
 * "Take it out of your list" closes it (the orders that use it keep it). On the base's WindowShell; a window that only shows (Close).
 */

export interface OwnColumnsWindowModel {
  readonly open: boolean
  readonly door: 'portal' | 'office'
  /** The customer's columns (open and closed); null while they are read. */
  readonly columns: readonly OwnColumn[] | null
  /** The ids this record uses, in their order. */
  readonly used: readonly string[]
  /** The record's values (a switch-off asks first where a line holds one). */
  readonly values: RecordOwnColumns['values']
  /** A write is out (the window's buttons wait). */
  readonly busy: boolean
  /** A refusal in words (the host's), or null. */
  readonly refused: string | null
  /** Why nothing can be written now (words: a preview, offline), or null. */
  readonly writeHeld: string | null
}

export interface OwnColumnsWindowActions {
  readonly onClose: () => void
  /** On or off for this order: `ids` the new used list; `dropValues` clears the values of a column going off. */
  readonly onUse?: (ids: string[], dropValues: boolean) => void
  /** A new column (or a quick one): the host makes it, then puts it on this order. */
  readonly onCreate?: (input: { name: string; kind: OwnColumnKind; choices: string[] }) => void
  /** "Take it out of your list": the column is closed (kept on the orders that use it). */
  readonly onCloseColumn?: (column: OwnColumn) => void
}

export function OwnColumnsWindow({ model, actions }: { model: OwnColumnsWindowModel; actions: OwnColumnsWindowActions }) {
  const { t } = useLinesWords()
  const portal = model.door === 'portal'
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={t(portal ? 'own.title' : 'own.titleOffice')} subtitle={t(portal ? 'own.sub' : 'own.subOffice')} size="lg">
      <OwnColumnsBody model={model} actions={actions} />
    </WindowShell>
  )
}

const KIND_ICON: Readonly<Record<OwnColumnKind, typeof Pencil>> = { TEXT: Pencil, YES_NO: ToggleLeft, CHOICE: List, NUMBER: Hash, DATE: Calendar }

/** The window's body (exported for the tests: a server render draws no dialog). */
export function OwnColumnsBody({ model, actions }: { model: OwnColumnsWindowModel; actions: OwnColumnsWindowActions }) {
  const { t } = useLinesWords()
  const portal = model.door === 'portal'
  const [name, setName] = useState('')
  const [kind, setKind] = useState<OwnColumnKind>('TEXT')
  const [choices, setChoices] = useState('')
  const [nameRefusal, setNameRefusal] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null)
  useEffect(() => {
    if (!model.open) {
      setName('')
      setKind('TEXT')
      setChoices('')
      setNameRefusal(null)
      setAsking(null)
    }
  }, [model.open])
  const columns = model.columns ?? []
  const shown = columns.filter((column) => !column.closed || model.used.includes(column.id))
  const full = !roomForColumn(model.used)
  const held = model.writeHeld ?? (model.busy ? t('own.busy') : null)
  const quick = QUICK_COLUMNS.filter((entry) => !openColumns(columns).some((column) => column.name.trim().toLocaleLowerCase() === t(`own.quick.${entry.id}`).toLocaleLowerCase()))
  const create = (input: { name: string; kind: OwnColumnKind; choices: string[] }) => actions.onCreate?.(input)
  const addQuick = (entry: QuickColumn) => create({ name: t(`own.quick.${entry.id}`), kind: entry.kind, choices: entry.choiceKeys.map((key) => t(key)) })
  const addNew = () => {
    const problem = newColumnProblem({ name, kind, choices }, columns)
    setNameRefusal(problem)
    if (problem) return
    create({ name: name.trim(), kind, choices: kind === 'CHOICE' ? choicesOf(choices) : [] })
    setName('')
    setChoices('')
  }
  const toggle = (column: OwnColumn) => {
    const on = model.used.includes(column.id)
    if (on && switchOff(column.id, model.values) === 'ask') {
      setAsking(column.id)
      return
    }
    if (!on && full) return
    actions.onUse?.(on ? model.used.filter((id) => id !== column.id) : [...model.used, column.id], false)
  }
  const kindWords = (column: OwnColumn) => `${t(`own.kind.${column.kind}`)}${column.kind === 'CHOICE' && column.choices.length > 0 ? `: ${column.choices.join(' · ')}` : ''}`
  return (
    <div className="fw-ol-ownnew">
      {model.refused ? <Banner tone="danger" title={model.refused} /> : null}
      {model.columns === null ? (
        <p className="fw-ol-quiet">{t('own.reading')}</p>
      ) : shown.length > 0 ? (
        <section aria-labelledby="fw-ol-own-mine">
          <h3 id="fw-ol-own-mine" className="fw-ol-label">
            {t(portal ? 'own.mine' : 'own.mineOffice')}
          </h3>
          <ul className="fw-ol-ownlist">
            {shown.map((column) => {
              const on = model.used.includes(column.id)
              const Icon = KIND_ICON[column.kind]
              return (
                <li key={column.id} className="fw-ol-ownrow">
                  <Button size="sm" variant={on ? 'secondary' : 'quiet'} aria-pressed={on} heldReason={held ?? (!on && full ? t('own.full', { max: OWN_COLUMNS_MAX }) : null)} onClick={() => toggle(column)}>
                    {on ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />} {column.name}
                  </Button>
                  <span className="fw-ol-grow fw-ol-quiet">
                    <Icon size={12} aria-hidden /> {kindWords(column)}
                  </span>
                  {on ? (
                    <span className="fw-ol-quiet">{t('own.onThis')}</span>
                  ) : (
                    <Button size="sm" variant="quiet" aria-label={t('own.closeAria', { name: column.name })} heldReason={held} onClick={() => actions.onCloseColumn?.(column)}>
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  )}
                  {asking === column.id ? (
                    <div className="fw-ol-ask" role="alert">
                      <span>{t('own.ask', { name: column.name })}</span>
                      <Button size="sm" onClick={() => setAsking(null)}>
                        {t('own.askKeep')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        heldReason={held}
                        onClick={() => {
                          setAsking(null)
                          actions.onUse?.(model.used.filter((id) => id !== column.id), true)
                        }}
                      >
                        {t('own.askDrop')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
      {full ? (
        <p className="fw-ol-quiet">
          <Info size={14} aria-hidden /> {t('own.full', { max: OWN_COLUMNS_MAX })}
        </p>
      ) : (
        <>
          {quick.length > 0 ? (
            <section aria-labelledby="fw-ol-own-quick">
              <h3 id="fw-ol-own-quick" className="fw-ol-label">
                {t('own.quickTitle')}
              </h3>
              <div className="fw-ol-kinds">
                {quick.map((entry) => (
                  <Button key={entry.id} size="sm" variant="quiet" heldReason={held} onClick={() => addQuick(entry)}>
                    <Plus size={14} aria-hidden /> {t(`own.quick.${entry.id}`)}
                  </Button>
                ))}
              </div>
            </section>
          ) : null}
          <section aria-labelledby="fw-ol-own-new" className="fw-ol-ownnew">
            <h3 id="fw-ol-own-new" className="fw-ol-label">
              {t('own.newTitle')}
            </h3>
            <Field label={t('own.name')} error={nameRefusal ? t(nameRefusal) : undefined}>
              <Input
                value={name}
                maxLength={OWN_COLUMN_NAME_MAX}
                placeholder={t('own.namePh')}
                onChange={(event) => {
                  setName(event.target.value)
                  if (nameRefusal) setNameRefusal(null)
                }}
                onBlur={() => setNameRefusal(name.trim() === '' ? null : newColumnProblem({ name, kind, choices: kind === 'CHOICE' ? choices : 'a, b' }, columns))}
              />
            </Field>
            <div className="fw-ol-kinds" role="group" aria-label={t('own.kindAria')}>
              {OWN_KINDS.map((entry) => {
                const Icon = KIND_ICON[entry.kind]
                return (
                  <Button key={entry.kind} size="sm" variant={kind === entry.kind ? 'secondary' : 'quiet'} aria-pressed={kind === entry.kind} onClick={() => setKind(entry.kind)}>
                    <Icon size={14} aria-hidden /> {t(entry.key)}
                  </Button>
                )
              })}
            </div>
            {kind === 'CHOICE' ? (
              <Field label={t('own.choices')}>
                <Input value={choices} placeholder={t('own.choicesPh')} onChange={(event) => setChoices(event.target.value)} onBlur={() => setNameRefusal(name.trim() === '' ? null : newColumnProblem({ name, kind, choices }, columns))} />
              </Field>
            ) : null}
            <span>
              <Button size="sm" variant="primary" heldReason={held} onClick={addNew}>
                <Plus size={14} aria-hidden /> {t('own.add')}
              </Button>
            </span>
          </section>
        </>
      )}
      <p className="fw-ol-quiet">
        <Info size={14} aria-hidden /> {t(portal ? 'own.note' : 'own.noteOffice')}
      </p>
    </div>
  )
}
