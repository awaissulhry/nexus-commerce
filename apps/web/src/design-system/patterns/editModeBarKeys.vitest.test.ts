import { describe, expect, it } from 'vitest'
import { isMacPlatform, isSaveShortcut, saveKeyAction, saveShortcutWords, warnBeforeLeaving, type SaveKeyEvent } from './editModeBarKeys'

const key = (k: string, mods: Partial<SaveKeyEvent> = {}): SaveKeyEvent => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('isSaveShortcut', () => {
  it('is ⌘S or Ctrl+S', () => {
    expect(isSaveShortcut(key('s', { metaKey: true }))).toBe(true)
    expect(isSaveShortcut(key('s', { ctrlKey: true }))).toBe(true)
    expect(isSaveShortcut(key('S', { metaKey: true }))).toBe(true)
  })
  it('is not S alone, nor with Alt or Shift, nor while composing', () => {
    expect(isSaveShortcut(key('s'))).toBe(false)
    expect(isSaveShortcut(key('s', { metaKey: true, shiftKey: true }))).toBe(false)
    expect(isSaveShortcut(key('s', { ctrlKey: true, altKey: true }))).toBe(false)
    expect(isSaveShortcut(key('s', { metaKey: true, isComposing: true }))).toBe(false)
    expect(isSaveShortcut(key('d', { metaKey: true }))).toBe(false)
  })
})

describe('saveKeyAction', () => {
  it('saves when the save may run', () => {
    expect(saveKeyAction(key('s', { metaKey: true }), { held: false, busy: false })).toBe('save')
  })
  it('swallows the key when the save is held or busy', () => {
    expect(saveKeyAction(key('s', { metaKey: true }), { held: true, busy: false })).toBe('held')
    expect(saveKeyAction(key('s', { ctrlKey: true }), { held: false, busy: true })).toBe('held')
  })
  it('ignores other keys', () => {
    expect(saveKeyAction(key('Enter'), { held: false, busy: false })).toBe('ignore')
  })
})

describe('leaving and words', () => {
  it('asks before leaving only with unsaved changes', () => {
    expect(warnBeforeLeaving(2)).toBe(true)
    expect(warnBeforeLeaving(0)).toBe(false)
    expect(warnBeforeLeaving(undefined)).toBe(false)
  })
  it('names the key per platform', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('Win32')).toBe(false)
    expect(saveShortcutWords(true)).toBe('⌘S')
    expect(saveShortcutWords(false)).toBe('Ctrl+S')
  })
})
