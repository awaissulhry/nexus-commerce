'use client'

import { useEffect, useMemo } from 'react'
import { Archive, Languages, Plus } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { SignOffPanel, type SignOffStep } from '@nexus/ui/components/SignOffPanel/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { Phrase, PhraseCell } from '../api'
import { approveHeld, CELL_TONE, PHRASE_KINDS, phraseHeld, readyCount, valueOf, type PhraseDraft } from '../model'
import type { PhrasesState, RulesMarketsActions, RulesMarketsModel } from '../view-model'
import { languageName, NoticeBanner, PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, WriteProblem, useWords } from './parts'

/**
 * Phrases & translations (design rm-phrases; PRD-343; B-W2b-249's phrase library, shared with the DoC generator and the user
 * information: generated texts stay drafts until a PPE consultant's yes per template, GATE-PPE-TEXTS): every label and warning
 * phrase with its source words and one column per language a switched-on market needs — approved, proposed (waiting for a second
 * person), stale (the source words changed since) or missing. The phrase's window proposes words per language and approves
 * them (the DS SignOffPanel: never one's own words); new source words make the next revision and every approved translation
 * stale. Archive N over the rows chosen.
 */
export function PhrasesTab({ model, state, actions, onHelp }: { model: RulesMarketsModel; state: PhrasesState | undefined; actions?: RulesMarketsActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const { address } = model
  const answer = state ? valueOf(state.phrases) : null
  const canManage = model.can.phrasesManage && (answer?.mayManage ?? true)
  const offline = model.live === 'offline'
  const selected = state?.selected ?? []
  const rows = answer?.phrases ?? null
  useEffect(() => {
    if (rows && selected.some((key) => !rows.some((row) => row.key === key))) actions?.phrases?.onSelected?.(selected.filter((key) => rows.some((row) => row.key === key)))
  }, [rows, selected, actions])
  const languages = answer?.languages ?? []

  const columns = useMemo<ColDef<Phrase>[]>(() => {
    const cellOf = (row: Phrase, language: string): PhraseCell | undefined => row.cells.find((cell) => cell.language === language)
    const language = (tag: string): ColDef<Phrase> => ({
      colId: `lang:${tag}`,
      headerName: languageName(tag, locale),
      headerTooltip: tag,
      minWidth: 150,
      flex: 1.1,
      wrapText: true,
      autoHeight: true,
      valueGetter: (params) => {
        const cell = params.data ? cellOf(params.data, tag) : undefined
        return cell ? `${t(`cell.${cell.state}`)} ${cell.approved?.text ?? cell.draft?.text ?? ''}` : ''
      },
      cellRenderer: ({ data }: ICellRendererParams<Phrase>) => {
        if (!data) return null
        const cell = cellOf(data, tag)
        if (!cell) return <span className="fw-rm-muted">—</span>
        if (cell.state === 'SOURCE') return <span className="fw-rm-muted">{t('cell.SOURCE')}</span>
        const text = cell.state === 'APPROVED' || cell.state === 'STALE' ? cell.approved?.text : cell.draft?.text
        return (
          <span className="fw-rm-cell">
            <Pill tone={CELL_TONE[cell.state]} dot>
              {t(`cell.${cell.state}`)}
            </Pill>
            {text ? <span className="fw-rm-clip">{text}</span> : null}
          </span>
        )
      },
    })
    return [
      {
        colId: 'key',
        headerName: t('phrases.col.key'),
        minWidth: 170,
        flex: 1,
        autoHeight: true,
        valueGetter: (params) => params.data?.key ?? '',
        cellRenderer: ({ data }: ICellRendererParams<Phrase>) =>
          data ? (
            <span className="fw-rm-cell">
              <span className="fw-rm-code">{data.key}</span>
              <span className="fw-rm-muted">
                {t(`phraseKind.${data.kind}`)} · {t('phrases.ready', readyCount(data))}
              </span>
            </span>
          ) : null,
      },
      {
        colId: 'source',
        headerName: t('phrases.col.source'),
        minWidth: 220,
        flex: 1.6,
        wrapText: true,
        autoHeight: true,
        valueGetter: (params) => params.data?.sourceText ?? '',
        cellRenderer: ({ data }: ICellRendererParams<Phrase>) =>
          data ? (
            <span className="fw-rm-cell">
              <span className="fw-rm-clip">{data.sourceText}</span>
              <span className="fw-rm-muted">{t('phrases.sourceOf', { language: data.sourceLanguage.toUpperCase(), revision: data.revision })}</span>
            </span>
          ) : null,
      },
      ...languages.map(language),
    ]
  }, [t, locale, languages])

  const picked = (rows ?? []).filter((row) => selected.includes(row.key))
  const addHeld = canManage ? (offline ? t('held.offline') : null) : t('held.phrasesManage')
  const filtered = !!(address.q || address.kind)
  const search = <Input size="sm" type="search" value={address.q} placeholder={t('phrases.search')} aria-label={t('phrases.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
  const filters = (
    <Select size="sm" value={address.kind ?? ''} aria-label={t('phrases.filterKind')} onChange={(event) => actions?.onAddress?.({ kind: event.target.value || null })}>
      <option value="">{t('phrases.allKinds')}</option>
      {PHRASE_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {t(`phraseKind.${kind}`)}
        </option>
      ))}
    </Select>
  )

  return (
    <>
      <section className="fw-rm-section" aria-labelledby="fw-rm-phrases">
        <SectionHead id="fw-rm-phrases" title={t('phrases.title')} note={t('phrases.note')}>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('phrases.add')}
          </Button>
        </SectionHead>
        <Banner tone="info" title={t('phrases.gate')} />
        {!state || state.phrases.status === 'loading' ? (
          <SectionLoading rows={6} />
        ) : state.phrases.status === 'error' ? (
          <SectionFailed title={t('phrases.failed')} problem={state.phrases.problem} onRetry={actions?.phrases?.onRetry} />
        ) : (
          <ListFrame<Phrase>
            label={t('phrases.title')}
            title={t('phrases.title')}
            listKey="compliance.settings.phrases"
            rows={rows}
            rowId={(row) => row.key}
            columns={columns}
            count={t('phrases.count', { count: rows?.length ?? 0, languages: languages.length })}
            search={search}
            tools={filters}
            selection={
              canManage
                ? {
                    selected,
                    onChange: (keys) => actions?.phrases?.onSelected?.(keys),
                    actions: (
                      <Button size="sm" aria-label={t('phrases.archiveMany', { count: picked.length })} heldReason={offline ? t('held.offline') : null} onClick={() => actions?.phrases?.onArchiveMany?.(picked.map((row) => row.key))}>
                        <Archive size={13} aria-hidden /> <SelectionLabel>{t('phrases.archiveMany', { count: picked.length })}</SelectionLabel>
                      </Button>
                    ),
                  }
                : undefined
            }
            keys={PAGE_KEYS(t)}
            onHelp={onHelp}
            onOpen={(row) => actions?.onAddress?.({ open: row.key })}
            state={
              rows && rows.length === 0 ? (
                filtered ? (
                  <EmptyState
                    icon={<Languages size={22} aria-hidden />}
                    title={t('phrases.noneFiltered')}
                    action={
                      <Button size="sm" onClick={() => actions?.onAddress?.({ q: '', kind: null })}>
                        {t('common.clearFilters')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState icon={<Languages size={22} aria-hidden />} title={t('phrases.emptyTitle')} description={t('phrases.empty')} />
                )
              ) : undefined
            }
            cards={{ fields: { key: { role: 'title' }, source: { role: 'subtitle' } } }}
          />
        )}
      </section>
      {state?.add && <NewPhraseDialog state={state} actions={actions} />}
      {state?.open && <PhraseWindow model={model} state={state} actions={actions} languages={languages} />}
    </>
  )
}

/** New phrase: its key (fixed after), kind, source language (Italian by default) and words. */
function NewPhraseDialog({ state, actions }: { state: PhrasesState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const add = state.add!
  const draft = add.draft
  const set = (next: Partial<PhraseDraft>) => actions?.phrases?.onAddDraft?.({ ...draft, ...next })
  const held = add.writing.busy ? 'held.busy' : phraseHeld(draft)
  const close = () => actions?.onAddress?.({ add: false })
  return (
    <Modal
      open
      onClose={close}
      title={t('phrases.addTitle')}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.phrases?.onAddSave?.()}>
            {t('phrases.addSave')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form-grid">
        <Field label={t('field.phraseKey')} hint={t('phrases.keyHint')} required>
          <Input size="sm" value={draft.key} maxLength={100} placeholder="warning.class-b" onChange={(event) => set({ key: event.target.value })} />
        </Field>
        <Field label={t('field.kind')} required>
          <Select size="sm" value={draft.kind ?? ''} onChange={(event) => set({ kind: (event.target.value || null) as PhraseDraft['kind'] })}>
            <option value="">{t('common.choose')}</option>
            {PHRASE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`phraseKind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('field.sourceLanguage')} hint={t('phrases.sourceLanguageHint')}>
          <Input size="sm" value={draft.sourceLanguage} maxLength={3} onChange={(event) => set({ sourceLanguage: event.target.value.toLowerCase() })} />
        </Field>
        <div className="fw-rm-span">
          <Field label={t('field.sourceText')} required>
            <Textarea value={draft.sourceText} rows={3} maxLength={4000} onChange={(event) => set({ sourceText: event.target.value })} />
          </Field>
        </div>
        <div className="fw-rm-span">
          <Field label={t('field.note')}>
            <Textarea value={draft.note} rows={2} maxLength={2000} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </div>
        <div className="fw-rm-span">
          <WriteProblem writing={add.writing} />
        </div>
      </div>
    </Modal>
  )
}

/**
 * The phrase's window: the source words (new words = the next revision; approved translations go stale), then per language its
 * state, the approved words and the words waiting for approval: propose (or replace the waiting draft), approve through the DS
 * SignOffPanel (a second person; never the author), withdraw a draft; the history of every translation.
 */
function PhraseWindow({ model, state, actions, languages }: { model: RulesMarketsModel; state: PhrasesState; actions?: RulesMarketsActions | undefined; languages: readonly string[] }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const open = state.open!
  const close = () => actions?.onAddress?.({ open: null })
  const offline = model.live === 'offline'
  const answer = valueOf(state.phrases)
  const mayManage = model.can.phrasesManage && (answer?.mayManage ?? true) && !offline
  const mayApprove = model.can.phrasesApprove && (answer?.mayApprove ?? true) && !offline
  const busy = open.writing.busy
  const when = (at: string | null | undefined) => (at ? formatDateTime(at, { locale }) : '')

  const body = () => {
    if (open.read.status === 'loading') return <SectionLoading rows={5} />
    if (open.read.status === 'error') return <SectionFailed title={t('phrases.phraseFailed')} problem={open.read.problem} onRetry={actions?.phrases?.onRetryOpen} />
    const { phrase, history } = open.read.value
    const tags = [...new Set([...languages, ...phrase.cells.map((cell) => cell.language)])].filter((tag) => tag !== phrase.sourceLanguage)
    return (
      <div className="fw-rm-form">
        {open.saved && <NoticeBanner tone={open.saved.tone} title={t(open.saved.key, open.saved.params)} />}
        <div className="fw-rm-panel">
          <h3 className="fw-rm-h3">{t('phrases.sourceTitle', { language: languageName(phrase.sourceLanguage, locale), revision: phrase.revision })}</h3>
          {open.source === null ? (
            <>
              <p>{phrase.sourceText}</p>
              <span className="fw-rm-row">
                <Button size="sm" heldReason={mayManage ? null : t(offline ? 'held.offline' : 'held.phrasesManage')} onClick={() => actions?.phrases?.onSource?.(phrase.sourceText)}>
                  {t('phrases.changeSource')}
                </Button>
              </span>
            </>
          ) : (
            <>
              <Field label={t('field.sourceText')} hint={t('phrases.staleWarning')}>
                <Textarea value={open.source} rows={3} maxLength={4000} onChange={(event) => actions?.phrases?.onSource?.(event.target.value)} />
              </Field>
              <span className="fw-rm-row">
                <Button size="sm" onClick={() => actions?.phrases?.onSource?.(null)}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" variant="primary" heldReason={busy ? t('held.busy') : open.source.trim() === '' || open.source.trim() === phrase.sourceText ? t('held.nothingChanged') : null} onClick={() => actions?.phrases?.onSourceSave?.()}>
                  {t('phrases.sourceSave')}
                </Button>
              </span>
            </>
          )}
        </div>
        {tags.map((tag) => {
          const cell = phrase.cells.find((entry) => entry.language === tag) ?? { language: tag, state: 'MISSING' as const, approved: null, draft: null }
          const typing = open.language === tag
          const approve = cell.draft ? approveHeld({ mayApprove, draftBy: cell.draft.proposedBy?.id ?? null, me: model.me, busy }) : null
          const steps: SignOffStep[] = cell.draft
            ? [
                { id: 'proposed', label: t('phrases.stepProposed'), state: 'signed', signer: cell.draft.proposedBy?.name ?? '—', method: 'typed' },
                {
                  id: 'approve',
                  label: t('phrases.stepApprove'),
                  role: t('role.quality_inspector'),
                  state: approve && approve !== 'held.busy' ? 'held' : 'waiting',
                  whoMay: t('phrases.whoMay'),
                  heldReason: approve && approve !== 'held.busy' ? t(approve) : null,
                  rules: [{ id: 'four', kind: 'authorNotApprover', state: cell.draft.proposedBy?.id === model.me ? 'broken' : 'met' }],
                  action: { label: t('phrases.approve'), onClick: () => actions?.phrases?.onApprove?.(tag), busy, busyLabel: t('common.working') },
                },
              ]
            : []
          return (
            <div key={tag} className="fw-rm-panel">
              <div className="fw-rm-head">
                <h3 className="fw-rm-h3">
                  {languageName(tag, locale)} <span className="fw-rm-muted">({tag})</span>
                </h3>
                <Pill tone={CELL_TONE[cell.state]} dot>
                  {t(`cell.${cell.state}`)}
                </Pill>
              </div>
              {cell.approved && (
                <p>
                  {cell.approved.text}{' '}
                  <span className="fw-rm-muted">
                    {t('phrases.approvedBy', { name: cell.approved.approvedBy?.name ?? '—', when: when(cell.approved.approvedAt) })}
                    {cell.state === 'STALE' ? ` · ${t('phrases.staleNote')}` : ''}
                  </span>
                </p>
              )}
              {cell.draft && (
                <>
                  <p>
                    {cell.draft.text} <span className="fw-rm-muted">{t('phrases.proposedBy', { name: cell.draft.proposedBy?.name ?? '—' })}</span>
                  </p>
                  <SignOffPanel title={t('phrases.signOff')} steps={steps} labels={ds.signOffPanel} headingLevel={4} />
                </>
              )}
              {typing ? (
                <>
                  <Field label={t('phrases.wordsIn', { language: languageName(tag, locale) })}>
                    <Textarea value={open.text} rows={2} maxLength={4000} onChange={(event) => actions?.phrases?.onText?.(event.target.value)} />
                  </Field>
                  <span className="fw-rm-row">
                    <Button size="sm" onClick={() => actions?.phrases?.onLanguage?.(null)}>
                      {t('common.cancel')}
                    </Button>
                    <Button size="sm" variant="primary" heldReason={busy ? t('held.busy') : open.text.trim() === '' ? t('held.words') : null} onClick={() => actions?.phrases?.onPropose?.()}>
                      {cell.draft ? t('phrases.replace') : t('phrases.propose')}
                    </Button>
                  </span>
                </>
              ) : (
                <span className="fw-rm-row">
                  <Button size="sm" heldReason={mayManage ? null : t(offline ? 'held.offline' : 'held.phrasesManage')} onClick={() => actions?.phrases?.onLanguage?.(tag)}>
                    {cell.draft ? t('phrases.changeDraft') : t('phrases.proposeWords')}
                  </Button>
                  {cell.draft && (
                    <Button size="sm" variant="quiet" heldReason={mayManage ? (busy ? t('held.busy') : null) : t('held.phrasesManage')} onClick={() => actions?.phrases?.onWithdraw?.(tag)}>
                      {t('phrases.withdraw')}
                    </Button>
                  )}
                </span>
              )}
            </div>
          )
        })}
        <WriteProblem writing={open.writing} />
        {history.length > 0 && (
          <>
            <h3 className="fw-rm-h3">{t('phrases.history')}</h3>
            <ul className="fw-rm-lines">
              {history.map((entry) => (
                <li key={entry.id}>
                  <b>{entry.language}</b> r{entry.revision} · {t(`translationStatus.${entry.status}`)} · {entry.text}{' '}
                  <span className="fw-rm-muted">{t('phrases.historyBy', { proposed: entry.proposedBy?.name ?? '—', approved: entry.approvedBy?.name ?? '—' })}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    )
  }
  const phrase = valueOf(open.read)?.phrase
  return (
    <Modal open onClose={close} title={phrase ? phrase.key : open.key} subtitle={phrase ? t(`phraseKind.${phrase.kind}`) : undefined} size="lg">
      {body()}
    </Modal>
  )
}
