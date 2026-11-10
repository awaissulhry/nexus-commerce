'use client'

import { useMemo } from 'react'
import { BookOpen, Check, Languages } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { CARE_SYMBOLS } from '@nexus/factory-domain/compliance/labels/rules'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { LabelDetail } from '../../api'
import type { LabelDraft } from '../../model'
import type { LabelRecordActions, RecordDepth, RecordDialog } from '../../view-model'
import type { LabelChecks, Phrases } from '../api'
import { approveTranslationHeld, fillFromLibrary, warningReasonOf, labelPhraseSpecs, languageColumns, phraseLibraryHref, phraseRows, proposeHeld, rowsBlock, type CellView, type LanguageColumn, type PhraseRow } from '../model'
import { PanelRead, RulesLink } from './parts'

const CELL_TONE: Record<CellView['state'], 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = { SOURCE: 'success', APPROVED: 'success', PROPOSED: 'info', STALE: 'warning', MISSING: 'danger', NOT_IN_LIBRARY: 'neutral' }

/**
 * Label › Languages (design rec:Label tab `languages`, lb-langs; PRD-343): each phrase the label prints — its class warnings,
 * the animal-origin phrase, each care symbol's words, an origin claim — with its approved words in every language the label
 * prints and every language a switched-on market needs on labels, "missing ✕" where none is approved. A missing warning
 * translation, and a language the label does not print, keep it from printing for the markets that need that language
 * (B-W2b-253's class warnings, B-W2b-254's label languages). Care and animal-origin words print from the label itself:
 * "Fill from the library" copies the approved words into a draft. Translate proposes words per language (saved when the
 * field is left: it waits for a second person) and approves another person's proposal (explicit). On the ONE list frame:
 * select phrases to approve their waiting proposals at once.
 */
export function LanguagesTab({ detail, draft, depth, prefix, dialog, actions }: { detail: LabelDetail; draft: LabelDraft | null; depth: RecordDepth; prefix: string; dialog: RecordDialog | null; actions?: LabelRecordActions }) {
  const d = useT('compliance-labels-depth')
  return (
    <PanelRead read={depth.checks} failedTitle={d('languages.checksFailed')} onRetry={actions?.onRetryChecks}>
      {(checks) => (
        <PanelRead read={depth.phrases} failedTitle={d('languages.failed')} onRetry={actions?.onRetryPhrases}>
          {(phrases) => <Grid detail={detail} draft={draft} depth={depth} checks={checks} phrases={phrases} prefix={prefix} dialog={dialog} actions={actions} />}
        </PanelRead>
      )}
    </PanelRead>
  )
}

