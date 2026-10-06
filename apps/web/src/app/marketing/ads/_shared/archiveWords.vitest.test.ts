/**
 * An archive is permanent at Amazon (its delete operation; Undo cannot put it back), so every Archive on the ad screens
 * asks first, in one sentence, with how many it archives.
 */
import { createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '@/design-system/primitives'
import { ARCHIVE_IS_PERMANENT, archiveConfirmWords } from './archiveWords'
import { ArchiveConfirm } from './ArchiveConfirm'

function buttons(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(buttons)
  if (!isValidElement<{ children?: ReactNode; footer?: ReactNode }>(node)) return []
  if (node.type === Button) return [node as ReactElement<Record<string, unknown>>]
  return [...buttons(node.props.footer), ...buttons(node.props.children)]
}

describe('archiveConfirmWords', () => {
  it('the one sentence, verbatim', () => {
    expect(ARCHIVE_IS_PERMANENT).toBe('Archive is permanent at Amazon: it cannot be undone.')
  })

  it('names how many it archives, singular and plural', () => {
    expect(archiveConfirmWords(1, ['ad group', 'ad groups'])).toEqual({ title: 'Archive 1 ad group?', sentence: ARCHIVE_IS_PERMANENT, confirm: 'Archive 1 ad group' })
    expect(archiveConfirmWords(3, ['keyword or target', 'keywords and targets'])).toEqual({ title: 'Archive 3 keywords and targets?', sentence: ARCHIVE_IS_PERMANENT, confirm: 'Archive 3 keywords and targets' })
  })
})

describe('ArchiveConfirm', () => {
  it('a DS modal: the count in the title, the sentence, Cancel and a danger Archive button; only the button archives', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn()
    const dialog = ArchiveConfirm({ count: 2, noun: ['product ad', 'product ads'], onConfirm, onCancel })
    expect(dialog.props).toMatchObject({ open: true, title: 'Archive 2 product ads?', subtitle: ARCHIVE_IS_PERMANENT })
    const [cancel, archive] = buttons(dialog)
    expect(archive.props).toMatchObject({ variant: 'danger', children: 'Archive 2 product ads' })
    ;(cancel.props.onClick as () => void)()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
    ;(archive.props.onClick as () => void)()
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(renderToStaticMarkup(createElement(Fragment, null, ...buttons(dialog)))).toContain('Archive 2 product ads')
  })

  it('while it writes, both buttons wait and closing does not cancel it', () => {
    const onCancel = vi.fn()
    const dialog = ArchiveConfirm({ count: 1, noun: ['campaign', 'campaigns'], busy: true, onConfirm: vi.fn(), onCancel })
    expect(buttons(dialog).map((b) => b.props.disabled)).toEqual([true, true])
    ;(dialog.props.onClose as () => void)()
    expect(onCancel).not.toHaveBeenCalled()
  })
})
