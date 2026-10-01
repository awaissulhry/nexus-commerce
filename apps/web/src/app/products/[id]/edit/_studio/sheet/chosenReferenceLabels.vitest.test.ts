/**
 * 2026-10-01 — a reference the operator CHOOSES (a description theme, an Etsy shipping profile …) shows its name at once.
 *
 * The final local browser round saw a newly chosen description theme shown as its internal id for more than 15 s: the
 * cell names a value from the sheet's reference names, which learned the new id only from a later read. The editor
 * already holds the chosen option's name; it now hands it over, and the names fall back to it for an id they cannot name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chosenReferenceLabels, forgetChosenReferenceLabels, rememberChosenReferenceLabel, subscribeChosenReferenceLabels, withChosenReferenceLabels } from './referenceOptions'

afterEach(() => forgetChosenReferenceLabels())

describe('chosen reference names', () => {
  it('remembers a chosen name per field and account, and tells subscribers', () => {
    const listener = vi.fn()
    const stop = subscribeChosenReferenceLabels(listener)
    rememberChosenReferenceLabel('descriptionThemeId', 'acct-1', 'theme_c', 'Theme C')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(chosenReferenceLabels('acct-1')).toEqual({ descriptionThemeId: { theme_c: 'Theme C' } })
    // Another account's sheet does not borrow it: Etsy resource ids belong to their shop.
    expect(chosenReferenceLabels('acct-2')).toEqual({})
    stop()
    rememberChosenReferenceLabel('descriptionThemeId', 'acct-1', 'theme_d', 'Theme D')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores a blank id or name, and an unchanged name tells nobody', () => {
    const listener = vi.fn()
    subscribeChosenReferenceLabels(listener)
    rememberChosenReferenceLabel('descriptionThemeId', 'acct-1', '', 'Theme')
    rememberChosenReferenceLabel('descriptionThemeId', 'acct-1', 'theme_c', '  ')
    rememberChosenReferenceLabel('descriptionThemeId', 'acct-1', 'theme_c', 'Theme C')
    rememberChosenReferenceLabel('descriptionThemeId', 'acct-1', 'theme_c', 'Theme C')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('fills only the ids the sheet cannot name; a name the sheet read wins', () => {
    const names = { descriptionThemeId: { theme_a: 'Theme A (server)' } }
    const chosen = { descriptionThemeId: { theme_a: 'Theme A (chosen earlier)', theme_c: 'Theme C' }, shop_section_id: { '7': 'Jackets' } }
    expect(withChosenReferenceLabels(names, chosen)).toEqual({
      descriptionThemeId: { theme_a: 'Theme A (server)', theme_c: 'Theme C' },
      shop_section_id: { '7': 'Jackets' },
    })
    expect(withChosenReferenceLabels(names, {})).toBe(names)
  })
})
