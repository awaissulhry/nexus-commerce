// apps/api/src/services/pim/master-field-gate.ts
var ALLOWED_MASTER_FIELDS = /* @__PURE__ */ new Set([
  "sku",
  // editable from master-data tab; uniqueness validated below
  "name",
  "description",
  // D.5: ZIP upload + grid editing
  "basePrice",
  "costPrice",
  "minMargin",
  "minPrice",
  "maxPrice",
  "totalStock",
  "lowStockThreshold",
  "brand",
  "manufacturer",
  "upc",
  "ean",
  "weightValue",
  // D.3j: weight/dim units + dim values
  "weightUnit",
  "dimLength",
  "dimWidth",
  "dimHeight",
  "dimUnit",
  // D.3k: master-level GTIN
  "gtin",
  "status",
  "fulfillmentChannel",
  // CC.1 — master Amazon productType. Drives the schema-driven
  // attribute set; per-listing override stays in
  // platformAttributes.productType (Q.5).
  "productType",
  // W1.4 — master long-form content + keyword tags. bulletPoints
  // and keywords are string[] columns on Product; the validator
  // below accepts both an array of strings and a JSON-string
  // payload (the bulk-ops grid pastes it as JSON, the master
  // editor sends it as an array).
  "bulletPoints",
  "keywords",
  // W1.4 — Italian fiscal / customs fields. hsCode is the
  // tariff classification (digit string) used by customs
  // declarations; countryOfOrigin is the ISO-2 alpha code used
  // on commercial invoices and Amazon attributes. Both flow
  // through PATCH /api/products/bulk so the master editor and
  // bulk-ops paste workflows share the same validator.
  "hsCode",
  "countryOfOrigin",
  // W7.1 — EU compliance: PPE directive category + ADR/IATA hazmat
  "ppeCategory",
  "hazmatClass",
  "hazmatUnNumber",
  // C4 — structured CE/PPE protective-gear data
  "garmentClass",
  "notifiedBodyNumber",
  "notifiedBodyName",
  "declarationOfConformityUrl",
  "impactProtectors",
  // GTIN.3 / Step 4 variant flow — the list-wizard's "promote to
  // parent" action PATCHes isParent=true and "link variant to
  // parent" PATCHes parentId. Both write into Product directly;
  // the wizard owned this surface but hit "Field not editable"
  // because the bulk allowlist didn't include them.
  "isParent",
  "parentId"
]);

