/**
 * Bundled list of common Amazon `productType` identifiers + display
 * names. Used by the Step 3 picker as a fallback when SP-API isn't
 * configured or hasn't been hit yet, so the wizard works end-to-end
 * pre-keys.
 *
 * The full Amazon productType list (~700 entries) varies slightly by
 * marketplace and changes a few times a year. The SP-API call to
 * `searchDefinitionsProductTypes` is the source of truth at runtime —
 * this list is the safety net.
 *
 * Curated for breadth across e-commerce verticals plus motorcycle
 * gear coverage (the user is Xavia, motorcycle gear on Amazon IT).
 * Add entries as gaps surface; don't try to mirror the full SP-API
 * list here.
 */

export interface BundledProductType {
  productType: string
  displayName: string
  /** Free-text tags fed into the local search index — no AI required. */
  keywords: string[]
}

export const BUNDLED_AMAZON_PRODUCT_TYPES: BundledProductType[] = [
  // ── Apparel & Outerwear (motorcycle, fashion) ────────────────────
  { productType: 'OUTERWEAR', displayName: 'Outerwear (Jackets, Coats)', keywords: ['jacket', 'coat', 'parka', 'windbreaker', 'motorcycle jacket', 'leather jacket', 'mesh jacket', 'race jacket', 'touring jacket'] },
  { productType: 'PANTS', displayName: 'Pants', keywords: ['pants', 'trousers', 'jeans', 'motorcycle pants', 'riding pants'] },
  { productType: 'SHORTS', displayName: 'Shorts', keywords: ['shorts'] },
  { productType: 'SHIRT', displayName: 'Shirt', keywords: ['shirt', 'blouse', 'top'] },
  { productType: 'SWEATER', displayName: 'Sweater', keywords: ['sweater', 'pullover', 'jumper'] },
  { productType: 'DRESS', displayName: 'Dress', keywords: ['dress', 'gown'] },
  { productType: 'SKIRT', displayName: 'Skirt', keywords: ['skirt'] },
  { productType: 'SUIT', displayName: 'Suit', keywords: ['suit'] },
  { productType: 'SLEEPWEAR', displayName: 'Sleepwear', keywords: ['pajama', 'pyjama', 'sleepwear', 'nightgown'] },
  { productType: 'UNDERWEAR', displayName: 'Underwear', keywords: ['underwear', 'briefs', 'boxer'] },
  { productType: 'SOCKS', displayName: 'Socks', keywords: ['socks', 'hosiery'] },
  { productType: 'SWIMWEAR', displayName: 'Swimwear', keywords: ['swimwear', 'swimsuit', 'bikini', 'trunks'] },
  { productType: 'ACTIVEWEAR', displayName: 'Activewear', keywords: ['activewear', 'sportswear', 'gym', 'workout'] },

  // ── Footwear ─────────────────────────────────────────────────────
  { productType: 'SHOES', displayName: 'Shoes', keywords: ['shoe', 'shoes', 'sneaker', 'trainer', 'loafer'] },
  { productType: 'BOOT', displayName: 'Boots', keywords: ['boot', 'boots', 'motorcycle boots', 'race boots', 'riding boots'] },
  { productType: 'SANDAL', displayName: 'Sandals', keywords: ['sandal', 'sandals', 'flip flop'] },
  { productType: 'SLIPPER', displayName: 'Slippers', keywords: ['slipper', 'slippers'] },
  { productType: 'DRESS_SHOES', displayName: 'Dress Shoes', keywords: ['dress shoe', 'oxford', 'formal'] },

  // ── Headwear & Helmets ───────────────────────────────────────────
  { productType: 'HELMET', displayName: 'Helmet', keywords: ['helmet', 'motorcycle helmet', 'racing helmet', 'full face', 'modular', 'open face'] },
  { productType: 'HAT', displayName: 'Hat / Cap', keywords: ['hat', 'cap', 'beanie', 'baseball cap'] },
  { productType: 'HEADBAND', displayName: 'Headband', keywords: ['headband', 'sweatband'] },

  // ── Accessories ─────────────────────────────────────────────────
  { productType: 'GLOVES', displayName: 'Gloves', keywords: ['glove', 'gloves', 'leather gloves', 'motorcycle gloves', 'racing gloves'] },
  { productType: 'BACKPACK', displayName: 'Backpack', keywords: ['backpack', 'rucksack'] },
  { productType: 'BAG', displayName: 'Bag', keywords: ['bag', 'handbag', 'tote', 'shoulder bag'] },
  { productType: 'LUGGAGE', displayName: 'Luggage', keywords: ['luggage', 'suitcase', 'travel bag'] },
  { productType: 'WALLET', displayName: 'Wallet', keywords: ['wallet', 'purse'] },
  { productType: 'BELT', displayName: 'Belt', keywords: ['belt'] },
  { productType: 'SUNGLASSES', displayName: 'Sunglasses', keywords: ['sunglasses', 'shades'] },
  { productType: 'EYEWEAR', displayName: 'Eyewear', keywords: ['eyewear', 'glasses', 'goggles', 'motorcycle goggles'] },
  { productType: 'WATCH', displayName: 'Watch', keywords: ['watch', 'wristwatch', 'smartwatch'] },
  { productType: 'JEWELRY', displayName: 'Jewelry', keywords: ['jewelry', 'necklace', 'bracelet', 'earring', 'ring'] },
  { productType: 'SCARF', displayName: 'Scarf', keywords: ['scarf', 'shawl', 'wrap'] },
  { productType: 'TIE', displayName: 'Tie', keywords: ['tie', 'necktie', 'bowtie'] },

  // ── Protective gear (motorcycle, sports) ─────────────────────────
  { productType: 'PROTECTIVE_GEAR', displayName: 'Protective Gear', keywords: ['protective', 'armor', 'pads', 'guards', 'motorcycle armor'] },
  { productType: 'BODY_ARMOR', displayName: 'Body Armor', keywords: ['body armor', 'chest protector', 'back protector'] },
  { productType: 'KNEEPADS', displayName: 'Kneepads', keywords: ['kneepad', 'knee pad', 'knee protector'] },
  { productType: 'ELBOW_PADS', displayName: 'Elbow Pads', keywords: ['elbow pad', 'elbow protector'] },

  // ── Sports & Outdoor ─────────────────────────────────────────────
  { productType: 'SPORTING_GOODS', displayName: 'Sporting Goods', keywords: ['sport', 'sporting goods', 'fitness equipment'] },
  { productType: 'OUTDOOR_RECREATION_PRODUCT', displayName: 'Outdoor Recreation', keywords: ['outdoor', 'camping', 'hiking', 'fishing'] },
  { productType: 'BICYCLE', displayName: 'Bicycle', keywords: ['bicycle', 'bike', 'cycling'] },
  { productType: 'EXERCISE_MAT', displayName: 'Exercise Mat', keywords: ['exercise mat', 'yoga mat'] },

  // ── Automotive (incl. motorcycle parts) ──────────────────────────
  { productType: 'AUTO_PART', displayName: 'Auto Part', keywords: ['auto', 'car', 'automotive', 'motorcycle part'] },
  { productType: 'AUTO_ACCESSORY', displayName: 'Auto Accessory', keywords: ['auto accessory', 'car accessory', 'motorcycle accessory'] },
  { productType: 'TIRE', displayName: 'Tire', keywords: ['tire', 'tyre'] },

  // ── Home & Kitchen ───────────────────────────────────────────────
  { productType: 'HOME', displayName: 'Home', keywords: ['home', 'household'] },
  { productType: 'HOME_BED_AND_BATH', displayName: 'Bed & Bath', keywords: ['bed', 'bath', 'sheets', 'towel', 'pillow'] },
  { productType: 'KITCHEN', displayName: 'Kitchen', keywords: ['kitchen', 'cookware'] },
  { productType: 'COOKWARE', displayName: 'Cookware', keywords: ['cookware', 'pot', 'pan', 'frying pan'] },
  { productType: 'KITCHEN_KNIFE', displayName: 'Kitchen Knife', keywords: ['knife', 'kitchen knife'] },
  { productType: 'DRINKWARE', displayName: 'Drinkware', keywords: ['drinkware', 'mug', 'cup', 'glass'] },
  { productType: 'FURNITURE', displayName: 'Furniture', keywords: ['furniture', 'chair', 'table', 'sofa', 'desk'] },
  { productType: 'LAMP', displayName: 'Lamp', keywords: ['lamp', 'light fixture'] },
  { productType: 'RUG', displayName: 'Rug', keywords: ['rug', 'carpet'] },
  { productType: 'WALL_ART', displayName: 'Wall Art', keywords: ['wall art', 'painting', 'poster', 'print'] },
  { productType: 'CLOCK', displayName: 'Clock', keywords: ['clock'] },
  { productType: 'CANDLE', displayName: 'Candle', keywords: ['candle'] },
  { productType: 'STORAGE_BOX', displayName: 'Storage Box', keywords: ['storage', 'box', 'container', 'bin'] },

  // ── Garden & Outdoor ────────────────────────────────────────────
  { productType: 'LAWN_AND_GARDEN', displayName: 'Lawn & Garden', keywords: ['garden', 'lawn', 'outdoor furniture', 'planter'] },
  { productType: 'TOOL', displayName: 'Tool', keywords: ['tool', 'hand tool', 'power tool'] },

  // ── Office ──────────────────────────────────────────────────────
  { productType: 'OFFICE_PRODUCTS', displayName: 'Office Products', keywords: ['office', 'stationery', 'pen', 'paper'] },
  { productType: 'BACKPACK_BAG', displayName: 'Office / Laptop Bag', keywords: ['laptop bag', 'office bag', 'briefcase'] },

  // ── Electronics ─────────────────────────────────────────────────
  { productType: 'CONSUMER_ELECTRONICS', displayName: 'Consumer Electronics', keywords: ['electronics', 'gadget'] },
  { productType: 'HEADPHONES', displayName: 'Headphones', keywords: ['headphone', 'earphone', 'earbud'] },
  { productType: 'SPEAKERS', displayName: 'Speakers', keywords: ['speaker', 'bluetooth speaker'] },
  { productType: 'MOBILE_PHONE_CASE', displayName: 'Phone Case', keywords: ['phone case', 'phone cover'] },
  { productType: 'CABLES', displayName: 'Cables', keywords: ['cable', 'cord', 'wire'] },
  { productType: 'BATTERY', displayName: 'Battery', keywords: ['battery', 'rechargeable'] },
  { productType: 'CAMERA', displayName: 'Camera', keywords: ['camera', 'photography'] },
  { productType: 'COMPUTER_COMPONENT', displayName: 'Computer Component', keywords: ['computer part', 'pc component'] },

  // ── Beauty & Health ─────────────────────────────────────────────
  { productType: 'BEAUTY', displayName: 'Beauty', keywords: ['beauty', 'cosmetic', 'makeup'] },
  { productType: 'SKIN_CARE', displayName: 'Skin Care', keywords: ['skin care', 'moisturizer', 'serum'] },
  { productType: 'HAIR_CARE', displayName: 'Hair Care', keywords: ['hair care', 'shampoo', 'conditioner'] },
  { productType: 'FRAGRANCE', displayName: 'Fragrance', keywords: ['fragrance', 'perfume', 'cologne'] },
  { productType: 'HEALTH_PERSONAL_CARE', displayName: 'Health & Personal Care', keywords: ['health', 'personal care', 'hygiene'] },
  { productType: 'VITAMIN', displayName: 'Vitamin / Supplement', keywords: ['vitamin', 'supplement'] },

  // ── Toys, Books, Pets, Food ─────────────────────────────────────
  { productType: 'TOYS_AND_GAMES', displayName: 'Toys & Games', keywords: ['toy', 'game', 'puzzle'] },
  { productType: 'BOOK', displayName: 'Book', keywords: ['book', 'novel', 'textbook'] },
  { productType: 'MUSICAL_INSTRUMENT', displayName: 'Musical Instrument', keywords: ['musical instrument', 'guitar', 'keyboard'] },
  { productType: 'PET_SUPPLIES', displayName: 'Pet Supplies', keywords: ['pet', 'dog', 'cat'] },
  { productType: 'GROCERY', displayName: 'Grocery', keywords: ['food', 'grocery', 'snack'] },

  // ── Misc ────────────────────────────────────────────────────────
  { productType: 'CRAFT_SUPPLIES', displayName: 'Craft Supplies', keywords: ['craft', 'art supply'] },
  { productType: 'PARTY_SUPPLIES', displayName: 'Party Supplies', keywords: ['party', 'decoration'] },
]

