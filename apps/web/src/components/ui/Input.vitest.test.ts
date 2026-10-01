/**
 * A search icon placed BEFORE the legacy `Input` stays visible.
 *
 * Thirteen toolbars (Customers, Stock, Listings, Inbound, Orders, …) put an absolutely positioned
 * magnifier first and the legacy `Input` after it, with `pl-7` to leave room. The Input's own wrapper
 * was `relative`: positioned, z-index auto, LATER in tree order — so it paints over the icon. That was
 * invisible while the field's `bg-card` was an invalid colour (transparent); once Tailwind's `bg-card`
 * read a real token the field went opaque and the icon vanished (measured on /customers, dark, 1280).
 * The wrapper is now positioned only when it holds its own prefix or suffix.
 *
 * Held here: the wrapper's class in each case, the Customers search box as rendered, and every caller
 * in the tree that puts an absolutely positioned element before an `<Input>` (which must then not use a
 * prefix/suffix, or position the field itself).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Search } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { Input } from './Input'

const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(Input, { id: 'x', ...props }))
/** The element that directly wraps the <input>, as rendered. */
const wrapperOf = (html: string) => /<div([^>]*)>(?:<span[^>]*>[^<]*<\/span>)?<input/.exec(html)?.[1] ?? null
const POSITIONED = /\b(relative|absolute|fixed|sticky)\b/

describe('the legacy Input wrapper', () => {
  it('is not positioned without a prefix or suffix', () => {
    const attrs = wrapperOf(render({ placeholder: 'Search' }))
    expect(attrs).not.toBeNull()
    expect(attrs).not.toMatch(POSITIONED)
  })

  it('is positioned when it holds a prefix or a suffix (they are absolutely placed inside it)', () => {
    const withPrefix = render({ prefix: '€' })
    expect(wrapperOf(withPrefix)).toBe(' class="relative"')
    expect(withPrefix).toMatch(/<span class="absolute left-2\.5[^"]*">€<\/span><input/)
    const withSuffix = render({ suffix: '%' })
    expect(withSuffix).toMatch(/<div class="relative"><input[^>]*><span class="absolute right-2\.5[^"]*">%<\/span>/)
  })
})

describe('the Customers search box (icon first, then the field)', () => {
  // The same elements CustomersWorkspace.tsx renders in its GridToolbar searchSlot.
  const html = renderToStaticMarkup(
    createElement('div', { className: 'flex-1 max-w-md relative' },
      createElement(Search, { size: 12, className: 'absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary dark:text-slate-500' }),
      createElement(Input, { id: 'customers-search', placeholder: 'Search', value: '', onChange: () => undefined, className: 'pl-7' }),
    ),
  )

  it('nothing positioned comes after the icon, so the opaque field cannot paint over it', () => {
    const iconEnd = html.indexOf('</svg>')
    expect(html.slice(0, iconEnd)).toMatch(/<svg[^>]*class="[^"]*\babsolute\b/)
    const after = html.slice(iconEnd)
    expect(after).toContain('<input')
    expect([...after.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).filter((c) => POSITIONED.test(c))).toEqual([])
  })
})

describe('every caller that puts an absolute element before a legacy <Input>', () => {
  const SRC = join(import.meta.dirname, '..', '..')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.tsx')) out.push(p)
    }
    return out
  }
  const importsLegacyInput = /from ['"](?:@\/components\/ui\/Input|(?:\.\.\/)+components\/ui\/Input|\.\/Input)['"]/
  const sites: Array<{ at: string; tag: string }> = []
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8')
    if (!importsLegacyInput.test(src)) continue
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      if (!/<Input(\s|$|>)/.test(line)) return
      if (!/className="[^"]*\babsolute\b/.test(lines.slice(Math.max(0, i - 8), i).join('\n'))) return
      const rest = lines.slice(i).join('\n')
      sites.push({ at: `${relative(SRC, file)}:${i + 1}`, tag: rest.slice(0, rest.indexOf('/>') + 2) })
    })
  }

  it('finds them (control: the Customers toolbar is one)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(13)
    expect(sites.some((s) => s.at.startsWith('app/customers/CustomersWorkspace.tsx:'))).toBe(true)
  })

  it('none gives the Input a prefix/suffix or positions the field, either of which would cover the icon again', () => {
    const covering = sites.filter((s) => /\b(prefix|suffix)=/.test(s.tag) || /className=["{][^\n]*\b(relative|absolute|fixed|sticky)\b/.test(s.tag))
    expect(covering.map((s) => s.at)).toEqual([])
  })
})
