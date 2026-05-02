-- Rollback: restore brand='Xavia Racing' on the seeded preferences.
UPDATE "TerminologyPreference"
SET "brand" = 'Xavia Racing'
WHERE "id" IN (
  'seed_xavia_giacca',
  'seed_xavia_pantaloni',
  'seed_xavia_casco',
  'seed_xavia_stivali',
  'seed_xavia_protezioni',
  'seed_xavia_pelle',
  'seed_xavia_rete'
);
