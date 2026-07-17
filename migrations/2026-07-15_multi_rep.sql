create table reps (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  name text not null,
  email text not null,
  hubspot_owner_id text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

alter table accounts add column rep_id uuid references reps(id);

alter table user_roles add column rep_id uuid references reps(id);

alter table outreach_log add column performed_by_user_id uuid;
alter table outreach_log add column admin_override boolean not null default false;
alter table outreach_log add column target_rep_id uuid references reps(id);
alter table outreach_log add column note text;
