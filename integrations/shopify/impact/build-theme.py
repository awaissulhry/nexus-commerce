#!/usr/bin/env python3
"""Apply the reviewed Nexus integration to the supplied Impact export; preserve other files byte for byte."""
import argparse, difflib, hashlib, json, re, shutil, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('--output', type=Path, default=Path('output/shopify-impact-2026-09-08'))
parser.add_argument('--customizations', type=Path, default=Path('/Users/awais/Downloads/theme_export__xaviaracing-it-xavia-racing__08SEP2026-0812pm.zip'))
args = parser.parse_args()
with zipfile.ZipFile(args.customizations) as archive:
    previous = {name: archive.read(name) for name in archive.namelist() if not name.endswith('/')}
if json.loads(previous['config/settings_schema.json'])[0]['theme_version'] != '6.11.2': raise ValueError('Review merchant customizations before applying a different earlier theme.')
root = args.output / 'theme'
root.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(args.source) as archive:
    original = {name: archive.read(name) for name in archive.namelist() if not name.endswith('/')}
for name, data in original.items():
    target = root / name
    if not target.resolve().is_relative_to(root.resolve()): raise ValueError('Unsafe archive path')
    target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
settings = json.loads(original['config/settings_schema.json'])
if settings[0]['theme_name'] != 'Impact' or settings[0]['theme_version'] != '7.2.0': raise ValueError('This patch is verified for Impact 7.2.0. Review the hooks before applying to another version.')
template = json.loads(original['templates/product.json'])
def write(name, value): (root / name).write_text(value)
def source(name): return original[name].decode()
def replace_once(text, old, new):
    if text.count(old) != 1: raise ValueError(f'Expected exactly one hook: {old[:100]}')
    return text.replace(old, new, 1)
def lookup(field, variable='nexus_field'):
    namespace, key = field.split('.')
    return f'''{{%- liquid
  assign nexus_variant = product.selected_or_first_available_variant
  assign nexus_contract = nexus_variant.metafields.nexus.resolved.value
  assign {variable} = product.metafields.{namespace}.{key}
  if nexus_contract.fields contains '{field}'
    assign {variable} = nexus_variant.metafields.{namespace}.{key}
  endif
-%}}
'''

# The managed gallery is a copy of Impact's markup, using explicit ordered IDs and its own carousel.
gallery = source('snippets/product-gallery.liquid')
gallery = replace_once(gallery, "{%- assign default_media = product.selected_or_first_available_variant.featured_media | default: product.featured_media -%}", '''{%- liquid
  assign nexus_contract = product.selected_or_first_available_variant.metafields.nexus.resolved.value
  assign nexus_media = null | sort
  for nexus_id in nexus_contract.mediaIds
    assign nexus_numeric_id = nexus_id | plus: 0
    assign nexus_match = product.media | where: 'id', nexus_numeric_id
    assign nexus_media = nexus_media | concat: nexus_match
  endfor
  assign default_media = nexus_media.first
-%}''')
start = gallery.index('{%- comment -%}', gallery.index('product_gallery_id'))
end = gallery.index('<product-gallery', start)
gallery = gallery[:start] + '{%- assign filtered_indexes = null | sort -%}\n' + gallery[end:]
gallery = gallery.replace('<product-gallery\n', '<product-gallery\n  data-nexus-gallery\n').replace('product.media', 'nexus_media')
# Restore the lookup against all product media; other loops only iterate the resolved order.
gallery = gallery.replace("assign nexus_match = nexus_media | where:", "assign nexus_match = product.media | where:")
gallery = gallery.replace('{{ default_media.position | minus: 1 }}', '0')
gallery = gallery.replace("{% if media.alt contains '@expand' %}", "{% if media == default_media %}")
gallery = gallery.replace("{%- for media in nexus_media -%}", """{%- for media in nexus_media -%}
  {%- liquid
    assign nexus_media_key = media.id | append: ''
    assign nexus_alt_values = nexus_contract.alts[nexus_media_key]
    assign nexus_language = request.locale.iso_code
    assign nexus_base_language = nexus_language | split: '-' | first
    assign nexus_alt = nexus_alt_values[nexus_language] | default: nexus_alt_values[nexus_base_language] | default: nexus_alt_values.default | default: media.alt
  -%}""")
gallery = gallery.replace("render 'media',", "render 'nexus-impact-media',\n              nexus_alt: nexus_alt,")
gallery = gallery.replace("| image_tag: loading: 'lazy',", "| image_tag: alt: nexus_alt, loading: 'lazy',")
gallery = '<div data-nexus-gallery-shell form="{{ product_form_id }}">\n{%- if product.selected_or_first_available_variant.metafields.nexus.resolved.value.mediaIds.size > 0 -%}\n' + gallery + '\n{%- endif -%}\n</div>\n'
write('snippets/nexus-impact-gallery.liquid', gallery)
# The existing `preload` flag only set loading/fetchpriority. Forward it to Shopify
# so the selected image is advertised in the HTTP Link header with matching sizes.
media = source('snippets/media.liquid').replace('loading: loading,', 'loading: loading,\n        preload: preload,')
write('snippets/media.liquid', media)
write('snippets/nexus-impact-media.liquid', media.replace('| image_tag:\n', '| image_tag:\n        alt: nexus_alt,\n'))
write('snippets/product-gallery.liquid', "{%- if product.metafields.nexus.resolved.value.managed -%}\n  {%- render 'nexus-impact-gallery', product: product, product_form_id: product_form_id -%}\n{%- else -%}\n" + source('snippets/product-gallery.liquid') + '\n{%- endif -%}\n')

