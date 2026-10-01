import { describe, it, expect } from 'vitest'
import { SHEET_TONES } from '@nexus/shared/sheet-groups'
import { GROUP_TONES, groupToneVars, groupToneVarsDark } from './groupTones'

describe('column-group tones', () => {
  it('names exactly the tones the sheet groups use', () => {
    expect(Object.keys(GROUP_TONES).sort()).toEqual([...SHEET_TONES].sort())
  })

  it('keeps the old flat file\'s band colours (Tailwind v3 colour-100 ground, colour-800 text)', () => {
    expect(GROUP_TONES.blue).toMatchObject({ bg: '#dbeafe', fg: '#1e40af' })
    expect(GROUP_TONES.purple).toMatchObject({ bg: '#f3e8ff', fg: '#6b21a8' })
    expect(GROUP_TONES.emerald).toMatchObject({ bg: '#d1fae5', fg: '#065f46' })
    expect(GROUP_TONES.orange).toMatchObject({ bg: '#ffedd5', fg: '#9a3412' })
    expect(GROUP_TONES.slate).toMatchObject({ bg: '#f1f5f9', fg: '#334155' })
  })

  it('restates every colour in the dark block, so no tone keeps its light value in dark mode', () => {
    const light = groupToneVars.filter((v) => v.name.startsWith('--nds-grid-tone-')).map((v) => v.name)
    expect(groupToneVarsDark.map((v) => v.name)).toEqual(light)
    expect(light).toHaveLength(SHEET_TONES.length * 3)
  })
})