// apps/api/src/services/pim/content-locale.ts
import { createHash } from "node:crypto";
var PRIMARY_CONTENT_LOCALE = (process.env.NEXUS_PRIMARY_LANGUAGE ?? "it").toLowerCase();
var CONTENT_COLUMNS = { title: "name", description: "description", bulletPoints: "bulletPoints", keywords: "keywords" };
var contentHash = (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
var contentLocale = (locale) => locale.toLowerCase();
function contentSlots(product) {
  const slots = { ...product.localizedContent ?? {} };
  for (const [tag, slot] of Object.entries(slots)) {
    const locale = contentLocale(tag);
    if (tag !== locale) slots[locale] = { ...slot, ...slots[locale] };
  }
  for (const translation of product.translations ?? []) {
    const locale = String(translation.language).toLowerCase();
    const slot = { ...slots[locale] };
    for (const [key, column3] of Object.entries(CONTENT_COLUMNS)) {
      const value = translation[column3];
      if (slot[key] !== void 0 || value == null || value === "" || Array.isArray(value) && !value.length) continue;
      slot[key] = value;
      slot._meta = { ...slot._meta, [key]: { state: "draft", legacy: true } };
    }
    slots[locale] = slot;
  }
  return slots;
}
function sourceContent(product, key, locale = PRIMARY_CONTENT_LOCALE) {
  locale = contentLocale(locale);
  const slots = contentSlots(product);
  if (Object.prototype.hasOwnProperty.call(slots[locale] ?? {}, key)) return slots[locale][key];
  if (locale === PRIMARY_CONTENT_LOCALE) {
    const column3 = CONTENT_COLUMNS[key];
    if (column3 && product[column3] !== void 0) return product[column3];
    if (product.categoryAttributes?.[key] !== void 0) return product.categoryAttributes[key];
  }
  return product.parent ? sourceContent(product.parent, key, locale) : null;
}
function contentReviewState(product, key, locale) {
  locale = contentLocale(locale);
  const review = contentSlots(product)[locale]?._meta?.[key];
  if (!review) return "current";
  if (review.sourceLocale && review.sourceLocale !== locale && review.sourceHash !== contentHash(sourceContent(product, key, review.sourceLocale))) return "outdated";
  return review.state === "reviewed" ? "reviewed" : "draft";
}

// apps/api/src/services/pim/variant-attribute-keys.ts
function canonicalVariantAxis(value) {
  const key = value.toLowerCase().replace(/[\s_-]/g, "");
  return {
    colore: "color",
    colour: "color",
    farbe: "color",
    couleur: "color",
    taglia: "size",
    taille: "size",
    talla: "size",
    gr\u00F6\u00DFe: "size",
    groesse: "size",
    stylename: "style"
  }[key] ?? key;
}

// apps/api/src/services/pim/attribute-resolver.ts
var DEFAULT_LOCALE = "en";
var SSOT_FIELDS = [
  { key: "title", followFlag: "followMasterTitle", overrideCol: "titleOverride", directCol: "title" },
  { key: "description", followFlag: "followMasterDescription", overrideCol: "descriptionOverride", directCol: "description" },
  { key: "price", followFlag: "followMasterPrice", overrideCol: "priceOverride", directCol: "price" },
  { key: "quantity", followFlag: "followMasterQuantity", overrideCol: "quantityOverride", directCol: "quantity" },
  { key: "bulletPoints", followFlag: "followMasterBulletPoints", overrideCol: "bulletPointsOverride", directCol: null }
];
var SYNTHESIS_MAP = [
  { resolverKey: "title", column: "name" },
  { resolverKey: "description", column: "description" },
  { resolverKey: "bulletPoints", column: "bulletPoints" },
  { resolverKey: "keywords", column: "keywords" },
  { resolverKey: "brand", column: "brand" },
  { resolverKey: "manufacturer", column: "manufacturer" },
  { resolverKey: "basePrice", column: "basePrice" }
];
function applyLayer(acc, layer, source, inheritedFrom, locale) {
  if (!layer || typeof layer !== "object") return;
  for (const [key, value] of Object.entries(layer)) {
    if (value === void 0) continue;
    if (locale && key.startsWith("_")) continue;
    acc[key] = { value, source, inheritedFrom, ...locale ? { requestedLocale: locale, effectiveLocale: locale, translationState: "current" } : {} };
  }
}
function applyVariantLayer(acc, product) {
  const variations = product.categoryAttributes?.variations;
  const bag = {
    ...product.variantAttributes && typeof product.variantAttributes === "object" ? product.variantAttributes : {},
    ...variations && typeof variations === "object" && !Array.isArray(variations) ? variations : {}
  };
  applyLayer(acc, bag, "variant", product.id);
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return;
  for (const axis of ["color", "size", "style"]) {
    if (Object.prototype.hasOwnProperty.call(bag, axis) && bag[axis] !== void 0) continue;
    const matches = Object.entries(bag).filter(([key, value]) => canonicalVariantAxis(key) === axis && value !== void 0);
    if (!matches.length) continue;
    const conflict = new Set(matches.map(([, value]) => JSON.stringify(value))).size > 1;
    acc[axis] = {
      value: conflict ? null : matches[0][1],
      source: "variant",
      inheritedFrom: product.id,
      ...conflict ? { warnings: [`Conflicting variant attributes supply ${axis}: ${matches.map(([key]) => key).join(", ")}. Set the canonical ${axis} attribute to resolve the conflict.`] } : {}
    };
  }
}
function applySynthesisLayer(acc, source, locale) {
  for (const { resolverKey, column: column3 } of SYNTHESIS_MAP) {
    const value = source[column3];
    if (value === void 0 || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    acc[resolverKey] = {
      value,
      source: "masterColumn",
      inheritedFrom: `${source.id}:${column3}`,
      ...["title", "description", "bulletPoints", "keywords"].includes(resolverKey) ? { requestedLocale: locale, effectiveLocale: PRIMARY_CONTENT_LOCALE, translationState: locale === PRIMARY_CONTENT_LOCALE ? "current" : "fallback" } : {}
    };
  }
}
function applyCanonicalFacts(acc, product) {
  for (const key of ALLOWED_MASTER_FIELDS) {
    if (["description", "bulletPoints", "keywords"].includes(key)) continue;
    let value = product[key];
    if (value === void 0 || value === null || value === "" || Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && typeof value.toNumber === "function") value = value.toNumber();
    acc[key] = { value, source: "masterColumn", inheritedFrom: product.id };
  }
}
function resolveAttributes(input) {
  const {
    product,
    parent,
    channelListing,
    locale: requestedLocale = DEFAULT_LOCALE,
    synthesize = true
  } = input;
  const locale = requestedLocale.toLowerCase();
  const acc = {};
  const doSynthesize = synthesize;
  if (parent) {
    if (doSynthesize) applySynthesisLayer(acc, parent, locale);
    applyLayer(acc, parent.categoryAttributes, "master", parent.id);
    if (synthesize) applyCanonicalFacts(acc, parent);
    if (parent.countryOfOrigin) applyLayer(acc, { countryOfOrigin: parent.countryOfOrigin, country_of_origin: parent.countryOfOrigin }, "masterColumn", parent.id);
    applyLayer(acc, contentSlots(parent)[locale], "masterLocale", parent.id, locale);
    if (locale !== DEFAULT_LOCALE) {
      applyLayerFallback(acc, contentSlots(parent)[DEFAULT_LOCALE], "masterLocale", parent.id, locale);
    }
  }
  if (doSynthesize) applySynthesisLayer(acc, product, locale);
  applyVariantLayer(acc, product);
  applyLayer(acc, product.categoryAttributes, parent ? "variant" : "master", product.id);
  if (synthesize) applyCanonicalFacts(acc, product);
  if (product.countryOfOrigin) applyLayer(acc, { countryOfOrigin: product.countryOfOrigin, country_of_origin: product.countryOfOrigin }, "masterColumn", product.id);
  applyLayer(acc, contentSlots(product)[locale], parent ? "variantLocale" : "masterLocale", product.id, locale);
  if (locale !== DEFAULT_LOCALE) {
    applyLayerFallback(acc, contentSlots(product)[DEFAULT_LOCALE], parent ? "variantLocale" : "masterLocale", product.id, locale);
  }
  if (synthesize) for (const key of ["description", "bulletPoints", "keywords"]) {
    const present3 = (v) => v !== null && v !== void 0 && v !== "" && (!Array.isArray(v) || v.length > 0);
    if (acc[key] !== void 0) continue;
    const source = present3(product[key]) ? product : parent && present3(parent[key]) ? parent : null;
    if (source) acc[key] = {
      value: source[key],
      source: "masterColumn",
      inheritedFrom: source.id,
      requestedLocale: locale,
      effectiveLocale: PRIMARY_CONTENT_LOCALE,
      translationState: locale === PRIMARY_CONTENT_LOCALE ? "current" : "fallback"
    };
  }
  if (synthesize) {
    const origin = acc.countryOfOrigin ?? acc.country_of_origin;
    if (origin) {
      acc.countryOfOrigin = origin;
      acc.country_of_origin = origin;
    }
  }
  const localizedKeys = new Set(input.localizableKeys ?? []);
  for (const owner of [parent, product]) if (owner) for (const slot of Object.values(contentSlots(owner))) {
    for (const key of Object.keys(slot)) if (!key.startsWith("_")) localizedKeys.add(key);
  }
  for (const key of localizedKeys) {
    if (acc[key]?.effectiveLocale) continue;
    const owner = Object.prototype.hasOwnProperty.call(contentSlots(product)[PRIMARY_CONTENT_LOCALE] ?? {}, key) ? product : parent && Object.prototype.hasOwnProperty.call(contentSlots(parent)[PRIMARY_CONTENT_LOCALE] ?? {}, key) ? parent : null;
    if (owner) acc[key] = { value: contentSlots(owner)[PRIMARY_CONTENT_LOCALE][key], source: owner === parent ? "masterLocale" : parent ? "variantLocale" : "masterLocale", inheritedFrom: owner.id };
    const hit = acc[key];
    if (hit) Object.assign(hit, { requestedLocale: locale, effectiveLocale: PRIMARY_CONTENT_LOCALE, translationState: locale === PRIMARY_CONTENT_LOCALE ? "current" : "fallback" });
  }
  if (channelListing) {
    applyLayer(acc, channelListing.overrideData, "channelOverride", channelListing.id);
    for (const ssot of SSOT_FIELDS) {
      const follows = channelListing[ssot.followFlag];
      const followsMaster = follows === void 0 ? true : Boolean(follows);
      if (followsMaster) continue;
      const overrideValue = channelListing[ssot.overrideCol];
      const directValue = ssot.directCol ? channelListing[ssot.directCol] : void 0;
      const winning = overrideValue !== void 0 && overrideValue !== null ? overrideValue : directValue;
      if (winning === void 0) continue;
      acc[ssot.key] = { value: winning, source: "channelExplicit", inheritedFrom: channelListing.id };
    }
  }
  for (const [key, hit] of Object.entries(acc)) {
    if (!hit.effectiveLocale || hit.translationState === "fallback") continue;
    const owner = parent && hit.inheritedFrom === parent.id ? parent : product;
    hit.translationState = contentReviewState({ ...owner, parent: owner === product ? parent : null }, key, hit.effectiveLocale);
  }
  return acc;
}
function applyLayerFallback(acc, layer, source, inheritedFrom, locale) {
  if (!layer || typeof layer !== "object") return;
  for (const [key, value] of Object.entries(layer)) {
    if (value === void 0) continue;
    if (key in acc && acc[key].translationState !== "fallback") continue;
    if (key.startsWith("_")) continue;
    acc[key] = { value, source, inheritedFrom, requestedLocale: locale, effectiveLocale: DEFAULT_LOCALE, translationState: "fallback" };
  }
}

// apps/api/src/services/pim/content-language.ts
function normalizeLanguage(tag) {
  if (typeof tag !== "string") throw new Error("Content language must be a language tag.");
  const language = tag.toLowerCase().split(/[-_]/, 1)[0];
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error(`Invalid content language: ${tag}`);
  return language;
}

// apps/api/src/services/pim/content-resolver.ts
var contentField = (field2) => field2 === "name" ? "title" : field2;
var present = (value) => value !== void 0 && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
var workspace = (row) => row.workspaceId ?? null;
var label = (language) => new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
var primary = () => normalizeLanguage(PRIMARY_CONTENT_LOCALE);
function sourceValue(product, parent, field2) {
  const column3 = CONTENT_COLUMNS[field2];
  for (const owner of [product, parent]) {
    if (!owner) continue;
    if (!column3 && Object.prototype.hasOwnProperty.call(owner.categoryAttributes ?? {}, field2) && owner.categoryAttributes?.[field2] !== void 0) return { value: owner.categoryAttributes[field2], owner };
    let value = column3 ? owner[column3] : owner.categoryAttributes?.[field2];
    if (!column3 && !present(value)) {
      const variations = owner.categoryAttributes?.variations;
      const bag = { ...owner.variantAttributes ?? {}, ...variations && typeof variations === "object" && !Array.isArray(variations) ? variations : {} };
      value = bag[field2];
      if (value === void 0 && ["color", "size", "style"].includes(field2)) {
        const aliases = Object.entries(bag).filter(([key, value2]) => canonicalVariantAxis(key) === field2 && value2 !== void 0);
        if (new Set(aliases.map(([, value2]) => JSON.stringify(value2))).size > 1) throw new Error(`Conflicting source variant attributes for ${field2}`);
        value = aliases[0]?.[1];
      }
      if (value !== void 0) return { value, owner };
    }
    if (present(value)) return { value, owner };
  }
  return null;
}
function contentSourceHash(product, parent, localizableKeys = []) {
  const fields = [.../* @__PURE__ */ new Set([...Object.keys(CONTENT_COLUMNS), ...localizableKeys.map(contentField)])].sort();
  return contentHash(Object.fromEntries(fields.map((field2) => [field2, sourceValue(product, parent, field2)?.value ?? null])));
}
function translationIndex(rows = []) {
  const index = /* @__PURE__ */ new Map();
  const groups3 = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const language = normalizeLanguage(row.language);
    groups3.set(language, [...groups3.get(language) ?? [], row]);
  }
  for (const [language, group] of groups3) {
    const canonical = group.filter((row) => row.language === language);
    const candidates = canonical.length ? canonical : group;
    if (candidates.length !== 1) throw new Error(`Ambiguous content translations for ${language}`);
    index.set(language, candidates[0]);
  }
  return index;
}
function coordinateMatches(a, b) {
  return a.channel === b.channel && a.market === b.market && (a.accountId ?? null) === (b.accountId ?? null) && (a.aliasId ?? null) === (b.aliasId ?? null);
}
function translationValue(row, field2) {
  if (!row) return void 0;
  const column3 = CONTENT_COLUMNS[field2];
  return column3 ? row[column3] : row.attributes?.[field2];
}
function legacyPin(listing, field2) {
  const columns = {
    title: ["titleOverride", "title", "followMasterTitle"],
    description: ["descriptionOverride", "description", "followMasterDescription"],
    bulletPoints: ["bulletPointsOverride", null, "followMasterBulletPoints"]
  };
  const spec2 = columns[field2];
  if (!spec2) return void 0;
  if (listing[spec2[2]] !== true && present(listing[spec2[0]])) return listing[spec2[0]];
  return spec2[1] ? listing[spec2[1]] : void 0;
}
function resolver(input) {
  const { product, parent, listing, localizableKeys = [] } = input;
  if (parent && (product.parentId !== parent.id || workspace(parent) !== workspace(product))) throw new Error("Content parent does not belong to this product/workspace.");
  if (listing && (listing.productId !== product.id || workspace(listing) !== workspace(product))) throw new Error("Content listing does not belong to this product/workspace.");
  const owners = [product, parent].filter((owner) => !!owner);
  const translations = owners.map((owner) => translationIndex((owner.translations ?? []).filter((row) => workspace(row) === workspace(owner) && (!row.productId || row.productId === owner.id))));
  const pins = translationIndex((listing?.translations ?? []).filter((row) => workspace(row) === workspace(product) && (!row.channelListingId || row.channelListingId === listing?.id)));
  const sourceLanguage = primary();
  const hashes = /* @__PURE__ */ new Map();
  const allowed = /* @__PURE__ */ new Set([...Object.keys(CONTENT_COLUMNS), ...localizableKeys.map(contentField)]);
  return (fieldInput, address, computed) => {
    const field2 = contentField(fieldInput), requested = normalizeLanguage(address.requested);
    if (!allowed.has(field2)) throw new Error(`Field ${field2} is not declared localizable.`);
    const result = (value, tier, language, member, from) => ({ value, tier, language, requested, provenance: { member, from } });
    const translated = (row, value, tier, owner) => {
      const source2 = row.source ?? "manual";
      const reviewedAt = row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null;
      if (row.sourceHash && !hashes.has(owner.id)) hashes.set(owner.id, contentSourceHash(owner, owner === product ? parent : null, localizableKeys));
      const outdated = !!row.sourceHash && row.sourceHash !== hashes.get(owner.id);
      const machine = source2 === "ai" || source2 === "translated";
      const member = outdated ? machine && !reviewedAt ? "aiStale" : "outdated" : machine && !reviewedAt ? "ai" : tier === "pin" ? "pinned" : address.coordinate || owner !== product ? "inherited" : "own";
      return { ...result(value, tier, requested, member, tier === "pin" ? listing.id : `${label(requested)} \xB7 shared`), translation: { source: source2, reviewedAt, outdated } };
    };
    if (address.coordinate && listing) {
      if (!coordinateMatches(listing.coordinate, address.coordinate)) throw new Error("Content listing coordinate does not match the requested address.");
      if (!listing.languages.length) throw new Error("Content listing needs its market languages.");
      const pin = pins.get(requested), value = translationValue(pin, field2);
      if (present(value)) return translated(pin, value, "pin", product);
      if (requested === normalizeLanguage(listing.languages[0])) {
        const legacy = legacyPin(listing, field2);
        if (present(legacy)) return result(legacy, "pin", requested, "pinned", listing.id);
      }
    }
    if (requested !== sourceLanguage) for (const [i, owner] of owners.entries()) {
      const row = translations[i].get(requested), value = translationValue(row, field2);
      if (present(value)) return translated(row, value, "language", owner);
    }
    const source = sourceValue(product, parent, field2);
    if (source) return result(source.value, "source", sourceLanguage, address.coordinate || requested !== sourceLanguage || source.owner !== product ? "inherited" : "own", `${label(sourceLanguage)} \xB7 source`);
    if (computed && present(computed.value)) return { ...result(computed.value, "computed", normalizeLanguage(computed.language), computed.provenance.member, computed.provenance.from) };
    return result(null, "computed", sourceLanguage, "inherited", null);
  };
}
function resolveContent(input) {
  return resolver(input)(input.field, input.address, input.computed);
}
function contentPathAddress(path, requested, localizableKeys = []) {
  const parts = path.replace(/\{locale\}/g, requested).split(".");
  let language = requested;
  if (parts[0] === "localizedContent") {
    parts.shift();
    language = parts.shift() ?? "";
  } else if (["categoryAttributes", "variantAttributes"].includes(parts[0])) parts.shift();
  const field2 = contentField(parts.shift() ?? "");
  if (![...Object.keys(CONTENT_COLUMNS), ...localizableKeys].includes(field2)) return null;
  return { field: field2, requested: normalizeLanguage(language), tail: parts };
}
function resolveContentPath(input) {
  const path = contentPathAddress(input.path, input.address.requested, input.localizableKeys);
  if (!path) return null;
  const resolved = resolveContent({ ...input, field: path.field, address: { ...input.address, requested: path.requested } });
  let value = resolved.value;
  for (const key of path.tail) value = value && typeof value === "object" ? value[key] ?? null : null;
  return { ...resolved, value };
}
function resolveContentBatch(input) {
  return input.members.flatMap((member) => {
    const resolve = resolver(member);
    return input.addresses.map((address) => ({ productId: member.product.id, address: { ...address, requested: normalizeLanguage(address.requested) }, fields: Object.fromEntries(input.fields.map((field2) => [field2, resolve(field2, address)])) }));
  });
}

// readonly-shadow:no-runtime-database
var no_runtime_database_default = new Proxy({}, { get() {
  throw new Error("Shadow comparison attempted an application database access");
} });

// apps/api/src/services/pim/market-languages.ts
var marketCode = (code) => code.toUpperCase() === "GB" ? "UK" : code.toUpperCase();
function marketLanguages(channel, code, rows) {
  const coordinate = { channel: channel.toUpperCase(), code: marketCode(code) };
  const read = (row) => {
    const values = row?.languages?.length ? [...row.languages] : row?.language ? [row.language.toLowerCase()] : [];
    if (!values.length) throw new Error(`No content languages configured for ${coordinate.channel}/${coordinate.code}.`);
    return values;
  };
  if (rows) return read(rows.find((row) => row.channel === coordinate.channel && row.code === coordinate.code));
  return no_runtime_database_default.marketplace.findFirst({ where: coordinate, select: { languages: true, language: true } }).then(read);
}
function languageTag(language, code) {
  if (!/^[a-z]{2,3}$/i.test(language) || !/^[a-z]{2}$/i.test(code)) throw new Error("A language and two-letter marketplace code are required for a regional language tag.");
  return `${language.toLowerCase()}_${code.toUpperCase() === "UK" ? "GB" : code.toUpperCase()}`;
}

// apps/api/src/services/pim/sheet-values.ts
function readPath(bag, path) {
  let cur = bag;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return void 0;
    cur = cur[p];
  }
  return cur;
}