# Adapt the custom product-template sections by reusing their original markup and layout settings.
# Dynamic metaobject bindings are discovered from the actual export, not guessed from field names.
section_fields = {
    'text-with-icons': 'custom.text_with_icon', 'media-with-text': 'custom.media_with_text_product_page',
    'scrolling-text': 'custom.scrolling_text_product_page', 'video': 'custom.video_product_page',
    'press': 'custom.press_product_page', 'multiple-images-with-text': 'custom.multiple_images_with_text_product_page',
    'media-grid': 'custom.media_grid_product_page', 'slideshow': 'custom.slideshow_product_page',
}
bindings = []
for sid, configured in template['sections'].items():
    section_type = configured['type']
    if section_type not in section_fields: continue
    field = section_fields[section_type]
    path = f'sections/{section_type}.liquid'
    body, schema = source(path).split('{% schema %}', 1)
    if section_type == 'slideshow':
        body = replace_once(body, 'if section.settings.show_initial_transition %}', 'if section.settings.show_initial_transition and section.index != 1 %}')
    schema_data = json.loads(schema.split('{% endschema %}', 1)[0])
    schema_data['settings'].append({'type': 'checkbox', 'id': 'nexus_variant_content', 'label': 'Use Nexus variant content', 'default': False})
    schema = '\n' + json.dumps(schema_data, ensure_ascii=False, indent=2) + '\n{% endschema %}\n'
    clone = body
    declarations = lookup(field) + '{%- assign nexus_entry = nexus_field.value -%}\n'
    repeated = next((b for b in configured.get('blocks', {}).values() if 'repeater' in b), None)
    if repeated is None:
        # Some exports use `source` + `settings` instead of a named repeater key.
        repeated = next((b for b in configured.get('blocks', {}).values() if '{{ block.repeater.' in json.dumps(b)), None)
    if repeated:
        # One source metaobject list expands the configured repeated block. Static defaults stay exact.
        declarations += '{%- assign nexus_blocks = nexus_entry -%}\n'
        clone = clone.replace('section.blocks', 'nexus_blocks')
        settings_keys = sorted(set(re.findall(r'block\.settings\.(\w+)', clone)))
        block_declarations = []
        for key in settings_keys:
            setting = repeated['settings'].get(key)
            match = re.search(r'block\.repeater\.(\w+)', str(setting))
            if match:
                expr = f'block.{match.group(1)}' + (' | metafield_tag' if '| metafield_tag' in setting else '.value')
                block_declarations.append(f'{{%- assign nexus_block_{key} = {expr} -%}}')
            else:
                literal = 'nil' if setting is None else str(setting).lower() if isinstance(setting, bool) else json.dumps(setting, ensure_ascii=False)
                block_declarations.append(f'{{%- assign nexus_block_{key} = {literal} -%}}')
        clone = re.sub(r'block\.settings\.(\w+)', lambda m: 'nexus_block_' + m[1], clone)
        clone = clone.replace('block.id', 'block.system.id').replace('{{ block.shopify_attributes }}', '')
        clone = clone.replace('block.type', json.dumps(repeated['type']))
        clone = re.sub(r'({%-? for block in nexus_blocks -?%})', lambda m: m[1] + '\n' + '\n'.join(block_declarations), clone)
    else:
        for bid, block in configured.get('blocks', {}).items():
            for setting, value in block.get('settings', {}).items():
                match = re.search(r'product\.metafields\.[\w]+\.[\w]+\.value\.(\w+)', str(value))
                if match:
                    expr = f'nexus_entry.{match[1]}.value'
                    key = f'nexus_block_{setting}'
                    # Current singleton video template only binds its heading text.
                    clone = clone.replace(f'block.settings.{setting}', key)
                    declarations += f'{{%- assign {key} = {expr} -%}}\n'
    for setting, value in configured.get('settings', {}).items():
        match = re.search(r'product\.metafields\.[\w]+\.[\w]+\.value\.(\w+)', str(value))
        if match:
            key = f'nexus_section_{setting}'
            clone = re.sub(rf'section\.settings\.{setting}\b', key, clone)
            declarations += f'{{%- assign {key} = nexus_entry.{match[1]}.value -%}}\n'
    # Section-properties reads shared section settings internally; pass the resolved colour overrides.
    colors = ['background', 'text_color']
    override_params = ', '.join(f'{key}: nexus_section_{key}' for key in colors if f'nexus_section_{key}' in declarations)
    if override_params:
        clone = clone.replace("render 'section-properties'", f"render 'section-properties', {override_params}")
    clone = declarations + '{%- if nexus_entry != blank -%}\n' + clone + '\n{%- endif -%}\n'
    write(f'snippets/nexus-impact-{section_type}.liquid', clone)
    wrapper = f'''{{%- if product.metafields.nexus.resolved.value.managed and section.settings.nexus_variant_content -%}}
<div data-nexus-section="{{{{ section.id }}}}" data-nexus-product="{{{{ product.id }}}}">
  {{%- render 'nexus-impact-{section_type}', product: product -%}}
</div>
{{%- else -%}}
{body}
{{%- endif -%}}
{{% schema %}}{schema}'''
    write(path, wrapper)
    bindings.append({'section': sid, 'type': section_type, 'field': field})

# Features: retain custom HTML/CSS, replace its document-wide script with a scoped custom element.
blocks = template['sections']['main']['blocks']
nexus_template = json.loads(json.dumps(template))
for bid, block in nexus_template['sections']['main']['blocks'].items():
    if block['type'] in ['text', 'button', 'collapsible_text']:
        block.pop('source', None)
        block.pop('repeater', None)
    if any(field in json.dumps(block) for field in ['custom.concise_description', 'custom.custom_button_product_page', 'custom.collapsible_text', 'features_metafield']):
        block['settings']['nexus_variant_content'] = True
for configured in nexus_template['sections'].values():
    if configured['type'] in section_fields:
        configured['settings']['nexus_variant_content'] = True
write('templates/product.nexus.json', json.dumps(nexus_template, ensure_ascii=False, indent=2) + '\n')
features_block = next((bid for bid, b in blocks.items() if b['type'] == 'liquid' and 'features_metafield' in b['settings'].get('liquid', '')), None)
if features_block:
    features = lookup('custom.features', 'features_metafield') + lookup('custom.features_title', 'features_title') + (HERE / 'nexus-features.liquid').read_text()
    features = features.replace("'Features'", "nexus_features_label")
    features = "{%- assign nexus_features_label = 'nexus.features' | t -%}\n" + features
    write('snippets/nexus-impact-features.liquid', features)

