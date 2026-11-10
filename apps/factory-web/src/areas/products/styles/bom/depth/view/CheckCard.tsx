'use client'

import { CircleAlert, CircleX } from 'lucide-react'
import { Card } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../../lib/i18n/provider'
import type { BomView, RoutingView } from '../../../api'
import { issueWords } from '../../../model'
import type { BomDepthView, BomStructureView, CheckItem } from '../api'
import { bomFindings, isW1Code, showMeOf, structureWords, type ShowMe } from '../model'

/**
 * THE BOM check on the Materials (BOM) tab (B-W2b-241 on B-W2b-223's GET …/bom/check; design style.bom.check "What stops
 * this BOM from being released, live", with W2b's "Archived or blocked material" and "Circular sub-assembly"): W1's
 * findings in W1's words and the structure's in this page's (a blocked material or alternate, a sub-assembly not released,
 * not made here, in a circle, too deep, without a size or a colourway for the garment, a group row in a circle, a PPE line's
 * material not approved yet), blockers first; each with "Show me", which lands on the cell to fix. Hidden when there is
 * nothing to say. The routing's findings are the Operations tab's.
 */
export function CheckCard({
  structure,
  depth,
  bom,
  routing,
  onShowMe,
}: {
  structure: BomStructureView
  depth: BomDepthView | null
  bom: BomView
  routing: RoutingView | null
  onShowMe: (target: ShowMe) => void
}) {
  const t = useT('products-bom-depth')
  const tp = useT('products')
  if (!structure.check.checked) return null
  const { blockers, warnings } = bomFindings(structure.check)
  if (blockers.length === 0 && warnings.length === 0) return null
  const words = (item: CheckItem): string => {
    if (isW1Code(item.code)) {
      const issue = { code: item.code, lineId: item.cell.lineId, size: item.cell.size, colourwayId: item.cell.colourwayId, stepId: item.cell.stepId, message: item.message } as BomView['issues'][number]
      const own = issueWords(issue, bom, routing)
      return tp(own.key, own.params)
    }
    const own = structureWords(item, structure, depth)
    return t(own.key, own.params)
  }
  const row = (item: CheckItem, index: number, blocked: boolean) => {
    const target = showMeOf(item)
    return (
      <li key={`${item.code}-${index}`} className={`fw-bmd-check ${blocked ? 'is-blocked' : 'is-warning'}`}>
        {blocked ? <CircleX size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
        <span>
          {words(item)}
          {!blocked && <span className="fw-bmd-sub"> · {t('findings.warningPasses')}</span>}
        </span>
        {target ? (
          <Button size="sm" variant="link" onClick={() => onShowMe(target)}>
            {t(target.to === 'add' ? 'findings.addFirst' : 'findings.showMe')}
          </Button>
        ) : (
          <span />
        )}
      </li>
    )
  }
  return (
    <Card header={blockers.length > 0 ? t('findings.title', { count: blockers.length }) : t('findings.titleWarnings', { count: warnings.length })} description={t('findings.intro')}>
      <ul className="fw-bmd-checklist">
        {blockers.map((item, index) => row(item, index, true))}
        {warnings.map((item, index) => row(item, index, false))}
      </ul>
    </Card>
  )
}
