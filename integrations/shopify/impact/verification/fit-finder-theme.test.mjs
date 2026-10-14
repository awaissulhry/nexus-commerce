import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { buildAsset } = await import('../fit-finder/build.mjs')
const { patchVariantPicker } = await import('../fit-finder/patch-variant-picker.mjs')
const { TEXT } = await import('../fit-finder/xavia-fit-i18n.js')
const read = name => readFileSync(new URL(`../fit-finder/${name}`, import.meta.url), 'utf8')

test('the theme asset builds into one module that loads and exposes open() and init()', async () => {
  const asset = buildAsset()
  assert.ok(!asset.includes('__XFF_CSS__') && asset.includes('.xff-dialog'), 'the CSS is inside')
  assert.ok(!/^import /m.test(asset), 'no imports left: the theme serves one file')
  const dir = mkdtempSync(join(tmpdir(), 'xff-')), file = join(dir, 'xavia-fit-finder.mjs')
  writeFileSync(file, asset)
  const module = await import(pathToFileURL(file))
  assert.equal(typeof module.open, 'function')
  assert.equal(typeof module.init, 'function')
  rmSync(dir, { recursive: true })
})

// The real Impact file is licensed theme code and stays out of this public repository; this keeps its shape.
const picker = [
  '          {%- endif -%}',
  '        </div>',
  '',
  "        {%- if resolved_option_selector_style == 'dropdown' -%}",
  '          <div class="relative">',
].join('\n')

test('the variant picker hook goes in once, under the label row, and only for the size option', () => {
  const out = patchVariantPicker(picker)
  assert.equal(out.split("render 'xavia-fit-finder'").length - 1, 1)
  assert.match(out, /<\/div>\n\n.*Xavia fit finder.*\n\s+\{%- if hide_size_chart != true and size_label_list contains option_downcase -%\}\n\s+\{%- render 'xavia-fit-finder', product: product, option: option, form_id: form_id -%\}\n\s+\{%- endif -%\}\n\n\s+\{%- if resolved_option_selector_style == 'dropdown' -%\}/)
  assert.equal(patchVariantPicker(out), out, 'applying twice changes nothing')
  assert.throws(() => patchVariantPicker('<variant-picker></variant-picker>'), /expected once, found 0/)
})

test('every language has every text, with the same {placeholders} as English', () => {
  const holes = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')
  for (const [lang, texts] of Object.entries(TEXT)) {
    assert.deepEqual(Object.keys(texts).sort(), Object.keys(TEXT.en).sort(), `${lang} keys`)
    for (const key of Object.keys(TEXT.en)) {
      if (Array.isArray(TEXT.en[key])) assert.equal(texts[key].length, TEXT.en[key].length, `${lang}.${key}`)
      else assert.equal(holes(texts[key]), holes(TEXT.en[key]), `${lang}.${key} placeholders`)
    }
  }
})

test('the button label the snippet prints before the dialog loads matches the dialog texts', () => {
  const liquid = read('xavia-fit-finder.liquid')
  for (const lang of ['it', 'de', 'fr', 'es']) assert.ok(liquid.includes(`when '${lang}'\n      assign xff_label = '${TEXT[lang].trigger}'`), lang)
  assert.ok(liquid.includes(`else\n      assign xff_label = '${TEXT.en.trigger}'`))
})

test('the boot script and the dialog agree on the saved profile key and the data attributes', () => {
  const liquid = read('xavia-fit-finder.liquid'), ui = read('xavia-fit-finder.js')
  assert.ok(liquid.includes("localStorage.getItem('xavia-fit-profile')") && ui.includes("const STORE = 'xavia-fit-profile'"))
  for (const attribute of ['data-xff', 'data-xff-form', 'data-xff-open', 'data-xff-module', 'data-xff-label', 'data-xff-hint', 'data-xff-config']) assert.ok(liquid.includes(attribute), attribute)
  for (const asset of ['xavia-fit-body-male.js', 'xavia-fit-body-female.js']) assert.ok(liquid.includes(`'${asset}' | asset_url`), asset)
})
