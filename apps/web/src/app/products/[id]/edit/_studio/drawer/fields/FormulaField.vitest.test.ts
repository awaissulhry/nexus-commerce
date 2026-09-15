import { afterEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  barrier: null as { flush: () => Promise<void>; blocker: () => string | null } | null,
  cleanup: null as (() => void) | null,
  scopeGuard: null as (() => boolean) | null,
}))

vi.mock('react', () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => () => void) => { lifecycle.cleanup = effect() },
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, vi.fn()],
}))

vi.mock('@/design-system/grid', () => ({
  exprOf: (text: string) => text.startsWith('=') ? text.slice(1) : text,
  isFormulaDraft: (text: string) => text.startsWith('='),
}))

vi.mock('@/design-system/grid/editors/FormulaComposer', () => ({
  FormulaComposer: () => null,
}))

vi.mock('../../contracts', () => ({
  usePublicationSave: () => ({
    registerPublicationBarrier: (barrier: typeof lifecycle.barrier) => {
      lifecycle.barrier = barrier
      return vi.fn()
    },
  }),
  useStudioScope: () => ({
    registerScopeChangeGuard: (guard: () => boolean) => {
      lifecycle.scopeGuard = guard
      return vi.fn()
    },
  }),
}))

import type { ReactElement } from 'react'
import { FormulaField } from './FormulaField'

const props = (save = vi.fn(async () => ({ ok: true }))) => ({
  column: {
    key: 'title', writeField: 'title', label: 'Title', group: 'Content', kind: 'text',
    storage: 'column', scope: 'global', requiredBy: [], editable: true,
  },
  rowId: 'row-1',
  formulas: {
    ready: true,
    functions: [],
    sourceLabel: 'Shared · English',
    exprFor: vi.fn(() => null),
    pinOver: vi.fn(async () => ({ ok: true })),
    preview: vi.fn(async () => ({ ok: true, value: 'Preview' })),
    save,
  },
  storedExpr: null,
  candidates: [],
  originalText: 'Old title',
  ariaLabel: 'Title',
  onExit: vi.fn(),
  onSaved: vi.fn(),
}) as Parameters<typeof FormulaField>[0]

const composer = (input: Parameters<typeof FormulaField>[0]) => FormulaField(input) as ReactElement<{
  text: string
  onChange: (text: string) => void
  onCancel: () => void
  onApply: (text: string) => Promise<{ ok: boolean; error?: string }>
}>

describe('drawer formula lifecycle guards', () => {
  afterEach(() => {
    lifecycle.cleanup?.()
    lifecycle.barrier = null
    lifecycle.cleanup = null
    lifecycle.scopeGuard = null
  })

  it('opens with the formula text typed in the record field and keeps the old value as cancel baseline', () => {
    const input = { ...props(), initialText: '=$brand' } as Parameters<typeof FormulaField>[0]
    const field = composer(input)

    expect(field.props.text).toBe('=$brand')
    expect(lifecycle.scopeGuard?.()).toBe(false)
    field.props.onCancel()
    expect(input.onExit).toHaveBeenCalledWith('Old title')
  })

  it('keeps an edited formula in the drawer until the operator applies or cancels it', () => {
    const input = props()
    const field = composer(input)
    expect(field.props.text).toBe('Old title')
    expect(lifecycle.scopeGuard?.()).toBe(true)
    expect(lifecycle.barrier?.blocker()).toBeNull()

    field.props.onChange('=$brand')
    expect(lifecycle.scopeGuard?.()).toBe(false)
    expect(lifecycle.barrier?.blocker()).toContain('formula')

    field.props.onCancel()
    expect(lifecycle.scopeGuard?.()).toBe(true)
    expect(lifecycle.barrier?.blocker()).toBeNull()
    expect(input.onExit).toHaveBeenCalledWith('Old title')
  })

  it('continues blocking after a refused save and releases the guard after a confirmed save', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'Formula refused' })
      .mockResolvedValueOnce({ ok: true })
    const input = props(save)
    const field = composer(input)
    field.props.onChange('=$brand')

    expect(await field.props.onApply('=$brand')).toEqual({ ok: false, error: 'Formula refused' })
    expect(lifecycle.scopeGuard?.()).toBe(false)

    expect(await field.props.onApply('=$brand')).toEqual({ ok: true })
    expect(lifecycle.scopeGuard?.()).toBe(true)
    expect(lifecycle.barrier?.blocker()).toBeNull()
    expect(input.onSaved).toHaveBeenCalledOnce()
  })
})
