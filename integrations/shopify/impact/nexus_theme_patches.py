"""Small, separately checkable patches applied by build-theme.py (exact anchors; any mismatch raises)."""
from pathlib import Path

HERE = Path(__file__).resolve().parent


def replace_once(text, old, new):
    if text.count(old) != 1: raise ValueError(f'Expected exactly one anchor: {old[:80]!r}')
    return text.replace(old, new)


def patch_slideshow(text, image, mobile, block_id, type_guard=''):
    """The first slide's photo downloads alone, with a soft 48 px preview that is preloaded at high priority; later
    slides keep their srcset/src in data-nexus-* until the first is shown (nexus-slideshow-release.liquid)."""
    start = text.index('              <picture>\n')
    end = text.index('              </picture>\n', start) + len('              </picture>\n')
    picture = text[start:end]
    held = ("              {%- capture nexus_picture -%}\n" + picture + "              {%- endcapture -%}\n"
            "              {%- if forloop.first -%}{{ nexus_picture }}{%- else -%}{{ nexus_picture | replace: ' srcset=\"', ' data-nexus-srcset=\"' | replace: ' src=\"', ' data-nexus-src=\"' }}{%- endif -%}\n")
    preload = ("              {%- if forloop.first -%}\n"
               "                {%- comment -%}Nexus: the soft preview of the first slide arrives before its photo (styled above).{%- endcomment -%}\n"
               "                {%- if " + mobile + " != blank -%}\n"
               "                  <link rel=\"preload\" as=\"image\" fetchpriority=\"high\" media=\"(max-width: 699px)\" href=\"{{ " + mobile + " | image_url: width: 48 }}\">\n"
               "                  <link rel=\"preload\" as=\"image\" fetchpriority=\"high\" media=\"(min-width: 700px)\" href=\"{{ " + image + " | image_url: width: 48 }}\">\n"
               "                {%- else -%}\n"
               "                  <link rel=\"preload\" as=\"image\" fetchpriority=\"high\" href=\"{{ " + image + " | image_url: width: 48 }}\">\n"
               "                {%- endif -%}\n"
               "              {%- endif -%}\n")
    text = text[:start] + preload + held + text[end:]
    rule_end = "      --slideshow-slide-controls-color: {{ controls_color.rgb }};\n    }\n"
    text = replace_once(text, rule_end, rule_end + (
        "    {%- if forloop.first and " + type_guard + image + " != blank -%}\n"
        "      #block-" + block_id + " .content-over-media > picture > img { background: url({{ " + image + " | image_url: width: 48 }}) center / cover no-repeat; }\n"
        "      {%- if " + mobile + " != blank -%}\n"
        "        @media (max-width: 699px) { #block-" + block_id + " .content-over-media > picture > img { background-image: url({{ " + mobile + " | image_url: width: 48 }}); } }\n"
        "      {%- endif -%}\n"
        "    {%- endif -%}\n"))
    tail = "  </slideshow-carousel>\n</x-slideshow>\n"
    return replace_once(text, tail, tail + (HERE / 'nexus-slideshow-release.liquid').read_text())


def patch_layout(layout):
    """Product pages place the colour row before the first frame (head); every page loads nexus-photos.js."""
    viewport = '    <meta name="viewport" content="width=device-width, initial-scale=1.0, height=device-height">\n'
    layout = replace_once(layout, viewport, viewport + '\n' + (HERE / 'nexus-colour-place.liquid').read_text())
    speed = "    {%- if request.page_type == 'product' -%}\n      <script type=\"module\" src=\"{{ 'nexus-product-speed.js' | asset_url }}\"></script>\n    {%- endif -%}\n"
    return replace_once(layout, speed, "    <script type=\"module\" src=\"{{ 'nexus-photos.js' | asset_url }}\"></script>\n\n" + speed)
