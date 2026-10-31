import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SaveStatus } from './SaveStatus'
import { SAVE_STATUS_LABELS, type SaveStatusLabels } from './SaveStatusLabels'
import { defaultSaveTime, saveStatusView } from './saveStatusModel'

/** B-W2b-09 (D6) — the band's save words: always visible, honest, one stable live region. */
const IT: Partial<SaveStatusLabels> = {
  saved: 'Tutto salvato',
  savedAt: (time) => `Tutto salvato · ${time}`,
  saving: 'Salvataggio…',
  failed: (count) => (count === 1 ? '1 modifica non salvata' : `${count} modifiche non salvate`),
  retry: 'Riprova',
  unsaved: 'Modifiche non salvate',
  offlineCount: (count) => `Offline — ${count} modifiche in attesa`,
  region: 'Stato del salvataggio',
}
const time = () => '10:42'

describe('saveStatusView', () => {
  it('says each state in words with its tone', () => {
    expect(saveStatusView({ kind: 'idle' })).toEqual({ text: '', tone: 'neutral', retry: false })
    expect(saveStatusView({ kind: 'saved', at: '2026-10-31T09:42:00Z' }, { time })).toEqual({ text: 'All changes saved · 10:42', tone: 'success', retry: false })
    expect(saveStatusView({ kind: 'saved' }).text).toBe('All changes saved')
    expect(saveStatusView({ kind: 'saving' }).text).toBe('Saving…')
    expect(saveStatusView({ kind: 'failed' }).text).toBe('1 change not saved')
    expect(saveStatusView({ kind: 'failed', count: 3, reason: 'someone else changed it' }).text).toBe('3 changes not saved — someone else changed it')
    expect(saveStatusView({ kind: 'unsaved' }).text).toBe('Unsaved changes')
    expect(saveStatusView({ kind: 'unsaved', count: 2 }).text).toBe('2 unsaved changes')
    expect(saveStatusView({ kind: 'offline' }).text).toBe('Offline')
    expect(saveStatusView({ kind: 'offline', count: 1 }).text).toBe('Offline — 1 change waits to be sent')
  })
  it('never invents a count: zero, negative or not a number says the plain words', () => {
    expect(saveStatusView({ kind: 'unsaved', count: 0 }).text).toBe('Unsaved changes')
    expect(saveStatusView({ kind: 'offline', count: Number.NaN }).text).toBe('Offline')
    expect(saveStatusView({ kind: 'failed', count: -2 }).text).toBe('1 change not saved')
  })
  it('offers Retry only for a failed save with a handler', () => {
    expect(saveStatusView({ kind: 'failed' }, { canRetry: true }).retry).toBe(true)
    expect(saveStatusView({ kind: 'failed' }).retry).toBe(false)
    expect(saveStatusView({ kind: 'offline', count: 2 }, { canRetry: true }).retry).toBe(false)
  })
  it('writes a time in the language, and nothing for a bad time', () => {
    expect(defaultSaveTime('not a time')).toBe('')
    expect(defaultSaveTime('2026-10-31T09:42:00Z', 'it')).toMatch(/^\d{2}[:.]\d{2}$/)
  })
})

describe('SaveStatus', () => {
  it('keeps the live region mounted while idle, so the first change is heard', () => {
    const html = render(h(SaveStatus, { state: { kind: 'idle' } }))
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('nds-savestatus-words')
  })
  it('draws the words, the icon and Retry (held with its reason when asked)', () => {
    const html = render(h(SaveStatus, { state: { kind: 'failed', count: 2 }, onRetry: () => {}, retryHeld: 'Offline: reconnect first' }))
    expect(html).toContain('2 changes not saved')
    expect(html).toContain('Retry')
    expect(html).toContain('aria-description="Offline: reconnect first"')
    expect(html).toContain('tone-danger')
  })
  it('speaks the words it is given', () => {
    const html = render(h(SaveStatus, { state: { kind: 'saved', at: '2026-10-31T09:42:00Z' }, formatTime: time, labels: IT }))
    expect(html).toContain('Tutto salvato · 10:42')
    expect(html).toContain('aria-label="Stato del salvataggio"')
    expect(html).not.toContain(SAVE_STATUS_LABELS.saved)
    expect(render(h(SaveStatus, { state: { kind: 'failed' }, onRetry: () => {}, labels: IT }))).toContain('Riprova')
  })
})
