'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PhraseKind } from '@nexus/factory-domain/compliance/phrases/rules'
import { newIdempotencyKey } from '../../../lib/api/client'
import { approveTranslation, createMarket, createPhrase, editMarket, editPhrase, proposeTranslation, readLanguages, readMarkets, readPhrase, readPhrases, switchMarket, withdrawTranslation, type LanguagesAnswer, type MarketEdit, type MarketsAnswer, type PhrasesAnswer, type PhraseRecord } from './api'
import { EMPTY_MARKET, EMPTY_PHRASE, marketBodyOf, marketListOf, PHRASE_KINDS, ruleDraftsOf, rulesBodyOf, valueOf } from './model'
import { each, useMarks, useRead, writingOf, type TabContext } from './use-settings'
import { IDLE, type MarketsActions, type MarketsState, type MarketWindowState, type PhrasesActions, type PhrasesState, type PhraseWindowState } from './view-model'

/**
 * Markets (rm-markets): the markets (archived too) and the LanguageMatrix with the phrase coverage, each cell autosaved at the
 * row's version, the switch (off asks why), Switch on N, New market, the market's window (national rules, note, archive).
 */
export function useMarkets(context: TabContext): { state: MarketsState; actions: MarketsActions } {
  const { api, active, can, address, go, notify, stamp, tick } = context
  const [markets, loadMarkets, setMarkets] = useRead<MarketsAnswer>()
  const [languages, loadLanguages] = useRead<LanguagesAnswer>()
  const [marks, setMark, saveCell] = useMarks()
  const [selected, setSelected] = useState<string[]>([])
  const [add, setAdd] = useState<MarketsState['add']>(null)
  const [open, setOpen] = useState<MarketWindowState | null>(null)
  const [off, setOff] = useState<MarketsState['off']>(null)

  const read = useCallback(
    (quiet = false) => {
      if (!can.view) return
      void loadMarkets(() => readMarkets(api, 'ALL'), quiet).then((value) => value && stamp())
      void loadLanguages(() => readLanguages(api), quiet)
    },
    [api, can.view, loadMarkets, loadLanguages, stamp],
  )
  useEffect(() => {
    if (active) read()
  }, [active, read])
  useEffect(() => {
    if (active && tick > 0) read(true)
  }, [tick])

  const rowOf = (code: string) => valueOf(markets)?.markets.find((row) => row.code === code) ?? null
  const replace = (next: MarketsAnswer['markets'][number]) =>
    setMarkets((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, markets: current.value.markets.map((row) => (row.code === next.code ? next : row)) } } : current))
  const patch = (code: string, field: string, body: Omit<MarketEdit, 'version'>) => {
    const row = rowOf(code)
    if (!row) return
    void saveCell(code, field, async () => {
      const next = await editMarket(api, code, { version: row.version, ...body }, newIdempotencyKey())
      replace(next)
      void loadLanguages(() => readLanguages(api), true)
      return next
    })
  }

  useEffect(() => {
    if (!active || !address.add || !can.rulesManage) return setAdd(null)
    setAdd((current) => current ?? { draft: EMPTY_MARKET, writing: IDLE })
  }, [active, address.add, can.rulesManage])

  const answer = valueOf(markets)
  useEffect(() => {
    if (!active || !address.open) return setOpen(null)
    const row = answer?.markets.find((entry) => entry.code === address.open)
    setOpen((current) => (current && current.code === address.open ? current : { code: address.open!, rules: row ? ruleDraftsOf(row) : [], note: row?.note ?? '', writing: IDLE }))
  }, [active, address.open, answer])

  const switchOn = (code: string) => {
    const row = rowOf(code)
    if (!row) return Promise.resolve()
    return saveCell(code, 'switchedOn', async () => {
      const next = await switchMarket(api, code, { version: row.version, on: true, reason: null }, newIdempotencyKey())
      replace(next)
      read(true)
      return next
    })
  }

  return {
    state: { markets, languages, marks, selected, add, open, off },
    actions: {
      onList: (code, field, text) => {
        const row = rowOf(code)
        if (!row) return
        const { codes, problem } = marketListOf(field, text)
        if (problem) return setMark(code, field, { state: 'refused', problem })
        if (codes.join(',') === row[field].join(',')) return
        patch(code, field, { [field]: codes })
      },
      onName: (code, name) => {
        const row = rowOf(code)
        if (!row || name.trim() === row.name) return
        if (name.trim() === '') return setMark(code, 'name', { state: 'refused', problem: 'held.name' })
        patch(code, 'name', { name: name.trim() })
      },
      onNeed: (code, field, value) => patch(code, field, { [field]: value }),
      onSwitch: (code, on) => {
        if (on) void switchOn(code)
        else setOff({ code, reason: '', writing: IDLE })
      },
      onOffReason: (reason) => setOff((current) => (current ? { ...current, reason, writing: IDLE } : current)),
      onOffCancel: () => setOff(null),
      onOffConfirm: () => {
        if (!off) return
        const row = rowOf(off.code)
        if (!row) return
        setOff({ ...off, writing: { busy: true, problem: null } })
        switchMarket(api, off.code, { version: row.version, on: false, reason: off.reason.trim() }, newIdempotencyKey()).then(
          (next) => {
            replace(next)
            setOff(null)
            notify({ tone: 'success', key: 'notice.marketOff', params: { code: next.code } })
            read(true)
          },
          (error) => setOff((current) => (current ? { ...current, writing: writingOf(error) } : current)),
        )
      },
      onSelected: setSelected,
      onSwitchOnMany: (codes) => {
        void each(codes, async (code) => {
          if (!(await switchOn(code))) throw new Error(`Market ${code} was not switched on.`)
        }).then((result) => {
          setSelected([])
          notify(result.refused.length > 0 ? { tone: 'warning', key: 'notice.marketsOnPartly', params: { done: result.done, refused: result.refused.length } } : { tone: 'success', key: 'notice.marketsOn', params: { count: result.done } })
        })
      },
      onAddDraft: (draft) => setAdd((current) => (current ? { draft, writing: IDLE } : current)),
      onAddSave: () => {
        if (!add) return
        setAdd({ ...add, writing: { busy: true, problem: null } })
        createMarket(api, marketBodyOf(add.draft), newIdempotencyKey()).then(
          (market) => {
            notify({ tone: 'success', key: 'notice.marketAdded', params: { code: market.code } })
            setAdd(null)
            read(true)
            go({ add: false })
          },
          (error) => setAdd((current) => (current ? { ...current, writing: writingOf(error, 'create') } : current)),
        )
      },
      onRules: (rules) => setOpen((current) => (current ? { ...current, rules, writing: IDLE } : current)),
      onNote: (note) => setOpen((current) => (current ? { ...current, note, writing: IDLE } : current)),
      onWindowSave: () => {
        if (!open) return
        const row = rowOf(open.code)
        if (!row) return
        setOpen({ ...open, writing: { busy: true, problem: null } })
        editMarket(api, open.code, { version: row.version, nationalRules: rulesBodyOf(open.rules), note: open.note.trim() || null }, newIdempotencyKey()).then(
          (next) => {
            replace(next)
            notify({ tone: 'success', key: 'notice.marketSaved', params: { code: next.code } })
            go({ open: null })
          },
          (error) => setOpen((current) => (current ? { ...current, writing: writingOf(error) } : current)),
        )
      },
      onArchive: (code, archive) => {
        const row = rowOf(code)
        if (!row) return
        editMarket(api, code, { version: row.version, status: archive ? 'ARCHIVED' : 'ACTIVE' }, newIdempotencyKey()).then(
          (next) => {
            replace(next)
            notify({ tone: 'success', key: archive ? 'notice.marketArchived' : 'notice.marketRestored', params: { code } })
            go({ open: null })
            read(true)
          },
          (error) => setOpen((current) => (current ? { ...current, writing: writingOf(error) } : current)),
        )
      },
      onRetry: () => read(),
    },
  }
}

