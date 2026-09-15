import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void>,
  profile: null as null | {
    isDirty: () => boolean
    save: () => Promise<void> | void
  },
  windowListeners: new Map<string, EventListener>(),
  documentListeners: new Map<string, EventListener>(),
}))

vi.mock('react', () => ({
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect()
    if (cleanup) harness.effects.push(cleanup)
  },
  useId: () => 'guard-id',
  useRef: <T>(current: T) => ({ current }),
}))

vi.mock('@/lib/workspaces/unsaved-changes', () => ({
  registerProfileChanges: (_id: string, profile: typeof harness.profile) => {
    harness.profile = profile
    return () => { harness.profile = null }
  },
}))

import { useInFlightGuard } from './useInFlightGuard'
import { createWorkspaceSaveStore } from './workspaceSave'

describe('studio exit guard', () => {
  beforeEach(() => {
    harness.effects.splice(0).forEach(cleanup => cleanup())
    harness.profile = null
    harness.windowListeners.clear()
    harness.documentListeners.clear()

    vi.stubGlobal('window', {
      location: { href: 'http://localhost:3000/products/p/edit/studio', origin: 'http://localhost:3000', pathname: '/products/p/edit/studio' },
      confirm: vi.fn(() => false),
      addEventListener: (name: string, listener: EventListener) => harness.windowListeners.set(name, listener),
      removeEventListener: (name: string) => harness.windowListeners.delete(name),
    })
    vi.stubGlobal('document', {
      addEventListener: (name: string, listener: EventListener) => harness.documentListeners.set(name, listener),
      removeEventListener: (name: string) => harness.documentListeners.delete(name),
    })
  })

  it('reads a newly dirty editor at every exit boundary without waiting for the provider to rerender', async () => {
    let blocker: string | null = null
    const canChangeEditor = vi.fn(() => blocker == null)
    const publicationBlocker = vi.fn(() => blocker)
    useInFlightGuard({ kind: 'idle' }, publicationBlocker, canChangeEditor)

    const unload = harness.windowListeners.get('beforeunload')!
    const cleanUnload = { preventDefault: vi.fn(), returnValue: undefined }
    unload(cleanUnload as unknown as Event)
    expect(cleanUnload.preventDefault).not.toHaveBeenCalled()
    expect(harness.profile?.isDirty()).toBe(false)

    blocker = 'Save or discard changes in the open editor before publishing.'
    const dirtyUnload = { preventDefault: vi.fn(), returnValue: undefined }
    unload(dirtyUnload as unknown as Event)
    expect(dirtyUnload.preventDefault).toHaveBeenCalledOnce()
    expect(dirtyUnload.returnValue).toBe('')
    expect(harness.profile?.isDirty()).toBe(true)
    await expect(harness.profile?.save()).rejects.toThrow('Save or discard changes in the open editor')

    const anchor = { href: '/products', target: '', getAttribute: () => '/products' }
    const click = {
      target: { closest: () => anchor }, defaultPrevented: false, button: 0,
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    }
    harness.documentListeners.get('click')!(click as unknown as Event)
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Leave anyway'))
    expect(click.preventDefault).toHaveBeenCalledOnce()
    expect(click.stopPropagation).toHaveBeenCalledOnce()
  })

  it('does not consult or flush editor guards until a click is an eligible page exit', () => {
    const store = createWorkspaceSaveStore(() => {})
    const publicationBlocker = vi.fn(store.publicationBlocker)
    const canChangeEditor = vi.fn(() => true)
    useInFlightGuard({ kind: 'idle' }, publicationBlocker, canChangeEditor)
    const click = harness.documentListeners.get('click')!

    const send = (anchor: { href: string; target?: string; raw?: string } | null, over: Partial<MouseEvent> = {}) => {
      click({
        target: { closest: () => anchor && ({
          href: anchor.href,
          target: anchor.target ?? '',
          getAttribute: () => anchor.raw ?? anchor.href,
        }) },
        defaultPrevented: false, button: 0,
        metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
        preventDefault: vi.fn(), stopPropagation: vi.fn(),
        ...over,
      } as unknown as Event)
    }

    send(null)
    send({ href: '/products' }, { metaKey: true })
    send({ href: '/products/p/edit/studio?scope=AMAZON' })
    expect(publicationBlocker).not.toHaveBeenCalled()
    expect(canChangeEditor).not.toHaveBeenCalled()

    send({ href: '/products' })
    expect(publicationBlocker).toHaveBeenCalledOnce()
    expect(canChangeEditor).toHaveBeenCalledOnce()
  })
})