# Main-product custom fields retain their existing placements, static settings and layout.
info = source('snippets/product-info.liquid')
info = replace_once(info, "{%- if contains_product -%}", "{%- if contains_product and product.metafields.nexus.resolved.value.managed != true -%}")
for bid, block in blocks.items():
    type_ = block['type']
    if type_ == 'text' and 'custom.concise_description' in json.dumps(block):
        old = '{{- block.settings.text -}}'
        new = f'''{{%- if product.metafields.nexus.resolved.value.managed and block.id == '{bid}' -%}}
{lookup('custom.concise_description')}
{{{{- nexus_field.value.text | metafield_tag -}}}}
{{%- else -%}}{old}{{%- endif -%}}'''
        info = replace_once(info, old, new)
        info = info.replace("{%- if block.settings.text != blank -%}", "{%- if block.settings.text != blank or product.metafields.nexus.resolved.value.managed -%}")
    elif type_ == 'button' and 'custom.custom_button_product_page' in json.dumps(block):
        begin = info.index("{%- when 'button' -%}"); end = info.index("{%- when 'liquid' -%}", begin)
        old = info[begin:end]
        override = lookup('custom.custom_button_product_page') + "{%- if nexus_field.value.text.value != blank -%}<div class=\"product-info__button\">{%- render 'button', content: nexus_field.value.text.value, href: nexus_field.value.link.value, size: block.settings.size, style: block.settings.style, stretch: block.settings.stretch, background: nexus_field.value.background.value, text_color: nexus_field.value.text_color.value -%}</div>{%- endif -%}"
        info = info[:begin] + "{%- when 'button' -%}\n" + f"{{%- if product.metafields.nexus.resolved.value.managed and block.id == '{bid}' -%}}\n{override}\n{{%- else -%}}\n" + old.split("{%- when 'button' -%}", 1)[1] + '\n{%- endif -%}\n' + info[end:]
    elif type_ == 'collapsible_text' and 'custom.collapsible_text' in json.dumps(block):
        begin = info.index("{%- when 'collapsible_text' -%}"); end = info.index("{%- when 'disclosures' -%}", begin)
        old = info[begin:end]
        override = lookup('custom.collapsible_text') + '''{%- for nexus_item in nexus_field.value -%}
{%- capture nexus_content -%}<div class="prose">{{ nexus_item.content | metafield_tag }}</div>{%- endcapture -%}
{%- render 'accordion', title: nexus_item.title.value, content: nexus_content, icon: nexus_item.icon.value, icon_width: block.settings.icon_width, class: 'product-info__accordion' -%}
{%- endfor -%}'''
        # Repeated block IDs can carry a Shopify suffix. Render the list once; skip expanded copies.
        info = info[:begin] + "{%- when 'collapsible_text' -%}\n" + f"{{%- if product.metafields.nexus.resolved.value.managed and block.id contains '{bid}' -%}}\n{{%- unless nexus_accordions_rendered -%}}{override}{{%- assign nexus_accordions_rendered = true -%}}{{%- endunless -%}}\n{{%- else -%}}\n" + old.split("{%- when 'collapsible_text' -%}", 1)[1] + '\n{%- endif -%}\n' + info[end:]
if features_block:
    # Shopify evaluates liquid settings first. Match the existing rendered
    # feature-group marker, not its source variable or a generated block ID.
    info = replace_once(info, '{{ block.settings.liquid }}', "{%- if block.settings.liquid contains 'features-accordion-group' or block.settings.nexus_variant_content -%}{%- render 'nexus-impact-features', product: product -%}{%- else -%}{{ block.settings.liquid }}{%- endif -%}")
begin = info.index("{%- when 'associated_products' -%}")
end = info.index("{%- when 'offer' -%}", begin)
complementary = info[begin:end]
complementary = complementary.replace('block.settings.title', 'nexus_complementary_title')
complementary = complementary.replace("{%- when 'associated_products' -%}", "{%- when 'associated_products' -%}" + lookup('custom.complementary_products_heading') + "{%- assign nexus_complementary_title = block.settings.title -%}{%- if product.metafields.nexus.resolved.value.managed -%}{%- assign nexus_complementary_title = nexus_field.value -%}{%- endif -%}")
complementary = complementary.replace('<product-recommendations ', '<product-recommendations data-nexus-recommendation-title="{{ nexus_complementary_title | escape }}" ')
complementary = complementary.replace('<p>{{ nexus_complementary_title | escape }}</p>', '<p data-nexus-recommendation-heading>{{ nexus_complementary_title | escape }}</p>')
info = info[:begin] + complementary + info[end:]
write('snippets/product-info.liquid', info)

# Render managed details in stable containers even when a family source is empty.
# Shopify can omit source/repeater blocks for blank family metafields; native variants still need their content.
details = """{%- assign nexus_contract = product.selected_or_first_available_variant.metafields.nexus.resolved.value -%}
{%- for nexus_display in nexus_contract.displayFields -%}
  {%- assign nexus_parts = nexus_display.key | split: '.' -%}
  {%- assign nexus_value = product.selected_or_first_available_variant.metafields[nexus_parts.first][nexus_parts.last] -%}
  {%- if nexus_value != blank -%}
    <div class="product-info__text"><p class="h6">{{ nexus_display.label | escape }}</p><div class="prose">
      {%- case nexus_value.type -%}
        {%- when 'json' -%}<pre>{{ nexus_value.value | json | escape }}</pre>
        {%- when 'metaobject_reference', 'list.metaobject_reference' -%}
          {%- assign nexus_entries = nexus_value.value -%}
          {%- if nexus_value.type == 'metaobject_reference' -%}{%- assign nexus_entries = nexus_entries | sort -%}{%- endif -%}
          {%- for nexus_entry in nexus_entries -%}{%- render 'nexus-impact-entry', entry: nexus_entry, definitions: nexus_contract.entryTypes, depth: 0 -%}{%- endfor -%}
        {%- else -%}{{ nexus_value | metafield_tag }}
      {%- endcase -%}
    </div></div>
  {%- endif -%}
{%- endfor -%}
"""
write('snippets/nexus-impact-details.liquid', details)
write('snippets/nexus-impact-entry.liquid', """{%- if depth < 5 -%}
{%- assign nexus_definition = definitions | where: 'type', entry.system.type | first -%}
{%- assign next_depth = depth | plus: 1 -%}
{%- for entry_field in nexus_definition.fields -%}
  {%- assign entry_value = entry[entry_field.key] -%}
  {%- if entry_value != blank -%}
    <div><span class="text-subdued">{{ entry_field.label | escape }}</span>
    {%- case entry_value.type -%}
      {%- when 'metaobject_reference' -%}{%- render 'nexus-impact-entry', entry: entry_value.value, definitions: definitions, depth: next_depth -%}
      {%- when 'list.metaobject_reference' -%}{%- for child_entry in entry_value.value -%}{%- render 'nexus-impact-entry', entry: child_entry, definitions: definitions, depth: next_depth -%}{%- endfor -%}
      {%- when 'json' -%}<pre>{{ entry_value.value | json | escape }}</pre>
      {%- else -%}{{ entry_value | metafield_tag }}
    {%- endcase -%}</div>
  {%- endif -%}
{%- endfor -%}
{%- endif -%}
""")
info = info.replace('</safe-sticky>', """{%- if product.metafields.nexus.resolved.value.managed -%}
<div data-block-type="nexus-details" data-block-id="nexus-details">{%- render 'nexus-impact-details', product: product -%}</div>
{%- endif -%}
</safe-sticky>""")
info = re.sub(r"block.id (?:==|contains) '[^']+'", 'block.settings.nexus_variant_content', info)
write('snippets/product-info.liquid', info)
main = source('sections/main-product.liquid').replace('{%- if product.media.size > 0 -%}', '{%- if product.media.size > 0 or product.metafields.nexus.resolved.value.managed -%}')
main_body, main_schema = main.split('{% schema %}', 1)
main_schema_data = json.loads(main_schema.split('{% endschema %}', 1)[0])
for block_schema in main_schema_data['blocks']:
    if block_schema['type'] in ['text', 'button', 'liquid', 'collapsible_text']:
        block_schema['settings'].append({'type': 'checkbox', 'id': 'nexus_variant_content', 'label': 'Use Nexus variant content', 'default': False})
