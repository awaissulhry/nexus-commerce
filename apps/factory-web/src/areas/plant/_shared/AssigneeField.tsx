'use client'

import { Field } from '@nexus/ui/components'
import { Select } from '@nexus/ui/primitives'
import type { Technician } from './api'
import { useWords } from './parts'

/** Who the job is given to: me, an office technician, a floor technician (named only in this picker), or nobody. */
export function AssigneeField({ value, technicians, floorListed, problem, onChange, wide = false }: { value: string; technicians: readonly Technician[] | null; floorListed: boolean; problem: string | null; onChange: (value: string) => void; wide?: boolean }) {
  const t = useWords()
  const office = (technicians ?? []).filter((entry) => entry.kind === 'USER')
  const floor = (technicians ?? []).filter((entry) => entry.kind === 'WORKER')
  return (
    <Field label={t('field.assignee')} className={wide ? 'wide' : undefined} hint={problem ? t(problem) : technicians === null ? t('field.assigneeLoading') : !floorListed ? t('field.assigneeNoFloor') : t('field.assigneeHint')}>
      <Select value={value} disabled={technicians === null} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('person.nobody')}</option>
        {office.length > 0 && (
          <optgroup label={t('field.assigneeOffice')}>
            {office.map((entry) => (
              <option key={entry.id} value={`USER:${entry.id}`}>
                {entry.me ? t('field.assigneeMe', { name: entry.name }) : entry.name}
              </option>
            ))}
          </optgroup>
        )}
        {floor.length > 0 && (
          <optgroup label={t('field.assigneeFloor')}>
            {floor.map((entry) => (
              <option key={entry.id} value={`WORKER:${entry.id}`}>
                {entry.name}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    </Field>
  )
}
