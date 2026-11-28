import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales'
import { CATALOGUE } from '../i18n/messages'
import { designScreen } from './fixtures'
import { actHeldOf, ROOM_NARROW_BELOW, roomOf, TABLE_COLUMN_MIN, tableMinWidth, WINDOW_SHEET_BELOW, windowFootOf, windowKeyOf } from './model'
import { WINDOW_SHELL_NS, windowWordsFor } from './words'

/**
 * owb-b5 (w5.3) — the ONE window frame: the foot fixed at the bottom (the DS footer, outside the scrolling body) with the act last,
 * Cancel for a window that acts and Close for one that only shows, a bottom sheet under the phone width, ⌘ Enter = the act, Escape =
 * the way out; and the room rules (a narrow-screen rule has its narrow-room twin at the same number, a table keeps its smallest width).
 */

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
const uncommented = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')
const key = (over: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing: boolean }>) => ({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, ...over })

describe('owb-b5 w5.3: the window — its foot', () => {
  it('a window that acts: the way out says Cancel, the act is last', () => {
    expect(windowFootOf({ acts: true, more: false })).toEqual({ leave: 'cancel', parts: ['grow', 'leave', 'act'] })
    expect(windowFootOf({ acts: true, more: true })).toEqual({ leave: 'cancel', parts: ['more', 'grow', 'leave', 'act'] })
  })

  it('a window that only shows (or whose act is done): Close, and no act', () => {
    expect(windowFootOf({ acts: false, more: false })).toEqual({ leave: 'close', parts: ['grow', 'leave'] })
    expect(windowFootOf({ acts: false, more: true }).parts).toEqual(['more', 'grow', 'leave'])
  })

  it('the foot is FIXED: the buttons go to the DS footer (outside the scrolling body), never into the body', () => {
    const view = source('./view/WindowShell.tsx')
    expect(view).toContain('footer={<>{parts}</>}')
    expect(view).toContain('<div ref={body} className="fw-wsh-body">')
    // The DS draws the body as the part that scrolls and the foot as the part that does not shrink.
    const ds = source('../../../../../packages/ui/src/styles/components.css')
    expect(ds).toMatch(/\.nds-modal-b \{[^}]*overflow-y: auto;/)
    expect(ds).toMatch(/\.nds-modal-f \{[^}]*flex-shrink: 0;/)
  })

  it('a held act says why (the host first, then "Working on it…" while it runs); otherwise it acts', () => {
    expect(actHeldOf({ held: 'Place the scan code first.' }, 'Working on it…')).toBe('Place the scan code first.')
    expect(actHeldOf({ held: 'Place the scan code first.', busy: true }, 'Working on it…')).toBe('Place the scan code first.')
    expect(actHeldOf({ busy: true }, 'Working on it…')).toBe('Working on it…')
    expect(actHeldOf({ held: null }, 'Working on it…')).toBeNull()
  })
})

describe('owb-b5 w5.3: the window — a sheet under the phone width', () => {
  it('under 720 px of screen the window is a bottom sheet (the DS Modal\'s `sheet`, the same breakpoint)', () => {
    expect(WINDOW_SHEET_BELOW).toBe(720)
    expect(source('./view/WindowShell.tsx')).toMatch(/<Modal open=\{open\} onClose=\{onClose\}[^>]* sheet /)
    expect(source('../../../../../packages/ui/src/components/modalSheet.css')).toContain(`@media (max-width: ${WINDOW_SHEET_BELOW - 1}px)`)
  })
})

