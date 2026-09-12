import { afterEach, expect, it, vi } from 'vitest'
import { TaxonomySearchCache, type SearchNode } from './search-cache.js'
const row = (id: string, path = 'Racing › Suits'): SearchNode => ({ externalId: id, parentId: null, name: path, path, assignable: true })
afterEach(() => vi.useRealTimers())

it('coalesces concurrent revision loads while retaining independent searches', async () => {
  const cache = new TaxonomySearchCache()
  const load = vi.fn(async () => [row('001'), row('002', 'Boots')])
  const [suits, boots] = await Promise.all([cache.search('a:v1',{query:'suit'},load),cache.search('a:v1',{query:'boots'},load)])
  expect(load).toHaveBeenCalledTimes(1)
  expect(suits.items.map(r=>r.externalId)).toEqual(['001'])
  expect(boots.items.map(r=>r.externalId)).toEqual(['002'])
})
it('keeps revisions and businesses separate and does not share mutable results', async () => {
  const cache = new TaxonomySearchCache()
  const first = await cache.search('a:v1',{},async()=>[row('a')])
  first.items[0].path = 'Changed by a caller'
  expect((await cache.search('a:v1',{},async()=>[])).items[0].path).toBe('Racing › Suits')
  expect((await cache.search('b:v1',{},async()=>[row('b')])).items[0].externalId).toBe('b')
  expect((await cache.search('a:v2',{},async()=>[row('new')])).items[0].externalId).toBe('new')
})
it('evicts least recently used revisions and expires idle data', async () => {
  vi.useFakeTimers()
  const cache = new TaxonomySearchCache(1_000_000,2), load = vi.fn(async()=>[row('1')])
  await cache.search('a',{},load); await cache.search('b',{},load); await cache.search('a',{},load); await cache.search('c',{},load)
  await cache.search('b',{},load)
  expect(load).toHaveBeenCalledTimes(4)
  vi.advanceTimersByTime(600_001)
  await cache.search('b',{},load)
  expect(load).toHaveBeenCalledTimes(5)
})
it('does not retain oversized snapshots or failed loads', async () => {
  const cache = new TaxonomySearchCache(1)
  const load = vi.fn(async()=>[row('1')])
  await cache.search('a',{},load); await cache.search('a',{},load)
  expect(load).toHaveBeenCalledTimes(2)
  await expect(cache.search('b',{},async()=>{throw new Error('offline')})).rejects.toThrow('offline')
  expect((await cache.search('b',{},load)).total).toBe(1)
})
it('searches complete paths and exact IDs literally with stable pages and parent filters', async () => {
  const cache = new TaxonomySearchCache()
  const rows = Array.from({length:105},(_,i)=>row(String(i).padStart(3,'0'),`Vêtements › Racing Suit ${i}`))
  rows.push({...row('percent','100% wool'),parentId:'parent',assignable:false})
  const load = async()=>rows
  expect((await cache.search('a',{query:'VÊTEMENTS suit',page:2},load)).items.map(r=>r.externalId)).toEqual(rows.slice(50,100).map(r=>r.externalId))
  expect((await cache.search('a',{query:'001'},load)).total).toBe(1)
  expect((await cache.search('a',{query:'%'},load)).total).toBe(1)
  expect((await cache.search('a',{parentId:'parent'},load)).total).toBe(1)
  expect((await cache.search('a',{parentId:'parent',assignableOnly:true},load)).total).toBe(0)
  expect((await cache.search('a',{page:99},load)).total).toBe(106)
})
it('limits simultaneous snapshot loads across businesses', async () => {
  const cache = new TaxonomySearchCache()
  let active = 0, peak = 0
  const load = async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return [row('1')]}
  await Promise.all(Array.from({length:8},(_,i)=>cache.search(String(i),{},load)))
  expect(peak).toBe(2)
})
