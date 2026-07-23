-- Raw counts only, no stored bounce_rate - computed at read time so the 2% threshold logic
-- can change later without a stored derived value drifting from its inputs.
create table deliverability_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  campaign_id text not null,
  campaign_name text,
  emails_sent_count integer,
  bounced_count integer,
  unsubscribed_count integer,
  reply_count integer,
  open_count integer,
  checked_at timestamptz not null default now()
);
