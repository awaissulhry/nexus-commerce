'use client'

import { useEffect, useMemo, useRef } from 'react'
import { Globe2, Plus, Power, Trash2 } from 'lucide-react'
import { Card, EmptyState, Field } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { LanguageMatrix, type LanguageMatrixWords } from '../../_shared/language-matrix/LanguageMatrix'
import type { Market } from '../api'
import { markKey, marketHeld, marketName, reasonHeld, rulesHeld, valueOf, type MarketDraft, type MarketList, type RuleDraft } from '../model'
import type { MarketsState, RulesMarketsActions, RulesMarketsModel } from '../view-model'
import { languageName, PAGE_KEYS, SaveMark, SectionFailed, SectionHead, SectionLoading, WriteProblem, useWords } from './parts'

const typing = () => (params: { event: KeyboardEvent; editing: boolean }) => {
  const event = params.event
  if (params.editing || event.metaKey || event.ctrlKey || event.altKey) return false
  return event.key.length === 1 && event.key !== ' '
}

/**
 * Markets (design rm-markets; PRD-275; B-W2b-249): per destination the languages of the label, the declaration and the user
 * information, the marks (CE, UKCA), the national extras, whether an importer or authorised representative and a GPSR contact
 * are needed, and whether the factory sells there (off with the question it waits for). The LanguageMatrix above shows what
 * each switched-on market will need, with how many phrases print in each language. Cells autosave one by one at the row's
 * version (languages typed "de, fr"); Switch on N over the rows chosen; the market's window keeps its national rules and note.
 */
