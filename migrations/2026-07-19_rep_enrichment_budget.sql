-- Nullable, but defaults to a conservative cap rather than unlimited - a rep onboarded without
-- anyone touching this column should be capped, not accidentally unlimited. null is reserved for
-- an admin explicitly opting a specific rep into unlimited Clay spend.
alter table reps add column weekly_enrichment_budget numeric default 5;

create table rep_budget_changes (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid not null references reps(id),
  client_id uuid not null references clients(id),
  changed_by_user_id uuid not null,
  previous_budget numeric,
  new_budget numeric,
  changed_at timestamptz not null default now()
);
