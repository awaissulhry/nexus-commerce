'use client'

import { Banner, Card } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { PartDraft } from '../../model'
import type { TextileChecks } from '../api'
import { compositionDraft, fibreName, sameComposition, uncomputed } from '../model'
import type { RecordDepth } from '../../view-model'
import { PanelRead } from './parts'

/**
 * The fibre composition per part computed from the BOM, with official names (design lb-builder "fibre composition per part
 * computed from the BOM with official names (PRD-338)"; B-W2b-208's checks): per group of colourways that agree, each part
 * (outer fabric, lining, padding, membrane) with its fibres by weight or as its one material says, the parts it could not
 * compute (a missing weight) named, and how much of the garment is textile. On a draft, "Use for the label" writes the
 * parts into the builder in the label's first language (saved with Save). Also drawn on the style's Compliance tab.
 */
export function CompositionGroups({ checks, language, current, onUse }: { checks: TextileChecks; language: string; current?: readonly PartDraft[] | null; onUse?: (parts: PartDraft[]) => void }) {
  const d = useT('compliance-labels-depth')
  if (checks.composition.length === 0) return <p className="fw-q-hint">{d('composition.none')}</p>
  return (
    <div className="fw-q-stack">
      {checks.composition.map((group, index) => {
        const parts = compositionDraft(group.parts, language)
        const missing = uncomputed(group.parts)
        const share = checks.textileShare.find((entry) => entry.colourways.join() === group.colourways.join()) ?? checks.textileShare[index] ?? null
        const same = current ? sameComposition(current, parts) : false
        return (
          <section key={group.colourways.join('-') || index} className="fw-lbd-group" aria-label={d('composition.group', { colourways: group.colourways.join(', ') || '—' })}>
            <div className="fw-q-section-head">
              <h3 className="fw-lb-h3">{checks.composition.length > 1 ? d('composition.group', { colourways: group.colourways.join(', ') }) : d('composition.every')}</h3>
              {onUse && (
                <Button size="sm" heldReason={parts.length === 0 ? d('held.nothingComputed') : same ? d('held.sameComposition') : null} onClick={() => onUse(parts)}>
                  {d('composition.use')}
                </Button>
              )}
              {!onUse && current && same && <Tag tone="success">{d('composition.labelSame')}</Tag>}
            </div>
            <ul className="fw-lbd-parts">
              {group.parts.map((part) => (
                <li key={`${part.component}-${part.part}`}>
                  <b>{part.words[language === 'it' ? 'it' : 'en'] || part.part}</b>{' '}
                  {part.fibres ? (
                    <span>
                      {part.fibres.map((fibre) => `${fibre.percent}% ${fibreName(fibre, language)}`).join(', ')}
                      <span className="fw-q-hint"> · {d(`basis.${part.basis ?? 'ONE_COMPOSITION'}`)}</span>
                    </span>
                  ) : (
                    <span className="fw-lbd-missing">{d('composition.notComputed')}</span>
                  )}
                </li>
              ))}
            </ul>
            {missing.length > 0 && <p className="fw-q-hint">{d('composition.missing', { parts: missing.map((part) => part.words[language === 'it' ? 'it' : 'en'] || part.part).join(', ') })}</p>}
            {group.findings.length > 0 && (
              <ul className="fw-lbd-findings" lang="en">
                {group.findings.map((finding) => (
                  <li key={`${finding.path}-${finding.message}`}>{finding.message}</li>
                ))}
              </ul>
            )}
            {share && (
              <p className="fw-q-hint">
                {share.pct === null ? d('composition.shareUnknown') : d(share.applies ? 'composition.shareApplies' : 'composition.shareBelow', { pct: share.pct })}
                {share.missing.length > 0 && ` · ${d('composition.shareMissing', { count: share.missing.length })}`}
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** The builder's card: the BOM's composition beside what the label says (W1's composition above it). */
export function BomCompositionCard({ depth, labelId, current, language, onUse, onRetry }: { depth: RecordDepth; labelId: string; current: readonly PartDraft[]; language: string; onUse?: (parts: PartDraft[]) => void; onRetry?: () => void }) {
  const d = useT('compliance-labels-depth')
  const locale = useLocale()
  return (
    <Card padded>
      <section className="fw-q-section" id="lb-sec-bom" aria-labelledby="lb-h-bom">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id="lb-h-bom">{d('composition.title')}</h2>
            <p className="fw-q-hint">{d('composition.intro')}</p>
          </div>
        </div>
        {depth.textile === null ? (
          <p className="fw-q-hint">{d('composition.noStyle')}</p>
        ) : (
          <PanelRead read={depth.textile} failedTitle={d('composition.failed')} onRetry={onRetry}>
            {(checks) => (
              <>
                <p className="fw-q-hint">{d('composition.read', { style: checks.style.code, revision: checks.revision.revision, size: checks.size ?? '—' })}</p>
                {checks.label?.id !== labelId && <LabelNote checks={checks} />}
                <CompositionGroups checks={checks} language={language || locale} current={current} onUse={onUse} />
              </>
            )}
          </PanelRead>
        )}
      </section>
    </Card>
  )
}

/** The textile checks compare the BOM with the label the revision names: another label (or none) is said. */
function LabelNote({ checks }: { checks: TextileChecks }) {
  const d = useT('compliance-labels-depth')
  return <Banner tone="info" title={checks.label ? d('composition.comparedWith', { code: checks.label.code, revision: checks.label.revision }) : d('composition.comparedNone', { revision: checks.revision.revision })} />
}
