'use client'

import type { CSSProperties, ReactNode } from 'react'
import { departmentIconOf } from '../icons'
import { departmentToneClass, stripColumnsOf, type Department } from '../model'
import { useDepartmentWords } from '../words'
import '../department.css'

/** One tile of the strip: a department of the order's routes, how many are there now, and (optional) their pictures. */
export interface DeptTile {
  readonly dept: Department
  readonly count: number
  /** Up to four small pictures of what is there (the host's RecordPictures); absent: none. */
  readonly pictures?: ReactNode
}

export interface DeptStripProps {
  readonly tiles: readonly DeptTile[]
  /** Which word set the counts say: the office and the floor count baskets, the customer counts pieces. */
  readonly kind: 'baskets' | 'pieces'
}

/**
 * owb-b4 w4.2 (design ui.js deptStrip; round 36 "3 + 3") — the departments of ONE order as tiles: the department's icon and short name
 * (its long name the hint), the count in big numbers with its word ("3 baskets", "1 piece"), and the host's pictures. A tile with
 * something in it takes its tone's wash; an empty one stays plain with its tone's edge. The room decides the rows (container queries,
 * never the window): two a row in a narrow room, rows of `stripColumnsOf` in a middle one, one row in a wide one. Nothing is a control.
 */
export function DeptStrip({ tiles, kind }: DeptStripProps) {
  const t = useDepartmentWords()
  const style = { '--fw-dept-n': tiles.length, '--fw-dept-cols': stripColumnsOf(tiles.length) } as CSSProperties
  return (
    <div className="fw-dept-strip-room">
      <ul className="fw-dept-strip" style={style} aria-label={t(`strip.label.${kind}`)}>
        {tiles.map(({ dept, count, pictures }, index) => {
          const Icon = departmentIconOf(dept.icon)
          return (
            <li key={`${index}:${dept.no}`} className={`fw-dept-tile ${departmentToneClass(dept.tone)}`} data-has={count > 0 || undefined}>
              <span className="fw-dept-tile-head" title={dept.name !== dept.shortName ? dept.name : undefined}>
                {Icon ? <Icon className="fw-dept-icon" aria-hidden /> : <span className="fw-dept-plain" aria-hidden />}
                <span className="fw-dept-tile-name">{dept.shortName}</span>
                <span className="nds-vh">{t('chip.number', { no: dept.no })}</span>
              </span>
              <span className="fw-dept-tile-count">
                {count}
                <small>{t(`strip.${kind}`, { count })}</small>
              </span>
              <span className="fw-dept-tile-pics">{pictures ?? (count === 0 ? <span className="fw-dept-tile-none">{t('strip.none')}</span> : null)}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