main = main_body + '{% schema %}\n' + json.dumps(main_schema_data, ensure_ascii=False, indent=2) + '\n{% endschema %}\n'
write('sections/main-product.liquid', main)

# Collection cards keep native Impact markup, variant prices/badges and quick-buy.
# A collection opts in only after its independently reviewed order is synchronised.
card = source('snippets/product-card.liquid')
card = card.replace('assign main_media_loading_strategy = null', "assign main_media_loading_strategy = 'eager'\n          assign nexus_card_priority = 'auto'\n          if section.index <= 3 and position <= 2\n            assign nexus_card_priority = 'high'\n          endif")
card = card.replace('| image_tag: loading: main_media_loading_strategy,', '| image_tag: loading: main_media_loading_strategy, fetchpriority: nexus_card_priority,')
card = replace_once(card, "    {%- if settings.product_color_display != 'hide' and show_swatches != false -%}", "    {%- render 'nexus-impact-card-swatches', product: product, nexus_variant: nexus_variant -%}\n    {%- if settings.product_color_display != 'hide' and show_swatches != false -%}")
card = card.replace('product.featured_media', 'nexus_media.first').replace('product.media.size', 'nexus_media.size')
card = card.replace('product.selected_or_first_available_variant', 'nexus_variant').replace('product.available', 'nexus_variant.available')
card = card.replace('product.url', 'nexus_variant.url')
card = card.replace('product.title', 'nexus_card_title')
card = card.replace("assign next_media = product.media[nexus_media.first.position] | default: product.media[1]", 'assign next_media = nexus_media[1]')
card = card.replace("render 'price-list', product: product,", "render 'price-list', product: product, variant: nexus_variant,")
card = card.replace("render 'product-badges', product: product,", "render 'nexus-impact-card-badges', product: product, variant: nexus_variant,")
card = card.replace('quick-buy-{{ section.id }}-{{ product.id }}', 'quick-buy-{{ section.id }}-{{ product.id }}-{{ nexus_variant.id }}')
card = card.replace('<product-card\n', '<product-card\n  data-nexus-variant="{{ nexus_variant.id }}"\n  data-nexus-card="{{ product.id }}:{{ nexus_card.id | escape }}"\n  data-nexus-price="{{ nexus_variant.price }}"\n  data-nexus-title="{{ nexus_card_title | escape }}"\n')
card = card.replace('| image_tag: loading: main_media_loading_strategy,', '| image_tag: alt: nexus_main_alt, loading: main_media_loading_strategy,')
card = card.replace("| image_tag:\n              class:", "| image_tag:\n              alt: nexus_secondary_alt,\n              class:")
card_setup = """{%- liquid
  assign show_swatches = false
  assign nexus_contract = nexus_variant.metafields.nexus.resolved.value
  assign nexus_media = null | sort
  for nexus_id in nexus_contract.mediaIds
    assign nexus_numeric_id = nexus_id | plus: 0
    assign nexus_match = product.media | where: 'id', nexus_numeric_id
    assign nexus_media = nexus_media | concat: nexus_match
  endfor
  assign nexus_main_key = nexus_media.first.id | append: ''
  assign nexus_secondary_key = nexus_media[1].id | append: ''
  assign nexus_main_alt = nexus_contract.alts[nexus_main_key][request.locale.iso_code] | default: nexus_contract.alts[nexus_main_key].default
  assign nexus_secondary_alt = nexus_contract.alts[nexus_secondary_key][request.locale.iso_code] | default: nexus_contract.alts[nexus_secondary_key].default
-%}
{%- capture nexus_card_title -%}{{ product.title }}{%- for option_index in nexus_card.optionIndexes %} · {{ nexus_variant.options[option_index] }}{% endfor -%}{%- endcapture -%}
"""
write('snippets/nexus-impact-product-card.liquid', card_setup + card)
badges = source('snippets/product-badges.liquid').replace('product.compare_at_price', 'variant.compare_at_price').replace('product.price', 'variant.price')
write('snippets/nexus-impact-card-badges.liquid', badges)
write('snippets/nexus-impact-collection-cards.liquid', """{%- if product.metafields.nexus.resolved.value.managed and product.metafields.nexus.resolved.value.cards.size > 0 -%}
  {%- for nexus_chunk in (0..4) -%}
    {%- assign nexus_offset = nexus_chunk | times: 50 -%}
    {%- for nexus_card in product.metafields.nexus.resolved.value.cards limit: 50 offset: nexus_offset -%}
      {%- liquid
        assign nexus_candidates = null | sort
        for nexus_variant_chunk in (0..4)
          assign nexus_variant_offset = nexus_variant_chunk | times: 50
          for nexus_variant_id in nexus_card.variantIds limit: 50 offset: nexus_variant_offset
            assign nexus_numeric_id = nexus_variant_id | plus: 0
            assign nexus_matches = product.variants | where: 'id', nexus_numeric_id | where: 'matched', true
            assign nexus_candidates = nexus_candidates | concat: nexus_matches
          endfor
        endfor
        assign nexus_available = nexus_candidates | where: 'available', true | sort: 'price'
        assign nexus_variant = nexus_available.first
        if nexus_variant == blank
          assign nexus_candidates = nexus_candidates | sort: 'price'
          assign nexus_variant = nexus_candidates.first
        endif
        if nexus_variant != blank
          render 'nexus-impact-product-card', product: product, nexus_variant: nexus_variant, nexus_card: nexus_card, stacked: true, position: position, show_badges: true
        endif
      -%}
    {%- endfor -%}
  {%- endfor -%}
{%- else -%}
  <div data-nexus-card="{{ product.id }}:family" data-nexus-price="{{ product.price }}" data-nexus-title="{{ product.title | escape }}">{%- render 'product-card', product: product, stacked: true, position: position, show_badges: true -%}</div>
{%- endif -%}
""")
write('snippets/nexus-impact-card-swatches.liquid', (HERE / 'nexus-card-swatches.liquid').read_text())
legacy_card = source('snippets/product-card.liquid')
legacy_card = legacy_card.replace('assign main_media_loading_strategy = null', "assign main_media_loading_strategy = 'eager'\n          assign nexus_card_priority = 'auto'\n          if section.index <= 3 and position <= 2\n            assign nexus_card_priority = 'high'\n          endif")
legacy_card = legacy_card.replace('| image_tag: loading: main_media_loading_strategy,', '| image_tag: loading: main_media_loading_strategy, fetchpriority: nexus_card_priority,')
legacy_card = legacy_card.replace('<product-card\n', '<product-card\n  data-nexus-variant="{{ product.selected_or_first_available_variant.id }}"\n')
legacy_card = replace_once(legacy_card, "    {%- if settings.product_color_display != 'hide' and show_swatches != false -%}", "    {%- render 'nexus-impact-card-swatches', product: product -%}\n    {%- if settings.product_color_display != 'hide' and show_swatches != false -%}")
write('snippets/nexus-impact-legacy-card.liquid', legacy_card)
write('snippets/product-card.liquid', """{%- if product.metafields.nexus.resolved.value.managed -%}
  {%- assign nexus_variant = product.selected_or_first_available_variant -%}
  {%- assign nexus_id = nexus_variant.id | append: '' -%}
  {%- assign nexus_card = product.metafields.nexus.resolved.value.swatches.first -%}
  {%- for nexus_chunk in (0..4) -%}
    {%- assign nexus_offset = nexus_chunk | times: 50 -%}
    {%- for nexus_group in product.metafields.nexus.resolved.value.swatches limit: 50 offset: nexus_offset -%}
      {%- if nexus_group.variantIds contains nexus_id -%}{%- assign nexus_card = nexus_group -%}{%- endif -%}
    {%- endfor -%}
  {%- endfor -%}
  {%- render 'nexus-impact-product-card', product: product, nexus_variant: nexus_variant, nexus_card: nexus_card, show_rating: show_rating, show_vendor: show_vendor, show_quick_buy: show_quick_buy, show_secondary_image: show_secondary_image, stacked: stacked, position: position, reveal: reveal, background: background, text_color: text_color, text_alignment: text_alignment, show_badges: show_badges -%}
{%- else -%}
  {%- render 'nexus-impact-legacy-card', product: product, show_rating: show_rating, show_vendor: show_vendor, show_quick_buy: show_quick_buy, show_secondary_image: show_secondary_image, show_swatches: show_swatches, stacked: stacked, position: position, reveal: reveal, background: background, text_color: text_color, text_alignment: text_alignment, show_badges: show_badges -%}
{%- endif -%}
""")
write('templates/product.nexus-card.liquid', "{% layout none %}\n{%- render 'product-card', product: product, show_badges: true -%}\n")
# Carry the exact merchant CSS forward, followed by narrowly scoped compatibility/accessibility fixes.
merchant_css = previous['assets/theme.css'].decode().split('/* Sticky Product Image - Desktop Only for Impact Theme */', 1)
if len(merchant_css) != 2: raise ValueError('Previous sticky-gallery customization was not found.')
write('assets/nexus-xavia-customizations.css', '/* Sticky Product Image - Desktop Only for Impact Theme */' + merchant_css[1] + """
/* Hide floating app surfaces for the menu's complete open lifecycle. */
/* Klaviyo resets child visibility to visible, so hiding only its host's
   visibility leaves the banner painted. Remove these fixed hosts from layout. */
html.nexus-menu-open :is(shopify-chat, .loloyal-launcher-wrapper, #loloyal-core-popup-root, [class*="kl-teaser-"], [data-nexus-floating-promotion]) { display: none !important; visibility: hidden !important; pointer-events: none !important; }
/* The mobile teaser sits between the observed loyalty/chat launchers. Keep
   its dismissal inside the banner instead of hanging behind the chat button. */
@media (max-width: 699px) {
  [class*="kl-teaser-"] { left: 88px !important; right: 88px !important; bottom: max(16px, env(safe-area-inset-bottom)) !important; margin: 0 !important; width: auto !important; max-width: 320px !important; }
  [class*="kl-teaser-"] [role="button"] { min-height: 56px !important; padding: 12px 48px 12px 12px !important; border-radius: 10px !important; }
  [class*="kl-teaser-"] [role="button"] :is(div, span) { font-size: 14px !important; line-height: 1.3 !important; }
  [class*="kl-teaser-"] .klaviyo-close-form { display: grid !important; place-items: center !important; top: 6px !important; right: 2px !important; width: 44px !important; height: 44px !important; }
}
.linked-products-swatches { width: 100%; }
/* The managed shell participates in the same grid as the original gallery. */
@media (min-width: 1000px) { .product > [data-nexus-gallery-shell] { display: contents; } }
/* Reserve a real grid row for thumbnails. The previous flex layout allowed
   the main carousel's intrinsic height to push them below the sticky box. */
@media (min-width: 1000px) {
  .product .product-gallery { display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 16px; height: calc(100svh - 120px); min-height: 0; }
  .product .product-gallery__media-list-wrapper { min-height: 0; height: 100%; margin-bottom: 0; }
  .product .product-gallery__media-list { min-height: 0; height: 100%; grid-auto-rows: 100%; }
  .product .product-gallery__media { min-height: 0; max-height: 100%; }
  .product .product-gallery__thumbnail-list-wrapper { height: 80px; margin: 0; padding: 0; min-height: 0; }
  /* The observed loyalty launcher occupies x=20..80 at the viewport bottom. */
  .product .product-gallery__thumbnail-list { height: 80px; padding-block: 8px; padding-inline-start: max(var(--spacing-6), calc(96px - var(--container-gutter))); align-items: center; }
}
.product .product-gallery__thumbnail img { object-fit: contain; }
.linked-variant-thumb[hidden], .linked-products-more[hidden] { display: none !important; }
.product-card:focus-within .linked-products-swatches { opacity: 1; visibility: visible; transform: translateY(0); max-height: 100px; margin-top: var(--spacing-1); }
.linked-variant-thumb:focus-visible { outline: 2px solid rgb(var(--text-color)); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .linked-products-swatches, .linked-variant-thumb, .linked-variant-thumb img { transition: none !important; } .product-gallery__thumbnail-list { scroll-behavior: auto; } }
""" + (HERE / 'nexus-features.css').read_text())
collection = source('sections/main-collection.liquid')
collection = collection.replace('<style>', '<style>\n  nexus-collection { display: block; }\n  nexus-collection product-list[hidden] { display: none !important; }', 1)
old = "{%- render 'product-card', product: product, stacked: true, position: forloop.index, show_badges: true -%}"
collection = replace_once(collection, old, "{%- if collection.metafields.nexus.card_order.value.version == 1 -%}{%- render 'nexus-impact-collection-cards', product: product, position: forloop.index -%}{%- else -%}" + old + "{%- endif -%}")
collection = replace_once(collection, "{%- paginate collection.products by section.settings.products_per_page -%}", """{%- paginate collection.products by section.settings.products_per_page -%}
{%- if collection.metafields.nexus.card_order.value.version == 1 -%}
<nexus-collection data-collection-id="{{ collection.id }}" data-pages="{{ paginate.pages }}" data-current-page="{{ paginate.current_page }}" data-page-param="{{ paginate.page_param }}" data-page-size="{{ section.settings.products_per_page }}" data-product-count="{{ collection.products_count }}" data-sort="{{ collection.sort_by | default: 'manual' }}" data-loading="{{ 'nexus.collection_loading' | t | escape }}" data-error="{{ 'nexus.collection_error' | t | escape }}" data-retry="{{ 'nexus.retry' | t | escape }}" data-count="{{ 'nexus.card_count' | t | escape }}" data-page-label="{{ 'nexus.page' | t | escape }}">
<script type="application/json" data-nexus-order>{{ collection.metafields.nexus.card_order.value | json }}</script>
<p role="status" aria-live="polite" data-nexus-collection-status></p>
<nav class="pagination" data-nexus-card-pagination aria-label="{{ 'general.accessibility.pagination' | t | escape }}" hidden></nav>
{%- endif -%}
""")
collection = replace_once(collection, '{%- endpaginate -%}', '{%- if collection.metafields.nexus.card_order.value.version == 1 -%}</nexus-collection>{%- endif -%}\n{%- endpaginate -%}')
collection = collection.replace('class="{{ promo_class_list }}"', 'class="{{ promo_class_list }}" data-nexus-promo-position="{{ block.settings.position }}"')
write('sections/main-collection.liquid', collection)

