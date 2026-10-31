import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { labelFor, mergeLabels } from './labels'
import { AsOf } from '../components/AsOf'
import { Timeline } from '../components/Timeline'
import { Countdown } from '../components/Countdown'
import { countdownWords } from '../components/CountdownLabels'
import { JobProgress } from '../components/JobProgress'
import { FileDropzone } from '../components/FileDropzone'
import { MediaStrip } from '../components/MediaStrip'
import { Combobox } from '../components/Combobox'
import { ConfirmPhraseField } from '../components/ConfirmPhraseField'
import { DateField } from '../components/DateField'
import { DateTimeField } from '../components/DateTimeField'
import { DateRangePicker } from '../components/DateRangePicker'
import { Textarea } from '../primitives/Textarea'
import { IconPicker } from '../primitives/IconPicker'
import { ColorSwatchPicker } from '../primitives/ColorSwatchPicker'
import { CellSaveMark } from '../grid/renderers/CellSaveMark'
import { GridDensityToggle } from '../grid/toolbars/GridDensityToggle'
import { reversalSentence } from '../grid/actions/registry'
import { detailNavHeld, detailNavLabel, detailPosition } from '../patterns/detailModalModel'
import { DETAIL_MODAL_LABELS } from '../patterns/DetailModalLabels'
import { doneSummary, saveButtonWords, saveHeldReason } from '../patterns/reviewChangesModel'
import { REVIEW_CHANGES_LABELS } from '../patterns/ReviewChangesModalLabels'
import { textareaCount } from '../primitives/textareaCounter'

/**
 * B-W2b-04 — DS words in the person's language: each part's `labels` reaches the screen (made-up Italian words here; the
 * factory's real catalogue has its own test), and a part without `labels` keeps its English (the existing tests).
 */
const NOW = Date.parse('2026-10-31T10:00:00Z')
const noop = () => {}

describe('mergeLabels and labelFor', () => {
  it('replaces only the words given; a missing or undefined word keeps the English', () => {
    const en = { a: 'One', b: 'Two' }
    expect(mergeLabels(en)).toBe(en)
    expect(mergeLabels(en, { b: 'Due' })).toEqual({ a: 'One', b: 'Due' })
    expect(mergeLabels(en, { a: undefined, b: 'Due' })).toEqual({ a: 'One', b: 'Due' })
    expect(en).toEqual({ a: 'One', b: 'Two' })
  })
  it('names by own keys only, else the fallback', () => {
    expect(labelFor({ Today: 'Oggi' }, 'Today', 'Today')).toBe('Oggi')
    expect(labelFor({ Today: 'Oggi' }, 'Yesterday', 'Yesterday')).toBe('Yesterday')
    expect(labelFor({}, 'toString', 'toString')).toBe('toString')
    expect(labelFor(undefined, 'x', 'X')).toBe('X')
  })
})

