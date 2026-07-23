-- Build 5: multi-contact sequencing.
-- Adds per-contact identity to assets (one asset per account has been the assumption until now)
-- and a single source of truth for "does this asset currently occupy one of the account's 3 seats."

ALTER TABLE assets
  ADD COLUMN contact_ref text NOT NULL DEFAULT 'primary',
  ADD COLUMN meeting_booked_at timestamptz,
  ADD COLUMN slot_freed_at timestamptz,
  ADD COLUMN slot_freed_reason text
    CHECK (slot_freed_reason IN ('sequence_complete', 'meeting_booked', 'rejected'));

-- Backfill first, before adding the uniqueness constraint below - real production history
-- (e.g. Lineage Logistics) already has a rejected draft superseded by a regenerated one for the
-- same contact_ref='primary', so the rejected row must be marked freed before any uniqueness
-- check runs, or the two legitimately-coexisting rows collide.
UPDATE assets
  SET slot_freed_at = rejected_at, slot_freed_reason = 'rejected'
  WHERE rejected_at IS NOT NULL;

UPDATE assets
  SET slot_freed_at = replied_at, slot_freed_reason = 'sequence_complete'
  WHERE replied_at IS NOT NULL AND slot_freed_at IS NULL;

-- Partial, not a plain UNIQUE constraint: the real invariant is "at most one ACTIVE asset per
-- contact," not "at most one asset per contact ever." A rejected/completed/superseded row is
-- history and must never block a fresh one for that same contact - only currently-occupied
-- seats (slot_freed_at IS NULL) need to stay unique per (account_id, contact_ref).
CREATE UNIQUE INDEX assets_account_contact_active_unique
  ON assets (account_id, contact_ref)
  WHERE slot_freed_at IS NULL;
