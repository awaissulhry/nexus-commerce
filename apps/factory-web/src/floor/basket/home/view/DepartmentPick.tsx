'use client'

import { ChevronDown, CircleAlert, MapPin, X } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import type { Department } from '../../../../lib/department/model'
import { DeptChip } from '../../../../lib/department/view/DeptChip'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { BASKET_NS } from '../../parts'
import '../../basket.css'

/**
 * owb-fl5 (lead settle 2; design § 5 Floor "the department's colour on top (tap to change it)") — the phone's "where am I": the
 * department in the top bar (its colour, number, icon and short name: the base's DeptChip); a tap opens the pick, a centred window
 * that is a sheet on a phone. One tap picks; a department with several stations at the site lists their names once; one with none
 * says so in words. Views only: the container sends `POST /floor/session/department`.
 */

export interface DepartmentPickModel {
  /** The session's department; null: none picked yet. */
  readonly current: Department | null
  readonly open: boolean
  /** The open departments of the factory (the server's: each has its id). */
  readonly departments: readonly Department[]
  /** After a pick with several stations: their names; null: no question. */
  readonly stations: readonly { readonly id: string; readonly name: string }[] | null
  readonly problem: 'noStation' | 'offline' | 'failed' | null
  readonly busy: boolean
}

export type DepartmentPickAction = { readonly type: 'pickOpen' } | { readonly type: 'pickClose' } | { readonly type: 'pick'; readonly departmentId: string } | { readonly type: 'station'; readonly stationId: string }

/** The top bar's button. */
export function DepartmentButton({ current, onPress }: { readonly current: Department | null; readonly onPress: () => void }) {
  const tb = useT(BASKET_NS)
  return (
    <FloorButton size="sm" variant="secondary" className="fw-bk-dept" aria-haspopup="dialog" aria-label={current ? tb('dept.button', { name: current.name }) : tb('dept.none')} onClick={onPress} icon={current ? undefined : <MapPin />}>
      {current ? <DeptChip dept={current} /> : tb('dept.none')}
      <ChevronDown aria-hidden="true" />
    </FloorButton>
  )
}

/** The pick window. */
export function DepartmentPickWindow({ model, onAction }: { readonly model: DepartmentPickModel; readonly onAction: (action: DepartmentPickAction) => void }) {
  const tb = useT(BASKET_NS)
  const picking = model.stations !== null && model.stations.length > 0
  return (
    <Modal open={model.open} onClose={() => onAction({ type: 'pickClose' })} title={tb('dept.title')} size="sm" sheet className="fw-floor-dialog">
      <div className="fw-floor-dialog-body">
        <p className="fw-floor-dialog-line fw-floor-muted">{picking ? tb('dept.chooseStation') : tb('dept.note')}</p>
        {picking ? (
          <div className="fw-bk-picks" role="group" aria-label={tb('dept.chooseStation')}>
            {model.stations!.map((station) => (
              <FloorButton key={station.id} size="md" variant="secondary" icon={<MapPin />} heldReason={model.busy ? tb('homePage.loading') : null} onClick={() => onAction({ type: 'station', stationId: station.id })}>
                {station.name}
              </FloorButton>
            ))}
          </div>
        ) : model.departments.length > 0 ? (
          <div className="fw-bk-picks" role="group" aria-label={tb('dept.title')}>
            {model.departments.map((dept) => (
              <FloorButton
                key={dept.id ?? dept.no}
                size="md"
                variant={model.current?.no === dept.no ? 'primary' : 'secondary'}
                aria-pressed={model.current?.no === dept.no}
                aria-label={dept.name}
                heldReason={model.busy ? tb('homePage.loading') : null}
                onClick={() => (dept.id ? onAction({ type: 'pick', departmentId: dept.id }) : undefined)}
              >
                <DeptChip dept={dept} />
              </FloorButton>
            ))}
          </div>
        ) : (
          <p className="fw-floor-dialog-line fw-floor-muted" aria-busy="true">
            {tb('homePage.loading')}
          </p>
        )}
        {model.problem ? (
          <p role="status" className="fw-floor-notice" data-tone={model.problem === 'noStation' ? 'warning' : 'danger'}>
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CircleAlert />
            </span>
            {tb(`dept.${model.problem}`)}
          </p>
        ) : null}
        <div className="fw-floor-dialog-actions">
          <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => onAction({ type: 'pickClose' })}>
            {tb('dept.close')}
          </FloorButton>
        </div>
      </div>
    </Modal>
  )
}
