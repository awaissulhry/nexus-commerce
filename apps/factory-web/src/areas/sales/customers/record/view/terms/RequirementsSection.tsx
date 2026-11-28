'use client'

import type { ReactElement } from 'react'
import { FileText, Plus } from 'lucide-react'
import { Button, FilterChip, Tag } from '@nexus/ui/primitives'
import { Fold } from '../../../../orders/record/money/view/parts'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../../../lib/record-sections/Kit'
import { said, termsKitId, type Say } from '../../terms/model'
import { endedLine, keptWords, REQUIREMENT_ROWS, type EndedRequirementRow, type RequirementRow } from '../../terms/requirements'
import type { TermsTabActions, TermsTabModel } from '../../terms/tab'
import { actItem, menuOf, useTermsSay } from './say'

/**
 * F-CT-506 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §5.3; 18-lead-settles Z12, Z29, Z31, Z36) — section 3,
 * Requirements (#party-requirements): the brand's rules as rows — the kind and the words with their version ("v2 · replaces v1 of …"),
 * what it applies to (all orders or each style "CODE · name"; a style no longer offered is said so), for which company, WHERE IT REALLY
 * SHOWS (printed on the delivery note, else kept — not on those screens yet), its file (a door with files.read) and who wrote it when.
 * Head: Add requirement · ⋯ · ⓘ; kind chips from six rules; ten rows, then "Show n more"; the ended and replaced ones folded and told
 * apart. Add / Replace with a new version… / End… open the depth provider's own windows. Rows lay out by the LIST's room. Draws its model.
 */

export function RequirementsSection({ model, actions }: { model: TermsTabModel; actions?: TermsTabActions | undefined }): ReactElement {
  const say = useTermsSay()
  const req = model.requirements
  const title = say(said('ct.req.title'))
  const buttons = req.add.shown
    ? [
        <Button key="add" size="sm" heldReason={req.add.held ? say(req.add.held) : null} onClick={() => actions?.onAddRequirement?.()}>
          <Plus size={14} aria-hidden /> {say(said('ct.req.add'))}
        </Button>,
      ]
    : []
  const more = menuOf([
    [req.ended.length > 0 ? { id: 'ended', label: say(req.endedOpen ? said('ct.req.hideEnded') : said('ct.req.endedFold', { params: { count: req.ended.length } })), onSelect: () => actions?.onFold?.('requirementsEnded', !req.endedOpen) } : null],
    [{ id: 'link', label: say(said('ct.copyLink', { params: { section: title } })), onSelect: () => actions?.onCopyLink?.('party-requirements') }],
  ])
  const head = {
    id: termsKitId('party-requirements'),
    title,
    buttons,
    more: <LineMenuButton label={say(said('ct.more', { params: { section: title } }))} items={more} />,
    info: (
      <>
        <p>{say(said('ct.req.info.what'))}</p>
        <p>{say(said('ct.req.info.where'))}</p>
        <p>{say(said('ct.req.info.styles'))}</p>
        <p>{say(said('ct.keys'))}</p>
      </>
    ),
  }
  if (req.reading)
    return (
      <Section {...head} answer={say(said('ct.reading'))}>
        <PartReading rows={3} height={36} />
      </Section>
    )
  if (req.problem)
    return (
      <Section {...head}>
        <PartFailed part={say(said('ct.req.part'))} problem={req.problem} onRetry={actions?.onRetryRequirements} />
      </Section>
    )
  const ended = req.endedOpen && req.ended.length > 0 ? <EndedList rows={req.ended} say={say} /> : null
  if (req.all.length === 0)
    return (
      <Section
        {...head}
        answer={
          <>
            {req.answer ? say(req.answer) : null}
            {req.ended.length > 0 ? (
              <>
                {' '}
                <Button size="sm" variant="link" aria-expanded={req.endedOpen} onClick={() => actions?.onFold?.('requirementsEnded', !req.endedOpen)}>
                  {say(req.endedOpen ? said('ct.req.hideEnded') : said('ct.req.endedInline', { params: { count: req.ended.length } }))}
                </Button>
              </>
            ) : null}
          </>
        }
      >
        {ended}
      </Section>
    )
  const marked = new Set(model.marked)
  return (
    <Section {...head} answer={req.answer ? say(req.answer) : undefined}>
      {req.kinds ? (
        <div className="fw-ctr-kinds" role="group" aria-label={say(said('ct.req.kindsLabel'))}>
          <FilterChip pressed={req.kind === null} count={req.all.length} onClick={() => actions?.onKind?.(null)}>
            {say(said('ct.req.all'))}
          </FilterChip>
          {req.kinds.map((entry) => (
            <FilterChip key={entry.kind} pressed={req.kind === entry.kind} count={entry.count} onClick={() => actions?.onKind?.(req.kind === entry.kind ? null : entry.kind)}>
              {say(said(`sales-customers-depth:kind.${entry.kind}`))}
            </FilterChip>
          ))}
        </div>
      ) : null}
      <div className="fw-ctr-ls" role="list" aria-label={say(said('ct.req.listLabel'))}>
        <div className="fw-ctr-hd is-r" aria-hidden>
          <div className="fw-ctr-what">{say(said('ct.req.col.what'))}</div>
          <div className="fw-ctr-app">{say(said('sales-customers-depth:req.col.appliesTo'))}</div>
          <div className="fw-ctr-where">{say(said('ct.req.col.where'))}</div>
          <div className="fw-ctr-file">{say(said('ct.req.col.file'))}</div>
          <div className="fw-ctr-o" />
        </div>
        {req.rows.map((row) => (
          <RequirementRowView key={row.id} row={row} marked={marked.has(row.anchor)} say={say} actions={actions} />
        ))}
      </div>
      {req.hidden > 0 || (req.kind === null && req.rows.length > REQUIREMENT_ROWS) ? (
        <Button size="sm" variant="quiet" className="fw-ctr-more" onClick={() => actions?.onMoreRequirements?.(req.hidden > 0)}>
          {say(req.hidden > 0 ? said('ct.req.showMore', { params: { count: req.hidden } }) : said('ct.req.showFewer'))}
        </Button>
      ) : null}
      {req.ended.length > 0 ? (
        <div className="fw-ctr-foldw">
          <Fold open={req.endedOpen} onToggle={() => actions?.onFold?.('requirementsEnded', !req.endedOpen)} label={say(said('ct.req.endedFold', { params: { count: req.ended.length } }))} />
        </div>
      ) : null}
      {ended}
    </Section>
  )
}

