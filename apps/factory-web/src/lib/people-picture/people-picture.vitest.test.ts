import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '../record-thread/parts/testing'
import { designScreen } from './fixtures'
import { iconOf, lettersOf, PICTURE_ICONS, PICTURE_TONES, pictureOf, toneOf } from './model'
import { PeoplePicture } from './view/PeoplePicture'
import { TeamChip } from './view/TeamChip'

/**
 * owb-b5 (w5.4; design plan § 5zb; Owner decision K) — a person's or a team's picture: two letters or one of 12 lucide icons on one of
 * the 10 grid tones, no photo; the team chip = the picture + the name.
 */

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('owb-b5 w5.4: the people picture — the model', () => {
  it('letters from a name: two words → first and last initials; one name → its first two letters; none → "?"', () => {
    expect(lettersOf('Team Noor')).toBe('TN')
    expect(lettersOf('Dora Maria Campione')).toBe('DC')
    expect(lettersOf('Noor')).toBe('NO')
    expect(lettersOf('cutting')).toBe('CU')
    expect(lettersOf('A')).toBe('A')
    expect(lettersOf('  ')).toBe('?')
    expect(lettersOf(null)).toBe('?')
    expect(lettersOf('(Noor) Team')).toBe('NT')
  })

  it('the 12 icons and the 10 tones, as the design and the DS name them', () => {
    expect(PICTURE_ICONS).toHaveLength(12)
    expect(new Set(PICTURE_ICONS).size).toBe(12)
    expect(PICTURE_ICONS).toEqual(['factory', 'shirt', 'scissors', 'layers', 'shield', 'ruler', 'flag', 'package', 'briefcase', 'image', 'users', 'truck'])
    expect(PICTURE_TONES).toEqual(['slate', 'purple', 'emerald', 'pink', 'orange', 'blue', 'yellow', 'red', 'violet', 'cyan'])
  })

  it('an unknown icon → none (the letters show); an unknown or missing colour → slate', () => {
    expect(iconOf('scissors')).toBe('scissors')
    expect(iconOf('needle')).toBeNull()
    expect(iconOf(null)).toBeNull()
    expect(toneOf('cyan')).toBe('cyan')
    expect(toneOf('gold')).toBe('slate')
    expect(toneOf(undefined)).toBe('slate')
  })

  it('the face: ICON with a known icon draws it; LETTERS, an unknown icon or no kind draws the letters; a person by default', () => {
    expect(pictureOf({ name: 'Team Noor', who: 'team', kind: 'ICON', icon: 'scissors', colour: 'orange' })).toEqual({ look: 'icon', letters: 'TN', icon: 'scissors', tone: 'orange', who: 'team', name: 'Team Noor' })
    expect(pictureOf({ name: 'Team Noor', who: 'team', kind: 'ICON', icon: 'needle', colour: 'orange' })).toMatchObject({ look: 'letters', icon: null })
    expect(pictureOf({ name: 'Team Noor', who: 'team', kind: 'LETTERS', icon: 'scissors' })).toMatchObject({ look: 'letters', icon: null, tone: 'slate' })
    expect(pictureOf({ name: 'Dora Campione' })).toMatchObject({ look: 'letters', letters: 'DC', who: 'person', tone: 'slate' })
    expect(pictureOf({ name: null }).name).toBe('?')
  })
})

describe('owb-b5 w5.4: the people picture — the parts', () => {
  it('alone it is an image named by the name; beside the name it is hidden; never a photo', () => {
    const alone = render(createElement(PeoplePicture, { source: { name: 'Dora Campione', colour: 'purple' } }))
    expect(alone).toContain('class="fw-ppic is-md is-person t-purple"')
    expect(alone).toContain('role="img"')
    expect(alone).toContain('aria-label="Dora Campione"')
    expect(alone).toContain('>DC<')
    expect(alone).not.toContain('<img')
    const beside = render(createElement(PeoplePicture, { source: { name: 'Team Noor', who: 'team', kind: 'ICON', icon: 'scissors', colour: 'orange' }, size: 'sm', nameBeside: true }))
    expect(beside).toContain('class="fw-ppic is-sm is-team t-orange"')
    expect(beside).toContain('aria-hidden="true"')
    expect(beside).toContain('<svg')
    expect(beside).not.toContain('role="img"')
  })

  it('the team chip: the picture (hidden) and the name in words; always a team', () => {
    const html = render(createElement(TeamChip, { team: { name: 'Team Noor', kind: 'LETTERS', colour: 'cyan' } }))
    expect(html).toContain('class="fw-ppic-chip"')
    expect(html).toContain('class="fw-ppic is-sm is-team t-cyan" aria-hidden="true"')
    expect(html).toContain('<span class="fw-ppic-name" title="Team Noor">Team Noor</span>')
  })

  it('every tone has its rule on the DS grid tokens; no raw colour; lucide only', () => {
    const css = source('./people-picture.css')
    for (const tone of PICTURE_TONES) expect(css, tone).toContain(`.fw-ppic.t-${tone} { background: var(--nds-grid-tone-${tone}-bg); color: var(--nds-grid-tone-${tone}-fg); box-shadow: inset 0 0 0 1px var(--nds-grid-tone-${tone}-rule); }`)
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
    expect(source('./view/PeoplePicture.tsx')).toContain("from 'lucide-react'")
  })

  it('the lab: letters, icons, tones, fallbacks, chips', () => {
    expect(designScreen.screen).toBe('SCR-owb-people-picture')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['letters', 'icons', 'tones', 'fallbacks', 'chips'])
  })
})