# Theme hooks: abort stale selections, replace the ordered gallery, update custom sections from the SAME response.
js = source('assets/theme.js')
js = 'import "nexus-menu-widgets";\nimport "nexus-card-swatches";\nimport "nexus-collection";\nimport { beginSelection, isCurrentSelection, finishSelection, applyContentSections } from "nexus-impact";\n' + js
# The real store has a slideshow repeater with no resolved slides. Impact's
# original callback dereferences an absent slide, including on the old theme.
js = replace_once(js, '    if (this.selectedIndex === 0) {\n      this.selectedSlide.classList.add("is-selected");', '    if (!this.items.length) return;\n    if (this.selectedIndex === 0) {\n      this.selectedSlide.classList.add("is-selected");')
js = replace_once(js, '    const selectedSlide = this.selectedSlide;\n    await imageLoaded(selectedSlide.querySelectorAll("img"));', '    const selectedSlide = this.selectedSlide;\n    if (!selectedSlide) return;\n    await imageLoaded(selectedSlide.querySelectorAll("img"));')
js = replace_once(js, '  async selectCombination({ optionValues, productChange }) {\n    const previousVariant', '''  async selectCombination({ optionValues, productChange }) {
    const nexusForm = __privateGet(this, _form);
    const nexusSelection = beginSelection(this, nexusForm);
    try {
    const previousVariant''')