function RequirementRowView({ row, marked, say, actions }: { row: RequirementRow; marked: boolean; say: Say; actions?: TermsTabActions | undefined }) {
  const kind = said(`sales-customers-depth:kind.${row.kind}`)
  const kept = keptWords(row.kept)
  const items = menuOf([
    [actItem('replace', said('ct.req.replace'), row.replace, say, () => actions?.onReplaceRequirement?.(row)), actItem('end', said('sales-customers-depth:req.end'), row.end, say, () => actions?.onEndRequirement?.(row))],
    [row.file && row.fileDoor ? { id: 'file', label: say(said('ct.req.openFile', { params: { file: row.file.name } })), onSelect: () => actions?.onOpenFile?.(row.file!.id) } : null],
    [{ id: 'words', label: say(said('ct.req.copyWords')), onSelect: () => actions?.onCopyWords?.(row.words) }, { id: 'link', label: say(said('ct.copyRowLink')), onSelect: () => actions?.onCopyLink?.(row.anchor) }],
  ])
  return (
    <div id={row.anchor} className={`fw-ctr-row is-r${marked ? ' is-mark' : ''}`} role="listitem">
      <div className="fw-ctr-what">
        <span className="fw-ctr-name">
          <Tag tone="neutral">{say(kind)}</Tag>
        </span>
        <span className="fw-ctr-words">{row.words}</span>
        {row.replaces ? <span className="fw-ctr-sub">{say(said('ct.req.version', { params: { version: row.version, before: row.replaces.version }, days: { date: row.replaces.on } }))}</span> : null}
      </div>
      <div className="fw-ctr-app">
        {row.everyStyle ? (
          <span>{say(said('sales-customers-depth:req.allOrders'))}</span>
        ) : (
          row.styles.map((style) =>
            style.code === null ? (
              <span key={style.id} className="fw-ctr-none">
                {say(said('ct.req.styleGone'))}
              </span>
            ) : (
              <span key={style.id} className="fw-ctr-sty">
                <b>{style.code}</b>
                {style.name ? ` · ${style.name}` : ''}
              </span>
            ),
          )
        )}
        <span className="fw-ctr-sub">{row.company === null ? say(said('sales-customers-depth:hold.everyCompany')) : row.company}</span>
      </div>
      <div className="fw-ctr-where">
        {row.ddt ? (
          <span className="fw-ctr-tags">
            <Tag tone="success">
              <FileText size={12} aria-hidden /> {say(said('ct.req.ddt'))}
            </Tag>
            <span className="fw-ctr-sub">{say(said('ct.req.ddtUnless'))}</span>
          </span>
        ) : null}
        {kept ? <span className="fw-ctr-sub">{say(kept)}</span> : null}
      </div>
      <div className="fw-ctr-file">
        {row.file ? (
          row.fileDoor ? (
            <Button size="sm" variant="link" onClick={() => actions?.onOpenFile?.(row.file!.id)}>
              <FileText size={13} aria-hidden /> {row.file.name}
            </Button>
          ) : (
            <span>
              <FileText size={13} aria-hidden /> {row.file.name}
            </span>
          )
        ) : (
          <span className="fw-ctr-none">{say(said('ct.req.noFile'))}</span>
        )}
        <span className="fw-ctr-sub">{say(row.by ? said('ct.req.writtenBy', { params: { name: row.by }, days: { date: row.on } }) : said('ct.req.written', { days: { date: row.on } }))}</span>
      </div>
      <div className="fw-ctr-o">
        <LineMenuButton label={say(said('ct.req.rowMore', { lower: { kind } }))} items={items} />
      </div>
    </div>
  )
}

function EndedList({ rows, say }: { rows: readonly EndedRequirementRow[]; say: Say }) {
  return (
    <div className="fw-ctr-ls" role="list" aria-label={say(said('ct.req.endedList'))}>
      {rows.map((row) => (
        <div key={row.id} className="fw-ctr-row is-e" role="listitem">
          <div>
            <span className="fw-ctr-name">
              <Tag tone="neutral">{say(said(`sales-customers-depth:kind.${row.kind}`))}</Tag>
              <Tag tone={row.replaced ? 'info' : 'neutral'}>{say(said(row.replaced ? 'ct.req.replaced' : 'ct.req.ended'))}</Tag>
            </span>
            <span className="fw-ctr-words is-old">{row.words}</span>
            <span className="fw-ctr-sub">{say(endedLine(row))}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
