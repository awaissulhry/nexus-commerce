import assert from 'node:assert/strict'
import { test } from 'node:test'
import { themeDefinitions } from './theme-definitions.mjs'

test('selector lists keep dark values out of the light reference', () => {
  const { light, dark } = themeDefinitions(`
    :root { --nds-text: #111; --nds-bg: #fff; }
    .dark, .dark body:has(.nds-theme-responsive), .dark body .nds-theme-responsive {
      --nds-text: #eee;
      --nds-bg: #222;
    }
  `)
  assert.equal(light.get('--nds-text'), '#111')
  assert.equal(light.get('--nds-bg'), '#fff')
  assert.equal(dark.get('--nds-text'), '#eee')
  assert.equal(dark.get('--nds-bg'), '#222')
})

test('comments and descendant overrides do not become root theme declarations', () => {
  const { light, dark } = themeDefinitions(`
    /* .dark { --nds-text: red; } */
    :root { --nds-text: #111; /* --nds-hidden: red; */ }
    .dark .panel { --nds-text: blue; }
    :root { --nds-text: #222; }
  `)
  assert.deepEqual([...light], [['--nds-text', '#222']])
  assert.equal(dark.size, 0)
})
