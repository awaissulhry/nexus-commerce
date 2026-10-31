import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The dialogs portal into <body> once hydrated: inline the portal and say "hydrated", so Node renders what a browser shows.
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))
vi.mock('../components/useHydrated', () => ({ useHydrated: () => true }))

import { Modal } from '../components/Modal'
import { ActionConfirm } from '../components/ActionConfirm'
import { EditModeBar } from './EditModeBar'
import { StepUpModal } from './StepUpModal'
import { DetailModal } from './DetailModal'
import { ReviewChangesModal } from './ReviewChangesModal'
import { PreferencesModal } from './PreferencesModal'
import { PREFERENCES_MODAL_LABELS, type PreferencesModalLabels } from './PreferencesModalLabels'

/**
 * B-W2b-04 — the dialogs speak the words they are given (made-up Italian), the close button included, and keep their
 * English without `labels` (the parity of the defaults was checked against main's source when the props were added).
 */
const noop = () => {}
const render = (el: unknown) => renderToStaticMarkup(el as never).replace(/(DndDescribedBy|DndLiveRegion)-\d+/g, '$1-N')

const saved: Record<string, unknown> = {}
beforeAll(() => {
  for (const k of ['document', 'getComputedStyle']) saved[k] = (globalThis as Record<string, unknown>)[k]
  ;(globalThis as Record<string, unknown>).document = { body: {}, activeElement: null, documentElement: {}, querySelectorAll: () => [] }
  ;(globalThis as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: () => '' })
})
afterAll(() => { for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v })

