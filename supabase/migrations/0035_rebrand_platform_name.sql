-- Update the platform display name in the live database.
-- Rebrand: platform display name is now just "محمد ياسر". Existing rows were seeded
-- with the old name (0011) and updated once (0024); this migration
-- applies the final rename for already-deployed environments.
UPDATE public.app_settings
SET value = '"محمد ياسر"',
    updated_at = now()
WHERE key = 'platform_name';