js = replace_once(js, '    if (!productChange) {\n      const newVariantPicker', '    if (!isCurrentSelection(nexusForm, nexusSelection)) return;\n    if (!productChange) {\n      const newVariantPicker')
js = js.replace('__privateGet(this, _form).id.value = __privateGet(this, _selectedVariant)?.id;', '__privateGet(this, _form).id.value = __privateGet(this, _selectedVariant)?.id ?? "";')
js = replace_once(js, '    __privateGet(this, _form).dispatchEvent(\n      new CustomEvent("product:rerender",', '    applyContentSections(newContent, this);\n    __privateGet(this, _form).dispatchEvent(\n      new CustomEvent("product:rerender",')
js = replace_once(js, '    Shopify?.PaymentButton?.init();\n  }\n};\n_form =', '    Shopify?.PaymentButton?.init();\n    finishSelection(nexusForm, nexusSelection, __privateGet(this, _selectedVariant));\n    } catch (error) {\n      finishSelection(nexusForm, nexusSelection, null, error);\n      this.dispatchEvent(new CustomEvent("nexus:variant-error", { bubbles: true, detail: { message: error.message } }));\n    }\n  }\n};\n_form =') if '    Shopify?.PaymentButton?.init();\n  }\n};\n_form =' in js else replace_once(js, '    Shopify?.PaymentButton?.init();\n  }\n};\n_preloadedHtml', '    Shopify?.PaymentButton?.init();\n    finishSelection(nexusForm, nexusSelection, __privateGet(this, _selectedVariant));\n    } catch (error) {\n      finishSelection(nexusForm, nexusSelection, null, error);\n      this.dispatchEvent(new CustomEvent("nexus:variant-error", { bubbles: true, detail: { message: error.message } }));\n    }\n  }\n};\n_preloadedHtml')
js = replace_once(js, '    const sectionQueryParam = this.getAttribute("context") === "quick_buy" ? "" : `&section_id=${this.getAttribute("section-id")}`;\n    const promise = new Promise(async (resolve) => {\n      resolve(await (await fetch(`${productUrl}?option_values=${optionValuesAsString}${sectionQueryParam}`)).text());\n    });', '''    const sectionQueryParam = this.getAttribute("context") === "quick_buy" || this.hasAttribute("data-nexus-content") ? "" : `&section_id=${this.getAttribute("section-id")}`;
    const nexusUrl = new URL(`${productUrl}?option_values=${optionValuesAsString}${sectionQueryParam}`, window.location.origin);
    const previewTheme = new URL(window.location.href).searchParams.get("preview_theme_id");
    if (previewTheme) nexusUrl.searchParams.set("preview_theme_id", previewTheme);
    const promise = fetch(nexusUrl, { signal: AbortSignal.timeout(20000) }).then(response => {
      if (!response.ok) throw new Error(`Option request failed (${response.status})`);
      return response.text();
    }).catch(error => {
      __privateGet(_VariantPicker, _preloadedHtml).delete(hashKey);
      throw error;
    });''')