/**
 * Map Nexus-internal productType identifiers (whatever the seller has
 * tagged on `Product.productType`) to a likely Amazon productType. Used
 * for the rule-based "first guess" hint in the Step 3 picker, so the
 * picker is smart even when AI keys aren't set.
 *
 * Keep entries here lower-case; matched case-insensitively against
 * Product.productType.
 */
export const NEXUS_TO_AMAZON_HINT: Record<string, string> = {
  // Xavia seed taxonomy
  race_jacket: 'OUTERWEAR',
  touring_jacket: 'OUTERWEAR',
  mesh_jacket: 'OUTERWEAR',
  leather_gloves: 'GLOVES',
  race_boots: 'BOOT',
  helmet: 'HELMET',

  // Common synonyms a seller might use
  jacket: 'OUTERWEAR',
  coat: 'OUTERWEAR',
  pants: 'PANTS',
  trousers: 'PANTS',
  shoes: 'SHOES',
  boots: 'BOOT',
  glove: 'GLOVES',
  gloves: 'GLOVES',
  backpack: 'BACKPACK',
  bag: 'BAG',
  watch: 'WATCH',
  sunglasses: 'SUNGLASSES',
  hat: 'HAT',
}

export function findHintFromNexusProductType(
  nexusProductType: string | null | undefined,
): string | null {
  if (!nexusProductType) return null
  const key = nexusProductType.trim().toLowerCase()
  return NEXUS_TO_AMAZON_HINT[key] ?? null
}

