'use client'

import { Check, Minus } from 'lucide-react'
import { Disclosure, SummaryTable } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'

export interface MatrixPermission {
  name: string
  area: string
  risk: 'read' | 'write' | 'stepUp'
  /** The catalogue's own sentence (English): shown only when this web has no words of its own for the permission. */
  description: string
}

export interface MatrixColumn {
  id: string
  name: string
  permissions: readonly string[]
}

/** The message key of a permission's words (`perm.inventory_issue_over`). */
export const permissionKey = (name: string) => `perm.${name.replace(/\./g, '_')}`

/** The areas in the catalogue's order, each with its permissions. */
export function byArea(permissions: readonly MatrixPermission[]): Array<{ area: string; permissions: MatrixPermission[] }> {
  const out: Array<{ area: string; permissions: MatrixPermission[] }> = []
  for (const permission of permissions) {
    const group = out.find((item) => item.area === permission.area)
    if (group) group.permissions.push(permission)
    else out.push({ area: permission.area, permissions: [permission] })
  }
  return out
}

/**
 * PermissionMatrix — the design's new DS part (02 "New DS parts": areas × actions in words with risk marks; read-only
 * for ready-made roles; differences marked), built here from DS Disclosure, SummaryTable and Tag until the DS adds it
 * (DS gap). One column is one role's permissions; two or three compare roles, and a row where they differ says so.
 */
export function PermissionMatrix({ permissions, columns, onlyHeld = false, openAreas }: { permissions: readonly MatrixPermission[]; columns: readonly MatrixColumn[]; onlyHeld?: boolean; openAreas?: boolean }) {
  const t = useT('admin')
  const words = (permission: MatrixPermission) => {
    const key = permissionKey(permission.name)
    const text = t(key)
    return text === key ? permission.description : text
  }
  const held = columns.map((column) => new Set(column.permissions))
  const groups = byArea(permissions)
    .map((group) => ({ ...group, permissions: onlyHeld ? group.permissions.filter((permission) => held.some((set) => set.has(permission.name))) : group.permissions }))
    .filter((group) => group.permissions.length > 0)
  const compare = columns.length > 1

  return (
    <div className="fw-adm-matrix">
      {groups.map((group) => {
        const counts = held.map((set) => group.permissions.filter((permission) => set.has(permission.name)).length)
        const areaKey = `area.${group.area}`
        const areaName = t(areaKey) === areaKey ? group.area : t(areaKey)
        return (
          <Disclosure
            key={group.area}
            open={openAreas ?? counts.some((count) => count > 0)}
            summary={
              <span className="fw-adm-matrix-summary">
                <span className="fw-adm-matrix-area">{areaName}</span>
                <span className="fw-adm-hint">
                  {compare
                    ? columns.map((column, index) => t('matrix.countOf', { name: column.name, count: counts[index], total: group.permissions.length })).join(' · ')
                    : t('matrix.count', { count: counts[0], total: group.permissions.length })}
                </span>
              </span>
            }
          >
            <SummaryTable
              label={t('matrix.tableLabel', { area: areaName })}
              columns={[t('matrix.permission'), ...columns.map((column) => column.name)]}
              widths={[compare ? '52%' : '78%']}
              stackOnPhone
              rows={group.permissions.map((permission) => {
                const ticks = held.map((set) => set.has(permission.name))
                const differs = compare && ticks.some((tick) => tick !== ticks[0])
                return {
                  id: permission.name,
                  cells: [
                    <span key="name" className="fw-adm-matrix-row">
                      <span>{words(permission)}</span>
                      <span className="fw-adm-matrix-marks">
                        {permission.risk === 'stepUp' && <Tag tone="warning">{t('matrix.risk.stepUp')}</Tag>}
                        {differs && <Tag tone="info">{t('matrix.differs')}</Tag>}
                      </span>
                    </span>,
                    ...ticks.map((tick, index) => (
                      <span key={columns[index]?.id ?? index} className={tick ? 'fw-adm-tick is-on' : 'fw-adm-tick'}>
                        {tick ? <Check size={14} aria-hidden /> : <Minus size={14} aria-hidden />}
                        <span className="fw-adm-sr">{t(tick ? 'matrix.yes' : 'matrix.no')}</span>
                      </span>
                    )),
                  ],
                }
              })}
            />
          </Disclosure>
        )
      })}
    </div>
  )
}
