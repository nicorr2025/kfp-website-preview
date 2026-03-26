-- ═══════════════════════════════════════════════════════════════════════════════
-- KFP Team Members — Supabase Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL → New Query)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Create the table
CREATE TABLE IF NOT EXISTS kfp_team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  allowed_tabs TEXT[] DEFAULT '{}',
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_kfp_team_user_id ON kfp_team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_kfp_team_status ON kfp_team_members(status);
CREATE INDEX IF NOT EXISTS idx_kfp_team_email ON kfp_team_members(email);

-- 3. Updated_at trigger
CREATE OR REPLACE FUNCTION kfp_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kfp_team_updated_at ON kfp_team_members;
CREATE TRIGGER kfp_team_updated_at
  BEFORE UPDATE ON kfp_team_members
  FOR EACH ROW EXECUTE FUNCTION kfp_update_updated_at();

-- 4. Auto-provision trigger: first user = admin, rest = pending member
CREATE OR REPLACE FUNCTION kfp_auto_provision_team_member()
RETURNS TRIGGER AS $$
DECLARE
  member_count INT;
  all_tabs TEXT[] := ARRAY['dashboard','inventory','orders','customers','quotes','shipping','outreach','website','settings','team'];
BEGIN
  -- Check if already provisioned
  IF EXISTS (SELECT 1 FROM kfp_team_members WHERE user_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO member_count FROM kfp_team_members;

  IF member_count = 0 THEN
    -- First user: auto-approved admin with all tabs
    INSERT INTO kfp_team_members (user_id, email, role, status, allowed_tabs, approved_at)
    VALUES (NEW.id, NEW.email, 'admin', 'approved', all_tabs, now());
  ELSE
    -- Subsequent users: pending member
    INSERT INTO kfp_team_members (user_id, email, role, status, allowed_tabs)
    VALUES (NEW.id, NEW.email, 'member', 'pending', '{}');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Note: The auto-provision trigger on auth.users requires superuser access.
-- If you can't create triggers on auth.users, we handle provisioning in the API instead.
-- Uncomment the following if you have access:
--
-- DROP TRIGGER IF EXISTS kfp_on_auth_user_created ON auth.users;
-- CREATE TRIGGER kfp_on_auth_user_created
--   AFTER INSERT ON auth.users
--   FOR EACH ROW EXECUTE FUNCTION kfp_auto_provision_team_member();

-- 5. Row Level Security
ALTER TABLE kfp_team_members ENABLE ROW LEVEL SECURITY;

-- Users can read their own record
CREATE POLICY "kfp_users_read_own" ON kfp_team_members
  FOR SELECT USING (auth.uid() = user_id);

-- Approved admins can read all records
CREATE POLICY "kfp_admins_read_all" ON kfp_team_members
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM kfp_team_members
      WHERE user_id = auth.uid()
      AND role = 'admin'
      AND status = 'approved'
    )
  );

-- Approved admins can insert
CREATE POLICY "kfp_admins_insert" ON kfp_team_members
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM kfp_team_members
      WHERE user_id = auth.uid()
      AND role = 'admin'
      AND status = 'approved'
    )
  );

-- Approved admins can update all records
CREATE POLICY "kfp_admins_update" ON kfp_team_members
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM kfp_team_members
      WHERE user_id = auth.uid()
      AND role = 'admin'
      AND status = 'approved'
    )
  );

-- Approved admins can delete
CREATE POLICY "kfp_admins_delete" ON kfp_team_members
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM kfp_team_members
      WHERE user_id = auth.uid()
      AND role = 'admin'
      AND status = 'approved'
    )
  );

-- Service role bypass (for API server-side operations)
-- The service_role key automatically bypasses RLS, so no extra policy needed.
