create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text not null,
  display_name text,
  role text not null default 'customer' check (role in ('owner', 'staff', 'customer')),
  barcode text unique,
  points_balance integer not null default 0,
  tier text not null default 'bronze' check (tier in ('bronze', 'silver', 'gold', 'vip')),
  lifetime_spend numeric not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  created_by uuid not null references public.profiles(id),
  used_by uuid references public.profiles(id),
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  staff_id uuid references public.profiles(id),
  type text not null check (type in ('earn', 'redeem', 'bonus', 'adjust')),
  points integer not null,
  spend_amount numeric,
  source text,
  receipt_image_url text,
  receipt_venue_match boolean,
  receipt_date_match boolean,
  verification jsonb,
  flag text check (flag in ('high_amount', 'repeat_pair', 'off_hours', 'velocity', 'duplicate_receipt', 'concentration')),
  description text,
  created_at timestamptz not null default now()
);

create table if not exists public.rewards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  points_cost integer not null,
  category text,
  tier_required text not null default 'bronze' check (tier_required in ('bronze', 'silver', 'gold', 'vip')),
  is_active boolean not null default true,
  quantity_limit integer,
  quantity_used integer not null default 0,
  image_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.redemptions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  reward_id uuid not null references public.rewards(id),
  transaction_id uuid references public.transactions(id),
  redemption_code text unique not null,
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'expired', 'cancelled')),
  fulfilled_by uuid references public.profiles(id),
  fulfilled_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.fraud_alerts (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid references public.transactions(id),
  staff_id uuid references public.profiles(id),
  customer_id uuid references public.profiles(id),
  alert_type text not null check (alert_type in ('high_amount', 'repeat_pair', 'off_hours', 'velocity', 'duplicate_receipt', 'concentration')),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed', 'confirmed')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.venue_settings (
  id uuid primary key default gen_random_uuid(),
  venue_name text not null default 'Golden Ice',
  venue_aliases text[] not null default array['golden ice', 'goldenice'],
  earn_rate numeric not null default 10,
  welcome_bonus integer not null default 100,
  receipt_window_hours integer not null default 48,
  min_spend_amount numeric not null default 5,
  max_spend_amount numeric not null default 2000,
  opens_at_hour integer not null default 20,
  closes_at_hour integer not null default 4,
  daily_staff_point_limit integer not null default 20000,
  dual_confirmation_threshold numeric not null default 1200,
  high_amount_multiplier numeric not null default 2,
  velocity_window_minutes integer not null default 10,
  velocity_threshold integer not null default 5,
  repeat_pair_threshold integer not null default 3,
  concentration_threshold numeric not null default 0.6,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
