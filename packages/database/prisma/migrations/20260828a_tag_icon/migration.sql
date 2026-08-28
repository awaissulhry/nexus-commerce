-- Tag.icon — a curated glyph per tag, alongside its colour.
--
-- Colour alone cannot carry a tag's identity: at the 9px dot the grid draws, hues stop being
-- distinguishable past about eight, and WCAG 1.4.1 forbids colour as the ONLY visual carrier
-- (~1 in 12 men have a colour vision deficiency). An icon is distinguishable across dozens of
-- values at 13px and is the redundant encoding that criterion asks for.
--
-- Nullable and additive: every existing tag keeps rendering its dot until an icon is chosen.
ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "icon" TEXT;
