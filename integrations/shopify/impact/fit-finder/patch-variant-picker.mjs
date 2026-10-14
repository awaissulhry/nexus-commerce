// The only change to an Impact file: on the size option's label row, variant-picker.liquid shows the fit finder's
// "Size guide" link when the product has a fit chart, and the theme's own size chart link otherwise. Same test as the
// theme uses for its link (not in quick buy, size option only). Idempotent; refuses when Impact's markup moved.
const ANCHOR = "          {%- if hide_size_chart != true and block.settings.size_chart_page != blank and size_label_list contains option_downcase -%}"
const HOOK = [
  '          {%- comment -%}Xavia fit finder: integrations/shopify/impact/fit-finder in the Nexus repository{%- endcomment -%}',
  '          {%- liquid',
  "            assign xff_link = ''",
  '            if hide_size_chart != true and size_label_list contains option_downcase',
  '              capture xff_link',
  "                render 'xavia-fit-finder', product: product, option: option, form_id: form_id",
  '              endcapture',
  '            endif',
  '          -%}',
  '          {%- if xff_link != blank -%}',
  '            {{- xff_link -}}',
  '          {%- elsif hide_size_chart != true and block.settings.size_chart_page != blank and size_label_list contains option_downcase -%}',
].join('\n')

export function patchVariantPicker(source) {
  if (source.includes("render 'xavia-fit-finder'")) return source
  const found = source.split(ANCHOR).length - 1
  if (found !== 1) throw new Error(`variant-picker.liquid: the size chart link was expected once, found ${found}. Impact changed; place the hook by hand.`)
  return source.replace(ANCHOR, () => HOOK)
}
