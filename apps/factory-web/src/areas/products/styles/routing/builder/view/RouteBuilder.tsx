'use client'

import { useId, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { GripVertical, Info, Plus, RotateCcw, X } from 'lucide-react'
import { Banner, DetailPopover, Disclosure, Field } from '@nexus/ui/components'
import { Button, FilterChip, Input, Select, Tag, ToolbarButton } from '@nexus/ui/primitives'
import { DeptChip } from '../../../../../../lib/department/view/DeptChip'
import { OrderedList, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WindowShell } from '../../../../../../lib/window-shell/view/WindowShell'
import type { RouteTemplate } from '../api'
import { NAME_MAX, REASON_MAX, TEMPLATE_NAME_MAX, type BuilderMode, type CopyOption, type PaletteRow, type StepRow } from '../model'
import { minutesWords, type Words } from '../../route/model'
import type { RouteParty } from '../../route/api'
import '../builder.css'

/**
 * owb-pd6 step 6.2 (S4; design plan § 5w; prototype prod.js routeBuilder) — THE route builder, ONE centred window (a sheet on a phone,
 * the foot fixed: lib/window-shell): left the factory's departments (drag one into the route, or press its +; a small count says how
 * often it is in the route), right the route (free order: drag a step, its ↑ / ↓, or Alt+↑ / Alt+↓ on its row — the focus stays on the
 * moved row; minutes per step; take a step out; a department may be there twice), under them "Start from a copy", the route's name and
 * who it is for (a new route), why this order is different (one line), "Save as ready-made…". The rules show live (two steps or more,
 * the last step is Packing — they hold Save with words; no quality check is a note). Measured: every step row one height, every
 * department row one height, the step buttons end on one line. Phone: one column, the route first. Key hints in ONE ⓘ.
 * Draws its model; fetches nothing (../RouteBuilderWindow.tsx). Words: `products-route`.
 */

/** A department dragged from the list carries its id under this type (a drop on the route adds it there). */
export const DEPARTMENT_DRAG = 'application/x-fw-department'

export interface BuilderViewModel {
  readonly mode: BuilderMode
  /** The product (or the order line) and which route. */
  readonly subtitle: string
  readonly palette: readonly PaletteRow[]
  readonly steps: readonly StepRow[]
  readonly total: string | null
  readonly errors: readonly Words[]
  readonly notes: readonly Words[]
  readonly copy: { readonly state: 'reading' | 'ready' | 'failed'; readonly templates: readonly CopyOption[]; readonly products: readonly CopyOption[]; readonly query: string }
  /** A model or customer route (new or edited): its name and who it is for; null: another mode. */
  readonly route: {
    readonly name: string
    readonly forWhom: 'MODEL' | 'CUSTOMER'
    readonly partyId: string | null
    /** The product is made for one customer: only that one may be named. */
    readonly fixedParty: RouteParty | null
    readonly customers: { readonly state: 'idle' | 'reading' | 'ready' | 'failed'; readonly list: readonly RouteParty[] }
  } | null
  /** One order line's exception: why; null: another mode. */
  readonly line: { readonly reason: string } | null
  /** "Save as ready-made…" and the ready-made routes (not for one order line). */
  readonly template: {
    readonly name: string
    readonly held: Words | null
    readonly open: readonly RouteTemplate[]
    readonly closed: readonly RouteTemplate[]
    readonly busy: boolean
    readonly problem: Words | null
    /** The name of the ready-made route just saved. */
    readonly done: string | null
  } | null
  readonly save: { readonly held: Words | null; readonly busy: boolean; readonly problem: Words | null }
}

export interface BuilderViewActions {
  readonly onAdd: (departmentId: string) => void
  readonly onDrop: (departmentId: string, at: number | 'end') => void
  readonly onReorder: (keys: string[]) => void
  readonly onMove: (from: number, to: number) => void
  readonly onRemove: (index: number) => void
  readonly onMinutes: (index: number, text: string) => void
  readonly onCopy: (value: string) => void
  readonly onQuery: (text: string) => void
  readonly onName: (text: string) => void
  readonly onForWhom: (forWhom: 'MODEL' | 'CUSTOMER') => void
  readonly onParty: (partyId: string | null) => void
  readonly onReason: (text: string) => void
  readonly onTemplateName: (text: string) => void
  readonly onSaveTemplate: () => void
  readonly onTemplateOpen: (templateId: string, open: boolean) => void
  readonly onSave: () => void
  readonly onClose: () => void
}

export interface RouteBuilderProps {
  readonly model: BuilderViewModel
  readonly actions: BuilderViewActions
  /** The departments list's head: the Manage switch (step 6.3), drawn by the window only for the production manager. */
  readonly manageSwitch?: ReactNode
  /** The departments list in Manage (step 6.3); absent: the list to add from. */
  readonly manageList?: ReactNode
}

export function RouteBuilder({ model, actions, manageSwitch, manageList }: RouteBuilderProps) {
  const t = useT('products-route')
  const say = (words: Words) => t(words.key, words.params)
  return (
    <WindowShell
      open
      onClose={actions.onClose}
      size="xl"
      title={t(`builder.title.${model.mode}`)}
      subtitle={model.subtitle}
      act={{ words: t(`builder.save.${model.mode}`), onAct: actions.onSave, held: model.save.held ? say(model.save.held) : null, busy: model.save.busy }}
    >
      <RouteBuilderBody model={model} actions={actions} manageSwitch={manageSwitch} manageList={manageList} />
    </WindowShell>
  )
}

/** The window's body (the shell draws its name and its foot): drawn alone by the tests, which have no browser for the dialog. */
export function RouteBuilderBody({ model, actions, manageSwitch, manageList }: RouteBuilderProps) {
  const t = useT('products-route')
  const locale = useLocale()
  const say = (words: Words) => t(words.key, words.params)
  const keys = model.steps.map((step) => step.key)
  const copyId = useId()
  const templateId = useId()

  const dropAt = (event: DragEvent<HTMLElement>, at: number | 'end') => {
    const id = event.dataTransfer.getData(DEPARTMENT_DRAG)
    if (!id) return
    event.preventDefault()
    event.stopPropagation()
    actions.onDrop(id, at)
  }
  const overRoute = (event: DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer.types).includes(DEPARTMENT_DRAG)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }
  /** A drop on the route: before the first row whose middle is below the pointer, else at the end. */
  const dropOnRoute = (event: DragEvent<HTMLElement>) => {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-nds-reorder-item]'))
    const index = rows.findIndex((row) => {
      const box = row.getBoundingClientRect()
      return event.clientY < box.top + box.height / 2
    })
    dropAt(event, index < 0 ? 'end' : index)
  }
  /** Alt+↑ / Alt+↓ anywhere on a step's row moves it (its field, its buttons); the focus stays where it is. */
  const moveByKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    const key = (event.target as HTMLElement).closest('[data-nds-reorder-item]')?.querySelector('[data-rb-key]')?.getAttribute('data-rb-key')
    const from = model.steps.findIndex((step) => step.key === key)
    if (from < 0) return
    event.preventDefault()
    actions.onMove(from, from + (event.key === 'ArrowUp' ? -1 : 1))
  }

  const stepName = (step: StepRow) => (step.dept ? step.dept.shortName : t('routes.noDepartment'))

  return (
    <div className="fw-rb">
      {/* ---- left: the departments ---- */}
      <section className="fw-rb-col fw-rb-depts" aria-labelledby="fw-rb-depts-h">
        <div className="fw-rb-head">
          <h3 className="fw-rb-h" id="fw-rb-depts-h">
            {t('builder.departments')}
          </h3>
          <span className="fw-rb-count">{model.palette.length}</span>
          <span className="fw-rb-grow" />
          {manageSwitch}
        </div>
        {manageList ?? (
          <>
            <p className="fw-rb-hint">{t('builder.departmentsHint')}</p>
            {model.palette.length === 0 ? (
              <p className="fw-rb-hint">{t('builder.noDepartments')}</p>
            ) : (
              <ul className="fw-rb-list" aria-label={t('builder.departments')}>
                {model.palette.map((row) => (
                  <li
                    key={row.id}
                    className="fw-rb-dept"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(DEPARTMENT_DRAG, row.id)
                      event.dataTransfer.setData('text/plain', row.dept.shortName)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                  >
                    <GripVertical size={14} className="fw-rb-grip" aria-hidden />
                    <DeptChip dept={row.dept} />
                    {row.fresh && <Tag tone="info">{t('builder.new')}</Tag>}
                    <span className="fw-rb-grow" />
                    {row.count > 0 && <span className="fw-rb-times">{t('builder.times', { count: row.count })}</span>}
                    <ToolbarButton icon={<Plus size={16} />} label={t('builder.addOf', { name: row.dept.shortName })} onClick={() => actions.onAdd(row.id)} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* ---- right: the route ---- */}
      <section className="fw-rb-col fw-rb-route" aria-labelledby="fw-rb-route-h">
        <div className="fw-rb-head">
          <h3 className="fw-rb-h" id="fw-rb-route-h">
            {t('builder.route')}
          </h3>
          <span className="fw-rb-count">{model.steps.length}</span>
          <span className="fw-rb-grow" />
          <span className="fw-rb-total">{model.total === null ? t('routes.noMinutes') : t('routes.total', { minutes: minutesWords(model.total, locale) })}</span>
          <DetailPopover trigger={<Info size={16} aria-hidden />} triggerLabel={t('builder.keysLabel')} triggerClassName="nds-btn icon" label={t('builder.keysLabel')} hoverDelay={0}>
            <ul className="fw-rb-keys">
              <li>{t('builder.keys.add')}</li>
              <li>{t('builder.keys.move')}</li>
              <li>{t('builder.keys.save')}</li>
            </ul>
          </DetailPopover>
        </div>
        <p className="fw-rb-hint">{t('builder.routeHint')}</p>
        <div className="fw-rb-drop" onDragOver={overRoute} onDrop={dropOnRoute} onKeyDown={moveByKeys}>
          {model.steps.length > 0 && (
            <OrderedList
              label={t('builder.route')}
              items={keys}
              onChange={actions.onReorder}
              liveDrag
              itemLabel={(key) => {
                const step = model.steps.find((entry) => entry.key === key)
                return step ? t('builder.stepOf', { no: step.no, name: stepName(step) }) : key
              }}
              renderItem={(key) => {
                const index = model.steps.findIndex((entry) => entry.key === key)
                const step = model.steps[index]
                if (!step) return null
                return (
                  <span className="fw-rb-step" data-rb-key={step.key}>
                    <span className="fw-rb-no">{step.no}</span>
                    {step.dept ? <DeptChip dept={step.dept} /> : <span className="fw-rb-old">{t('routes.noDepartment')}</span>}
                    <span className="fw-rb-grow" />
                    <Input
                      size="sm"
                      fieldClassName="fw-rb-min"
                      inputMode="decimal"
                      value={step.minutes}
                      aria-label={t('builder.minutesOf', { no: step.no, name: stepName(step) })}
                      aria-invalid={step.minutesBad || undefined}
                      onChange={(event) => actions.onMinutes(index, event.target.value)}
                      suffix={t('builder.min')}
                    />
                    <ToolbarButton icon={<X size={16} />} label={t('builder.removeOf', { no: step.no, name: stepName(step) })} onClick={() => actions.onRemove(index)} />
                  </span>
                )
              }}
            />
          )}
          <div className="fw-rb-end" onDragOver={overRoute} onDrop={(event) => dropAt(event, 'end')}>
            {model.steps.length > 0 ? t('builder.dropEnd') : t('builder.empty')}
          </div>
        </div>
        <div className="fw-rb-notes" aria-live="polite">
          {model.save.problem && <Banner tone="danger" title={say(model.save.problem)} />}
          {model.errors.length > 0 && (
            <Banner tone="warning" title={t('builder.errorsTitle', { count: model.errors.length })}>
              <ul className="fw-rb-issues">
                {model.errors.map((words, index) => (
                  <li key={`${words.key}:${index}`}>{say(words)}</li>
                ))}
              </ul>
            </Banner>
          )}
          {model.notes.map((words) => (
            <p key={words.key} className="fw-rb-note">
              <Info size={14} aria-hidden /> {say(words)}
            </p>
          ))}
        </div>
      </section>

      {/* ---- under them: a copy, the route's name or the line's reason, ready-made routes ---- */}
      <div className="fw-rb-more">
        <Field label={t('builder.copy.label')} htmlFor={copyId} hint={model.copy.state === 'failed' ? t('builder.copy.failed') : model.copy.state === 'reading' ? t('builder.copy.reading') : undefined}>
          <span className="fw-rb-copy">
            <Select id={copyId} value="" onChange={(event) => event.target.value && actions.onCopy(event.target.value)}>
              <option value="">{t('builder.copy.choose')}</option>
              {model.copy.templates.length > 0 && (
                <optgroup label={t('builder.copy.templates')}>
                  {model.copy.templates.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t('builder.copy.option', { name: option.name, count: option.steps })}
                    </option>
                  ))}
                </optgroup>
              )}
              {model.copy.products.length > 0 && (
                <optgroup label={t('builder.copy.products')}>
                  {model.copy.products.map((option) => (
                    <option key={option.value} value={option.value}>
                      {t('builder.copy.option', { name: option.name, count: option.steps })}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
            <Input type="search" value={model.copy.query} placeholder={t('builder.copy.find')} aria-label={t('builder.copy.find')} onChange={(event) => actions.onQuery(event.target.value)} />
          </span>
        </Field>

        {model.route && (
          <>
            <Field label={t('builder.name')} required>
              <Input value={model.route.name} maxLength={NAME_MAX} placeholder={t('builder.namePlaceholder')} onChange={(event) => actions.onName(event.target.value)} />
            </Field>
            <div className="fw-rb-for" role="group" aria-label={t('builder.forWhom')}>
              <span className="fw-rb-label">{t('builder.forWhom')}</span>
              <span className="fw-rb-chips">
                <FilterChip size="md" pressed={model.route.forWhom === 'MODEL'} onClick={() => actions.onForWhom('MODEL')}>
                  {t('builder.forModel')}
                </FilterChip>
                <FilterChip size="md" pressed={model.route.forWhom === 'CUSTOMER'} onClick={() => actions.onForWhom('CUSTOMER')}>
                  {model.route.fixedParty ? t('builder.forOnly', { customer: `${model.route.fixedParty.code} · ${model.route.fixedParty.name}` }) : t('builder.forCustomer')}
                </FilterChip>
              </span>
              {model.route.forWhom === 'CUSTOMER' && !model.route.fixedParty && (
                <Field label={t('builder.customer')} hint={model.route.customers.state === 'failed' ? t('builder.customersFailed') : model.route.customers.state === 'reading' ? t('builder.customersReading') : undefined}>
                  <Select value={model.route.partyId ?? ''} onChange={(event) => actions.onParty(event.target.value || null)}>
                    <option value="">{t('builder.customerPick')}</option>
                    {model.route.customers.list.map((party) => (
                      <option key={party.id} value={party.id}>
                        {party.code} · {party.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
          </>
        )}

        {model.line && (
          <Field label={t('builder.reason')} required hint={t('builder.reasonHint')}>
            <Textarea value={model.line.reason} rows={2} maxLength={REASON_MAX} placeholder={t('builder.reasonPlaceholder')} onChange={(event) => actions.onReason(event.target.value)} />
          </Field>
        )}

        {model.template && (
          <div className="fw-rb-tpl">
            <Field label={t('builder.template.label')} htmlFor={templateId}>
              <span className="fw-rb-copy">
                <Input id={templateId} value={model.template.name} maxLength={TEMPLATE_NAME_MAX} placeholder={t('builder.template.placeholder')} onChange={(event) => actions.onTemplateName(event.target.value)} />
                <Button size="sm" heldReason={model.template.held ? say(model.template.held) : null} onClick={actions.onSaveTemplate}>
                  <Plus size={13} aria-hidden /> {t('builder.template.save')}
                </Button>
              </span>
            </Field>
            {model.template.done && <p className="fw-rb-note">{t('builder.template.done', { name: model.template.done })}</p>}
            {model.template.problem && <Banner tone="danger" title={say(model.template.problem)} />}
            {model.template.open.length + model.template.closed.length > 0 && (
              <Disclosure summary={t('builder.template.list', { count: model.template.open.length })}>
                <ul className="fw-rb-tpls">
                  {model.template.open.map((entry) => (
                    <li key={entry.id} className="fw-rb-tplrow">
                      <span className="fw-rb-tplname">{entry.name}</span>
                      <span className="fw-rb-times">{t('builder.copy.steps', { count: entry.steps.length })}</span>
                      <span className="fw-rb-grow" />
                      <ToolbarButton icon={<X size={16} />} label={t('builder.template.takeOut', { name: entry.name })} disabled={model.template?.busy} onClick={() => actions.onTemplateOpen(entry.id, false)} />
                    </li>
                  ))}
                </ul>
                {model.template.closed.length > 0 && (
                  <>
                    <p className="fw-rb-label">{t('builder.template.closed')}</p>
                    <ul className="fw-rb-tpls">
                      {model.template.closed.map((entry) => (
                        <li key={entry.id} className="fw-rb-tplrow">
                          <span className="fw-rb-tplname">{entry.name}</span>
                          <span className="fw-rb-times">{t('builder.copy.steps', { count: entry.steps.length })}</span>
                          <span className="fw-rb-grow" />
                          <Button size="sm" variant="quiet" heldReason={model.template?.busy ? t('held.busy') : null} onClick={() => actions.onTemplateOpen(entry.id, true)}>
                            <RotateCcw size={13} aria-hidden /> {t('builder.template.openAgain')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Disclosure>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