describe('plain parts speak the words they are given', () => {
  it('AsOf: empty words and the time writers', () => {
    expect(render(h(AsOf, { at: null, labels: { notChecked: 'mai controllato' } }))).toContain('mai controllato')
    expect(render(h(AsOf, { at: null, kind: 'event', labels: { never: 'mai' } }))).toContain('>mai<')
  })

  it('Timeline: tone words, "not yet", and its times through AsOf', () => {
    const html = render(h(Timeline, {
      label: 'Passi', now: NOW,
      labels: { problem: 'Problema: ', needsAttention: 'Attenzione: ', notYet: 'non ancora' },
      steps: [{ key: 'a', label: 'Rifiutato', tone: 'danger', at: null }, { key: 'b', label: 'Lento', tone: 'warning' }],
    }))
    expect(html).toContain('<span class="nds-vh">Problema: </span>Rifiutato')
    expect(html).toContain('<span class="nds-vh">Attenzione: </span>Lento')
    expect(html).toContain('non ancora')
    expect(html).not.toMatch(/not yet|Problem: |Needs attention/)
  })

  it('Countdown: "in …", "now" and the unit letters; `label` / `doneLabel` still win', () => {
    const it_ = { in: (l: string) => `tra ${l}`, now: 'adesso', day: 'g', hour: 'h', minute: 'min', second: 's' }
    expect(render(h(Countdown, { to: NOW + 2 * 86_400_000, now: NOW, labels: it_ }))).toContain('>tra 2 g<')
    expect(render(h(Countdown, { to: NOW - 1, now: NOW, labels: it_ }))).toContain('>adesso<')
    expect(render(h(Countdown, { to: NOW + 14_000, now: NOW, labels: it_, label: (l: string) => `Parte tra ${l}` }))).toContain('>Parte tra 14 s<')
    expect(countdownWords('3 h', { second: 's', minute: 'min', hour: 'ore', day: 'g' })).toBe('3 ore')
    expect(countdownWords('—', { second: 's', minute: 'min', hour: 'h', day: 'd' })).toBe('—')
  })

  it('JobProgress: the elapsed clock', () => {
    expect(render(h(JobProgress, { label: 'Salvo', startedAt: NOW, labels: { elapsed: (t: string) => `${t} trascorsi` } }))).toContain('aria-label="0 s trascorsi"')
  })

  it('FileDropzone: prompt and default hints', () => {
    const labels = { prompt: 'Trascina o fai clic', hintWithSize: (a: string, m: string) => `${a} · fino a ${m}`, hintSizeOnly: (m: string) => `Fino a ${m}` }
    const both = render(h(FileDropzone, { onFiles: noop, accept: '.pdf', maxBytes: 1024 * 1024, labels }))
    expect(both).toContain('Trascina o fai clic')
    expect(both).toContain('.pdf · fino a 1MB')
    expect(render(h(FileDropzone, { onFiles: noop, maxBytes: 2048, labels }))).toContain('Fino a 2KB')
  })

  it('MediaStrip: its name, media types, the shared mark, positions and the empty word', () => {
    const labels = {
      items: (l: string, n: number) => `${l}, ${n} elementi`, type: (t: string) => (t === 'IMAGE' ? 'Immagine' : 'File'), shared: 'condivisa',
      reorderHint: 'Trascina per riordinare.', position: (name: string, p: number, n: number) => `${name}, posizione ${p} di ${n}`, add: 'Aggiungi',
    }
    const html = render(h(MediaStrip, { items: [{ id: '1', type: 'IMAGE', muted: true }], label: 'Foto', onReorder: noop, labels }))
    expect(html).toContain('aria-label="Foto, 1 elementi"')
    expect(html).toContain('aria-label="Immagine, posizione 1 di 1"')
    expect(html).not.toMatch(/media items|position 1 of/)
    expect(render(h(MediaStrip, { items: [], label: 'Foto', labels }))).toContain('>Aggiungi<')
  })

  it('Combobox: the empty text', () => {
    expect(render(h(Combobox, { options: [], onChange: noop, labels: { search: 'Cerca…' } }))).toContain('placeholder="Cerca…"')
  })

  it('ConfirmPhraseField: the label around the phrase and every state line', () => {
    const labels = {
      typeToConfirm: (p: unknown) => h('span', null, 'Digita ', p as never, ' per confermare'),
      states: { empty: 'Maiuscole e spazi contano.', partial: 'Continua.', mismatch: 'Non corrisponde.', match: 'Corrisponde.' },
    }
    const html = render(h(ConfirmPhraseField, { phrase: 'SKU-1', value: 'SX', onChange: noop, id: 'f', labels }))
    expect(html).toContain('Digita <strong class="nds-confirm-h">SKU-1</strong> per confermare')
    expect(html).toContain('Non corrisponde.')
    expect(render(h(ConfirmPhraseField, { phrase: 'SKU-1', value: 'SKU-1', onChange: noop, id: 'f', labels }))).toContain('Corrisponde.')
  })

  it('DateField, DateTimeField, DateRangePicker: empty words, names and the locale', () => {
    expect(render(h(DateField, { value: '', onChange: noop, labels: { notSet: 'non impostata' } }))).toContain('non impostata')
    const dt = render(h(DateTimeField, { value: '', onChange: noop, labels: { dateAndTime: 'Data e ora', date: 'data', time: 'ora', notChosen: 'non scelta', chooseDate: 'Scegli una data', timePlaceholder: 'Ora' } }))
    expect(dt).toContain('aria-label="Data e ora: data, non scelta"')
    expect(dt).toContain('Scegli una data')
    expect(dt).not.toMatch(/Date and time|not chosen|Choose a date/)
    const range = render(h(DateRangePicker, { value: { start: new Date(2026, 9, 1), end: new Date(2026, 9, 20) }, onChange: noop, labels: { locale: 'it-IT' } }))
    expect(range).toContain('ott')
    expect(range).not.toContain('Oct')
  })

  it('Textarea: the counter words, and `honourRows` lets `rows` set the height', () => {
    const labels = { counter: (u: number, l: number) => `${u} su ${l}`, tooLong: (o: number) => `${o} caratteri di troppo` }
    expect(render(h(Textarea, { value: 'a'.repeat(12), onChange: noop, limit: 10, labels }))).toContain('12 su 10 · 2 caratteri di troppo')
    expect(textareaCount('abc', 10, undefined, (o) => `${o} di troppo`).text).toBe('3 / 10')
    expect(render(h(Textarea, { rows: 2, honourRows: true }))).toContain('style="min-height:0"')
    expect(render(h(Textarea, { rows: 2, honourRows: true, style: { minHeight: 40 } }))).toContain('style="min-height:40px"')
    expect(render(h(Textarea, { rows: 2 }))).not.toContain('style=')
  })

  it('IconPicker and ColorSwatchPicker: the group, "No icon" and each name; an unnamed one keeps its English', () => {
    const icons = render(h(IconPicker, { value: null, onChange: noop, labels: { group: 'Icona', none: 'Nessuna icona', names: { star: 'Stella' } } }))
    expect(icons).toContain('aria-label="Icona"')
    expect(icons).toContain('aria-label="Nessuna icona"')
    expect(icons).toContain('aria-label="Stella"')
    expect(icons).toContain('aria-label="Heart"')
    const swatches = render(h(ColorSwatchPicker, { value: null, onChange: noop, labels: { group: 'Colore', names: { Blue: 'Blu' } } }))
    expect(swatches).toContain('aria-label="Colore"')
    expect(swatches).toContain('aria-label="Blu"')
  })

  it('CellSaveMark and GridDensityToggle', () => {
    expect(render(h(CellSaveMark, { state: 'waiting', labels: { waiting: 'In attesa' } }))).toContain('aria-label="In attesa"')
    const density = render(h(GridDensityToggle, { value: 'cozy', onChange: noop, labels: { compact: 'Compatta', cozy: 'Comoda', spacious: 'Ampia' } }))
    expect(density).toContain('Compatta')
    expect(density).not.toContain('Cozy')
  })
})