js = replace_once(js, '    return `${optionValuesAsString}-${this.getAttribute("section-id")}`;', '    return `${this.productHandle}-${window.location.pathname}-${optionValuesAsString}-${this.getAttribute("section-id")}`;') if '    return `${optionValuesAsString}-${this.getAttribute("section-id")}`;' in js else js.replace('return `${optionValuesAsString}-${this.getAttribute("section-id")}`;', 'return `${this.productHandle}-${window.location.pathname}-${optionValuesAsString}-${this.getAttribute("section-id")}`;')
js = replace_once(js, '    if (!event.detail.variant) {\n      return;\n    }\n    let newMediaPosition;', '    if (this.hasAttribute("data-nexus-gallery") || !event.detail.variant) {\n      return;\n    }\n    let newMediaPosition;')
js = replace_once(js, '    this._abortController.abort();\n  }\n  get filteredIndexes()', '    this._abortController.abort();\n    this._photoswipe?.destroy();\n  }\n  get filteredIndexes()')
# The gallery shell persists even for an explicitly empty set, so a subsequent selection can restore it.
hook = '  const focusedElement = document.activeElement;\n  if (!this.hasAttribute("allow-partial-rerender")'
js = replace_once(js, hook, '''  const focusedElement = document.activeElement;
  const nexusGallery = this.querySelector('[data-nexus-gallery-shell]');
  const newNexusGallery = matchingElement.querySelector('[data-nexus-gallery-shell]');
  if (nexusGallery && newNexusGallery && !event.detail.productChange) nexusGallery.replaceWith(newNexusGallery.cloneNode(true));
  const recommendation = this.querySelector('[data-nexus-recommendation-title]');
  const nextRecommendation = matchingElement.querySelector('[data-nexus-recommendation-title]');
  if (recommendation && nextRecommendation) {
    recommendation.dataset.nexusRecommendationTitle = nextRecommendation.dataset.nexusRecommendationTitle;
    const heading = recommendation.querySelector('[data-nexus-recommendation-heading]');
    if (heading) { heading.textContent = recommendation.dataset.nexusRecommendationTitle; heading.hidden = !heading.textContent; }
  }
  if (!this.hasAttribute("allow-partial-rerender")''')
js = replace_once(js, '      "liquid"\n    ];', '      "liquid",\n      ...(this.querySelector("[data-nexus-content]") ? ["text", "button", "collapsible-text", "nexus-details"] : [])\n    ];')
for parameter in ['target.control', 'input']:
    old = f'__privateMethod(this, _VariantPicker_instances, renderForCombination_fn).call(this, __privateMethod(this, _VariantPicker_instances, getOptionValuesFromOption_fn).call(this, {parameter}));'
    js = replace_once(js, old, old[:-1] + '.catch(() => {});')
js = replace_once(js, '      this.replaceChildren(...document.importNode(productRecommendationsElement, true).childNodes);', '''      this.replaceChildren(...document.importNode(productRecommendationsElement, true).childNodes);
      if (this.hasAttribute('data-nexus-recommendation-title')) {
        const heading = this.querySelector('[data-nexus-recommendation-heading]');
        if (heading) { heading.textContent = this.dataset.nexusRecommendationTitle; heading.hidden = !heading.textContent; }
      }''')
# Size-guide page HTML stays inert until the drawer opens. This avoids fetching
# hidden full-size images and preserves Impact's drawer, focus trap and animation.
js = replace_once(js, '          this.removeAttribute("inert");\n          this._originalParentBeforeAppend = null;', '''          const deferredContent = this.querySelector(':scope > template[data-nexus-deferred-content]');
          if (deferredContent) deferredContent.replaceWith(deferredContent.content.cloneNode(true));
          this.removeAttribute("inert");
          this._originalParentBeforeAppend = null;''')
# Prefetch on demonstrated intent (the existing pointer/touch listeners), rather
# than issuing a request for every size as soon as a picker enters the viewport.
# Actual option selection still uses the same cache, request and error handling.
js = replace_once(js, '    __privateAdd(this, _intersectionObserver, new IntersectionObserver(__privateMethod(this, _VariantPicker_instances, onIntersection_fn).bind(this)));\n', '')
js = replace_once(js, '    __privateGet(this, _intersectionObserver).observe(this);\n', '')
js = replace_once(js, '    __privateGet(this, _intersectionObserver).unobserve(this);\n', '')
js = replace_once(js, '_intersectionObserver = new WeakMap();\n', '')
js = replace_once(js, ', _intersectionObserver, _form,', ', _form,')
js = replace_once(js, ', onIntersection_fn, renderForCombination_fn,', ', renderForCombination_fn,')
bulk_prefetch_start = js.index('/**\n * When the variant picker is intersecting the viewport')
bulk_prefetch_end = js.index('renderForCombination_fn = async function', bulk_prefetch_start)
js = js[:bulk_prefetch_start] + js[bulk_prefetch_end:]
write('assets/theme.js', js)
write('assets/nexus-impact.js', (HERE / 'nexus-impact.js').read_text())
write('assets/nexus-collection.js', (HERE / 'nexus-collection.js').read_text())
write('assets/nexus-card-swatches.js', (HERE / 'nexus-card-swatches.js').read_text())
write('assets/nexus-menu-widgets.js', (HERE / 'nexus-menu-widgets.js').read_text())
layout = source('layout/theme.liquid').replace('"photoswipe":', '"nexus-impact": "{{ \'nexus-impact.js\' | asset_url }}",\n          "photoswipe":')
layout = layout.replace('"photoswipe":', '"nexus-collection": "{{ \'nexus-collection.js\' | asset_url }}",\n          "photoswipe":')
layout = layout.replace('<html lang=', '<html data-nexus-variant-error="{{ \'nexus.variant_error\' | t | escape }}" lang=')
layout = layout.replace('"photoswipe":', '"nexus-menu-widgets": "{{ \'nexus-menu-widgets.js\' | asset_url }}",\n          "nexus-card-swatches": "{{ \'nexus-card-swatches.js\' | asset_url }}",\n          "photoswipe":')
# Keep merchant customizations as an independently reviewable source asset, but
# deliver them in the theme stylesheet to avoid a second render-blocking request.
write('assets/theme.css', source('assets/theme.css') + '\n/* Nexus customization bundle: generated by build-theme.py. */\n' + (root / 'assets/nexus-xavia-customizations.css').read_text())
# Discover the stylesheet before the app-injected head markup. CSS variables keep
# their original position and the cascade remains theme first, overrides last.
layout = replace_once(layout, "    {{- 'theme.css' | asset_url | stylesheet_tag: preload: true -}}", '')
layout = replace_once(layout, "    {%- render 'social-meta-tags' -%}", "    {{- 'theme.css' | asset_url | stylesheet_tag: preload: true -}}\n\n    {%- render 'social-meta-tags' -%}")
# Preserve pinch zoom; the export disabled it at the viewport level.
layout = layout.replace(', minimum-scale=1.0, maximum-scale=1.0', '')
write('layout/theme.liquid', layout)
header_body, header_schema = source('sections/header.liquid').split('{% schema %}', 1)
header_body = replace_once(header_body, '      show_country_selector: section.settings.show_country_selector,', '      show_country_selector: section.settings.show_mobile_country_selector,')
header_schema_data = json.loads(header_schema.split('{% endschema %}', 1)[0])
header_schema_data['settings'].append({'type': 'checkbox', 'id': 'show_mobile_country_selector', 'label': 'Show country/currency in mobile menu', 'default': True})
write('sections/header.liquid', header_body + '{% schema %}\n' + json.dumps(header_schema_data, ensure_ascii=False, indent=2) + '\n{% endschema %}\n')
picker = source('snippets/variant-picker.liquid').replace('<variant-picker\n', '<variant-picker\n    {% if product.metafields.nexus.resolved.value.managed %}data-nexus-content{% endif %}\n')
picker = replace_once(picker, '''              <div class="prose">
                {{- block.settings.size_chart_page.content -}}
              </div>''', '''              <template data-nexus-deferred-content>
                <div class="prose">
                  {{- block.settings.size_chart_page.content -}}
                </div>
              </template>''')