describe('dialog words', () => {
  it('Modal: the close button', () => {
    expect(render(h(Modal, { open: true, onClose: noop, title: 'T', labels: { close: 'Chiudi' } }, 'x'))).toContain('aria-label="Chiudi"')
    expect(render(h(Modal, { open: true, onClose: noop, title: 'T' }, 'x'))).toContain('aria-label="Close"')
  })

  it('EditModeBar: count line, shortcut, Discard and Apply', () => {
    const html = render(h(EditModeBar, {
      count: 2, onDiscard: noop, onApply: noop, saveShortcut: true,
      labels: { region: 'Modifica', unsaved: (n: number) => `${n} modifiche non salvate`, saveWith: 'Salva con', discard: 'Annulla', apply: 'Applica' },
    }))
    for (const word of ['aria-label="Modifica"', '2 modifiche non salvate', ' · Salva con ', '>Annulla<', '>Applica<']) expect(html).toContain(word)
    expect(html).not.toMatch(/unsaved|Save with|Discard|Apply changes|Edit mode/)
  })

  it('StepUpModal: buttons, the code field and Close', () => {
    const html = render(h(StepUpModal, {
      open: true, title: 'Alza', sentence: 'Frase', busy: false, error: null, onSubmit: noop, onClose: noop,
      labels: { cancel: 'Annulla', confirm: 'Conferma', checking: 'Verifico…', code: 'Codice a due fattori', codeHint: 'Le 6 cifre della tua app.', close: 'Chiudi' },
    }))
    for (const word of ['Annulla', 'Conferma', 'Codice a due fattori', 'Le 6 cifre della tua app.', 'aria-label="Chiudi"']) expect(html).toContain(word)
    expect(html).not.toMatch(/Cancel|Confirm<|Two-factor|authenticator|"Close"/)
  })

  it('ActionConfirm: headings, columns, the reversal sentence, the typed phrase and the check times', () => {
    const impact = {
      title: 'Elimina', level: 'type-to-confirm', reach: 'channel', confirmPhrase: 'SKU-1', subject: { kind: 'sku', value: 'SKU-1' },
      asOf: null, consequences: ['a'], reversal: { verb: 'Ripubblica', fidelity: 'lossy' }, findings: [{ label: 'Ordini', severity: 'unknown' }],
      sideEffects: ['b'], review: { title: 'Valori', rows: [{ label: 'Prezzo', before: '10', after: '—' }] }, handoffs: [{ label: 'Altrove', reason: 'qui' }],
      acknowledge: 'Ho capito',
    } as const
    const labels = {
      cancel: 'Annulla', confirm: 'Conferma', checked: 'Controllato', whatChanges: 'Cosa cambia', whatFound: 'Cosa ha trovato il controllo',
      notChecked: 'Non controllato: ', alsoHappens: 'Succede anche', continueElsewhere: 'Continua altrove', item: 'Voce', before: 'Prima', after: 'Dopo',
      reversal: { unchecked: 'Non verificato.', none: 'Irreversibile.', exact: (v: string) => `Annulla con «${v}».`, lossy: (v: string) => `Torna indietro con «${v}»: qualcosa si perde.` },
      close: 'Chiudi', asOf: { notChecked: 'mai controllato' },
      confirmPhrase: { typeToConfirm: (p: unknown) => h('span', null, 'Digita ', p as never), states: { empty: 'Maiuscole contano.', partial: 'Continua.', mismatch: 'No.', match: 'Sì.' } },
    }
    for (const mode of ['modal', 'inline'] as const) {
      const html = render(h(ActionConfirm, { impact: impact as never, onConfirm: noop, onCancel: noop, mode, labels }))
      for (const word of ['Annulla', 'Conferma', 'Controllato <span class="nds-as-of">mai controllato</span>', 'Cosa cambia', 'Cosa ha trovato il controllo', 'Non controllato: Ordini',
        'Succede anche', 'Continua altrove', '>Voce<', '>Prima<', '>Dopo<', 'Torna indietro con «Ripubblica»: qualcosa si perde.', 'Digita ', 'Maiuscole contano.']) expect(html).toContain(word)
      expect(html).not.toMatch(/What this changes|What the check found|This also happens|Continue elsewhere|>Item<|>Before<|>After<|Return with|Type <|Capital letters|not checked|Checked </)
      if (mode === 'modal') expect(html).toContain('aria-label="Chiudi"')
    }
  })

  it('DetailModal: Prev / Next, the counter, tabs, "Reading…", Try again and Close', () => {
    const labels = {
      noun: 'riga', previous: (n: string) => `${n} precedente`, next: (n: string) => `${n} successiva`, moveBetween: (n: string) => `Sposta tra le ${n}`,
      position: (p: number, t: number) => `${p} di ${t}`, first: (n: string) => `È la prima ${n}`, last: (n: string) => `È l'ultima ${n}`,
      notInTable: (n: string) => `Questa ${n} non è nella tabella`, tabs: 'Sezioni', reading: 'Lettura…', tryAgain: 'Riprova', close: 'Chiudi',
    }
    const html = render(h(DetailModal, { open: true, onClose: noop, title: 'R', tabs: [{ id: 'a', label: 'A' }], nav: { ids: ['a', 'b', 'c'], current: 'a', onGo: noop }, labels }, 'x'))
    for (const word of ['aria-label="riga precedente"', 'aria-label="riga successiva"', 'aria-label="Sposta tra le riga"', '1 di 3', 'È la prima riga', 'aria-label="Sezioni"', 'aria-label="Chiudi"']) expect(html).toContain(word)
    expect(html).not.toMatch(/Previous|Next row|Move between|1 of 3|This is the first|Sections|"Close"/)
    expect(render(h(DetailModal, { open: true, onClose: noop, title: 'R', loading: true, labels }, 'x'))).toContain('Lettura…')
    expect(render(h(DetailModal, { open: true, onClose: noop, title: 'R', error: 'Errore.', onRetry: noop, labels }, 'x'))).toContain('>Riprova<')
  })

  it('ReviewChangesModal: title, columns, held Save, the tick, the Done line and Close', () => {
    const labels = {
      title: (n: number) => `Rivedi ${n} modifiche`, save: (n: number) => `Salva ${n} modifiche`, cancel: 'Annulla', done: 'Fatto', undo: 'Annulla modifiche',
      heldTick: 'Spunta la casella', ack: () => 'Capisco che l’automazione farà di più.', where: 'Dove', what: 'Cosa', now: 'Ora', next: 'Nuovo', note: 'Nota', result: 'Esito',
      to: ' a ', raiseNote: 'L’automazione fa di più', counted: (n: number, v: string) => `${n} ${v}`, whatWas: (v: string) => `Cosa è stato ${v}`, close: 'Chiudi',
      conflictsTitle: 'Cambiato da quando hai aperto', conflict: (l: string, was: string, now: string) => `${l}: era ${was}, ora ${now}`,
    }
    const changes = [{ id: 'a', where: 'Regola A', what: 'Modo', now: 'Guarda', next: 'Agisci', raise: true }]
    const ready = render(h(ReviewChangesModal, { open: true, onClose: noop, changes, onSave: noop, labels, state: { phase: 'ready', conflicts: [{ label: 'Offerta', was: '1', now: '2' }] } }))
    for (const word of ['Rivedi 1 modifiche', 'Salva 1 modifiche', '>Annulla<', 'Spunta la casella', 'Capisco che l’automazione farà di più.', '>Dove<', '>Cosa<', '>Ora<', '>Nuovo<', '>Nota<',
      'L’automazione fa di più', 'Cambiato da quando hai aperto', 'Offerta: era 1, ora 2', 'aria-label="Chiudi"', '<span class="nds-vh"> a </span>']) expect(ready).toContain(word)
    expect(ready).not.toMatch(/Review 1 change|Save 1 change|>Cancel<|Tick the box|I understand|>Where<|>What<|>Now<|>New<|>Note<|Lets automation|Changed since|"Close"|> to </)
    const done = render(h(ReviewChangesModal, { open: true, onClose: noop, changes, onSave: noop, onUndo: noop, labels, doneVerb: 'salvate', state: { phase: 'done', results: { a: { ok: true, words: 'ok' } } } }))
    for (const word of ['>Fatto<', '1 salvate', 'Cosa è stato salvate', '>Esito<', 'Annulla modifiche']) expect(done).toContain(word)
  })

  it('PreferencesModal: every word of the plain, tabbed and grouped layouts can be replaced', () => {
    // Every word turned into a marked one (its key in capitals, so a marker never spells an English word): the dialog
    // then shows no English word of its own.
    const mark = (key: string) => `«${key.toUpperCase()}`
    const marked = Object.fromEntries(Object.entries(PREFERENCES_MODAL_LABELS).map(([key, value]) => [key,
      typeof value === 'function' ? (...args: unknown[]) => `${mark(key)}:${args.join('|')}»`
        : typeof value === 'string' ? `${mark(key)}»` : Object.fromEntries(Object.keys(value).map((k) => [k, `${mark(`${key}.${k}`)}»`]))])) as unknown as PreferencesModalLabels
    const cols = Array.from({ length: 14 }, (_, i) => ({ key: `c${i}`, label: `C${i}`, group: i < 7 ? 'G1' : 'G2', ...(i === 0 ? { locked: true } : {}), ...(i === 3 ? { alwaysShown: true } : {}) }))
    const value = { visibleColumns: ['c0', 'c1', 'c3', 'c8'], lockedColumns: ['c1'], stickyFirstColumn: true, stickyLastColumn: true, pageSize: 50, sortBy: 'c2', sortDir: 'desc' as const, rowGroups: ['c2'], aggregations: { c8: 'sum' as const } }
    const base = { open: true, onClose: noop, value, onConfirm: noop, allColumns: cols, defaultVisible: ['c0'], labels: marked }
    const english = Object.values(PREFERENCES_MODAL_LABELS).filter((v): v is string => typeof v === 'string' && v.length > 3)
    const layouts = [
      h(PreferencesModal, { ...base, sortFieldOptions: [{ value: 'c2', label: 'C2' }], quickPicks: [{ id: 'q', label: 'Q', columns: ['c4'] }], bulkPick: true, viewSave: { activeName: 'Mia', onSaveAs: async () => {}, onUpdate: async () => {} } }),
      h(PreferencesModal, { ...base, groupByOptions: [{ key: 'c2', label: 'C2' }, { key: 'c4', label: 'C4' }], aggregationOptions: [{ key: 'c8', label: 'C8', funcs: ['sum', 'avg'] }, { key: 'c9', label: 'C9', funcs: ['max'] }] }),
      h(PreferencesModal, { ...base, attributeGroups: true, viewSave: { activeName: null, onSaveAs: async () => {}, startNaming: true } }),
    ]
    for (const layout of layouts) {
      const html = render(layout)
      expect(html).toContain('«')
      for (const word of english) { const at = html.indexOf(word); expect(at, `"${word}" is still English: …${html.slice(Math.max(0, at - 200), at + 60)}`).toBe(-1) }
      // …nor a sentence its word functions write (a column's name in English words).
      expect(html).not.toMatch(/from the view|Drag C|Drag the|Move C|Lock C|Unlock C|Stop grouping|Group by|Total for|Add a total|Update “| shown| pinned| columns<| in view|Filter col|Picked up/)
    }
    expect(render(layouts[0])).toContain('«TITLE»')
    expect(render(layouts[1])).toContain('«TABGROUPING»')
  })
})