// apps/api/src/services/etsy/information-content.ts
var ETSY_CONTENT_FIELDS = /* @__PURE__ */ new Set(["title", "description", "tags"]);
function etsyContentState(listing, locale, field2) {
  if (!listing || !ETSY_CONTENT_FIELDS.has(field2)) return null;
  locale = locale.toLowerCase();
  const attrs = listing.platformAttributes ?? {};
  const drafts = attrs._etsyInformationLocales ?? {};
  const tag = Object.keys(drafts).find((key) => key.toLowerCase() === locale) ?? locale;
  const draft = readPath(drafts, [Object.prototype.hasOwnProperty.call(drafts, locale) ? locale : tag, field2]);
  if (draft !== void 0) return { value: draft, requestedLocale: locale, effectiveLocale: locale, translationState: "draft", needsTranslation: false };
  const translations = Array.isArray(attrs.translations) ? attrs.translations : Object.values(attrs.translations ?? {});
  const translated = translations.find((row) => row && String(row.language).toLowerCase() === locale);
  if (translated && Object.prototype.hasOwnProperty.call(translated, field2)) return { value: translated[field2], requestedLocale: locale, effectiveLocale: locale, translationState: "current", needsTranslation: false };
  const primary2 = typeof attrs.language === "string" && attrs.language ? attrs.language.toLowerCase() : null;
  const value = Object.prototype.hasOwnProperty.call(attrs, field2) ? attrs[field2] : listing[field2];
  if (value === void 0 || !primary2) return null;
  return { value, requestedLocale: locale, effectiveLocale: primary2, translationState: primary2 === locale ? "current" : "fallback", needsTranslation: primary2 !== locale };
}

