'use client'

import { Lock, LockOpen, Plus, SlidersHorizontal } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Input, Tag, Toggle, ToolbarButton } from '@nexus/ui/primitives'
import { departmentToneClass } from '../../../../../../lib/department/model'
import { DeptChip } from '../../../../../../lib/department/view/DeptChip'
import { useT } from '../../../../../../lib/i18n/provider'
import type { Words } from '../../route/model'
import { DEPARTMENT_NAME_MAX, type ManageRow } from '../manage'
import '../../../../../../lib/department/department.css'
import '../builder.css'

/**
 * owb-pd6 step 6.3 (S4; design plan § 5x; prototype prod.js routeBuilder's `pal` with Manage ON) — the departments list with Manage ON,
 * inside the route builder (no new page, no new window): a name field + Add (the new row is marked "new" and goes into the route at
 * once with its +), a rename in the row (Enter or leaving the field saves it; every route shows the new name), the lock closes a
 * department (it leaves the list, the routes keep it) or opens it again. A floor department keeps its name and has no lock ("on the
 * floor"). A refusal is said in words under the list. Draws its model; fetches nothing (../RouteBuilderWindow.tsx).
 */

export interface ManageViewModel {
  readonly rows: readonly ManageRow[]
  /** What is typed in a row's name field, by department id (absent: its name as it is). */
  readonly drafts: Readonly<Record<string, string>>
  readonly newName: string
  /** Why Add is held (no name yet, the same name, a write running). */
  readonly addHeld: Words | null
  readonly busy: boolean
  readonly problem: Words | null
  /** What the last act did ("Cutting is closed. …"), read out politely. */
  readonly done: Words | null
}

export interface ManageViewActions {
  readonly onDraft: (departmentId: string, text: string) => void
  readonly onRename: (departmentId: string) => void
  readonly onLock: (departmentId: string, open: boolean) => void
  readonly onNewName: (text: string) => void
  readonly onAddDepartment: () => void
  readonly onAddToRoute: (departmentId: string) => void
}

/** The small switch beside "Departments" (production.departments.manage only). */
export function ManageSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useT('products-route')
  return (
    <label className="fw-rb-manage">
      <SlidersHorizontal size={14} aria-hidden />
      <span>{t('manage.switch')}</span>
      <Toggle size="sm" checked={on} onChange={onChange} />
    </label>
  )
}

export function ManageDepartments({ model, actions }: { model: ManageViewModel; actions: ManageViewActions }) {
  const t = useT('products-route')
  const say = (words: Words) => t(words.key, words.params)
  return (
    <div className="fw-rb-col">
      <p className="fw-rb-hint">{t('manage.hint')}</p>
      <ul className="fw-rb-list" aria-label={t('manage.listLabel')}>
        {model.rows.map((row) => (
          <li key={row.id} className="fw-rb-dept fw-rb-mrow" data-closed={row.closed || undefined}>
            {row.rename ? (
              <>
                <span className={`fw-rb-mdot ${departmentToneClass(row.dept.tone)}`} aria-hidden>
                  {row.dept.no}
                </span>
                <Input
                  size="sm"
                  fieldClassName="fw-rb-mname"
                  value={model.drafts[row.id] ?? row.dept.shortName}
                  maxLength={DEPARTMENT_NAME_MAX}
                  disabled={model.busy}
                  aria-label={t('manage.nameOf', { name: row.dept.shortName })}
                  onChange={(event) => actions.onDraft(row.id, event.target.value)}
                  onBlur={() => actions.onRename(row.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      actions.onRename(row.id)
                    }
                  }}
                />
              </>
            ) : (
              <DeptChip dept={row.dept} />
            )}
            {row.floorReady && <Tag tone="neutral">{t('manage.onFloor')}</Tag>}
            {row.closed && <Tag tone="warning">{t('manage.closed')}</Tag>}
            {row.fresh && <Tag tone="info">{t('builder.new')}</Tag>}
            <span className="fw-rb-grow" />
            {row.lock && (
              <ToolbarButton
                icon={row.closed ? <LockOpen size={16} /> : <Lock size={16} />}
                label={row.closed ? t('manage.openOf', { name: row.dept.shortName }) : t('manage.closeOf', { name: row.dept.shortName })}
                description={row.closed ? t('manage.openHint') : t('manage.closeHint')}
                active={row.closed}
                disabled={model.busy}
                onClick={() => actions.onLock(row.id, row.closed)}
              />
            )}
            {row.add && <ToolbarButton icon={<Plus size={16} />} label={t('builder.addOf', { name: row.dept.shortName })} onClick={() => actions.onAddToRoute(row.id)} />}
          </li>
        ))}
        <li className="fw-rb-dept fw-rb-mnew">
          <Input
            size="sm"
            fieldClassName="fw-rb-mname"
            value={model.newName}
            maxLength={DEPARTMENT_NAME_MAX}
            placeholder={t('manage.newPlaceholder')}
            aria-label={t('manage.newLabel')}
            onChange={(event) => actions.onNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                actions.onAddDepartment()
              }
            }}
          />
          <Button size="sm" heldReason={model.addHeld ? say(model.addHeld) : null} onClick={actions.onAddDepartment}>
            <Plus size={13} aria-hidden /> {t('manage.add')}
          </Button>
        </li>
      </ul>
      <div aria-live="polite" className="fw-rb-notes">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        {model.done && <p className="fw-rb-note">{say(model.done)}</p>}
      </div>
    </div>
  )
}
