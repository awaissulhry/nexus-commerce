import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

import { FloorActionBar } from './ActionBar'
import { FloorButton } from './FloorButton'
import { FloorFrame, FloorHeader } from './FloorFrame'
import { FloorList, FloorListRow } from './FloorListRow'
import { IdleOverlay } from './IdleOverlay'
import { OfflineBanner } from './OfflineBanner'
import { OperatorChip, operatorInitials } from './OperatorChip'
import { ScanInput } from './ScanInput'
import { FloorTile, FloorTileGrid } from './Tiles'

const icon = h('svg', { 'data-icon': 'x' })

describe('floor frame (G2)', () => {
  it('puts the floor tier on its own root, so every --nds-density-* inside reads the floor values', () => {
    const out = render(h(FloorFrame, { header: h(FloorHeader, { title: 'Linea 2' }) }, 'contenuto'))
    expect(out).toMatch(/class="nds-floor-frame"[^>]*data-density="floor"/)
    expect(out).toContain('<header')
    expect(out).toContain('<main')
  })

  it('takes another tier, and drops its landmarks when several frames share a page', () => {
    const out = render(h(FloorFrame, { density: 'comfortable', landmarks: false, fill: false }, 'x'))
    expect(out).toMatch(/data-density="comfortable"/)
    expect(out).toMatch(/data-fill="false"/)
    expect(out).not.toContain('<main')
  })
})

describe('operator chip (G2)', () => {
  it('derives initials from letters, not code units', () => {
    expect(operatorInitials('Maria Rossi')).toBe('MR')
    expect(operatorInitials('  Ana  ')).toBe('AN')
    expect(operatorInitials('élodie de la Croix')).toBe('ÉC')
    expect(operatorInitials('')).toBe('')
  })

  it('is a button only when it opens something', () => {
    expect(render(h(OperatorChip, { name: 'Maria Rossi' }))).not.toContain('<button')
    expect(render(h(OperatorChip, { name: 'Maria Rossi', onPress: vi.fn(), label: 'Maria Rossi — menu' }))).toMatch(/<button[^>]*aria-label="Maria Rossi — menu"/)
  })
})

describe('offline banner (G2)', () => {
  const labels = { offlineLabel: 'Offline', sendingLabel: 'Invio', pendingLabel: (n: number) => (n === 1 ? 'azione da inviare' : 'azioni da inviare'), refusedLabel: (n: number) => `${n} rifiutate` }

  it('offline: shows the waiting count as a big number with its words', () => {
    const out = render(h(OfflineBanner, { online: false, pending: 3, ...labels }))
    expect(out).toMatch(/data-tone="warning"/)
    expect(out).toContain('nds-floor-offline-number">3<')
    expect(out).toContain('azioni da inviare')
  })

  it('online with nothing waiting: hidden, the live region kept for the next change', () => {
    const out = render(h(OfflineBanner, { online: true, pending: 0, ...labels }))
    expect(out).toMatch(/role="status"[^>]*hidden/)
  })

  it('refused: danger, with the queue button when the app gives one', () => {
    const out = render(h(OfflineBanner, { online: true, pending: 0, refused: 2, onOpenQueue: vi.fn(), queueLabel: 'Apri coda', ...labels }))
    expect(out).toMatch(/data-tone="danger"/)
    expect(out).toContain('2 rifiutate')
    expect(out).toContain('Apri coda')
  })
})

describe('idle overlay (G2)', () => {
  const props = { secondsLeft: 30, title: 'Ci sei ancora?', secondsLabel: (n: number) => `${n} secondi`, stayLabel: 'Sono qui', onStay: vi.fn() }

  it('renders nothing while closed', () => {
    expect(render(h(IdleOverlay, { ...props, open: false }))).toBe('')
  })

  it('open: a modal alert dialog with the seconds as a numeral and the big "I am here"', () => {
    const out = render(h(IdleOverlay, { ...props, open: true }))
    expect(out).toMatch(/role="alertdialog"[^>]*aria-modal="true"/)
    expect(out).toContain('nds-floor-idle-number">30<')
    expect(out).toContain('Sono qui')
  })
})

