# Etsy field crosswalk

Verified against the connected catalogue on 2026-09-10T22:04:55.681Z. Existing Etsy listings were excluded.

Every native field has a shared source or a declared owner. Ownership does not supply missing listing values or establish publish readiness. Etsy category properties are added after category selection and requirements refresh.

| Etsy field | Shared column / workspace | Source or owner | Authoring |
| --- | --- | --- | --- |
| `description` | `description` | Master `description` | Listing override / mapping |
| `featured_rank` | `featured_rank` | Listing settings | Listing setting |
| `is_customizable` | `is_customizable` | Listing settings | Listing setting |
| `materials` | `material` | Master `material` | Listing override / mapping |
| `image_ids` | `productMedia` | Product media | Product Media editor |
| `styles` | `style` | Master `style` | Listing override / mapping |
| `title` | `name` | Master `title` | Listing override / mapping |
| `taxonomy_id` | `taxonomy_id` | Etsy category selection | Listing setting |
| `is_supply` | `is_supply` | Listing settings | Listing setting |
| `type` | `type` | Listing settings | Listing setting |
| `production_partner_ids` | `production_partner_ids` | Listing settings | Listing setting |
| `shop_section_id` | `shop_section_id` | Listing settings | Listing setting |
| `when_made` | `when_made` | Listing settings | Listing setting |
| `who_made` | `who_made` | Listing settings | Listing setting |
| `tags` | `keywords` | Master `keywords` | Listing override / mapping |
| `converted_price__amount` | `converted_price__amount` | Channel-reported data | Reported by Etsy |
| `converted_price__currency_code` | `converted_price__currency_code` | Channel-reported data | Reported by Etsy |
| `converted_price__divisor` | `converted_price__divisor` | Channel-reported data | Reported by Etsy |
| `price_currency_code` | `price_currency_code` | Channel-reported data | Reported by Etsy |
| `price` | `price` | Master `basePrice` | Listing override / mapping |
| `quantity` | `quantity` | Master `totalStock` | Listing override / mapping |
| `item_dimensions_unit` | `dimUnit` | Master `dimUnit` | Listing override / mapping |
| `item_height` | `dimHeight` | Master `dimHeight` | Listing override / mapping |
| `item_length` | `dimLength` | Master `dimLength` | Listing override / mapping |
| `item_weight` | `weightValue` | Master `weightValue` | Listing override / mapping |
| `item_width` | `dimWidth` | Master `dimWidth` | Listing override / mapping |
| `processing_max` | `processing_max` | Listing settings | Listing setting |
| `processing_min` | `processing_min` | Listing settings | Listing setting |
| `readiness_state_id` | `readiness_state_id` | Listing settings | Listing setting |
| `shipping_profile_id` | `shipping_profile_id` | Listing settings | Listing setting |
| `item_weight_unit` | `weightUnit` | Master `weightUnit` | Listing override / mapping |
| `should_auto_renew` | `should_auto_renew` | Channel policies | Listing setting |
| `return_policy_id` | `return_policy_id` | Channel policies | Listing setting |
| `is_taxable` | `is_taxable` | Channel policies | Listing setting |
| `created_timestamp` | `created_timestamp` | Channel-reported data | Reported by Etsy |
| `ending_timestamp` | `ending_timestamp` | Channel-reported data | Reported by Etsy |
| `file_data` | `file_data` | Channel-reported data | Reported by Etsy |
| `has_variations` | `has_variations` | Channel-reported data | Reported by Etsy |
| `is_personalizable` | `is_personalizable` | Channel-reported data | Reported by Etsy |
| `is_private` | `is_private` | Channel-reported data | Reported by Etsy |
| `language` | `language` | Channel-reported data | Reported by Etsy |
| `listing_id` | `listing_id` | Channel-reported data | Reported by Etsy |
| `state` | `state` | Channel-reported data | Reported by Etsy |
| `non_taxable` | `non_taxable` | Channel-reported data | Reported by Etsy |
| `num_favorers` | `num_favorers` | Channel-reported data | Reported by Etsy |
| `original_creation_timestamp` | `original_creation_timestamp` | Channel-reported data | Reported by Etsy |
| `rich_description` | `rich_description` | Channel-reported data | Reported by Etsy |
| `shop_id` | `shop_id` | Channel-reported data | Reported by Etsy |
| `state_timestamp` | `state_timestamp` | Channel-reported data | Reported by Etsy |
| `suggested_title` | `suggested_title` | Channel-reported data | Reported by Etsy |
| `updated_timestamp` | `updated_timestamp` | Channel-reported data | Reported by Etsy |
| `url` | `url` | Channel-reported data | Reported by Etsy |
| `user_id` | `user_id` | Channel-reported data | Reported by Etsy |

## Consolidated API aliases

| API names | Retained field |
| --- | --- |
| `style`, `styles` | `styles` → Master `style` |
| `listing_type`, `type` | `type` (explicit physical/digital choice) |
| `creation_timestamp`, `created_timestamp` | `created_timestamp` (Created on Etsy) |
| `last_modified_timestamp`, `updated_timestamp` | `updated_timestamp` (Updated on Etsy) |

Original API names remain in schema coverage. Timestamp aliases retain legacy read paths. Product creation/update dates in Nexus are different events and are not used for Etsy timestamps.

## Category mappings

Exact editable taxonomy names `color` / `primary_color`, `material` / `materials`, `style` and unscaled `size` inherit their corresponding Master facts. Category-specific property IDs retain separate storage, constraints and options. Fixed category values use Etsy’s selection; variation-only properties and scaled sizes retain their dedicated setup. Unknown or off-list values remain visible for review. No category is assigned by this audit.