// apps/api/src/services/pim/resolve-channel-field.ts
function resolveSourcePath(path, resolved, product, locale) {
  if (!path || typeof path !== "string") return null;
  const substituted = path.replace(/\{locale\}/g, locale);
  if (!substituted.includes(".")) {
    return resolved[substituted] ?? null;
  }
  const segments = substituted.split(".");
  const root = segments[0];
  const rest = segments.slice(1);
  let cursor;
  switch (root) {
    case "localizedContent":
      cursor = product.localizedContent;
      break;
    case "categoryAttributes":
      cursor = Object.prototype.hasOwnProperty.call(resolved, rest[0]) ? { ...product.categoryAttributes ?? {}, [rest[0]]: resolved[rest[0]] } : product.categoryAttributes;
      break;
    case "variantAttributes":
      cursor = Object.prototype.hasOwnProperty.call(resolved, rest[0]) ? { ...product.variantAttributes ?? {}, [rest[0]]: resolved[rest[0]] } : product.variantAttributes;
      break;
    default:
      cursor = resolved[root] ?? null;
  }
  for (const seg of rest) {
    if (cursor === null || cursor === void 0 || typeof cursor !== "object") return null;
    cursor = cursor[seg];
  }
  return cursor ?? null;
}

// apps/api/src/services/pim/global-content.ts
function globalContentLocales(product, parent, configuredLanguages = []) {
  const own = { ...product, localizedContent: {} };
  const ancestor = parent ? { ...parent, localizedContent: {} } : null;
  const languages = /* @__PURE__ */ new Set([PRIMARY_CONTENT_LOCALE, ...configuredLanguages]);
  for (const owner of [ancestor, own]) for (const row of owner?.translations ?? []) languages.add(String(row.language).toLowerCase());
  return Object.fromEntries([...languages].sort().map((language) => {
    const resolved = resolveAttributes({ product: own, parent: ancestor, locale: language });
    return [language, {
      title: resolved.title?.value ?? null,
      description: resolved.description?.value ?? null,
      bulletPoints: resolved.bulletPoints?.value ?? [],
      keywords: resolved.keywords?.value ?? []
    }];
  }));
}

// apps/api/src/services/pim/channel-specs/store.ts
import { informationRegistry, nativeTranslationKeys, shopifyMappingFieldKey } from "@nexus/shared/shopify-information";

