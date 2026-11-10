'use client'

import { CloudOff, MapPin, Ruler, Settings2, Shirt, Tag } from 'lucide-react'
import { SummaryTable } from '@nexus/ui/components'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { FloorFacts } from '../../../frame/view/FloorFacts'
import { TaskLine } from '../../shared/view/TaskParts'
import type { FloorInstruction, FloorSpec } from '../api'
import { decimalWords, materialName, measureText, settingRows } from '../model'

/**
 * floor.instructions sec:spec-pages "Spec for this size" (PRD-258): the work order's frozen spec for the bundle in hand — the
 * revision it was released on, colourway, size and label; the size's measures as a big table; the materials of its cell per
 * garment (never a cost); the machine settings of this operation; the routing with "you are here". The full spec pages (a PDF
 * with label positions) are the tech pack's, an office document: the tablet says so (no floor route serves them yet).
 */
export function SpecPages({ spec, settings, asOf, problem, locale, timeZone, t }: { spec: FloorSpec | null; settings: FloorInstruction['settings']; asOf: string | null; problem: 'offline' | 'unavailable' | null; locale: Locale; timeZone?: string; t: Translate }) {
  const day = (value: string | null) => (value ? formatDate(value, { locale, timeZone }) : '—')
  if (!spec) {
    return (
      <TaskLine tone="warning" icon={<CloudOff />}>
        {t(problem === 'offline' ? 'spec.notKept' : 'spec.failed')}
      </TaskLine>
    )
  }
  // Floor-size facts (the DS KeyValue keeps the console's size): a value and, where it helps, its second line.
  const facts = [
    { label: t('spec.fact.workOrder'), value: spec.workOrder.batchNumber ? `${spec.workOrder.number} · ${spec.workOrder.batchNumber}` : spec.workOrder.number },
    { label: t('spec.fact.style'), value: spec.style ? `${spec.style.code} · ${spec.style.name}` : '—' },
    { label: t('spec.fact.revision'), value: spec.revision ? <Two main={t('spec.revision', { n: spec.revision.revision })} sub={t('spec.frozen', { date: day(spec.workOrder.releasedAt) })} /> : t('spec.noRevision') },
    { label: t('spec.fact.colourway'), value: spec.colourway ? `${spec.colourway.code} · ${spec.colourway.name}` : '—' },
    { label: t('spec.fact.size'), value: spec.size.label ? `${spec.size.code} · ${spec.size.label}` : spec.size.code },
    { label: t('spec.fact.bundle'), value: <Two main={spec.bundle.part ? `${spec.bundle.code} · ${spec.bundle.part}` : spec.bundle.code} sub={t('spec.pieces', { count: spec.bundle.quantity })} /> },
    { label: t('spec.fact.label'), value: spec.label ? <Two main={t('spec.labelValue', { code: spec.label.code, n: spec.label.revision })} sub={spec.label.languages.length > 0 ? spec.label.languages.join(' · ').toUpperCase() : null} /> : t('spec.noLabel') },
    ...(spec.style && spec.style.ppeCategory !== 'NONE' ? [{ label: t('spec.fact.ppe'), value: [spec.style.ppeCategory.replace('_', ' '), spec.style.ppeStandard, spec.style.ppeClass].filter(Boolean).join(' · ') }] : []),
  ]
  const measures = spec.size.measures.map((measure) => ({ id: measure.point, cells: [measure.point, measureText(measure, locale)] }))
  const materials = spec.materials.map((row, index) => ({ id: `${row.seq}-${index}`, cells: [row.placement ?? '—', `${row.item.code} · ${materialName(row.item, locale)}`, row.colour ? `${row.colour.code} · ${row.colour.name}` : '—', `${decimalWords(row.perGarment, locale)} ${row.uom}`] }))
  return (
    <div className="fw-floor-stack fw-fi-spec">
      {asOf ? (
        <TaskLine tone="info" icon={<CloudOff />}>
          {t('asOf', { time: formatTime(asOf, { locale, timeZone }) })}
        </TaskLine>
      ) : null}
      <div className="fw-task-split">
        <div className="fw-floor-stack">
          <section className="fw-floor-section" aria-labelledby="fw-fi-spec-measures">
            <h3 id="fw-fi-spec-measures" className="fw-floor-subtitle fw-fi-spec-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Ruler />
              </span>
              {t('spec.measuresTitle', { size: spec.size.code })}
            </h3>
            {measures.length > 0 ? <SummaryTable label={t('spec.measuresTitle', { size: spec.size.code })} columns={[t('spec.col.point'), t('spec.col.value')]} rows={measures} align={[undefined, 'right']} widths={['60%']} density="roomy" /> : <p className="fw-floor-lead">{t('spec.noMeasures')}</p>}
            <p className="fw-floor-muted">{t('spec.measuresNote')}</p>
          </section>
          <section className="fw-floor-section" aria-labelledby="fw-fi-spec-facts">
            <h3 id="fw-fi-spec-facts" className="fw-floor-subtitle fw-fi-spec-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Shirt />
              </span>
              {t('spec.factsTitle')}
            </h3>
            <FloorFacts facts={facts} />
          </section>
        </div>
        <div className="fw-floor-stack">
          <section className="fw-floor-section" aria-labelledby="fw-fi-spec-materials">
            <h3 id="fw-fi-spec-materials" className="fw-floor-subtitle fw-fi-spec-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Tag />
              </span>
              {t('spec.materialsTitle')}
            </h3>
            {materials.length > 0 ? <SummaryTable label={t('spec.materialsTitle')} columns={[t('spec.col.placement'), t('spec.col.material'), t('spec.col.colour'), t('spec.col.perGarment')]} rows={materials} align={[undefined, undefined, undefined, 'right']} stackOnPhone density="roomy" /> : <p className="fw-floor-lead">{t('spec.noMaterials')}</p>}
          </section>
          {settings.length > 0 ? (
            <section className="fw-floor-section" aria-labelledby="fw-fi-spec-settings">
              <h3 id="fw-fi-spec-settings" className="fw-floor-subtitle fw-fi-spec-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Settings2 />
                </span>
                {t('spec.settingsTitle')}
              </h3>
              {settings.map((setting) => (
                <FloorFacts key={setting.seq} facts={settingRows(setting, locale).map((row) => ({ label: t(`spec.setting.${row.key}`), value: row.value }))} />
              ))}
            </section>
          ) : null}
          {spec.operations.length > 0 ? (
            <section className="fw-floor-section" aria-labelledby="fw-fi-spec-route">
              <h3 id="fw-fi-spec-route" className="fw-floor-subtitle fw-fi-spec-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <MapPin />
                </span>
                {t('spec.routeTitle')}
              </h3>
              <ol className="fw-fi-route">
                {spec.operations.map((operation) => (
                  <li key={operation.id} data-current={operation.current} aria-current={operation.current ? 'step' : undefined}>
                    <span className="fw-fi-route-seq">{t('opShort', { seq: operation.seq })}</span>
                    <span>
                      {operation.code} · {operation.name}
                    </span>
                    {operation.current ? (
                      <span className="fw-floor-pill" data-tone="info">
                        {t('spec.here')}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
        </div>
      </div>
      <p className="fw-floor-muted">{t('spec.pdfNote')}</p>
    </div>
  )
}

/** A value and its smaller second line. */
function Two({ main, sub }: { main: string; sub: string | null }) {
  return (
    <>
      {main}
      {sub ? <span className="fw-fi-sub">{sub}</span> : null}
    </>
  )
}
