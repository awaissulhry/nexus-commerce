'use client'

import { useMemo } from 'react'
import { Banner } from '@nexus/ui/components'
import { VersionCompare } from '@nexus/ui/patterns/VersionCompare/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { VersionsCompareView } from '../api'
import { sectionKey } from '../model'
import { useWords } from '../parts'

/** Field and total ids of B-W2b-220's compare that have words here (another id keeps the API's English label). */
const FIELD_IDS: Readonly<Record<string, readonly string[]>> = {
  revision: ['labelTemplate', 'plannedHideYieldPct', 'output', 'releasedColourways', 'releasedSizes'],
  bom: ['seq', 'qty', 'uom', 'wastagePct', 'colour', 'supplier', 'section', 'group', 'subAssembly', 'customerSupplied', 'issueToSubcontract', 'sourceKey', 'option', 'step', 'mtm', 'alternates', 'note'],
  routing: ['seq', 'code', 'name', 'workCentreKind', 'standardMinutes', 'allowances', 'timeVersion', 'setupMinutes', 'waitMinutes', 'moveMinutes', 'scanRequired', 'parallelGroup', 'cells', 'checkpoint', 'settings', 'workshop', 'transitDays', 'instructions'],
  measurements: ['uom', 'tolerance'],
  protectors: ['item', 'standard', 'level', 'sizes', 'positionNote'],
  pieces: ['seq', 'quantity', 'line', 'minGrade', 'grain', 'sizes', 'note'],
}
const TOTAL_IDS: readonly string[] = ['lines', 'minutesPerGarment', 'steps', 'spec', 'points', 'pieces', 'perGarment']

export interface RedlineModel {
  /** The compare (null while it is read); `problem` when the read failed; `none`: no proposed revision yet. */
  compare: VersionsCompareView | null
  problem: string | null
  none?: boolean
}

/**
 * The redline of a change order (design pop:changes.decide "Redline summary (VersionCompare)"; Change tab "Redlines"): the
 * released revision against the draft revision that holds the change, one DS VersionCompare per part that differs (BOM,
 * routing and minutes, measurement spec, protectors, pattern pieces, the revision's own facts), the unchanged parts named
 * in one line. Values are the API's written codes and decimals; field names and the parts are said in the page's words by
 * their id. No cost here (the compare's cost section stays on the style's Versions tab with its grain).
 */
export function Redline({ model, onUseAsNote, noteHeld, onRetry }: { model: RedlineModel; onUseAsNote?: (note: string) => void; noteHeld?: string | null; onRetry?: () => void }) {
  const { t, locale } = useWords()
  const ds = useDsWords()
  const compare = model.compare
  const sections = useMemo(() => (compare ? compare.sections.filter((section) => compare.differs.some((entry) => entry.section === section.id)) : []), [compare])
  if (model.none) return <p className="fw-chg-hint">{t('redline.none')}</p>
  if (model.problem)
    return (
      <Banner
        tone="danger"
        title={t('redline.failed')}
        action={
          onRetry ? (
            <Button size="sm" variant="quiet" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          ) : undefined
        }
      >
        {t(model.problem)}
      </Banner>
    )
  if (!compare)
    return (
      <p className="fw-chg-hint" role="status">
        <Spinner size={14} /> {t('redline.reading')}
      </p>
    )
  const label = (section: string, id: string, fallback: string) => (FIELD_IDS[section]?.includes(id) ? t(`cmp.${section}.${id}`) : fallback)
  const unchanged = compare.sections.filter((section) => !sections.includes(section)).map((section) => t(sectionKey(section.id)))
  const head = (side: VersionsCompareView['before']) => ({ label: t('redline.rev', { revision: side.revision }), note: t(`revision.${side.status}`) })
  return (
    <div className="fw-chg-redline">
      <p className="fw-chg-hint">
        {compare.differs.length === 0
          ? t('redline.same', { from: compare.before.revision, to: compare.after.revision })
          : compare.differs.map((entry) => t('redline.differs', { section: t(sectionKey(entry.section)), added: entry.added, removed: entry.removed, changed: entry.changed })).join(' · ')}
      </p>
      {sections.map((section) => (
        <section key={section.id} className="fw-chg-section" aria-label={t(sectionKey(section.id))}>
          <h3 className="fw-chg-h3">{t(sectionKey(section.id))}</h3>
          <div className="fw-chg-bleed">
            <VersionCompare
              before={head(compare.before)}
              after={head(compare.after)}
              lines={section.lines.map((line) => (section.id === 'revision' ? { ...line, label: t(sectionKey('revision')) } : line))}
              fields={section.fields.map((field) => ({ id: field.id, label: label(section.id, field.id, field.label) }))}
              sizes={section.sizes}
              totals={section.totals.map((total) => ({ ...total, label: TOTAL_IDS.includes(total.id) ? t(`cmp.total.${total.id}`) : total.label }))}
              locale={INTL_LOCALE[locale as Locale]}
              onUseAsNote={onUseAsNote}
              noteHeldReason={noteHeld ?? null}
              labels={ds.versionCompare}
            />
          </div>
        </section>
      ))}
      {unchanged.length > 0 && compare.differs.length > 0 && <p className="fw-chg-hint">{t('redline.unchanged', { parts: unchanged.join(', ') })}</p>}
    </div>
  )
}
