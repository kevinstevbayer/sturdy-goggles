-- =============================================================================
-- Explicit Schema, Table, Sequence, and View GRANTs for Supabase Roles
-- Ensures clean deployments even when "Grant API access automatically" is off.
-- All row-level access remains strictly enforced by RLS policies.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.event_settings,
  public.role_sessions,
  public.stations,
  public.teams,
  public.attempts,
  public.station_resets,
  public.audit_log,
  public.final_snapshots
TO authenticated;

GRANT SELECT ON public.teams_public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
