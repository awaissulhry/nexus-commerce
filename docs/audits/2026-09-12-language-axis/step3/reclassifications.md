# Q-LX3-1 — production shadow reclassification list

Written 2026-09-12T06:43:08.889673+00:00, for production snapshot **2026-09-12T06:39:05.637Z**. **Review pending; this list does not authorize its own acceptance.**

338 products (37 roots), 977 listings, 20 account/alias-aware marketplace coordinates, nine languages. GALE-JACKET positive control: 21 family rows. All rows visible to the production role were included; RLS visibility was checked. Transaction read-only and rolled back.

**14,033 differing observations / 692,203 comparisons**, including 10,030 value differences and 4,003 differences of metadata only. **Zero unclassified differences.**

| ID | Observations | Proposed classification |
|---|---:|---|
| R10-empty-field-fallback | 6,085 | Absent/default empty text fields fall through individually rather than hiding a populated lower tier. |
| R2-default-language-listing-pin | 866 | Existing listing title/description and broken-inheritance overrides are pins for Marketplace.languages[0] only. |
| R6-explicit-source-fallback | 2,945 | An exact-language sourceContent miss now returns source text with its actual source language. |
| R7-outbound-content-retired | 134 | Provider/store-specific content bags no longer supply authored language content. |
| R8-language-review-metadata | 4,003 | The resolved value reports its actual language and translation-row review status. |

R10 is the raw resolver contract’s empty-value representation (`[]` becomes `null` when no stored tier answers). Existing API list projections can retain `[]`; no stored list changes. R8 compares actual-language/review metadata only where the bytes agree. R2 includes title and description columns even when Follow Master is enabled, per design LX.3; explicit override columns still respect their follow flag.

The categories were declared before production measurement. Two defects were fixed rather than reclassified: missing native variant aliases, and an explicit child attribute clear that resurrected parent text. Their regressions are in the resolver tests.

Representative exact observations (text previews are shortened; every full old/new value and its classification is in production-diffs.jsonl and production-diffs.json.gz):

## R10-empty-field-fallback

1J-EYE5-Y0TW · Shared · de · bulletPoints · reader `global-content`

```json
{
  "old": {
    "value": []
  },
  "next": {
    "value": null,
    "tier": "computed",
    "language": "it",
    "requested": "de",
    "provenance": {
      "member": "inherited",
      "from": null
    }
  }
}
```

Field/language occurrences: bulletPoints/de: 338, bulletPoints/en: 338, bulletPoints/es: 338, bulletPoints/fr: 338, bulletPoints/it: 339, bulletPoints/nl: 338, bulletPoints/pl: 338, bulletPoints/sv: 338, bulletPoints/tr: 338, keywords/de: 338, keywords/en: 338, keywords/es: 338, keywords/fr: 338, keywords/it: 338, keywords/nl: 338, keywords/pl: 338, keywords/sv: 338, keywords/tr: 338.

## R2-default-language-listing-pin

GALE-JACKET-BLACK-MEN-3XL · EBAY/IT · it · title · reader `attribute-coordinate`

```json
{
  "old": {
    "value": "XAVIA GALE Giacca Da Moto Da Uomo - Giubbotto Moto Impermeabile E Ventilata Con Protezione Di Livello 2 | Per Tutte Le Stagioni",
    "source": "masterColumn",
    "inheritedFrom": "cmokmy0jf0003pm0ppnu1b2yy:name",
    "requestedLocale": "it",
    "effectiveLocale": "it",
    "translationState": "current"
  },
  "next": {
    "value": "Giubbotto Impermeabile e Traspirante Con Protezione Livello 2 | Giacca Moto Uomo",
    "tier": "pin",
    "language": "it",
    "requested": "it",
    "provenance": {
      "member": "pinned",
      "from": "cmqrogyqs0001njpktgl6ylk3"
    }
  }
}
```

Field/language occurrences: description/it: 222, title/de: 184, title/es: 123, title/fr: 115, title/it: 222.

