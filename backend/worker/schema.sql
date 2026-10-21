-- SteinWall backend (Cloudflare D1): licenses, referrals, anonymous savings counter.
-- D1 has no public endpoint: only the Worker reaches it through its binding.

create table if not exists licenses (
  id text primary key,                       -- opaque license id (lid in the token)
  stripe_customer text,
  stripe_subscription text unique,
  checkout_session text unique,
  email text,
  plan text not null,                         -- monthly | yearly | founder
  status text not null default 'active',      -- active | past_due | canceled
  founder integer not null default 0,
  referral_code text unique not null,
  referred_by text,                           -- referral code used at purchase
  period_end text not null,                   -- ISO timestamp
  bonus_days integer not null default 0,      -- earned through referrals
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists referrals (
  id integer primary key autoincrement,
  referrer_code text not null references licenses (referral_code),
  referred_license text not null unique references licenses (id),
  credited_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Opt-in telemetry: one row per install and day, nothing else.
create table if not exists telemetry_daily (
  install_id text not null,
  day text not null,
  saved_usd real not null check (saved_usd >= 0 and saved_usd <= 1000),
  received_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (install_id, day)
);
