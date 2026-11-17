import { expect, type Page } from '@playwright/test'
import { scanText } from '../../../src/lib/testing/brand-scan'
import type { BrandFixture } from '../../../src/lib/testing/two-brands'

/**
 * B-TH-302 — the brand wall's DOM name scan in the browser golden flows (T00 at the screen level; the screens' twin is
 * src/lib/testing/brand-scan.ts, which reads the same two made-up brands of src/lib/testing/two-brands.ts): everything a page
 * shows — its text, the values of its fields, the titles and labels a pointer or a screen reader finds, its links — must hold
 * none of the other brand's markers (names, codes, contacts, numbers, ids), plus the extra words a stage names (that brand's
 * own order numbers in this run).
 */
export async function pageWords(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.title, document.body.innerText]
    for (const element of Array.from(document.querySelectorAll('[title], [aria-label], [alt], [placeholder], a[href], input, textarea'))) {
      for (const name of ['title', 'aria-label', 'alt', 'placeholder', 'href']) {
        const value = element.getAttribute(name)
        if (value) parts.push(value)
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) parts.push(element.value)
    }
    return parts.join('\n')
  })
}

/** The markers of `brand` (and the stage's extra words, each a whole token) a text holds. */
export function brandMarkersIn(text: string, brand: BrandFixture, extra: readonly string[] = []): string[] {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const words = text.replace(/\s+/g, ' ')
  return [...scanText(text, brand), ...extra.filter((value) => new RegExp(`(?<![A-Za-z0-9])${escape(value)}(?![A-Za-z0-9])`, 'i').test(words)).map((value) => `this run's: ${value}`)]
}

/** Fails when the page shows anything of `brand` (or the extra words). */
export async function expectNothingOf(page: Page, brand: BrandFixture, extra: readonly string[] = [], where = page.url()): Promise<void> {
  expect(brandMarkersIn(await pageWords(page), brand, extra), `${where} shows ${brand.tradeName}`).toEqual([])
}