export function MarketsTab({ model, state, actions, onHelp }: { model: RulesMarketsModel; state: MarketsState | undefined; actions?: RulesMarketsActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const answer = state ? valueOf(state.markets) : null
  const canManage = model.can.rulesManage && (answer?.mayManage ?? true)
  const offline = model.live === 'offline'
  const latest = useRef({ marks: state?.marks ?? {}, actions })
  latest.current = { marks: state?.marks ?? {}, actions }
  const selected = state?.selected ?? []
  const rows = answer?.markets ?? null
  useEffect(() => {
    if (rows && selected.some((code) => !rows.some((row) => row.code === code))) actions?.markets?.onSelected?.(selected.filter((code) => rows.some((row) => row.code === code)))
  }, [rows, selected, actions])
  const editable = canManage && !offline

  const columns = useMemo<ColDef<Market>[]>(() => {
    const mark = (code: string, field: string) => latest.current.marks[markKey(code, field)]
    const list = (field: MarketList, header: string): ColDef<Market> => ({
      colId: field,
      headerName: header,
      minWidth: 130,
      flex: 0.9,
      wrapHeaderText: true,
      autoHeaderHeight: true,
      valueGetter: (params) => (params.data ? params.data[field].join(', ') : ''),
      ...(editable ? { editable: (params: { data?: Market }) => params.data?.status === 'ACTIVE', cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 200 } } : {}),
      suppressKeyboardEvent: typing(),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.markets?.onList?.(params.data.code, field, String(params.newValue ?? ''))
        return false
      },
      cellRenderer: ({ data }: ICellRendererParams<Market>) =>
        data ? (
          <span className="fw-rm-cell-row">
            <span className={data[field].length === 0 ? 'fw-rm-muted' : 'fw-rm-code'}>{data[field].length === 0 ? t('markets.none') : data[field].join(' · ').toUpperCase()}</span>
            <SaveMark mark={mark(data.code, field)} />
          </span>
        ) : null,
    })
    const need = (field: 'importerNeeded' | 'gpsrContactNeeded', header: string): ColDef<Market> => ({
      colId: field,
      headerName: header,
      minWidth: 140,
      flex: 0.8,
      wrapHeaderText: true,
      autoHeaderHeight: true,
      valueGetter: (params) => (params.data ? (params.data[field] ? t('common.yes') : t('common.no')) : ''),
      cellRenderer: ({ data }: ICellRendererParams<Market>) =>
        data ? (
          <span className="fw-rm-cell-row">
            {canManage ? <Toggle size="xs" checked={data[field]} disabled={!editable || data.status !== 'ACTIVE'} title={offline ? t('held.offline') : data.status !== 'ACTIVE' ? t('held.archived') : undefined} aria-label={t(`markets.${field}Of`, { code: data.code })} onChange={(next) => latest.current.actions?.markets?.onNeed?.(data.code, field, next)} /> : null}
            <span>{data[field] ? t('common.yes') : t('common.no')}</span>
            <SaveMark mark={mark(data.code, field)} />
          </span>
        ) : null,
    })
    return [
      {
        colId: 'code',
        headerName: t('markets.col.market'),
        minWidth: 170,
        flex: 1.2,
        valueGetter: (params) => (params.data ? marketName(params.data, locale) : ''),
        ...(editable ? { editable: (params: { data?: Market }) => params.data?.status === 'ACTIVE', cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 200 } } : {}),
        suppressKeyboardEvent: typing(),
        valueSetter: (params) => {
          if (params.data) latest.current.actions?.markets?.onName?.(params.data.code, String(params.newValue ?? ''))
          return false
        },
        autoHeight: true,
        cellRenderer: ({ data }: ICellRendererParams<Market>) =>
          data ? (
            <span className="fw-rm-cell">
              <span className="fw-rm-cell-row">
                <span className="fw-rm-code">{data.code}</span> <span>{marketName(data, locale)}</span>
                <SaveMark mark={mark(data.code, 'name')} />
              </span>
              {data.status === 'ARCHIVED' && <span className="fw-rm-muted">{t('markets.archived')}</span>}
            </span>
          ) : null,
      },
      list('labelLanguages', t('markets.col.label')),
      list('docLanguages', t('markets.col.doc')),
      list('userInfoLanguages', t('markets.col.userInfo')),
      list('markings', t('markets.col.marks')),
      {
        colId: 'nationalRules',
        headerName: t('markets.col.extras'),
        minWidth: 170,
        flex: 1.2,
        wrapText: true,
        autoHeight: true,
        valueGetter: (params) => (params.data ? params.data.nationalRules.map((rule) => rule.words[locale] ?? rule.words.en ?? rule.key).join('; ') : ''),
        cellRenderer: ({ data }: ICellRendererParams<Market>) =>
          data ? (
            data.nationalRules.length === 0 ? (
              <span className="fw-rm-muted">{t('markets.noExtras')}</span>
            ) : (
              <span className="fw-rm-cell">
                {data.nationalRules.slice(0, 2).map((rule) => (
                  <span key={rule.key}>{rule.words[locale] ?? rule.words.en ?? Object.values(rule.words)[0] ?? rule.key}</span>
                ))}
                {data.nationalRules.length > 2 && <span className="fw-rm-muted">{t('markets.moreExtras', { count: data.nationalRules.length - 2 })}</span>}
              </span>
            )
          ) : null,
      },
      need('importerNeeded', t('markets.col.importer')),
      need('gpsrContactNeeded', t('markets.col.gpsr')),
      {
        colId: 'switchedOn',
        headerName: t('markets.col.sells'),
        minWidth: 170,
        flex: 1.1,
        wrapText: true,
        autoHeight: true,
        valueGetter: (params) => (params.data ? (params.data.switchedOn ? t('markets.on') : t('markets.off')) : ''),
        cellRenderer: ({ data }: ICellRendererParams<Market>) =>
          data ? (
            <span className="fw-rm-cell">
              <span className="fw-rm-cell-row">
                {canManage ? <Toggle size="xs" checked={data.switchedOn} disabled={!editable || data.status !== 'ACTIVE'} title={offline ? t('held.offline') : data.status !== 'ACTIVE' ? t('held.archived') : undefined} aria-label={t('markets.switchOf', { code: data.code })} onChange={(next) => latest.current.actions?.markets?.onSwitch?.(data.code, next)} /> : null}
                <Pill tone={data.switchedOn ? 'success' : 'neutral'}>{data.switchedOn ? t('markets.on') : t('markets.off')}</Pill>
                <SaveMark mark={mark(data.code, 'switchedOn')} />
              </span>
              {!data.switchedOn && data.offReason ? <span className="fw-rm-muted">{data.offReason}</span> : null}
            </span>
          ) : null,
      },
    ]
  }, [t, locale, editable, canManage, offline])

  const words: LanguageMatrixWords = {
    label: t('matrix.label'),
    market: t('matrix.market'),
    short: { LABEL: t('matrix.short.LABEL'), DOC: t('matrix.short.DOC'), USER_INFO: t('matrix.short.USER_INFO') },
    long: { LABEL: t('matrix.long.LABEL'), DOC: t('matrix.long.DOC'), USER_INFO: t('matrix.long.USER_INFO') },
    off: t('markets.off'),
    none: t('matrix.none'),
    coverageRow: t('matrix.coverageRow'),
    coverage: (entry) => (entry.missing + entry.stale > 0 ? t('matrix.coverageMissing', { missing: entry.missing + entry.stale, ready: entry.ready, total: entry.inLibrary }) : entry.proposed > 0 ? t('matrix.coverageWaiting', { proposed: entry.proposed, ready: entry.ready, total: entry.inLibrary }) : t('matrix.coverageReady', { ready: entry.ready, total: entry.inLibrary })),
    noCoverage: t('matrix.noCoverage'),
    legend: t('matrix.legend'),
    empty: t('matrix.empty'),
  }
  const languages = state ? valueOf(state.languages) : null
  /** The matrix names each market in the page's language, as the list does. */
  const names = new Map((rows ?? []).map((row) => [row.code, marketName(row, locale)]))
  const switchable = (rows ?? []).filter((row) => selected.includes(row.code) && !row.switchedOn && row.status === 'ACTIVE')
  const addHeld = canManage ? (offline ? t('held.offline') : null) : t('held.rulesManage')

  return (
    <>
      <Card header={t('matrix.title')} description={t('matrix.description')} headingLevel={2} className="fw-rm-card">
        {!state || state.languages.status === 'loading' ? (
          <SectionLoading rows={3} />
        ) : state.languages.status === 'error' ? (
          <SectionFailed title={t('matrix.failed')} problem={state.languages.problem} onRetry={actions?.markets?.onRetry} />
        ) : (
          <LanguageMatrix data={{ ...languages!.matrix, markets: languages!.matrix.markets.map((row) => ({ ...row, name: names.get(row.code) ?? row.name })) }} coverage={languages!.phrases} words={words} languageName={(tag) => languageName(tag, locale)} />
        )}
      </Card>
      <section className="fw-rm-section" aria-labelledby="fw-rm-markets">
        <SectionHead id="fw-rm-markets" title={t('markets.title')} note={t('markets.note')}>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('markets.add')}
          </Button>
        </SectionHead>
        {!state || state.markets.status === 'loading' ? (
          <SectionLoading rows={6} />
        ) : state.markets.status === 'error' ? (
          <SectionFailed title={t('markets.failed')} problem={state.markets.problem} onRetry={actions?.markets?.onRetry} />
        ) : (
          <ListFrame<Market>
            label={t('markets.title')}
            title={t('markets.title')}
            listKey="compliance.settings.markets"
            rows={rows}
            rowId={(row) => row.code}
            columns={columns}
            count={t('markets.count', { count: rows?.length ?? 0 })}
            selection={
              canManage
                ? {
                    selected,
                    onChange: (codes) => actions?.markets?.onSelected?.(codes),
                    actions: (
                      <Button size="sm" variant="primary" aria-label={t('markets.switchOnMany', { count: switchable.length })} heldReason={switchable.length === 0 ? t('held.noneOff') : offline ? t('held.offline') : null} onClick={() => actions?.markets?.onSwitchOnMany?.(switchable.map((row) => row.code))}>
                        <Power size={13} aria-hidden /> <SelectionLabel>{t('markets.switchOnMany', { count: switchable.length })}</SelectionLabel>
                      </Button>
                    ),
                  }
                : undefined
            }
            isRowSelectable={canManage ? (row) => (row.status === 'ARCHIVED' ? t('held.archived') : null) : undefined}
            keys={PAGE_KEYS(t)}
            onHelp={onHelp}
            onOpen={(row) => actions?.onAddress?.({ open: row.code })}
            state={rows && rows.length === 0 ? <EmptyState icon={<Globe2 size={22} aria-hidden />} title={t('markets.emptyTitle')} description={t('markets.empty')} /> : undefined}
            cards={{ fields: { code: { role: 'title' }, labelLanguages: { role: 'subtitle' }, switchedOn: { role: 'aside' } } }}
          />
        )}
      </section>
      {state?.add && <NewMarketDialog state={state} actions={actions} />}
      {state?.open && <MarketWindow model={model} state={state} actions={actions} />}
      {state?.off && <SwitchOffDialog state={state} actions={actions} />}
    </>
  )
}