## R6-explicit-source-fallback

1J-EYE5-Y0TW · Shared · de · title · reader `sourceContent`

```json
{
  "old": {
    "value": null
  },
  "next": {
    "value": "Xavia Riser Guanti da Moto in Pelle Unisex | Guanti da Moto Touch Screen, Guanti per Moto Traspiranti con Protezione Paranocche per Scooter, Motocross, Motorino, ATV, BMX, MTB, Arrampicata",
    "tier": "source",
    "language": "it",
    "requested": "de",
    "provenance": {
      "member": "inherited",
      "from": "Italian · source"
    }
  }
}
```

Field/language occurrences: style/de: 9, style/en: 9, style/es: 9, style/fr: 9, style/it: 9, style/nl: 9, style/pl: 9, style/sv: 9, style/tr: 9, title/de: 338, title/en: 338, title/es: 338, title/fr: 338, title/nl: 338, title/pl: 338, title/sv: 338, title/tr: 338, weave_type/de: 20, weave_type/en: 20, weave_type/es: 20, weave_type/fr: 20, weave_type/nl: 20, weave_type/pl: 20, weave_type/sv: 20, weave_type/tr: 20.

## R7-outbound-content-retired

85-A8DQ-UNYF · AMAZON/ES · es · title · reader `syndication-title`

```json
{
  "old": {
    "value": null
  },
  "next": {
    "value": "Xavia Misano - Chaqueta de moto para hombre - Chaqueta de motorista de piel ligera y transpirable con protecciones de nivel 2 certificadas CE, Negro , 44",
    "tier": "pin",
    "language": "es",
    "requested": "es",
    "provenance": {
      "member": "pinned",
      "from": "cmp27idw201g3nv01jk4nt11r"
    }
  }
}
```

Field/language occurrences: title/de: 76, title/es: 21, title/fr: 37.

## R8-language-review-metadata

1J-EYE5-Y0TW · AMAZON/IT · it · title · reader `attribute-coordinate`

```json
{
  "old": {
    "value": "Xavia Riser Guanti da Moto in Pelle Unisex | Guanti da Moto Touch Screen, Guanti per Moto Traspiranti con Protezione Paranocche per Scooter, Motocross, Motorino, ATV, BMX, MTB, Arrampicata",
    "source": "channelExplicit",
    "inheritedFrom": "cmonwkpmb0001nq01ykxmdg59"
  },
  "next": {
    "value": "Xavia Riser Guanti da Moto in Pelle Unisex | Guanti da Moto Touch Screen, Guanti per Moto Traspiranti con Protezione Paranocche per Scooter, Motocross, Motorino, ATV, BMX, MTB, Arrampicata",
    "tier": "pin",
    "language": "it",
    "requested": "it",
    "provenance": {
      "member": "pinned",
      "from": "cmonwkpmb0001nq01ykxmdg59"
    }
  }
}
```

Field/language occurrences: bulletPoints/de: 218, bulletPoints/es: 124, bulletPoints/fr: 154, bulletPoints/it: 462, description/de: 172, description/es: 124, description/fr: 124, description/it: 322, title/de: 460, title/es: 348, title/fr: 308, title/it: 1167, weave_type/it: 20.

## Gate and remaining work

Please acknowledge that you have reviewed this list before the flag/reader switch. This is the explicit gate in your Step 3 instruction and design §5. Until then, all Appendix B readers and their locale branches remain unchanged; DEFAULT_LOCALE is not removed; route/service/import normaliser integration remains pending. No Step 4 schema or writer routing is started.

No migrations, data movement, backfill, existing-value writes, provider calls, publication rehearsal, push or deployment occurred. Regional APlusContent keys (72 existing it-IT rows) remain untouched; their read boundaries must normalize in memory, without folding those rows.

[All field/language counts](field-language-counts.md) · [Machine-readable receipt](production-shadow.json) · [Every difference](production-diffs.jsonl)