describe('scan input (G3)', () => {
  it('asks for no on-screen keyboard, never autocorrects, and labels the field', () => {
    const out = render(h(ScanInput, { label: 'Scansiona', scannedLabel: (c: string) => `Letto ${c}`, onScan: vi.fn(), keepFocus: false }))
    expect(out).toMatch(/inputMode="none"/)
    expect(out).toMatch(/autoComplete="off"/)
    expect(out).toMatch(/spellCheck="false"/)
    expect(out).toMatch(/<label for="([^"]+)"[^>]*>Scansiona<\/label>/)
    // No camera and no keyboard button unless the app gives them.
    expect(out).not.toContain('<button')
  })

  it('shows the camera button only with an injected scanner, worded by the app', () => {
    const scanner = { start: vi.fn() }
    const out = render(
      h(ScanInput, {
        label: 'Scansiona',
        scannedLabel: (c: string) => c,
        onScan: vi.fn(),
        keepFocus: false,
        keyboardLabel: 'Digita',
        camera: { scanner, startLabel: 'Fotocamera', stopLabel: 'Chiudi', errorLabel: 'Non disponibile' },
      }),
    )
    expect(out).toContain('Fotocamera')
    expect(out).toContain('Digita')
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(2)
    expect(scanner.start).not.toHaveBeenCalled()
  })
})

describe('tiles, action bar, list rows (G5)', () => {
  it('a tile is a button, a link with href, and held (focusable, inert) with a reason', () => {
    expect(render(h(FloorTile, { icon, label: 'Taglio', onPress: vi.fn() }))).toMatch(/^<button type="button"|^<button[^>]*type="button"/)
    expect(render(h(FloorTile, { icon, label: 'Taglio', href: '/taglio' }))).toMatch(/^<a[^>]*href="\/taglio"/)
    const held = render(h(FloorTile, { icon, label: 'Taglio', onPress: vi.fn(), heldReason: 'Nessun fascio' }))
    expect(held).toMatch(/aria-disabled="true"/)
    expect(held).toMatch(/aria-description="Nessun fascio"/)
    expect(held).not.toMatch(/\sdisabled=""/)
  })

  it('a tile shows its count with words for a screen reader, and its tone', () => {
    const out = render(h(FloorTileGrid, { label: 'Home', children: h(FloorTile, { icon, label: 'Coda', count: 4, countLabel: '4 in coda', tone: 'warning' }) }))
    expect(out).toMatch(/role="group"[^>]*aria-label="Home"/)
    expect(out).toMatch(/data-tone="warning"/)
    expect(out).toMatch(/nds-floor-tile-count" aria-hidden="true">4</)
    expect(out).toContain('4 in coda')
  })

  it('the action bar puts the main action last, primary by default', () => {
    const out = render(
      h(FloorActionBar, {
        actions: [
          { label: 'Pausa', onPress: vi.fn() },
          { label: 'Fine', onPress: vi.fn() },
        ],
      }),
    )
    const buttons = [...out.matchAll(/<button[^>]*class="([^"]+)"[^>]*>.*?<span class="nds-floor-btn-label">([^<]+)</g)].map((m) => [m[2], m[1]])
    expect(buttons).toEqual([
      ['Pausa', 'nds-floor-btn secondary size-lg'],
      ['Fine', 'nds-floor-btn primary size-lg is-main'],
    ])
  })

  it('a list row carries icon, tone, status word and the big number; plain without a press', () => {
    const out = render(h(FloorList, { label: 'Da prelevare', children: h(FloorListRow, { icon, title: 'Pelle nera', tone: 'danger', status: 'Manca 1', count: 4, countLabel: 'pezzi' }) }))
    expect(out).toMatch(/<ul class="nds-floor-list" aria-label="Da prelevare">/)
    expect(out).toMatch(/<div class="nds-floor-row" data-tone="danger"/)
    expect(out).toContain('nds-floor-row-number">4<')
    expect(out).toContain('Manca 1')
  })

  it('a held floor button never uses the disabled attribute', () => {
    const out = render(h(FloorButton, { heldReason: 'Prima scansiona' }, 'Inizia'))
    expect(out).toMatch(/aria-disabled="true"/)
    expect(out).not.toMatch(/\sdisabled=""/)
  })
})

describe('floor.css reads the density tokens (G1 → G2–G8)', () => {
  const css = readFileSync(new URL('./floor.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('every size of the touch parts comes from --nds-density-*', () => {
    for (const rule of ['.nds-floor-btn {', '.nds-floor-pin-keys {', '.nds-floor-tile {', '.nds-floor-row {', '.nds-floor-scan-field {']) {
      const body = css.slice(css.indexOf(rule), css.indexOf('}', css.indexOf(rule)))
      expect(body, rule).toMatch(/var\(--nds-density-/)
    }
  })

  it('no raw colour: no hex, no numbered ramp', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/var\(--nds-(grey|blue|green|red|amber|purple|cyan)-[0-9]/)
  })

  it('reduced motion holds the feedback colour still', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\[data-nds-feedback\] \{\s*animation: none;/)
  })
})