function Grid({ detail, draft, depth, checks, phrases, prefix, dialog, actions }: { detail: LabelDetail; draft: LabelDraft | null; depth: RecordDepth; checks: LabelChecks; phrases: Phrases; prefix: string; dialog: RecordDialog | null; actions?: LabelRecordActions }) {
  const d = useT('compliance-labels-depth')
  // The care symbols' words are W1's (the labels catalogue).
  const w = useT('labels')
  const languages = draft?.languages ?? detail.languages
  const columns = useMemo(() => languageColumns(languages, checks.markets.map((entry) => entry.market)), [languages, checks.markets])
  const specs = useMemo(() => labelPhraseSpecs(draft ? { animalOriginPhrase: draft.animalOriginPhrase, care: draft.care, originClaimKey: detail.originClaimKey } : detail, checks.marking.warnings), [draft, detail, checks.marking.warnings])
  const rows = useMemo(
    () => phraseRows(specs, phrases.phrases, columns, draft ? { layout: { ...detail.layout, texts: { animalOrigin: draft.animalOriginTexts } }, care: draft.care } : detail),
    [specs, phrases.phrases, columns, draft, detail],
  )
  const blocked = rowsBlock(rows, columns)
  const fill = draft ? fillFromLibrary(draft, rows) : null
  const fillHeld = !draft ? d(detail.status === 'DRAFT' ? 'held.manage' : 'held.frozen') : fill && fill.filled === 0 ? d('held.nothingToFill') : null
  const can = { ...depth.can, phrasesManage: depth.can.phrasesManage && phrases.mayManage, phrasesApprove: depth.can.phrasesApprove && phrases.mayApprove }
  const waitingIn = (row: PhraseRow) => row.cells.filter((cell) => approveTranslationHeld(can, depth.me, cell, false) === null)

  const nameOf = (row: PhraseRow): string =>
    row.spec.kind === 'CARE'
      ? d('row.CARE', { symbol: row.spec.symbol && CARE_SYMBOLS[row.spec.symbol] ? w(`care.${row.spec.symbol}`) : (row.spec.symbol ?? '—') })
      : row.spec.kind === 'WARNING'
        ? warningReasonOf(row.spec.key)
          ? d(`warning.${warningReasonOf(row.spec.key)}`)
          : d('row.WARNING', { key: row.spec.key })
        : d(`row.${row.spec.kind}`)

  const gridColumns: ColDef<PhraseRow>[] = useMemo(() => {
    const PhraseCell = ({ data }: ICellRendererParams<PhraseRow>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{nameOf(data)}</span>
          <span className="fw-q-hint fw-q-code">
            {data.phrase ? (
              <RulesLink href={phraseLibraryHref(prefix, data.spec.key)} can={depth.can.rules}>
                {data.spec.key}
              </RulesLink>
            ) : (
              d('cell.notInLibraryKey', { key: data.spec.key })
            )}
          </span>
        </span>
      ) : null
    const LanguageCell = (column: LanguageColumn) =>
      function Cell({ data }: ICellRendererParams<PhraseRow>) {
        const cell = data?.cells.find((entry) => entry.language === column.language)
        if (!data || !cell) return null
        return (
          <span className="fw-q-cell">
            <span className="fw-q-cell-row">
              <Pill tone={CELL_TONE[cell.state]} dot>
                {d(`cell.${cell.state}`)}
              </Pill>
              {cell.blocks.length > 0 && <Tag tone="danger">{d('cell.blocks', { markets: cell.blocks.join(', ') })}</Tag>}
            </span>
            {cell.text && (
              <span className="fw-lbd-celltext" lang={column.language}>
                {cell.text}
              </span>
            )}
            {cell.draft && (
              <span className="fw-q-hint" lang={column.language}>
                {d('cell.proposal', { text: cell.draft.text })}
              </span>
            )}
            {cell.labelText && cell.labelText !== cell.text && <span className="fw-q-hint">{d('cell.labelSays', { text: cell.labelText })}</span>}
          </span>
        )
      }
    const ActionCell = ({ data }: ICellRendererParams<PhraseRow>) =>
      data ? (
        <Button size="sm" heldReason={!data.phrase ? d('held.notInLibrary') : null} onClick={() => actions?.onDialog?.({ kind: 'translate', key: data.spec.key, texts: {} })} aria-label={d('languages.translateRow', { phrase: nameOf(data) })}>
          <Languages size={13} aria-hidden /> {d('languages.translate')}
        </Button>
      ) : null
    return [
      { colId: 'phrase', headerName: d('languages.col.phrase'), cellRenderer: PhraseCell, sortable: false, flex: 1.3, minWidth: 200, autoHeight: true, wrapText: true },
      ...columns.map(
        (column): ColDef<PhraseRow> => ({
          colId: `lang-${column.language}`,
          headerName: `${column.language.toUpperCase()}${column.onLabel ? '' : ` · ${d('languages.notOnLabelShort')}`}`,
          headerTooltip: column.markets.length > 0 ? d('languages.neededBy', { markets: column.markets.join(', ') }) : d('languages.neededByNone'),
          cellRenderer: LanguageCell(column),
          sortable: false,
          flex: 1,
          minWidth: 170,
          autoHeight: true,
          wrapText: true,
        }),
      ),
      { colId: 'actions', headerName: d('languages.col.actions'), cellRenderer: ActionCell, sortable: false, width: 140, minWidth: 140, suppressHeaderMenuButton: true },
    ]
    // nameOf reads the catalogue only.
  }, [columns, d, w, prefix, depth.can.rules, actions])

  const selected = rows.filter((row) => depth.selectedPhrases?.includes(row.id))
  const approvable = selected.flatMap((row) => waitingIn(row).map((cell) => ({ key: row.spec.key, draft: cell.draft! })))
  const bulk = (
    <Button size="sm" heldReason={approvable.length === 0 ? d('held.nothingToApprove') : depth.writing ? d('held.busy') : null} onClick={() => actions?.onApproveTranslations?.(approvable.map((entry) => ({ key: entry.key, draft: { id: entry.draft.id, version: entry.draft.version } })))} aria-label={d('languages.bulkApprove', { count: approvable.length })}>
      <Check size={13} aria-hidden /> <SelectionLabel>{d('languages.bulkApprove', { count: approvable.length })}</SelectionLabel>
    </Button>
  )
  const open = dialog?.kind === 'translate' ? (rows.find((row) => row.spec.key === dialog.key) ?? null) : null

  return (
    <div className="fw-q-stack">
      <Card padded>
        <section className="fw-q-section" aria-labelledby="lb-h-langs">
          <div className="fw-q-section-head">
            <div className="fw-q-section-title">
              <h2 id="lb-h-langs">{d('languages.title')}</h2>
              <p className="fw-q-hint">{d('languages.intro')}</p>
            </div>
            <span className="fw-q-actions">
              <Button size="sm" heldReason={fillHeld} onClick={() => actions?.onFillFromLibrary?.()}>
                <BookOpen size={13} aria-hidden /> {fill && fill.filled > 0 ? d('languages.fillN', { count: fill.filled }) : d('languages.fill')}
              </Button>
              <RulesLink href={phraseLibraryHref(prefix)} can={depth.can.rules}>
                {d('list.phraseLibrary')}
              </RulesLink>
            </span>
          </div>
          <p className="fw-lbd-rule-words">{d('languages.rule')}</p>
          <ul className="fw-lbd-columns" aria-label={d('languages.columns')}>
            {columns.map((column) => (
              <li key={column.language} className={column.onLabel ? undefined : 'is-missing'}>
                <b className="fw-q-code">{column.language.toUpperCase()}</b> <span>{column.onLabel ? d('languages.onLabel') : d('languages.notOnLabel')}</span>
                <span className="fw-q-hint"> · {column.markets.length > 0 ? d('languages.neededBy', { markets: column.markets.join(', ') }) : d('languages.neededByNone')}</span>
              </li>
            ))}
          </ul>
          {blocked.length > 0 ? (
            <Banner tone="warning" title={d('languages.blocked', { markets: blocked.join(', ') })}>
              {columns.some((column) => !column.onLabel && column.markets.length > 0) ? d('languages.blockedLanguage') : d('languages.blockedPhrase')}
            </Banner>
          ) : (
            <p className="fw-q-hint">{d('languages.noneBlocked')}</p>
          )}
          {depth.cellProblem && !open && (
            <Banner tone="danger" title={d(depth.cellProblem.key)}>
              {depth.cellProblem.lines?.join(' ')}
            </Banner>
          )}
        </section>
      </Card>
      {rows.length === 0 ? (
        <Card padded>
          <EmptyState title={d('languages.empty')} description={d('languages.emptyBody')} />
        </Card>
      ) : (
        <ListFrame<PhraseRow>
          label={d('languages.table')}
          rows={rows}
          rowId={(row) => row.id}
          columns={gridColumns}
          count={d('languages.count', { count: rows.length })}
          selection={{ selected: depth.selectedPhrases ?? [], onChange: (ids) => actions?.onSelectPhrases?.(ids), actions: bulk }}
          isRowSelectable={(row) => (waitingIn(row).length > 0 ? null : d('held.rowNothingToApprove'))}
          listKey={null}
        />
      )}
      {open && dialog?.kind === 'translate' && <TranslateDialog row={open} name={nameOf(open)} columns={columns} depth={depth} can={can} dialog={dialog} actions={actions} />}
    </div>
  )
}

