import { describe, expect, it } from 'vitest'
import { issueFieldHref } from './issueHref'

describe('issueFieldHref — an issue opens its exact field in the studio', () => {
  it('a channel row opens its scope, its record (<alias or primary>:<product>) and the field; the errors tab is dropped', () => {
    const href = issueFieldHref({ productId: 'p1', channel: 'AMAZON', aliasKey: '', editorHref: '/products/p1/edit/studio?scope=AMAZON&locale=it&tab=errors&market=IT&account=acc1' }, 'manufacturer', null)
    const url = new URL(href, 'http://x')
    expect(url.pathname).toBe('/products/p1/edit/studio')
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'AMAZON', locale: 'it', market: 'IT', account: 'acc1', rec: 'primary:p1', cell: 'manufacturer' })
  })
  it('an alias row keeps its alias in the record id and the URL', () => {
    const url = new URL(issueFieldHref({ productId: 'p1', channel: 'EBAY', aliasKey: 'al2', editorHref: '/products/p1/edit/studio?scope=EBAY&locale=it&tab=errors&market=IT&alias=al2' }, 'brand', null), 'http://x')
    expect(url.searchParams.get('rec')).toBe('al2:p1')
    expect(url.searchParams.get('alias')).toBe('al2')
  })
  it('a shared row opens master at the product itself', () => {
    const url = new URL(issueFieldHref({ productId: 'p1', channel: 'SHARED', aliasKey: '', editorHref: '/products/p1/edit/studio?scope=master&locale=it&tab=errors' }, 'name', null), 'http://x')
    expect(Object.fromEntries(url.searchParams)).toEqual({ scope: 'master', locale: 'it', rec: 'p1', cell: 'name' })
  })
})