/**
 * Phrases & translations (rm-phrases): the library with its filters from the address, New phrase, the phrase's window
 * (`?open=<key>`: propose, approve as a second person, withdraw a draft, new source words), Archive N.
 */
export function usePhrases(context: TabContext): { state: PhrasesState; actions: PhrasesActions } {
  const { api, active, can, address, go, notify, stamp, tick } = context
  const [phrases, loadPhrases] = useRead<PhrasesAnswer>()
  const [selected, setSelected] = useState<string[]>([])
  const [add, setAdd] = useState<PhrasesState['add']>(null)
  const [open, setOpen] = useState<PhraseWindowState | null>(null)
  const kind = address.kind && (PHRASE_KINDS as readonly string[]).includes(address.kind) ? (address.kind as PhraseKind) : null
  const q = address.q

  const read = useCallback((quiet = false) => (can.view ? loadPhrases(() => readPhrases(api, { kind, q }), quiet).then((value) => value && stamp()) : Promise.resolve()), [api, can.view, kind, q, loadPhrases, stamp])
  useEffect(() => {
    if (active) void read()
  }, [active, read])
  useEffect(() => {
    if (active && tick > 0) void read(true)
  }, [tick])

  const readOpen = useCallback(
    (key: string, saved: PhraseWindowState['saved'] = null) =>
      readPhrase(api, key).then(
        (value: PhraseRecord) => setOpen((current) => (current && current.key === key ? { ...current, read: { status: 'ready', value }, writing: IDLE, saved: saved ?? current.saved } : current)),
        () => setOpen((current) => (current && current.key === key ? { ...current, read: { status: 'error', problem: 'problem.read' } } : current)),
      ),
    [api],
  )
  useEffect(() => {
    if (!active || !address.open) return setOpen(null)
    const key = address.open
    setOpen((current) => (current && current.key === key ? current : { key, read: { status: 'loading' }, language: null, text: '', source: null, writing: IDLE, saved: null }))
    void readOpen(key)
  }, [active, address.open, readOpen])

  useEffect(() => {
    if (!active || !address.add || !can.phrasesManage) return setAdd(null)
    setAdd((current) => current ?? { draft: EMPTY_PHRASE, writing: IDLE })
  }, [active, address.add, can.phrasesManage])

  const record = open ? valueOf(open.read) : null
  const write = (work: () => Promise<unknown>, savedKey: string, after?: Partial<PhraseWindowState>) => {
    if (!open) return
    setOpen({ ...open, writing: { busy: true, problem: null }, saved: null })
    work().then(
      () => {
        setOpen((current) => (current ? { ...current, ...after } : current))
        void readOpen(open.key, { tone: 'success', key: savedKey })
        void read(true)
      },
      (error) => setOpen((current) => (current ? { ...current, writing: writingOf(error) } : current)),
    )
  }
  const cellOf = (language: string) => record?.phrase.cells.find((cell) => cell.language === language) ?? null

  return {
    state: { phrases, selected, add, open },
    actions: {
      onSelected: setSelected,
      onArchiveMany: (keys) => {
        const rows = (valueOf(phrases)?.phrases ?? []).filter((row) => keys.includes(row.key))
        void each(rows, (row) => editPhrase(api, row.key, { version: row.version, status: 'ARCHIVED' }, newIdempotencyKey())).then((result) => {
          setSelected([])
          notify(result.refused.length > 0 ? { tone: 'warning', key: 'notice.archivedPartly', params: { done: result.done, refused: result.refused.length } } : { tone: 'success', key: 'notice.phrasesArchived', params: { count: result.done } })
          void read(true)
        })
      },
      onAddDraft: (draft) => setAdd((current) => (current ? { draft, writing: IDLE } : current)),
      onAddSave: () => {
        if (!add) return
        setAdd({ ...add, writing: { busy: true, problem: null } })
        const draft = add.draft
        createPhrase(api, { key: draft.key.trim(), kind: draft.kind!, sourceLanguage: draft.sourceLanguage, sourceText: draft.sourceText.trim(), note: draft.note.trim() || null }, newIdempotencyKey()).then(
          (phrase) => {
            notify({ tone: 'success', key: 'notice.phraseAdded', params: { key: phrase.key } })
            setAdd(null)
            void read(true)
            go({ add: false, open: phrase.key })
          },
          (error) => setAdd((current) => (current ? { ...current, writing: writingOf(error, 'create') } : current)),
        )
      },
      onLanguage: (language) => setOpen((current) => (current ? { ...current, language, text: language ? (cellOf(language)?.draft?.text ?? cellOf(language)?.approved?.text ?? '') : '', writing: IDLE } : current)),
      onText: (text) => setOpen((current) => (current ? { ...current, text, writing: IDLE } : current)),
      onPropose: () => {
        if (!open?.language) return
        const draft = cellOf(open.language)?.draft
        const language = open.language
        write(() => proposeTranslation(api, open.key, { language, text: open.text.trim(), ...(draft ? { version: draft.version } : {}) }, newIdempotencyKey()), 'saved.proposed', { language: null, text: '' })
      },
      onApprove: (language) => {
        const draft = cellOf(language)?.draft
        if (!open || !draft) return
        write(() => approveTranslation(api, open.key, draft.id, draft.version, newIdempotencyKey()), 'saved.approved')
      },
      onWithdraw: (language) => {
        const draft = cellOf(language)?.draft
        if (!open || !draft) return
        write(() => withdrawTranslation(api, open.key, draft.id, draft.version, newIdempotencyKey()), 'saved.withdrawn')
      },
      onSource: (text) => setOpen((current) => (current ? { ...current, source: text, writing: IDLE } : current)),
      onSourceSave: () => {
        if (!open || !record || open.source === null) return
        const text = open.source.trim()
        write(() => editPhrase(api, open.key, { version: record.phrase.version, sourceText: text }, newIdempotencyKey()), 'saved.revised', { source: null })
      },
      onRetry: () => void read(),
      onRetryOpen: () => {
        if (!open) return
        setOpen({ ...open, read: { status: 'loading' } })
        void readOpen(open.key)
      },
    },
  }
}
