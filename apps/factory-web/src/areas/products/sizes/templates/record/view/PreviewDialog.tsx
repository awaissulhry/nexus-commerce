'use client'

import { useState } from 'react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { basicProblem, basicsOf, formPoints, pointProblem, type Phrase as MtmPhrase } from '../../../../../sales/mtm/model'
import { MeasurementForm } from '../../../../../sales/mtm/view/MeasurementForm'
import type { TemplateView } from '../../api'
import { useWords } from '../../parts'

/**
 * "Preview as the MeasurementForm a fitter will see" (design template.points): Sales › Made-to-measure's own office form over
 * this template's ACTIVE points, typed values kept in this pop-up only (nothing is saved): the points in measuring order by
 * body zone, how to measure each, the plausible range asked again in words. The template's rules are not checked here (they
 * need the API); the form says so. Esc closes. Fetches nothing.
 */
export function PreviewDialog({ template, initial, onClose }: { template: TemplateView; initial?: { values: Record<string, string>; confirmed: string[] } | null; onClose: () => void }) {
  const { t } = useWords()
  const [values, setValues] = useState<Record<string, string>>(initial?.values ?? {})
  const [confirmed, setConfirmed] = useState<string[]>(initial?.confirmed ?? [])
  const points = formPoints(template.points)
  const basics = basicsOf(points)
  const problems: Record<string, MtmPhrase> = {}
  for (const point of points) {
    if (!(values[point.code] ?? '').trim()) continue
    const problem = pointProblem(point, { values, confirmed })
    if (problem) problems[point.code] = problem
  }
  for (const code of basics) {
    const problem = basicProblem(values[code])
    if (problem) problems[code] = problem
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('preview.title', { code: template.code })}
      subtitle={t('preview.subtitle')}
      size="xl"
      footer={
        <>
          <Button onClick={() => (setValues({}), setConfirmed([]))}>{t('preview.clear')}</Button>
          <Button variant="primary" onClick={onClose}>
            {t('preview.close')}
          </Button>
        </>
      }
    >
      <MeasurementForm
        model={{ points, values, confirmed, problems, flags: [], basics, preview: true, rulesOff: !template.rulesOn }}
        actions={{
          onValue: (code, value) => setValues((now) => ({ ...now, [code]: value })),
          onConfirm: (code, checked) => setConfirmed((now) => (checked ? [...new Set([...now, code])] : now.filter((entry) => entry !== code))),
        }}
      />
    </Modal>
  )
}