function TranslateDialog({ row, name, columns, depth, can, dialog, actions }: { row: PhraseRow; name: string; columns: readonly LanguageColumn[]; depth: RecordDepth; can: RecordDepth['can']; dialog: Extract<RecordDialog, { kind: 'translate' }>; actions?: LabelRecordActions }) {
  const d = useT('compliance-labels-depth')
  const q = useT('quality')
  const phrase = row.phrase
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal open onClose={close} size="lg" title={d('translate.title', { phrase: name })} footer={<Button onClick={close}>{q('common.close')}</Button>}>
      <div className="fw-q-form fw-lbd-dialog">
        <p className="fw-q-hint fw-q-code">{row.spec.key}</p>
        {phrase && (
          <p>
            <span className="fw-q-hint">{d('translate.source', { language: phrase.sourceLanguage.toUpperCase() })}</span>{' '}
            <span lang={phrase.sourceLanguage}>{phrase.sourceText}</span>
          </p>
        )}
        <p className="fw-q-hint">{d('translate.intro')}</p>
        {row.cells.map((cell) => {
          const at = `${row.spec.key}|${cell.language}`
          const typed = dialog.texts[cell.language] ?? cell.draft?.text ?? ''
          const held = proposeHeld(can, row, cell, depth.writing === at)
          const approve = approveTranslationHeld(can, depth.me, cell, depth.writing !== null)
          const problem = depth.cellProblem?.at === at ? depth.cellProblem : null
          const column = columns.find((entry) => entry.language === cell.language)
          return (
            <fieldset key={cell.language} className="fw-lb-part">
              <legend className="fw-lb-part-head">
                <span className="fw-q-code">{cell.language.toUpperCase()}</span>
                <Pill tone={CELL_TONE[cell.state]} dot>
                  {d(`cell.${cell.state}`)}
                </Pill>
                {column && column.markets.length > 0 && <span className="fw-q-hint">{d('languages.neededBy', { markets: column.markets.join(', ') })}</span>}
              </legend>
              {cell.text && (
                <p lang={cell.language}>
                  <span className="fw-q-hint">{d('translate.approved')}</span> {cell.text}
                </p>
              )}
              {cell.state !== 'SOURCE' && (
                <Field
                  label={cell.draft ? d('translate.change') : d('translate.propose')}
                  hint={depth.writing === at ? d('translate.saving') : cell.draft ? d('translate.waiting', { name: cell.draft.proposedBy?.name ?? '—' }) : d('translate.hint')}
                  error={problem ? d(problem.key) : undefined}
                >
                  <Input
                    lang={cell.language}
                    value={typed}
                    maxLength={2000}
                    disabled={held !== null && held !== 'held.busy'}
                    onChange={(event) => actions?.onDialog?.({ ...dialog, texts: { ...dialog.texts, [cell.language]: event.target.value } })}
                    onBlur={() => {
                      const text = typed.trim()
                      if (held || !text || text === (cell.draft?.text ?? '').trim()) return
                      actions?.onPropose?.(row.spec.key, cell.language, text, cell.draft?.version)
                    }}
                  />
                </Field>
              )}
              {held && held !== 'held.busy' && cell.state !== 'SOURCE' && <p className="fw-q-hint">{d(held)}</p>}
              {cell.draft && (
                <span className="fw-q-actions">
                  <Button size="sm" variant="primary" heldReason={approve ? d(approve) : null} onClick={() => actions?.onApproveTranslations?.([{ key: row.spec.key, draft: { id: cell.draft!.id, version: cell.draft!.version } }])}>
                    {depth.writing === at ? <Spinner size={12} /> : null} {d('translate.approve')}
                  </Button>
                  {/* Held: why, on screen (not only to a screen reader). */}
                  {approve && approve !== 'held.busy' && <span className="fw-q-hint">{d(approve)}</span>}
                </span>
              )}
            </fieldset>
          )
        })}
      </div>
    </Modal>
  )
}
