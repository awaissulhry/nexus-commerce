import { describe, expect, it } from 'vitest'
import { MADE_EXTRA_WORDS } from './made-extra'

/**
 * B-OO-015 (order overview plan N12, Q9; review 17-review F12): "made extra" says what it counts. The count is the cell floor
 * beyond what the line now wants, and the floor also holds what a cut order only plans to cut (a planned line holds its
 * garments: the guard needs them) — so the words say "cut or planned to cut", never that the pieces were made. Office only:
 * the portal never reads them. Made-up sizes; no database.
 */

describe('MADE_EXTRA_WORDS.madeExtra (B-OO-015)', () => {
  it('says the pieces beyond the order are cut or planned to cut, with their size, in English and Italian', () => {
    expect(MADE_EXTRA_WORDS.madeExtra(4, 'M')).toEqual({ en: 'Size M: 4 more than ordered (cut or planned to cut)', it: "Taglia M: 4 in più dell'ordine (tagliati o da tagliare)" })
    expect(MADE_EXTRA_WORDS.madeExtra(1, '52')).toEqual({ en: 'Size 52: 1 more than ordered (cut or planned to cut)', it: "Taglia 52: 1 in più dell'ordine (tagliati o da tagliare)" })
  })

  it('names the size before its count — never "1 52 more…" (the count and a numeric size run together); no size: the count alone', () => {
    expect(MADE_EXTRA_WORDS.madeExtra(1, '48').en).toMatch(/^Size 48: 1 more than ordered/)
    expect(MADE_EXTRA_WORDS.madeExtra(1, '48').it).toMatch(/^Taglia 48: 1 in più dell'ordine/)
    expect(MADE_EXTRA_WORDS.madeExtra(2, '')).toEqual({ en: '2 more than ordered (cut or planned to cut)', it: "2 in più dell'ordine (tagliati o da tagliare)" })
  })

  it('never claims the pieces were made (the old "Made extra" / "Fatti in più")', () => {
    const words = MADE_EXTRA_WORDS.madeExtra(2, 'L')
    expect(words.en).not.toMatch(/made/i)
    expect(words.it).not.toMatch(/fatti/i)
  })

  it('keeps the material words as they are', () => {
    expect(MADE_EXTRA_WORDS.usedForExtra()).toEqual({ en: 'Used for extra pieces', it: 'Usato per pezzi in più' })
  })
})
