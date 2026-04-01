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

create or replace function public.accept_staff_invite(code_input text, user_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  invite_row public.staff_invites;
begin
  select * into invite_row
  from public.staff_invites
  where code = code_input
    and used_at is null
    and expires_at > now();

  if invite_row.id is null then
    raise exception 'Invalid or expired invite code';
  end if;

  update public.staff_invites
  set used_by = user_id,
      used_at = now()
  where id = invite_row.id;

  update public.profiles
  set role = 'staff'
  where id = user_id;
end;
$$;

create or replace function public.award_points(
  customer_id_input uuid,
  staff_id_input uuid,
  spend_amount_input numeric,
  receipt_asset_input text,
  verification_input jsonb
)
returns public.transactions
language plpgsql
security definer
as $$
declare
  settings_row public.venue_settings;
  customer_row public.profiles;
  multiplier numeric;
  points_to_award integer;
  transaction_row public.transactions;
begin
  select * into settings_row from public.venue_settings order by created_at asc limit 1;
  select * into customer_row from public.profiles where id = customer_id_input;

  if customer_row.id is null then
    raise exception 'Customer not found';
  end if;

  multiplier := case customer_row.tier
    when 'silver' then 1.25
    when 'gold' then 1.5
    when 'vip' then 2
    else 1
  end;

  points_to_award := round(spend_amount_input * settings_row.earn_rate * multiplier);

  insert into public.transactions (
    customer_id,
    staff_id,
    type,
    points,
    spend_amount,
    source,
    receipt_image_url,
    receipt_venue_match,
    receipt_date_match,
    verification,
    description
  ) values (
    customer_id_input,
    staff_id_input,
    'earn',
    points_to_award,
    spend_amount_input,
    'scan',
    receipt_asset_input,
    coalesce((verification_input ->> 'venueMatched')::boolean, false),
    coalesce((verification_input ->> 'dateValid')::boolean, false),
    verification_input,
    'Points awarded from verified receipt scan'
  )
  returning * into transaction_row;

  update public.profiles
  set points_balance = points_balance + points_to_award,
      lifetime_spend = lifetime_spend + spend_amount_input
  where id = customer_id_input;

  return transaction_row;
end;
$$;

create or replace function public.redeem_reward(customer_id_input uuid, reward_id_input uuid)
returns public.redemptions
language plpgsql
security definer
as $$
declare
  reward_row public.rewards;
  redemption_row public.redemptions;
  transaction_row public.transactions;
begin
  select * into reward_row from public.rewards where id = reward_id_input and is_active = true;

  if reward_row.id is null then
    raise exception 'Reward not available';
  end if;

  insert into public.transactions (
    customer_id,
    type,
    points,
    source,
    description
  ) values (
    customer_id_input,
    'redeem',
    reward_row.points_cost * -1,
    'redeem',
    'Reward redemption'
  )
  returning * into transaction_row;

  insert into public.redemptions (
    customer_id,
    reward_id,
    transaction_id,
    redemption_code,
    status,
    expires_at
  ) values (
    customer_id_input,
    reward_id_input,
    transaction_row.id,
    upper(substr(gen_random_uuid()::text, 1, 8)),
    'pending',
    now() + interval '12 hours'
  )
  returning * into redemption_row;

  update public.profiles
  set points_balance = points_balance - reward_row.points_cost
  where id = customer_id_input;

  update public.rewards
  set quantity_used = quantity_used + 1
  where id = reward_id_input;

  return redemption_row;
end;
$$;
