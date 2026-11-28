'use client'

import type { ReactNode } from 'react'
import { RecordPicture } from '../../record-picture/view/RecordPicture'
import { fixedDepartments, type Department } from '../model'
import { useDepartmentWords } from '../words'
import { DeptBar } from './DeptBar'
import { DeptChip } from './DeptChip'
import { DeptStrip } from './DeptStrip'

/**
 * owb-b4 w4.2 — the lab of the department parts (`/design/department-parts`): every chip of the fixed table (the page's language), a
 * department with an icon the parts do not know (a plain dot), the route bar in its three moments and the strip in its two word sets.
 * The departments are the fixed table's (`fixedDepartments`: nothing is read). Made-up data only.
 */

export interface DepartmentLabModel {
  readonly show: 'chips' | 'bar' | 'strip' | 'strip-pieces' | 'strip-nine'
}

/** A department made later with an icon the map does not know: drawn with a plain dot. */
const UNKNOWN: Department = { no: 12, tone: 'red', icon: 'hand-stitch', name: 'Hand embroidery', shortName: 'Embroidery', id: null }

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} style={{ display: 'grid', gap: 'var(--nds-space-8)', padding: 'var(--nds-space-16)' }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {children}
    </section>
  )
}

const pictures = (count: number): ReactNode =>
  count > 0 ? Array.from({ length: Math.min(count, 4) }, (_, index) => <RecordPicture key={index} source="order" recordId={`demo-${index}`} number="Your order 12" picture={null} size="cell" />) : undefined

export function DepartmentLab({ model }: { model: DepartmentLabModel }) {
  const departments = fixedDepartments(useDepartmentWords())
  const six = departments.slice(0, 6)
  if (model.show === 'chips')
    return (
      <Box title="chips">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-8)' }}>
          {departments.map((dept) => (
            <DeptChip key={dept.no} dept={dept} />
          ))}
          <DeptChip dept={UNKNOWN} />
        </div>
      </Box>
    )
  if (model.show === 'bar')
    return (
      <>
        <Box title="not started">
          <DeptBar route={six} current={null} />
        </Box>
        <Box title="at step 4">
          <DeptBar route={six} current={3} />
        </Box>
        <Box title="every step done">
          <DeptBar route={six} current={six.length} />
        </Box>
        <Box title="a short route (design, molding, quality, packing)">
          <DeptBar route={[departments[6]!, departments[7]!, departments[4]!, departments[5]!]} current={1} />
        </Box>
      </>
    )
  const counts = [0, 3, 2, 5, 1, 0, 2, 0, 1]
  const tiles = (list: readonly Department[]) => list.map((dept, index) => ({ dept, count: counts[index] ?? 0, pictures: pictures(counts[index] ?? 0) }))
  if (model.show === 'strip-pieces')
    return (
      <Box title="pieces (the customer)">
        <DeptStrip tiles={tiles(six).map((tile) => ({ ...tile, count: tile.count * 4 }))} kind="pieces" />
      </Box>
    )
  if (model.show === 'strip-nine')
    return (
      <Box title="nine departments">
        <DeptStrip tiles={tiles(departments)} kind="baskets" />
      </Box>
    )
  return (
    <Box title="baskets (the office, the floor)">
      <DeptStrip tiles={tiles(six)} kind="baskets" />
    </Box>
  )
}