// apps/api/src/services/pim/channel-specs/etsy-listing-schema.ts
var etsyListingSchema = {
  source: "https://www.etsy.com/openapi/generated/oas/3.0.0.json",
  verifiedAt: "2026-09-10",
  listing: { type: "object", properties: {
    "listing_id": { "type": "integer", "minimum": 1 },
    "user_id": { "type": "integer", "minimum": 1 },
    "shop_id": { "type": "integer", "minimum": 1 },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "rich_description": { "type": "string", "nullable": true },
    "state": { "type": "string", "enum": ["active", "inactive", "sold_out", "draft", "expired"] },
    "creation_timestamp": { "type": "integer", "minimum": 946684800 },
    "created_timestamp": { "type": "integer", "minimum": 946684800 },
    "ending_timestamp": { "type": "integer", "minimum": 946684800 },
    "original_creation_timestamp": { "type": "integer", "minimum": 946684800 },
    "last_modified_timestamp": { "type": "integer", "minimum": 946684800 },
    "updated_timestamp": { "type": "integer", "minimum": 946684800 },
    "state_timestamp": { "type": "integer", "nullable": true, "minimum": 946684800 },
    "quantity": { "type": "integer", "minimum": 0 },
    "shop_section_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "featured_rank": { "type": "integer" },
    "url": { "type": "string" },
    "num_favorers": { "type": "integer", "minimum": 0 },
    "non_taxable": { "type": "boolean" },
    "is_taxable": { "type": "boolean" },
    "is_customizable": { "type": "boolean" },
    "is_personalizable": { "type": "boolean" },
    "listing_type": { "type": "string", "enum": ["physical", "download", "both"] },
    "tags": { "type": "array", "items": { "type": "string" } },
    "materials": { "type": "array", "items": { "type": "string" } },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "processing_min": { "type": "integer", "nullable": true, "minimum": 0 },
    "processing_max": { "type": "integer", "nullable": true, "minimum": 0 },
    "who_made": { "type": "string", "nullable": true, "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "nullable": true, "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "is_supply": { "type": "boolean", "nullable": true },
    "item_weight": { "type": "number", "nullable": true },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["oz", "lb", "g", "kg"] },
    "item_length": { "type": "number", "nullable": true },
    "item_width": { "type": "number", "nullable": true },
    "item_height": { "type": "number", "nullable": true },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "is_private": { "type": "boolean" },
    "style": { "type": "array", "items": { "type": "string" } },
    "file_data": { "type": "string", "nullable": true },
    "has_variations": { "type": "boolean" },
    "should_auto_renew": { "type": "boolean" },
    "language": { "type": "string", "nullable": true },
    "price": { "type": "money" },
    "converted_price": { "type": "money" },
    "taxonomy_id": { "type": "integer", "nullable": true },
    "readiness_state_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "suggested_title": { "type": "string", "nullable": true }
  } },
  create: { type: "object", required: ["quantity", "title", "description", "price", "who_made", "when_made", "taxonomy_id"], properties: {
    "quantity": { "type": "integer" },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "price": { "type": "number" },
    "who_made": { "type": "string", "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "taxonomy_id": { "type": "integer", "minimum": 1 },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "materials": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "shop_section_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "processing_min": { "type": "integer", "nullable": true },
    "processing_max": { "type": "integer", "nullable": true },
    "readiness_state_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "tags": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "styles": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "item_weight": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_length": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_width": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_height": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["oz", "lb", "g", "kg"] },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "production_partner_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "image_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "is_supply": { "type": "boolean" },
    "is_customizable": { "type": "boolean" },
    "should_auto_renew": { "type": "boolean" },
    "is_taxable": { "type": "boolean" },
    "type": { "type": "string", "enum": ["physical", "download", "both"] }
  } },
  update: { type: "object", properties: {
    "image_ids": { "type": "array", "items": { "type": "integer", "minimum": 1 } },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "materials": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "should_auto_renew": { "type": "boolean" },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "shop_section_id": { "type": "integer", "nullable": true },
    "item_weight": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_length": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_width": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_height": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["", "oz", "lb", "g", "kg"] },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["", "in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "is_taxable": { "type": "boolean" },
    "taxonomy_id": { "type": "integer", "minimum": 1 },
    "tags": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "who_made": { "type": "string", "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "featured_rank": { "type": "integer", "nullable": true },
    "state": { "type": "string", "enum": ["active", "inactive"] },
    "is_supply": { "type": "boolean" },
    "production_partner_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "type": { "type": "string", "nullable": true, "enum": ["physical", "download", "both"] }
  } }
};

// apps/api/src/services/pim/channel-specs/etsy.ts
var groups = ["Content", "Classification", "Search", "Offer", "Shipping", "Policies", "Listing status", "Category attributes"].map((label2, order) => ({ key: label2.toLowerCase().replace(/ /g, "_"), label: label2, channelLabel: null, order }));
var column = (column3, followFlag) => ({ kind: "listingColumn", column: column3, followFlag });
var titleStore = column("title", "followMasterTitle");
var descriptionStore = column("description", "followMasterDescription");
var native = etsyListingSchema.listing.properties;
var create = etsyListingSchema.create.properties;
var update = etsyListingSchema.update.properties;

// apps/api/src/services/pim/channel-specs/store.ts
var groups2 = ["Content", "Classification", "Search", "Offer", "Shipping", "Policies"].map((label2, order) => ({ key: label2.toLowerCase(), label: label2, channelLabel: null, order }));
var pa = (...path) => ({ kind: "platformAttributes", path });
var column2 = (column3, followFlag) => ({ kind: "listingColumn", column: column3, followFlag });
function field(key, label2, group, extra = {}) {
  return {
    key,
    attribute: key,
    path: [],
    label: label2,
    englishLabel: label2,
    kind: "text",
    shape: "scalar",
    cardinality: { min: 0, max: 1 },
    requirement: "optional",
    requiredInParent: false,
    editable: true,
    hidden: false,
    variantEligible: false,
    group: groups2.find((g) => g.key === group),
    channelStore: pa(key),
    ...extra
  };
}
var titleStore2 = column2("title", "followMasterTitle");
var descriptionStore2 = column2("description", "followMasterDescription");
function shopifyProductSpec(schema = null, accountId, locale) {
  if (schema && !accountId) throw new Error("A Shopify definition requires its connected store identity.");
  if (locale) locale = schema?.locales.find((l) => l.locale.toLowerCase() === locale.toLowerCase())?.locale ?? locale.toLowerCase();
  const primaryLocale = schema?.locales.find((l) => l.primary)?.locale;
  const translationLocale = locale && locale !== "und" && primaryLocale && locale !== primaryLocale ? locale : null;
  if (translationLocale && !schema?.locales.some((l) => l.locale === translationLocale)) throw new Error("This language is not enabled in the selected Shopify store.");
  const native2 = {
    title: { masterKey: "name", requirement: "required", channelStore: titleStore2 },
    descriptionHtml: { masterKey: "description", channelStore: descriptionStore2 },
    vendor: { masterKey: "brand", channelStore: { kind: "platformAttributes", path: ["vendor"], legacyPaths: [["shopifyVendor"]] } },
    productType: { masterKey: "shopify_product_type", channelStore: { kind: "platformAttributes", path: ["productType"], legacyPaths: [["shopifyProductType"]] } },
    price: { masterKey: "basePrice", channelStore: column2("price", "followMasterPrice"), validation: { minimum: 0 } },
    cost: { masterKey: "costPrice", validation: { minimum: 0 } },
    sku: { defaultRule: { source: "sku" } },
    countryCodeOfOrigin: { masterKey: "countryOfOrigin", validation: { pattern: "^[A-Z]{2}$" } },
    harmonizedSystemCode: { masterKey: "hsCode" },
    weight: {
      shape: "measure",
      kind: "number",
      unitOptions: ["g", "kg", "oz", "lb"],
      defaultRule: { source: "weightValue", transforms: [{ type: "expr", expr: 'measure($weightValue, $weightUnit, "g|kg|oz|lb")' }] }
    },
    compareAtPrice: { validation: { minimum: 0 }, channelStore: { kind: "platformAttributes", path: ["compareAtPrice"], legacyPaths: [["shopifyCompareAtPrice"]] } },
    inventoryPolicy: { kind: "select", mode: "strict", options: schema?.native?.enums.inventoryPolicy?.map((choice) => choice.name) ?? [] },
    category: { validation: { pattern: "^gid://shopify/TaxonomyCategory/[a-zA-Z0-9-]+$" } },
    handle: { validation: { pattern: "^[a-zA-Z0-9-]+$" } },
    tags: { validation: { uniqueItems: true }, maxLength: 255 }
  };
  const fields = informationRegistry(schema).flatMap((info) => {
    const key = shopifyMappingFieldKey(info, accountId ?? "");
    const baseType = info.type.replace(/^list\./, "");
    const kind = ["number_integer", "number_decimal", "money"].includes(baseType) ? "number" : baseType === "boolean" ? "boolean" : ["date", "date_time"].includes(baseType) ? "date" : ["multi_line_text_field", "rich_text_field", "json"].includes(baseType) ? "longtext" : "text";
    const group = {
      key: info.group.toLowerCase().replace(/ /g, "_"),
      label: info.group,
      channelLabel: null,
      order: ["General", "Publishing", "Pricing", "Inventory", "Shipping", "SEO", "Metafields", "Category Metafields"].indexOf(info.group)
    };
    const entry = field(key, info.label, "content", {
      attribute: info.id,
      kind,
      group,
      shopifyField: info,
      shape: info.cardinality,
      cardinality: { min: 0, max: info.cardinality === "list" ? null : 1 },
      variantEligible: info.owner === "PRODUCTVARIANT",
      channelStore: info.definition ? pa("metafields", info.owner, info.definition.namespace, info.definition.key, info.type) : pa(...info.id.split(".")),
      helpText: info.definition ? `${info.owner === "PRODUCT" ? "Product" : "Variant"} \xB7 ${info.source}. ${info.definition.description ?? ""}`.trim() : [info.channelLabel !== info.label ? `Shopify: ${info.channelLabel}.` : "", info.reason].filter(Boolean).join(" ") || void 0,
      // Media and stock require a published Shopify resource; their native workspace
      // owns exact file and stocking-location identities after publication.
      readOnlyReason: info.reason ?? (info.id === "media" ? "Use the media workspace to manage product media." : void 0),
      editable: !info.reason,
      ...native2[info.id] ?? {}
    });
    if (translationLocale) {
      const translatable = info.definition ? ["single_line_text_field", "multi_line_text_field", "rich_text_field", "json", "url", "link", "list.single_line_text_field", "list.url", "list.link"].includes(info.type) : !!nativeTranslationKeys[info.id];
      const reason = info.reason ?? (!translatable ? "Shopify shares this field across languages. Select the store\u2019s primary language to edit its base value." : !schema?.native?.scopes.includes("write_translations") ? "This Shopify connection needs write_translations permission." : void 0);
      entry.channelStore = pa("_shopifyInformationLocales", translationLocale, info.id);
      entry.readOnlyReason = reason;
      entry.editable = !reason;
      entry.shopifyField = { ...info, reason };
      entry.helpText = `${translationLocale} translation. Clearing restores the primary-language value. Shopify translatability is verified against the created resource before synchronization.`;
    }
    return info.id === "inventory" ? [{ key: "availableQuantity", label: "Available quantity" }, { key: "onHandQuantity", label: "On hand quantity" }].map((quantity) => ({
      ...entry,
      ...quantity,
      englishLabel: quantity.label,
      attribute: quantity.key,
      kind: "number",
      channelStore: pa(quantity.key),
      editable: false,
      readOnlyReason: "This draft has no Shopify inventory item or stocking locations. Publish it, then edit inventory by location in Shopify Information."
    })) : [entry];
  });
  const result = spec("SHOPIFY", fields);
  result.groups = [...new Map(fields.map((f) => [f.group.key, f.group])).values()];
  result.schemaVersion = schema?.revision ?? "shopify-native-mapping-2026-09-10";
  result.validationSchema = void 0;
  return result;
}
function spec(channel, fields) {
  const properties = Object.fromEntries(fields.map((f) => {
    const scalar = {
      type: f.kind === "number" ? "number" : f.kind === "boolean" ? "boolean" : "string",
      ...f.options ? { enum: f.options } : {},
      ...f.maxLength ? { maxLength: f.maxLength } : {},
      ...Object.fromEntries(Object.entries(f.validation ?? {}).filter(([key]) => key !== "uniqueItems"))
    };
    return [f.attribute, f.shape === "list" ? {
      type: "array",
      items: scalar,
      ...f.cardinality.max !== null ? { maxItems: f.cardinality.max } : {},
      ...f.validation?.uniqueItems ? { uniqueItems: true } : {}
    } : scalar];
  }));
  return {
    channel,
    marketplace: "GLOBAL",
    category: "*",
    fields,
    validationSchema: { type: "object", properties, required: fields.filter((f) => f.requirement === "required").map((f) => f.attribute) },
    groups: groups2.filter((g) => fields.some((f) => f.group?.key === g.key)),
    fetchedAt: null,
    schemaVersion: "product-information-2026-09-08",
    coverage: Object.fromEntries(fields.map((f) => [f.attribute, [f.key]])),
    unrecognised: [],
    absent: false
  };
}

// apps/api/src/services/pim/channel-inheritance.ts
var CHANNEL_OVERRIDE_COLUMNS = {
  title: "titleOverride",
  description: "descriptionOverride",
  price: "priceOverride",
  quantity: "quantityOverride"
};
function readStoredChannelValue(store, listing, overrideKeys = []) {
  if (!listing || typeof listing !== "object") return void 0;
  const row = listing;
  if (store?.kind === "listingColumn") {
    if (store.followFlag && row[store.followFlag] !== false) return void 0;
    const override = CHANNEL_OVERRIDE_COLUMNS[store.column];
    return override ? row[override] ?? row[store.column] : row[store.column];
  }
  if (store?.kind === "platformAttributes" && store.path[0] === "_etsyInformationLocales") return etsyContentState(row, store.path[1], store.path[2])?.value;
  if (store?.kind === "platformAttributes") {
    const value = readPath(row.platformAttributes, store.path);
    if (value !== void 0) return value;
  }
  const bag = row.overrideData;
  if (bag && typeof bag === "object" && !Array.isArray(bag)) {
    for (const key of overrideKeys) if (Object.prototype.hasOwnProperty.call(bag, key)) return bag[key];
  }
  if (store?.kind === "platformAttributes") for (const path of store.legacyPaths ?? []) {
    const value = readPath(row.platformAttributes, path);
    if (value !== void 0) return value;
  }
  return void 0;
}

// apps/api/src/services/pim/channel-value-mutation.ts
function storedChannelState(listing, store, keys) {
  const value = readStoredChannelValue(store, listing, keys);
  if (value === void 0) return { state: "inherited", value: null };
  const unitPath = store?.kind === "platformAttributes" ? store.unitPath : void 0;
  return { state: "stored", value: unitPath && value !== null ? { value, unit: readPath(listing.platformAttributes, unitPath) ?? null } : value };
}

// apps/api/src/services/pim/content-resolver-shadow.ts
var reclassifications = {
  "R1-legacy-json-retired": "Product.localizedContent no longer supplies text; no values are moved or backfilled.",
  "R2-default-language-listing-pin": "Existing listing title/description and broken-inheritance overrides are pins for Marketplace.languages[0] only.",
  "R3-language-before-source": "A parent language translation answers before a child native source value; child wins within each tier.",
  "R4-native-source-authority": "Native Product columns supply primary text; untagged category aliases and primary translation rows no longer override those columns.",
  "R5-untagged-text-override-retired": "overrideData continues to hold facts but no longer supplies language content.",
  "R6-explicit-source-fallback": "An exact-language sourceContent miss now returns source text with its actual source language.",
  "R7-outbound-content-retired": "Provider/store-specific content bags no longer supply authored language content.",
  "R8-language-review-metadata": "The resolved value reports its actual language and translation-row review status.",
  "R9-regional-key-normalized": "An existing regional table key is found in memory through the language-only normaliser; nothing is rewritten.",
  "R10-empty-field-fallback": "Absent/default empty text fields fall through individually rather than hiding a populated lower tier."
};
var equalContent = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
var object = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
var present2 = (v) => v != null && v !== "" && (!Array.isArray(v) || v.length > 0);
var workspace2 = (row) => row.workspaceId ?? null;
var id = (row, key = row.id) => JSON.stringify([workspace2(row), key]);
function classifyContentDiff(input) {
  const { old, next, product, parent, listing, field: field2, reader } = input;
  const column3 = CONTENT_COLUMNS[field2];
  const native2 = (owner) => column3 ? owner[column3] : owner.categoryAttributes?.[field2] ?? owner.categoryAttributes?.variations?.[field2] ?? owner.variantAttributes?.[field2];
  const source = column3 ? [product, parent].filter(Boolean).map((owner) => native2(owner)).find(present2) ?? null : resolveAttributes({ product: { ...product, localizedContent: {}, translations: [] }, parent: parent ? { ...parent, localizedContent: {}, translations: [] } : null, locale: PRIMARY_CONTENT_LOCALE })[field2]?.value ?? null;
  const translations = [product, parent].filter(Boolean).flatMap((owner) => owner.translations ?? []);
  const tableValues = translations.filter((row) => normalizeLanguage(row.language) === next.requested).map((row) => column3 ? row[column3] : row.attributes?.[field2]);
  const legacyValues = field2 === "title" ? [listing?.titleOverride, listing?.title] : field2 === "description" ? [listing?.descriptionOverride, listing?.description] : field2 === "bulletPoints" ? [listing?.bulletPointsOverride] : [];
  if (next.language !== (["source", "computed"].includes(next.tier) ? normalizeLanguage(PRIMARY_CONTENT_LOCALE) : next.requested) || next.tier === "source" && !equalContent(next.value, source) || next.tier === "language" && !tableValues.some((value) => equalContent(value, next.value)) || next.tier === "pin" && !legacyValues.some((value) => present2(value) && equalContent(value, next.value)) || next.tier === "computed" && next.value !== null) return "UNCLASSIFIED";
  if (equalContent(old.value, next.value)) return "R8-language-review-metadata";
  if (reader.startsWith("etsy") || reader.startsWith("shopify") || reader.startsWith("syndication")) return "R7-outbound-content-retired";
  if (next.tier === "pin" || old.source === "channelExplicit") return "R2-default-language-listing-pin";
  if (old.source === "channelOverride") return "R5-untagged-text-override-retired";
  const slots = [product, parent].filter(Boolean).flatMap((owner) => Object.values(object(owner.localizedContent)));
  if (old.value != null && slots.some((slot) => Object.prototype.hasOwnProperty.call(object(slot), field2) && equalContent(object(slot)[field2], old.value))) return "R1-legacy-json-retired";
  if (translations.some((row) => row.language !== normalizeLanguage(row.language) && normalizeLanguage(row.language) === next.requested)) return "R9-regional-key-normalized";
  if (next.tier === "language" && old.source === "masterColumn") return "R3-language-before-source";
  if (["sourceContent", "mapping-source"].includes(reader) && old.value == null && next.tier === "source") return "R6-explicit-source-fallback";
  if (next.tier === "source" && ["master", "variant", "masterLocale", "variantLocale"].includes(old.source)) return "R4-native-source-authority";
  if (old.value === "" || Array.isArray(old.value) && !old.value.length) return "R10-empty-field-fallback";
  return "UNCLASSIFIED";
}
function compareProductionContent(data) {
  const products = data.products.map((product) => ({ ...product, translations: data.translations.filter((row) => id(row, row.productId) === id(product)) }));
  const productMap = new Map(products.map((product) => [id(product), product]));
  const counts = {};
  const classificationCounts = {}, diffs = [];
  const coveredListings = /* @__PURE__ */ new Set(), coordinates = /* @__PURE__ */ new Set();
  const observe = (reader, product, parent, listing, coordinate, field2, language, old, next) => {
    const key = JSON.stringify([reader, field2, language]);
    const count = counts[key] ??= { compared: 0, valueDiffs: 0, languageDiffs: 0, reviewDiffs: 0, diffs: 0 };
    count.compared++;
    const valueChanged = !equalContent(old.value, next.value);
    const languageChanged = present2(old.value) && present2(next.value) && (old.effectiveLocale ?? null) !== next.language;
    const newReview = next.translation ? next.translation.outdated ? "outdated" : next.translation.reviewedAt ? "reviewed" : next.translation.source === "manual" ? "current" : "draft" : next.language !== language ? "fallback" : "current";
    const reviewChanged = present2(old.value) && present2(next.value) && old.translationState != null && old.translationState !== newReview;
    if (!valueChanged && !languageChanged && !reviewChanged) return;
    const classification = classifyContentDiff({ old, next, product, parent, listing, field: field2, reader });
    count.valueDiffs += Number(valueChanged);
    count.languageDiffs += Number(languageChanged);
    count.reviewDiffs += Number(reviewChanged);
    count.diffs++;
    classificationCounts[classification] = (classificationCounts[classification] ?? 0) + 1;
    diffs.push({ reader, productId: product.id, sku: product.sku, workspaceId: workspace2(product), listingId: listing?.id ?? null, coordinate, field: field2, language, valueChanged, languageChanged, reviewChanged, classification, old: { ...old, value: old.value ?? null }, next });
  };
  for (const product of products) {
    const parent = product.parentId ? productMap.get(id(product, product.parentId)) : void 0;
    if (product.parentId && !parent) throw new Error(`Missing parent for ${product.id}`);
    const localizableKeys = data.localizableKeysByProduct?.[id(product)] ?? [];
    const fields = [...Object.keys(CONTENT_COLUMNS), ...localizableKeys];
    const markets = data.marketplaces.filter((market) => workspace2(market) === workspace2(product));
    const sharedLanguages = [.../* @__PURE__ */ new Set([normalizeLanguage(PRIMARY_CONTENT_LOCALE), ...markets.flatMap((m) => marketLanguages(m.channel, m.code, markets)), ...[product, parent].filter(Boolean).flatMap((p) => p.translations.map((row) => normalizeLanguage(row.language)))])].sort();
    const global = globalContentLocales(product, parent ?? null, sharedLanguages);
    const scopes = [{ coordinate: null, languages: sharedLanguages }];
    for (const market of markets) {
      const marketListings = data.listings.filter((l) => workspace2(l) === workspace2(product) && l.channel === market.channel && (l.marketplace && l.marketplace !== "DEFAULT" ? l.marketplace : l.region) === market.code);
      const languages = marketLanguages(market.channel, market.code, markets);
      const coordinateOf = (listing) => ({ channel: market.channel, market: market.code, ...listing?.channelConnectionId ? { accountId: listing.channelConnectionId } : {}, ...listing?.aliasId || listing?.aliasKey ? { aliasId: listing.aliasId ?? listing.aliasKey } : {} });
      const marketCoordinates = [...new Map((marketListings.length ? marketListings : [void 0]).map((listing) => {
        const coordinate = coordinateOf(listing);
        return [JSON.stringify(coordinate), coordinate];
      })).values()];
      for (const coordinate of marketCoordinates) {
        const matches = marketListings.filter((l) => id(l, l.productId) === id(product) && JSON.stringify(coordinateOf(l)) === JSON.stringify(coordinate));
        if (matches.length > 1) throw new Error(`Ambiguous listings for ${product.id} at ${JSON.stringify(coordinate)}`);
        const listing = matches[0];
        if (listing) coveredListings.add(id(listing));
        scopes.push({ coordinate, listing, languages });
      }
    }
    for (const scope of scopes) {
      const { coordinate, listing, languages } = scope;
      if (coordinate) coordinates.add(JSON.stringify([workspace2(product), coordinate]));
      const hydratedListing = listing ? { ...listing, id: listing.id, productId: listing.productId, coordinate, languages } : null;
      const batch = resolveContentBatch({ members: [{ product, parent, listing: hydratedListing, localizableKeys }], fields, addresses: languages.map((requested) => ({ requested, ...coordinate ? { coordinate } : {} })) });
      for (const row of batch) {
        const language = row.address.requested;
        const old = resolveAttributes({ product, parent: parent ?? null, channelListing: listing, locale: language, localizableKeys });
        const oldProduct = !coordinate ? data.productResolvedContent?.({ ...product, parent }, language) : void 0;
        for (const field2 of fields) {
          const next = row.fields[field2];
          observe(coordinate ? "attribute-coordinate" : "attribute-shared", product, parent, listing, coordinate, field2, language, old[field2] ?? { value: null }, next);
          if (!coordinate) observe("sourceContent", product, parent, void 0, null, field2, language, { value: sourceContent({ ...product, parent }, field2, language) }, next);
          if (!coordinate && field2 in CONTENT_COLUMNS) {
            observe("global-content", product, parent, void 0, null, field2, language, { ...old[field2], value: global[language]?.[field2] }, next);
            if (oldProduct) observe("product-content", product, parent, void 0, null, field2, language, oldProduct.fields[CONTENT_COLUMNS[field2]], next);
          }
          if (listing?.channel === "ETSY" && ["title", "description"].includes(field2)) observe("etsyContentState", product, parent, listing, coordinate, field2, language, etsyContentState(listing, language, field2) ?? { value: null }, next);
          if (listing?.channel === "AMAZON" && field2 === "title" && data.extractLocaleTitle) observe("syndication-title", product, parent, listing, coordinate, field2, language, { value: data.extractLocaleTitle(listing.platformAttributes, coordinate.market, language) }, next);
          if (listing?.channel === "SHOPIFY" && ["title", "description"].includes(field2)) {
            const spec2 = shopifyProductSpec(null, coordinate?.accountId).fields.find((spec3) => spec3.masterKey === (field2 === "title" ? "name" : field2));
            const stored = storedChannelState(listing, spec2.channelStore, [spec2.masterKey ?? spec2.key, spec2.key]);
            observe("shopify-information-native", product, parent, listing, coordinate, field2, language, { value: stored.value }, next);
            for (const tag of Object.keys(object(listing.platformAttributes?._shopifyInformationLocales)).filter((tag2) => normalizeLanguage(tag2) === language)) {
              const translated = storedChannelState(listing, { kind: "platformAttributes", path: ["_shopifyInformationLocales", tag, spec2.shopifyField.id] }, [spec2.masterKey ?? spec2.key, spec2.key]);
              observe("shopify-information-locale", product, parent, listing, coordinate, field2, language, { value: translated.value, effectiveLocale: tag }, next);
            }
          }
        }
        if (coordinate) {
          const market = markets.find((m) => m.channel === coordinate.channel && m.code === coordinate.market);
          const mapping = object(market.schemaMapping), category = listing?.platformAttributes?.productType ?? product.productType;
          const rules = { ...object(mapping.fields), ...object(mapping.byProductType?.[category]) };
          const paths = [...new Set(Object.values(rules).flatMap((rule) => [rule.source, rule.fallback].filter((path) => typeof path === "string" && !!path)))];
          for (const path of paths) {
            const parsed = contentPathAddress(path, language, localizableKeys);
            if (!parsed) continue;
            const next = resolveContentPath({ product, parent, listing: hydratedListing, address: { requested: language, coordinate }, localizableKeys, path });
            const flat = Object.fromEntries(Object.entries(old).map(([field2, hit]) => [field2, hit.value]));
            const value = resolveSourcePath(path, flat, product, language);
            observe("mapping-source", product, parent, listing, coordinate, parsed.field, language, { ...old[parsed.field], value, path }, next);
          }
        }
      }
    }
  }
  if (coveredListings.size !== data.listings.length) throw new Error(`Listing coverage mismatch: ${coveredListings.size}/${data.listings.length}`);
  return { counts: Object.entries(counts).map(([key, counts2]) => {
    const [reader, field2, language] = JSON.parse(key);
    return { reader, field: field2, language, ...counts2 };
  }), classificationCounts, diffs, coveredListings: coveredListings.size, coordinates: coordinates.size };
}

// <stdin>
function extractLocaleTitle(pa2, marketplace, language) {
  if (!pa2 || typeof pa2 !== "object") return null;
  const attrs = pa2.attributes;
  if (!attrs || typeof attrs !== "object") return null;
  const itemName = attrs.item_name;
  if (!Array.isArray(itemName) || itemName.length === 0) return null;
  const langTag = languageTag(language, marketplace);
  const match = langTag ? itemName.find((n) => n?.language_tag === langTag) : null;
  const value = match?.value ?? itemName[0]?.value;
  return typeof value === "string" && value.length > 0 ? value.slice(0, 200) : null;
}
function resolvedContent(product, language) {
  const resolved = resolveAttributes({ product, parent: product.parent ?? null, locale: language });
  const fields = Object.fromEntries(Object.entries(CONTENT_COLUMNS).map(([key, column3]) => [column3, resolved[key] ?? { value: null, source: "default", inheritedFrom: null, requestedLocale: language, translationState: "missing" }]));
  return {
    name: String(fields.name?.value ?? ""),
    description: fields.description?.value ?? null,
    bulletPoints: fields.bulletPoints?.value ?? [],
    keywords: fields.keywords?.value ?? [],
    source: Object.values(fields).some((field2) => field2.effectiveLocale === language && ["masterLocale", "variantLocale"].includes(field2.source ?? "")) ? "translation" : "master",
    language,
    fields
  };
}
export {
  classifyContentDiff,
  compareProductionContent,
  equalContent,
  extractLocaleTitle,
  resolvedContent as productResolvedContent,
  reclassifications
};
