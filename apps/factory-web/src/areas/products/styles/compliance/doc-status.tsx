'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Banner, Card, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { browserApi } from '../../../../lib/api/browser'
import { useOfficeSession } from '../../../../lib/session/context'
import type { OfficeSession } from '../../../../lib/session/session'
import { listDeclarations, readCoverage, type CoverageRow, type DeclarationRow } from '../../../compliance/declarations/api'
import { declarationsCan, mayGenerate, newDeclarationHref, readProblemOf, recordHref } from '../../../compliance/declarations/model'
import { CellPill, DeclarationsMessages, StatusPill, useWords } from '../../../compliance/declarations/view/parts'

/**
 * SCR-045 Compliance › Garment label and documents — "DoC and user information status" (B-W2b-268; design style.cp.label,
 * W2b): for the style's current revision, each language the markets need with the state of its DoC and of its user information
 * (issued with its revision, a draft — generated ones stay drafts until GATE-PPE-TEXTS —, in translation, missing, not needed),
 * the drafts made here with their number, and the way to Declarations & instructions (New declaration for this style, the
 * style's rows). Mounted by the Compliance tab with one line; it reads its own two answers (the coverage and the list of this
 * style, compliance.certificates.view) and nothing else. Outside the office (the design index) it draws nothing.
 */

export interface StyleDocStatusRead {
  readonly status: 'loading' | 'ready' | 'error'
  readonly rows?: readonly CoverageRow[]
  readonly documents?: readonly DeclarationRow[]
  readonly problem?: string
}

/** The office session, or null outside the office (the design index renders the tab without one). */
function useOptionalSession(): OfficeSession | null {
  try {
    return useOfficeSession()
  } catch {
    return null
  }
}

/** The part as the Compliance tab mounts it: reads the style's coverage and documents, then draws the card. */
export function StyleDocStatus({ styleId, styleCode, prefix }: { styleId: string; styleCode: string; prefix: string }) {
  const session = useOptionalSession()
  const company = session?.company?.code ?? null
  const api = useMemo(() => (session ? browserApi({ company }) : null), [session, company])
  const can = useMemo(() => declarationsCan(session?.permissions ?? []), [session])
  const [read, setRead] = useState<StyleDocStatusRead>({ status: 'loading' })
  const load = useCallback(() => {
    if (!api || !can.view) return
    setRead({ status: 'loading' })
    Promise.all([readCoverage(api, styleId), listDeclarations(api, { styleId })]).then(
      ([coverage, list]) => setRead({ status: 'ready', rows: coverage.rows, documents: list.declarations }),
      (error: unknown) => setRead({ status: 'error', problem: readProblemOf(error) }),
    )
  }, [api, can.view, styleId])
  useEffect(load, [load])
  if (!session || !can.view) return null
  return <DocStatusCard read={read} prefix={prefix} styleId={styleId} styleCode={styleCode} canGenerate={mayGenerate(can, 'DECLARATION_OF_CONFORMITY') || mayGenerate(can, 'USER_INFORMATION')} onRetry={load} />
}

/** The card itself (one read model, nothing fetched): the design review draws it with made-up reads. */
export function DocStatusCard(props: { read: StyleDocStatusRead; prefix: string; styleId: string; styleCode: string; canGenerate: boolean; onRetry?: () => void }) {
  return (
    <DeclarationsMessages>
      <Body {...props} />
    </DeclarationsMessages>
  )
}

function Body({ read, prefix, styleId, styleCode, canGenerate, onRetry }: { read: StyleDocStatusRead; prefix: string; styleId: string; styleCode: string; canGenerate: boolean; onRetry?: (() => void) | undefined }) {
  const t = useWords()
  const header = t('styleStatus.title')
  if (read.status === 'loading')
    return (
      <Card header={header} aria-busy="true">
        <div className="fw-dc-stack" role="status" aria-label={t('styleStatus.loading')}>
          <Skeleton height={18} width="70%" />
          <Skeleton height={18} width="50%" />
        </div>
      </Card>
    )
  if (read.status === 'error')
    return (
      <Card header={header}>
        <Banner tone="danger" title={t('styleStatus.failed')} action={onRetry ? <Button size="sm" onClick={onRetry}>{t('styleStatus.retry')}</Button> : undefined}>
          {t(read.problem ?? 'styleStatus.failed')}
        </Banner>
      </Card>
    )
  const rows = read.rows ?? []
  const documents = read.documents ?? []
  const languages = [...new Set(rows.flatMap((row) => row.cells.filter((cell) => cell.state !== 'NOT_NEEDED').map((cell) => cell.language)))].sort()
  const revision = rows[0]?.style.revision ?? null
  const drafts = documents.filter((document) => document.origin === 'GENERATED' && document.status === 'DRAFT')
  return (
    <Card header={header} description={revision === null ? t('styleStatus.notPpe') : t('styleStatus.intro', { revision })}>
      <div className="fw-dc-stack">
        {rows.length === 0 ? (
          <p className="fw-dc-muted">{t('styleStatus.none')}</p>
        ) : (
          <SummaryTable
            label={header}
            stackOnPhone
            columns={[t('styleStatus.col.language'), t('kindShort.DECLARATION_OF_CONFORMITY'), t('kindShort.USER_INFORMATION')]}
            rows={languages.map((language) => ({
              id: language,
              cells: [
                language.toUpperCase(),
                ...(['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'] as const).map((kind) => {
                  const cell = rows.find((row) => row.kind === kind)?.cells.find((entry) => entry.language === language)
                  if (!cell) return '—'
                  return cell.documentId ? (
                    <Link key={kind} className="fw-dc-celllink" href={recordHref(prefix, cell.documentId)} aria-label={t('styleStatus.open', { kind: t(`kindShort.${kind}`), language: language.toUpperCase(), state: t(`cell.${cell.state}`) })}>
                      <CellPill state={cell.state} revision={cell.revision} />
                    </Link>
                  ) : (
                    <CellPill key={kind} state={cell.state} revision={cell.revision} />
                  )
                }),
              ],
            }))}
          />
        )}
        {drafts.length > 0 && (
          <ul className="fw-dc-list" aria-label={t('styleStatus.drafts')}>
            {drafts.map((document) => (
              <li key={document.id} className="fw-dc-row">
                <Link className="fw-dc-link" href={recordHref(prefix, document.id)}>
                  {document.number ?? `${t(`kindShort.${document.kind}`)} ${document.language.toUpperCase()}`}
                </Link>
                <StatusPill status={document.status} />
                <span className="fw-dc-muted">{t('styleStatus.draftNote')}</span>
              </li>
            ))}
          </ul>
        )}
        <span className="fw-dc-row">
          <Link className="fw-dc-link" href={`${prefix}/compliance/declarations?q=${encodeURIComponent(styleCode)}`}>
            {t('styleStatus.openAll')}
          </Link>
          {canGenerate && (
            <Link className="fw-dc-link" href={newDeclarationHref(prefix, { styleId })}>
              {t('styleStatus.new')}
            </Link>
          )}
        </span>
      </div>
    </Card>
  )
}
