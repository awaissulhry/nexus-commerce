'use client'

import { departmentIconOf } from '../icons'
import { departmentToneClass, type Department } from '../model'
import { useDepartmentWords } from '../words'
import '../department.css'

/**
 * owb-b4 w4.2 (design § 5zl: "a department chip: ONE name in every door, the short one; the long name is the hint"; § 9: the number dot
 * is new and lives in src/lib) — a department as one chip: its number in a dot, its icon, its ONE short name; the long name is the
 * hint (and is read after the short one when they differ). Its colour is its DS group tone; never colour alone: the number, the icon
 * and the name say it. An icon id the map does not know draws a plain dot. Not a control: it sizes with its text (`em`), so a floor
 * page's larger text makes a larger chip. It draws its department and nothing else.
 */
export function DeptChip({ dept }: { dept: Department }) {
  const t = useDepartmentWords()
  const Icon = departmentIconOf(dept.icon)
  const long = dept.name.trim() !== '' && dept.name !== dept.shortName
  return (
    <span className={`fw-dept-chip ${departmentToneClass(dept.tone)}`} title={long ? dept.name : undefined} data-dept={dept.no}>
      <span className="fw-dept-dot" aria-hidden>
        {dept.no}
      </span>
      <span className="nds-vh">{t('chip.number', { no: dept.no })}</span>
      {Icon ? <Icon className="fw-dept-icon" aria-hidden /> : <span className="fw-dept-plain" aria-hidden />}
      <span className="fw-dept-name">{dept.shortName}</span>
      {long ? <span className="nds-vh">{t('chip.long', { name: dept.name })}</span> : null}
    </span>
  )
}