/**
 * Phase K.2 — bundled fallback for variation themes per productType.
 * Used by VariationsService when CategorySchema.variationThemes is
 * null (SP-API not configured, schema not yet fetched, or productType
 * absent from cache). The values are the conventional Amazon theme
 * names; the frontend humanises them via the existing
 * KNOWN_THEME_LABELS map.
 *
 * Empty array = no commonly-used theme for that productType (the
 * frontend then offers the "Custom theme" path so the user can name
 * their own attribute set).
 */
export const BUNDLED_THEMES_BY_PRODUCT_TYPE: Record<string, string[]> = {
  // Apparel/outerwear
  OUTERWEAR: ['SIZE_COLOR', 'SIZE_NAME', 'COLOR_NAME'],
  PANTS: ['SIZE_COLOR', 'SIZE_NAME', 'COLOR_NAME'],
  SHORTS: ['SIZE_COLOR', 'SIZE_NAME'],
  SHIRT: ['SIZE_COLOR', 'SIZE_NAME', 'COLOR_NAME'],
  SWEATER: ['SIZE_COLOR', 'SIZE_NAME', 'COLOR_NAME'],
  DRESS: ['SIZE_COLOR', 'SIZE_NAME'],
  SKIRT: ['SIZE_COLOR', 'SIZE_NAME'],
  SUIT: ['SIZE_COLOR', 'SIZE_NAME'],
  SLEEPWEAR: ['SIZE_COLOR', 'SIZE_NAME'],
  UNDERWEAR: ['SIZE_COLOR', 'SIZE_NAME'],
  SOCKS: ['SIZE_COLOR', 'SIZE_NAME'],
  SWIMWEAR: ['SIZE_COLOR', 'SIZE_NAME'],
  ACTIVEWEAR: ['SIZE_COLOR', 'SIZE_NAME'],

  // Footwear
  SHOES: ['SIZE_COLOR', 'SIZE_NAME'],
  BOOT: ['SIZE_COLOR', 'SIZE_NAME'],
  SANDAL: ['SIZE_COLOR', 'SIZE_NAME'],
  SLIPPER: ['SIZE_COLOR', 'SIZE_NAME'],
  DRESS_SHOES: ['SIZE_COLOR', 'SIZE_NAME'],

  // Headwear
  HELMET: ['SIZE_COLOR', 'SIZE_NAME', 'COLOR_NAME'],
  HAT: ['SIZE_COLOR', 'COLOR_NAME'],

  // Accessories
  GLOVES: ['SIZE_COLOR', 'SIZE_NAME'],
  BACKPACK: ['COLOR_NAME', 'STYLE_NAME'],
  BAG: ['COLOR_NAME', 'STYLE_NAME'],
  LUGGAGE: ['COLOR_NAME', 'SIZE_NAME'],
  WALLET: ['COLOR_NAME'],
  BELT: ['SIZE_COLOR', 'SIZE_NAME'],
  SUNGLASSES: ['COLOR_NAME', 'STYLE_NAME'],
  EYEWEAR: ['COLOR_NAME', 'STYLE_NAME'],
  WATCH: ['COLOR_NAME', 'STYLE_NAME'],
  SCARF: ['COLOR_NAME', 'PATTERN_NAME'],
  TIE: ['COLOR_NAME', 'PATTERN_NAME'],

  // Protective gear
  PROTECTIVE_GEAR: ['SIZE_COLOR', 'SIZE_NAME'],
  BODY_ARMOR: ['SIZE_COLOR', 'SIZE_NAME'],
  KNEEPADS: ['SIZE_NAME'],
  ELBOW_PADS: ['SIZE_NAME'],

  // Sports / outdoor
  SPORTING_GOODS: ['STYLE_NAME', 'COLOR_NAME'],
  EXERCISE_MAT: ['COLOR_NAME', 'SIZE_NAME'],

  // Home / kitchen — most are single-axis
  COOKWARE: ['SIZE_NAME'],
  KITCHEN_KNIFE: ['STYLE_NAME', 'SIZE_NAME'],
  DRINKWARE: ['COLOR_NAME', 'SIZE_NAME'],
  FURNITURE: ['COLOR_NAME', 'STYLE_NAME'],
  LAMP: ['COLOR_NAME'],
  RUG: ['COLOR_NAME', 'SIZE_NAME', 'PATTERN_NAME'],
  CANDLE: ['STYLE_NAME', 'COLOR_NAME'],
  STORAGE_BOX: ['COLOR_NAME', 'SIZE_NAME'],

  // Electronics
  HEADPHONES: ['COLOR_NAME'],
  SPEAKERS: ['COLOR_NAME'],
  MOBILE_PHONE_CASE: ['COLOR_NAME', 'STYLE_NAME'],
  CABLES: ['COLOR_NAME', 'SIZE_NAME'],
}

export function bundledThemesFor(productType: string | null | undefined): string[] {
  if (!productType) return []
  return BUNDLED_THEMES_BY_PRODUCT_TYPE[productType.toUpperCase()] ?? []
}
