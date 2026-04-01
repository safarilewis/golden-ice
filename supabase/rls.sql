alter table public.profiles enable row level security;
alter table public.staff_invites enable row level security;
alter table public.transactions enable row level security;
alter table public.rewards enable row level security;
alter table public.redemptions enable row level security;
alter table public.fraud_alerts enable row level security;
alter table public.venue_settings enable row level security;

create or replace function public.current_role()
returns text
language sql
stable
as $$
  select role
  from public.profiles
  where id = auth.uid()
$$;

create or replace function public.current_roles()
returns text[]
language sql
stable
as $$
  select case role
    when 'owner' then array['customer', 'owner']
    when 'staff' then array['customer', 'staff']
    when 'customer' then array['customer']
    else array[]::text[]
  end
  from public.profiles
  where id = auth.uid()
$$;

create policy "receipt uploads by staff or owner"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'receipts'
  and public.current_role() in ('staff', 'owner')
);

create policy "receipt reads by authenticated users"
on storage.objects
for select
to authenticated
using (bucket_id = 'receipts');

create policy "profiles read own or managed"
on public.profiles
for select
using (
  id = auth.uid()
  or public.current_role() = 'owner'
  or (public.current_role() = 'staff' and role = 'customer')
);

create policy "profiles insert self or owner"
on public.profiles
for insert
with check (
  id = auth.uid()
  or public.current_role() = 'owner'
);

create policy "profiles update self or owner"
on public.profiles
for update
using (id = auth.uid() or public.current_role() = 'owner')
with check (id = auth.uid() or public.current_role() = 'owner');

create policy "transactions read own or staff owner"
on public.transactions
for select
using (
  customer_id = auth.uid()
  or public.current_role() in ('staff', 'owner')
);

create policy "transactions insert welcome bonus"
on public.transactions
for insert
to authenticated
with check (
  customer_id = auth.uid()
  and type = 'bonus'
  and source = 'welcome'
  and staff_id is null
);

create policy "rewards read active"
on public.rewards
for select
using (is_active or public.current_role() = 'owner');

create policy "redemptions read own or staff owner"
on public.redemptions
for select
using (
  customer_id = auth.uid()
  or public.current_role() in ('staff', 'owner')
);

create policy "fraud alerts owner only"
on public.fraud_alerts
for all
using (public.current_role() = 'owner')
with check (public.current_role() = 'owner');

create policy "staff invites owner only"
on public.staff_invites
for all
using (public.current_role() = 'owner')
with check (public.current_role() = 'owner');

create policy "venue settings owner write public read"
on public.venue_settings
for select
using (true);

create policy "venue settings owner update"
on public.venue_settings
for update
using (public.current_role() = 'owner')
with check (public.current_role() = 'owner');