/** New market: code (fixed after), name, the three language lists, marks, the needs, on (or off with why). */
function NewMarketDialog({ state, actions }: { state: MarketsState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const add = state.add!
  const draft = add.draft
  const set = (next: Partial<MarketDraft>) => actions?.markets?.onAddDraft?.({ ...draft, ...next })
  const held = add.writing.busy ? 'held.busy' : marketHeld(draft)
  const close = () => actions?.onAddress?.({ add: false })
  return (
    <Modal
      open
      onClose={close}
      title={t('markets.addTitle')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.markets?.onAddSave?.()}>
            {t('markets.addSave')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form-grid">
        <Field label={t('field.marketCode')} hint={t('markets.codeHint')} required>
          <Input size="sm" value={draft.code} maxLength={40} placeholder="NL" onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
        </Field>
        <Field label={t('field.name')} required>
          <Input size="sm" value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label={t('markets.col.label')} hint={t('markets.languagesHint')}>
          <Input size="sm" value={draft.labelLanguages} placeholder="nl, en" onChange={(event) => set({ labelLanguages: event.target.value })} />
        </Field>
        <Field label={t('markets.col.doc')} hint={t('markets.languagesHint')}>
          <Input size="sm" value={draft.docLanguages} placeholder="nl" onChange={(event) => set({ docLanguages: event.target.value })} />
        </Field>
        <Field label={t('markets.col.userInfo')} hint={t('markets.languagesHint')}>
          <Input size="sm" value={draft.userInfoLanguages} placeholder="nl" onChange={(event) => set({ userInfoLanguages: event.target.value })} />
        </Field>
        <Field label={t('markets.col.marks')} hint={t('markets.marksHint')}>
          <Input size="sm" value={draft.markings} placeholder="CE" onChange={(event) => set({ markings: event.target.value })} />
        </Field>
        <Field label={t('markets.col.importer')}>
          <span className="fw-rm-cell-row">
            <Toggle checked={draft.importerNeeded} aria-label={t('markets.col.importer')} onChange={(next) => set({ importerNeeded: next })} />
            <span>{draft.importerNeeded ? t('common.yes') : t('common.no')}</span>
          </span>
        </Field>
        <Field label={t('markets.col.gpsr')}>
          <span className="fw-rm-cell-row">
            <Toggle checked={draft.gpsrContactNeeded} aria-label={t('markets.col.gpsr')} onChange={(next) => set({ gpsrContactNeeded: next })} />
            <span>{draft.gpsrContactNeeded ? t('common.yes') : t('common.no')}</span>
          </span>
        </Field>
        <Field label={t('markets.col.sells')} hint={t('markets.sellsHint')}>
          <span className="fw-rm-cell-row">
            <Toggle checked={draft.switchedOn} aria-label={t('markets.col.sells')} onChange={(next) => set({ switchedOn: next })} />
            <span>{draft.switchedOn ? t('markets.on') : t('markets.off')}</span>
          </span>
        </Field>
        {!draft.switchedOn && (
          <Field label={t('markets.offReason')} hint={t('markets.offReasonHint')} required>
            <Textarea value={draft.offReason} rows={2} maxLength={500} onChange={(event) => set({ offReason: event.target.value })} />
          </Field>
        )}
        <div className="fw-rm-span">
          <WriteProblem writing={add.writing} />
        </div>
      </div>
    </Modal>
  )
}

/** Switching a market off: why, in words (the question it waits for). */
function SwitchOffDialog({ state, actions }: { state: MarketsState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const off = state.off!
  const held = off.writing.busy ? 'held.busy' : reasonHeld(off.reason)
  return (
    <Modal
      open
      onClose={() => actions?.markets?.onOffCancel?.()}
      title={t('markets.offTitle', { code: off.code })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.markets?.onOffCancel?.()}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.markets?.onOffConfirm?.()}>
            {t('markets.offSave')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form">
        <p className="fw-rm-muted">{t('markets.offBody')}</p>
        <Field label={t('markets.offReason')} hint={t('markets.offReasonHint')} required>
          <Textarea value={off.reason} rows={3} maxLength={500} onChange={(event) => actions?.markets?.onOffReason?.(event.target.value)} />
        </Field>
        <WriteProblem writing={off.writing} />
      </div>
    </Modal>
  )
}

/** The market's window: its national extras (key, words in Italian and English, law, link), its note; archive or restore. */
function MarketWindow({ model, state, actions }: { model: RulesMarketsModel; state: MarketsState; actions?: RulesMarketsActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const open = state.open!
  const market = valueOf(state.markets)?.markets.find((row) => row.code === open.code) ?? null
  const canManage = model.can.rulesManage && model.live !== 'offline'
  const close = () => actions?.onAddress?.({ open: null })
  const set = (index: number, next: Partial<RuleDraft>) => actions?.markets?.onRules?.(open.rules.map((rule, at) => (at === index ? { ...rule, ...next } : rule)))
  const held = !canManage ? t('held.rulesManage') : open.writing.busy ? t('held.busy') : rulesHeld(open.rules) ? t(rulesHeld(open.rules)!) : null
  if (!market) {
    return (
      <Modal open onClose={close} title={open.code} size="md">
        {state.markets.status === 'loading' ? <SectionLoading rows={3} /> : <EmptyState title={t('markets.notFound')} />}
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={close}
      title={`${market.code} · ${marketName(market, locale)}`}
      subtitle={market.switchedOn ? t('markets.on') : t('markets.offWhy', { reason: market.offReason ?? '' })}
      size="lg"
      footer={
        <>
          <Button variant="quiet" heldReason={canManage ? null : t('held.rulesManage')} onClick={() => actions?.markets?.onArchive?.(market.code, market.status === 'ACTIVE')}>
            {market.status === 'ACTIVE' ? t('markets.archive') : t('markets.restore')}
          </Button>
          <Button onClick={close}>{t('common.close')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.markets?.onWindowSave?.()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form">
        <h3 className="fw-rm-h3">{t('markets.extrasTitle')}</h3>
        <p className="fw-rm-muted">{t('markets.extrasNote')}</p>
        {open.rules.length === 0 && <p className="fw-rm-muted">{t('markets.noExtras')}</p>}
        {open.rules.map((rule, index) => (
          <div key={index} className="fw-rm-panel fw-rm-form-grid">
            <Field label={t('field.ruleKey')} required>
              <Input size="sm" value={rule.key} maxLength={60} disabled={!canManage} onChange={(event) => set(index, { key: event.target.value })} />
            </Field>
            <Field label={t('field.law')}>
              <Input size="sm" value={rule.law} maxLength={300} disabled={!canManage} onChange={(event) => set(index, { law: event.target.value })} />
            </Field>
            <Field label={t('field.wordsIt')}>
              <Textarea value={rule.it} rows={2} maxLength={2000} disabled={!canManage} onChange={(event) => set(index, { it: event.target.value })} />
            </Field>
            <Field label={t('field.wordsEn')}>
              <Textarea value={rule.en} rows={2} maxLength={2000} disabled={!canManage} onChange={(event) => set(index, { en: event.target.value })} />
            </Field>
            <Field label={t('field.link')}>
              <Input size="sm" value={rule.href} maxLength={2000} placeholder="https://" disabled={!canManage} onChange={(event) => set(index, { href: event.target.value })} />
            </Field>
            <span className="fw-rm-row fw-rm-end">
              <Button size="sm" variant="quiet" heldReason={canManage ? null : t('held.rulesManage')} onClick={() => actions?.markets?.onRules?.(open.rules.filter((_, at) => at !== index))}>
                <Trash2 size={13} aria-hidden /> {t('markets.removeExtra')}
              </Button>
            </span>
          </div>
        ))}
        <span className="fw-rm-row">
          <Button size="sm" heldReason={canManage ? (open.rules.length >= 50 ? t('held.tooMany') : null) : t('held.rulesManage')} onClick={() => actions?.markets?.onRules?.([...open.rules, { key: '', it: '', en: '', law: '', href: '' }])}>
            <Plus size={13} aria-hidden /> {t('markets.addExtra')}
          </Button>
        </span>
        <Field label={t('field.note')}>
          <Textarea value={open.note} rows={2} maxLength={2000} disabled={!canManage} onChange={(event) => actions?.markets?.onNote?.(event.target.value)} />
        </Field>
        <WriteProblem writing={open.writing} />
      </div>
    </Modal>
  )
}