picker = replace_once(picker, "        if variant_image_options contains option_downcase", "        assign nexus_axis_index = option.position | minus: 1\n        if product.metafields.nexus.resolved.value.managed and product.metafields.nexus.resolved.value.thumbnailAxisIndexes contains nexus_axis_index\n          assign resolved_option_selector_style = 'variant_image'\n        endif\n        if variant_image_options contains option_downcase")
write('snippets/variant-picker.liquid', picker)
storefront_translations = {
    'locales/fr.json': {
        'read_more': 'En savoir plus', 'show_more': 'Voir plus', 'show_less': 'Voir moins', 'close': 'Fermer', 'features': 'Caractéristiques',
        'variant_error': 'Impossible de charger les options sélectionnées. Sélectionnez-les à nouveau avant d’ajouter au panier.',
        'collection_loading': 'Chargement de la collection…', 'collection_error': 'Impossible de charger la collection complète. Réessayez.',
        'retry': 'Réessayer', 'card_count': '{count} articles', 'page': 'Page', 'card_options': 'Variantes', 'all_options': 'Afficher toutes les variantes',
    },
    'locales/de.json': {
        'read_more': 'Mehr erfahren', 'show_more': 'Mehr anzeigen', 'show_less': 'Weniger anzeigen', 'close': 'Schließen', 'features': 'Merkmale',
        'variant_error': 'Die gewählten Optionen konnten nicht geladen werden. Wähle sie erneut aus, bevor du den Artikel in den Warenkorb legst.',
        'collection_loading': 'Kollektion wird geladen…', 'collection_error': 'Die vollständige Kollektion konnte nicht geladen werden. Versuche es erneut.',
        'retry': 'Erneut versuchen', 'card_count': '{count} Artikel', 'page': 'Seite', 'card_options': 'Varianten', 'all_options': 'Alle Varianten anzeigen',
    },
    'locales/es.json': {
        'read_more': 'Más información', 'show_more': 'Ver más', 'show_less': 'Ver menos', 'close': 'Cerrar', 'features': 'Características',
        'variant_error': 'No se pudieron cargar las opciones seleccionadas. Vuelve a seleccionarlas antes de añadir el artículo al carrito.',
        'collection_loading': 'Cargando la colección…', 'collection_error': 'No se pudo cargar la colección completa. Vuelve a intentarlo.',
        'retry': 'Reintentar', 'card_count': '{count} artículos', 'page': 'Página', 'card_options': 'Variantes', 'all_options': 'Ver todas las variantes',
    },
}
for name, data in original.items():
    if not name.startswith('locales/') or not name.endswith('.json'): continue
    locale = json.loads(data)
    locale['nexus'] = ({'read_more': 'Leggi di più', 'show_more': 'Mostra di più', 'show_less': 'Mostra meno', 'close': 'Chiudi', 'features': 'Caratteristiche', 'variant_error': 'Impossibile caricare le opzioni selezionate. Selezionale di nuovo prima di aggiungere al carrello.'} if name == 'locales/it.json' else {'read_more': 'Read more', 'show_more': 'Show more', 'show_less': 'Show less', 'close': 'Close', 'features': 'Features', 'variant_error': 'The selected options could not be loaded. Select your options again before adding to cart.'})
    locale['nexus'].update({'collection_loading': 'Caricamento della collezione…', 'collection_error': 'Impossibile caricare la collezione completa. Riprova.', 'retry': 'Riprova', 'card_count': '{count} articoli', 'page': 'Pagina'} if name == 'locales/it.json' else {'collection_loading': 'Loading collection…', 'collection_error': 'The complete collection could not be loaded. Try again.', 'retry': 'Retry', 'card_count': '{count} items', 'page': 'Page'})
    locale['nexus'].update({'card_options': 'Varianti', 'all_options': 'Mostra tutte le varianti'} if name == 'locales/it.json' else {'card_options': 'Variants', 'all_options': 'View all variants'})
    locale['nexus'].update(storefront_translations.get(name, {}))
    # Translate the five currently offered storefront languages; retain explicit
    # English fallbacks for other installed locales. Product content is separate.
    if '.schema.' not in name: write(name, json.dumps(locale, ensure_ascii=False, indent=2) + '\n')

manifest = []
for file in sorted(root.rglob('*')):
    if not file.is_file(): continue
    name = file.relative_to(root).as_posix(); data = file.read_bytes()
    if original.get(name) != data: manifest.append({'file': name, 'change': 'modified' if name in original else 'added', 'sha256': hashlib.sha256(data).hexdigest(), 'originalSha256': hashlib.sha256(original[name]).hexdigest() if name in original else None})
args.output.mkdir(parents=True, exist_ok=True)
zip_path = args.output / 'nexus-impact-7.2.0-review.zip'
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob('*')):
        if file.is_file():
            entry = zipfile.ZipInfo(file.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, file.read_bytes())
shutil.copyfile(zip_path, args.output / 'nexus-impact-7.2.0.zip')
patch = []
for change in manifest:
    name = change['file']
    before = original.get(name, b'').decode().splitlines(keepends=True)
    after = (root / name).read_text().splitlines(keepends=True)
    for line in difflib.unified_diff(before, after, fromfile='a/' + name if name in original else '/dev/null', tofile='b/' + name):
        patch.append(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n')
(args.output / 'theme.patch').write_text(''.join(patch))
(args.output / 'changes.json').write_text(json.dumps({'sourceSha256': hashlib.sha256(args.source.read_bytes()).hexdigest(), 'impactVersion': '7.2.0', 'customizationSourceSha256': hashlib.sha256(args.customizations.read_bytes()).hexdigest(), 'customizationSourceVersion': '6.11.2', 'zip': zip_path.name, 'zipSha256': hashlib.sha256(zip_path.read_bytes()).hexdigest(), 'zipBytes': zip_path.stat().st_size, 'changes': manifest, 'bindings': bindings}, indent=2) + '\n')
print(f'Prepared {zip_path}: {len(manifest)} changed or added files. Original export preserved.')
