-- SteinWall backend: licenses, referrals, anonymous savings counter.
-- Only the Edge Functions (service role) access these tables; RLS is enabled without policies,
-- so the public anon key cannot read or write anything.

create table licenses (
  id text primary key,                       -- opaque license id (lid in the token)
  stripe_customer text,
  stripe_subscription text unique,
  checkout_session text unique,
  email text,
  plan text not null,                         -- monthly | yearly | founder
  status text not null default 'active',      -- active | past_due | canceled
  founder boolean not null default false,
  referral_code text unique not null,
  referred_by text,                           -- referral code used at purchase
  period_end timestamptz not null,
  bonus_days integer not null default 0,      -- earned through referrals
  created_at timestamptz not null default now()
);

create table referrals (
  id bigint generated always as identity primary key,
  referrer_code text not null references licenses (referral_code),
  referred_license text not null unique references licenses (id),
  credited_at timestamptz not null default now()
);

-- Opt-in telemetry: one row per install and day, nothing else.
create table telemetry_daily (
  install_id uuid not null,
  day date not null,
  saved_usd numeric(10, 2) not null check (saved_usd >= 0 and saved_usd <= 1000),
  received_at timestamptz not null default now(),
  primary key (install_id, day)
);

alter table licenses enable row level security;
alter table referrals enable row level security;
alter table telemetry_daily enable row level security;

-- Founder price: the first 500 paying founder licenses.
create view founder_count as
  select count(*)::int as n from licenses where founder and status <> 'canceled';

create view savings_counter as
  select coalesce(sum(saved_usd), 0)::numeric(14, 2) as total_usd, count(distinct install_id)::int as installs
  from telemetry_daily;

-- Views run with the caller's rights (RLS applies), and only the service role may read them.
alter view founder_count set (security_invoker = true);
alter view savings_counter set (security_invoker = true);
revoke all on founder_count, savings_counter from anon, authenticated;
revoke all on licenses, referrals, telemetry_daily from anon, authenticated;