describe('owb-b5 w5.3: the window — the keys', () => {
  const acting = { acts: true, held: null, busy: false }

  it('⌘ Enter and Ctrl Enter do the act; Enter alone stays the focused control\'s; Alt never', () => {
    expect(windowKeyOf(key({ metaKey: true }), acting)).toBe('act')
    expect(windowKeyOf(key({ ctrlKey: true }), acting)).toBe('act')
    expect(windowKeyOf(key({}), acting)).toBeNull()
    expect(windowKeyOf(key({ metaKey: true, altKey: true }), acting)).toBeNull()
    expect(windowKeyOf(key({ key: 'a', metaKey: true }), acting)).toBeNull()
  })

  it('nothing to do: a held act, a running act, a window that only shows, a key inside a composition', () => {
    expect(windowKeyOf(key({ metaKey: true }), { acts: true, held: 'Why not' })).toBeNull()
    expect(windowKeyOf(key({ metaKey: true }), { acts: true, busy: true })).toBeNull()
    expect(windowKeyOf(key({ metaKey: true }), { acts: false })).toBeNull()
    expect(windowKeyOf(key({ metaKey: true, isComposing: true }), acting)).toBeNull()
  })

  it('Escape is the way out — Cancel or Close: the DS Modal\'s Escape calls the same onClose as the foot\'s button', () => {
    expect(windowKeyOf(key({ key: 'Escape' }), acting)).toBe('leave')
    expect(windowKeyOf(key({ key: 'Escape' }), { acts: false })).toBe('leave')
    const view = source('./view/WindowShell.tsx')
    expect(view).toContain('<Button key="leave" size="sm" onClick={onClose} heldReason={closeHeld}>')
    expect(view).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"')
    // ⌘ Enter only inside THIS window (a window opened over it keeps its own key).
    expect(view).toContain("const dialog = body.current?.closest('[role=\"dialog\"]')")
    expect(view).toContain('!dialog.contains(event.target)')
  })
})

describe('owb-b5 w5.3: the room rules', () => {
  it('a room is narrow under 720 px of its own width; a table keeps 120 px a column', () => {
    expect(ROOM_NARROW_BELOW).toBe(720)
    expect(roomOf(719)).toBe('narrow')
    expect(roomOf(720)).toBe('wide')
    expect(roomOf(343)).toBe('narrow')
    expect(TABLE_COLUMN_MIN).toBe(120)
    expect(tableMinWidth(8)).toBe(960)
    expect(tableMinWidth(0)).toBe(120)
  })

  it('every narrow-screen rule has its narrow-room twin at the same number; a table scrolls inside its card; one button height in a bar', () => {
    const css = uncommented(source('./room.css'))
    const screen = css.match(new RegExp(`@media \\(max-width: ${ROOM_NARROW_BELOW - 1}px\\)`, 'g'))?.length ?? 0
    const room = css.match(new RegExp(`@container fwroom \\(max-width: ${ROOM_NARROW_BELOW - 1}px\\)`, 'g'))?.length ?? 0
    expect(screen).toBeGreaterThan(0)
    expect(room).toBe(screen)
    expect(css).not.toMatch(/@media[^{]*\((min|max)-width: (?!719px)/)
    expect(css).toMatch(/\.fw-room \{[^}]*container: fwroom \/ inline-size;/)
    expect(css).toMatch(/\.fw-room-scroll \{[^}]*overflow-x: auto;/)
    expect(css).toMatch(/\.fw-room-scroll > table \{[^}]*min-width: var\(--fw-room-min, 100%\);/)
    expect(css).toMatch(/\.fw-room-bar \.nds-btn \{[^}]*height: var\(--nds-control-h-sm\);/)
    // The window's body is a room: what is inside follows the window, never the screen.
    expect(uncommented(source('./window-shell.css'))).toMatch(/\.fw-wsh-body \{[^}]*container: fwroom \/ inline-size;/)
    // No new hook: a part that must know its room in code uses the order cells' useRoomWidth.
    expect(source('./model.ts')).toContain('useRoomWidth(roomOf')
    for (const file of ['./room.css', './window-shell.css']) expect(uncommented(source(file)), file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })
})

describe('owb-b5 w5.3: the frame\'s own words and its lab', () => {
  it('Cancel, Close and Working on it… in every language, read straight from the catalogue', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][WINDOW_SHELL_NS]!
      for (const name of ['cancel', 'close', 'busy']) expect(words[name], `${locale} ${name}`).toBeTruthy()
    }
    expect(windowWordsFor('en', 'office')('cancel')).toBe('Cancel')
    expect(windowWordsFor('it', 'office')('close')).toBe('Chiudi')
    expect(windowWordsFor('it', 'outside')('cancel')).toBe('Annulla')
  })

  it('the lab draws one open window per case: acts, only shows, held, running, danger, the room', () => {
    expect(designScreen.screen).toBe('SCR-owb-window-shell')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['act', 'show', 'held', 'busy', 'danger', 'room'])
  })
})
