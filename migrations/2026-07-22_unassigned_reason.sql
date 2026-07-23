alter table accounts add column unassigned_reason text;

-- Audit parity with outreach_log's admin_override column, for the admin-override enrichment path.
alter table enrichment_requests add column admin_override boolean not null default false;

-- Accurate backfill, not a guess: Pallet (a0c67977-2817-4308-ac76-deed4e6c0911) has never had
-- HubSpot credentials configured at any point, so every account of theirs that resolved
-- unassigned did so for that specific reason.
update accounts
set unassigned_reason = 'no_hubspot_credentials'
where rep_id is null
  and unassigned_reason is null
  and client_id = 'a0c67977-2817-4308-ac76-deed4e6c0911';
