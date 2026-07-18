create table enrichment_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  account_id uuid not null references accounts(id),
  requested_by_user_id uuid not null,
  contact_ref text not null,
  fields_requested text[] not null,
  status text not null default 'pending',
  source text,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