describe('the rules behind the dialogs take the same words', () => {
  it('reversalSentence', () => {
    const words = { unchecked: 'Non verificato.', none: 'Non si può annullare.', exact: (v: string) => `Annulla con «${v}».`, lossy: (v: string) => `Ripristina con «${v}».` }
    expect(reversalSentence({ reversal: { verb: 'Ripristina', fidelity: 'exact' } }, words)).toBe('Annulla con «Ripristina».')
    expect(reversalSentence({}, words)).toBe('Non verificato.')
  })

  it('DetailModal: Prev / Next names, the counter and the held reasons', () => {
    const words = { ...DETAIL_MODAL_LABELS, previous: (n: string) => `${n} precedente`, next: (n: string) => `${n} successiva`, position: (p: number, t: number) => `${p} di ${t}`,
      first: (n: string) => `È la prima ${n}`, last: (n: string, onPage: boolean) => `È l'ultima ${n}${onPage ? ' di questa pagina' : ''}` }
    const pos = detailPosition(['a', 'b'], 'b', { offset: 0, total: 9 }, words)
    expect(pos.words).toBe('2 di 9')
    expect(detailNavLabel('prev', 'riga', words)).toBe('riga precedente')
    expect(detailNavHeld(pos, 'riga', { offset: 0, total: 9 }, words).next).toBe('È l\'ultima riga di questa pagina')
  })

  it('ReviewChangesModal: held reasons, the button and the Done line', () => {
    const words = { ...REVIEW_CHANGES_LABELS, heldTick: 'Spunta la casella', savingOf: (d: number, c: number) => `Salvo ${d} di ${c}…`,
      counted: (n: number, v: string) => `${n} ${v}`, notCounted: (n: number, v: string) => `${n} non ${v}` }
    expect(saveHeldReason({ state: { phase: 'ready' }, count: 1, problems: 0, raises: 1, ack: false }, words)).toBe('Spunta la casella')
    expect(saveButtonWords({ phase: 'saving', done: 1 }, 3, undefined, words)).toBe('Salvo 1 di 3…')
    expect(doneSummary([{ id: 'a' }, { id: 'b' }], { a: { ok: true, words: 'ok' }, b: { ok: false, words: 'no' } }, 'salvate', words).line).toBe('1 salvate · 1 non salvate')
  })
})
