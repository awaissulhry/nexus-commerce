// The only change to an Impact file: variant-picker.liquid renders the fit finder under the size option's label row,
// with the same test the theme uses for its own size chart link. Idempotent; refuses when Impact's markup moved.
const ANCHOR = "        </div>\n\n        {%- if resolved_option_selector_style == 'dropdown' -%}"
const HOOK = [
  '        </div>',
  '',
  '        {%- comment -%}Xavia fit finder: integrations/shopify/impact/fit-finder in the Nexus repository{%- endcomment -%}',
  '        {%- if hide_size_chart != true and size_label_list contains option_downcase -%}',
  "          {%- render 'xavia-fit-finder', product: product, option: option, form_id: form_id -%}",
  '        {%- endif -%}',
  '',
  "        {%- if resolved_option_selector_style == 'dropdown' -%}",
].join('\n')

export function patchVariantPicker(source) {
  if (source.includes("render 'xavia-fit-finder'")) return source
  const found = source.split(ANCHOR).length - 1
  if (found !== 1) throw new Error(`variant-picker.liquid: the size option's label row was expected once, found ${found}. Impact changed; place the hook by hand.`)
  return source.replace(ANCHOR, () => HOOK)
}
