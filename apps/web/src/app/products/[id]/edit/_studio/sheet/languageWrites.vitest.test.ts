import { expect, it, vi } from 'vitest'
import { commitLanguageGroups } from './languageWrites'

const request = { rowId:'p', row:{}, expectedVersion:10, cells:[{colId:'name@nl',value:'Dutch',intent:'set' as const},{colId:'name@fr',value:'French',intent:'set' as const}] }
it('keeps language contexts distinct and advances CAS from the actual response', async () => {
  const commit=vi.fn().mockResolvedValueOnce({ok:true,version:17}).mockResolvedValueOnce({ok:true,version:29})
  const result=await commitLanguageGroups(request,key=>key.split('@')[1],commit)
  expect(commit.mock.calls.map(([r,l])=>[l,r.expectedVersion,r.cells.map((c:any)=>c.value)])).toEqual([['nl',10,['Dutch']],['fr',17,['French']]])
  expect(result.version).toBe(29)
  expect(result.cells?.['name@fr'].ok).toBe(true)
})
it('stops after an unknown outcome or CAS conflict instead of guessing the next version', async () => {
  const commit=vi.fn().mockResolvedValue({ok:false,unreachable:true,reason:'Checking stored value'})
  const result=await commitLanguageGroups(request,key=>key.split('@')[1],commit)
  expect(commit).toHaveBeenCalledTimes(1)
  expect(result.cells?.['name@fr'].ok).toBe(false)
  expect(result.unreachable).toBe(true)
})
