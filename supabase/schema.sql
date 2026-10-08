-- =====================================================================
--  Морьтон Парад-2026 — тасалбарын систем (Supabase SQL)
--  Supabase → SQL Editor → New query → энэ файлыг бүтнээр нь хуулж → Run.
--  Дахин ажиллуулахад аюулгүй (байгаа өгөгдлийг устгахгүй).
-- =====================================================================

-- ---------- 1. Хүснэгтүүд ----------

create table if not exists public.parade_settings (
  id            int primary key default 1 check (id = 1),
  event_name    text not null default 'Морьтон Парад-2026',
  event_at      timestamptz not null default '2026-10-11 10:00:00+08',
  sales_until   timestamptz,                         -- хоосон бол парадын өдрийн 18:00 хүртэл
  location      text not null default 'Хүй долоон худаг',
  phone         text not null default '7732-0404',
  price         int  not null default 50000 check (price >= 0),
  start_no      int  not null default 11111 check (start_no > 0),
  total         int  not null default 600 check (total > 0 and total <= 100000),
  max_per_order int  not null default 10 check (max_per_order between 1 and 100),
  hold_minutes  int  not null default 20 check (hold_minutes between 5 and 1440),
  transfer_hold_hours int not null default 12 check (transfer_hold_hours between 1 and 168),
  sales_open    boolean not null default true,
  bank_info     text not null default '',            -- QPay тохируулаагүй үед дансаар төлөх заавар
  notify_email  text not null default '',            -- шинэ борлуулалтын мэдэгдэл очих имэйл (таслалаар олон)
  site_url      text not null default '',            -- https://ТАНЫ-НЭР.github.io/parade/
  updated_at    timestamptz not null default now()
);
insert into public.parade_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.parade_orders (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,
  access_key        text not null,
  name              text not null,
  phone             text not null,
  email             text,
  qty               int  not null check (qty between 1 and 100),
  unit_price        int  not null,
  amount            int  not null,
  status            text not null default 'pending'
                    check (status in ('pending','paid','expired','cancelled','refund')),
  source            text not null default 'online' check (source in ('online','manual')),
  pay_method        text not null default 'qpay',      -- qpay | transfer | cash | card | free
  invoice_id        text,
  invoice_qr_text   text,
  invoice_qr_image  text,
  invoice_urls      jsonb,
  invoice_short_url text,
  payment_id        text,
  paid_amount       int,
  paid_at           timestamptz,
  expires_at        timestamptz,
  email_sent_at     timestamptz,
  email_error       text,
  note              text,
  created_by        text,
  client_ip         text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.parade_orders add column if not exists client_ip text;
-- Бүртгэлийн нэмэлт мэдээлэл
alter table public.parade_orders add column if not exists phone2 text;
alter table public.parade_orders add column if not exists aimag  text;
alter table public.parade_orders add column if not exists sum    text;
alter table public.parade_orders add column if not exists title  text;
create index if not exists parade_orders_status_idx on public.parade_orders (status, expires_at);
create index if not exists parade_orders_phone_idx  on public.parade_orders (phone);
create index if not exists parade_orders_email_idx  on public.parade_orders (lower(email));

create table if not exists public.parade_tickets (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.parade_orders(id) on delete cascade,
  number       int  not null,
  token        text not null unique,
  status       text not null default 'valid' check (status in ('valid','cancelled')),
  holder_name  text,
  entry_at     timestamptz, entry_by text,
  food_at      timestamptz, food_by  text,
  drink_at     timestamptz, drink_by text,
  cancelled_at timestamptz,
  created_at   timestamptz not null default now()
);
-- нэг дугаар зөвхөн нэг хүчинтэй тасалбарт
create unique index if not exists parade_tickets_number_valid on public.parade_tickets (number) where status = 'valid';
create index if not exists parade_tickets_order_idx on public.parade_tickets (order_id);

create table if not exists public.parade_staff (
  email      text primary key,
  role       text not null default 'staff' check (role in ('admin','staff')),
  created_at timestamptz not null default now()
);
-- Анхны админ (Authentication → Users хэсэгт ижил имэйлтэй хэрэглэгч үүсгэнэ)
insert into public.parade_staff (email, role) values ('khongor95@gmail.com', 'admin') on conflict (email) do nothing;

create table if not exists public.parade_draws (
  id          bigint generated always as identity primary key,
  prize       text not null,
  pool        text not null default 'all',
  ticket_id   uuid references public.parade_tickets(id) on delete set null,
  number      int,
  holder_name text,
  phone       text,
  voided      boolean not null default false,
  drawn_by    text,
  created_at  timestamptz not null default now()
);

create table if not exists public.parade_log (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  actor  text,
  action text not null,
  detail jsonb
);

-- ---------- 2. Хамгаалалт: хөтчөөс шууд хандах эрхгүй (зөвхөн Edge Function) ----------
alter table public.parade_settings enable row level security;
alter table public.parade_orders   enable row level security;
alter table public.parade_tickets  enable row level security;
alter table public.parade_staff    enable row level security;
alter table public.parade_draws    enable row level security;
alter table public.parade_log      enable row level security;
revoke all on public.parade_settings, public.parade_orders, public.parade_tickets,
              public.parade_staff, public.parade_draws, public.parade_log from anon, authenticated;
grant all on public.parade_settings, public.parade_orders, public.parade_tickets,
             public.parade_staff, public.parade_draws, public.parade_log to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------- 3. Функцууд ----------

-- Санамсаргүй, таах боломжгүй QR токен (80 бит)
create or replace function public.parade_token() returns text
language sql volatile as $$
  select substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 20)
$$;

-- Захиалгын код: MP-XXXXXX (андуурагдах үсэг/тоогүй)
create or replace function public.parade_code() returns text
language plpgsql volatile as $$
declare
  a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  c text;
begin
  loop
    c := 'MP-';
    for i in 1..6 loop
      c := c || substr(a, 1 + floor(random() * length(a))::int, 1);
    end loop;
    exit when not exists (select 1 from public.parade_orders where code = c);
  end loop;
  return c;
end $$;

-- Борлуулалт хаагдах хугацаа
create or replace function public.parade_sales_close(s public.parade_settings) returns timestamptz
language sql stable as $$
  select coalesce(s.sales_until,
                  ((s.event_at at time zone 'Asia/Ulaanbaatar')::date + time '18:00') at time zone 'Asia/Ulaanbaatar')
$$;

-- Үлдсэн тасалбар (хүчинтэй тасалбар + төлбөр хүлээж буй захиалгын суудлыг хасна)
create or replace function public.parade_available(p_exclude uuid default null) returns int
language sql stable as $$
  select s.total
       - (select count(*) from public.parade_tickets t where t.status = 'valid')::int
       - coalesce((select sum(o.qty) from public.parade_orders o
                    where o.status = 'pending' and o.expires_at >= now()
                      and (p_exclude is null or o.id <> p_exclude)), 0)::int
  from public.parade_settings s where s.id = 1
$$;

-- Нийтэд харагдах мэдээлэл
create or replace function public.parade_public_info() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'event_name', s.event_name, 'event_at', s.event_at, 'location', s.location, 'phone', s.phone,
    'price', s.price, 'total', s.total, 'start_no', s.start_no, 'max_per_order', s.max_per_order,
    'hold_minutes', s.hold_minutes, 'sales_open', s.sales_open, 'sales_close', public.parade_sales_close(s),
    'bank_info', s.bank_info,
    'sold', (select count(*) from public.parade_tickets t where t.status = 'valid'),
    'available', greatest(public.parade_available(), 0),
    'now', now())
  from public.parade_settings s where s.id = 1
$$;

-- Онлайн захиалга үүсгэх (суудал түр барина)
create or replace function public.parade_create_order(
  p_name text, p_phone text, p_email text, p_qty int, p_method text default 'qpay', p_ip text default null)
returns jsonb language plpgsql as $$
declare
  s public.parade_settings;
  o public.parade_orders;
  v_avail int;
  v_exp timestamptz;
begin
  select * into s from public.parade_settings where id = 1 for update;   -- нэг зэрэг олон хүн авахад дараалуулна
  if not s.sales_open then raise exception 'SALES_CLOSED'; end if;
  if now() >= public.parade_sales_close(s) then raise exception 'SALES_ENDED'; end if;
  if p_qty is null or p_qty < 1 or p_qty > s.max_per_order then raise exception 'BAD_QTY'; end if;
  if coalesce(trim(p_name), '') = '' or coalesce(trim(p_phone), '') = '' then raise exception 'BAD_INPUT'; end if;

  update public.parade_orders set status = 'expired', updated_at = now()
   where status = 'pending' and expires_at < now();

  -- суудлыг хуурамчаар барихаас сэргийлнэ: нэг утсаар 2, нэг IP-аас 10 хүртэл төлөгдөөгүй захиалга
  if (select count(*) from public.parade_orders
       where status = 'pending' and expires_at >= now() and phone = trim(p_phone)) >= 2
     or (p_ip is not null and (select count(*) from public.parade_orders
       where status = 'pending' and expires_at >= now() and client_ip = p_ip) >= 10) then
    raise exception 'TOO_MANY';
  end if;

  v_avail := public.parade_available();
  if p_qty > v_avail then raise exception 'SOLD_OUT:%', greatest(v_avail, 0); end if;

  v_exp := case when p_method = 'transfer'
                then now() + make_interval(hours => s.transfer_hold_hours)
                else now() + make_interval(mins => s.hold_minutes) end;

  insert into public.parade_orders (code, access_key, name, phone, email, qty, unit_price, amount,
                                    status, source, pay_method, expires_at, client_ip)
  values (public.parade_code(), public.parade_token() || public.parade_token(), trim(p_name), trim(p_phone),
          nullif(lower(trim(coalesce(p_email, ''))), ''), p_qty, s.price, s.price * p_qty,
          'pending', 'online', coalesce(p_method, 'qpay'), v_exp, p_ip)
  returning * into o;
  return to_jsonb(o);
end $$;

-- Төлбөр баталгаажсан захиалгад тасалбар олгох (давхар дуудсан ч нэг л удаа олгоно)
create or replace function public.parade_finalize_order(
  p_order_id uuid, p_payment_id text default null, p_paid_amount int default null,
  p_method text default null, p_actor text default null)
returns jsonb language plpgsql as $$
declare
  s public.parade_settings;
  o public.parade_orders;
  v_avail int;
  v_cnt int;
begin
  select * into s from public.parade_settings where id = 1 for update;
  select * into o from public.parade_orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;

  if o.status = 'paid' then
    return jsonb_build_object('ok', true, 'already', true, 'order', to_jsonb(o));
  end if;

  if p_paid_amount is not null and p_paid_amount < o.amount then
    raise exception 'UNDERPAID:%', p_paid_amount;
  end if;

  -- Цуцлагдсан захиалга QPay-ээр төлөгдсөн бол буцаан олголт хийх жагсаалтад
  if o.status in ('cancelled', 'refund') then
    update public.parade_orders
       set status = 'refund', payment_id = coalesce(p_payment_id, payment_id),
           paid_amount = coalesce(p_paid_amount, paid_amount), paid_at = coalesce(paid_at, now()), updated_at = now()
     where id = o.id returning * into o;
    return jsonb_build_object('ok', false, 'reason', 'CANCELLED_PAID', 'order', to_jsonb(o));
  end if;

  v_avail := public.parade_available(o.id);
  if o.qty > v_avail then
    update public.parade_orders
       set status = 'refund', payment_id = coalesce(p_payment_id, payment_id),
           paid_amount = coalesce(p_paid_amount, o.amount), paid_at = now(), updated_at = now(),
           note = concat_ws(' · ', note, 'Тасалбар дууссан — мөнгийг буцаах')
     where id = o.id returning * into o;
    return jsonb_build_object('ok', false, 'reason', 'SOLD_OUT_REFUND', 'order', to_jsonb(o));
  end if;

  insert into public.parade_tickets (order_id, number, token, holder_name)
  select o.id, n, public.parade_token(), o.name
    from generate_series(s.start_no, s.start_no + s.total - 1) as n
   where not exists (select 1 from public.parade_tickets t where t.number = n and t.status = 'valid')
   order by n
   limit o.qty;
  get diagnostics v_cnt = row_count;
  if v_cnt < o.qty then raise exception 'NO_NUMBERS'; end if;

  update public.parade_orders
     set status = 'paid', paid_at = now(), payment_id = coalesce(p_payment_id, payment_id),
         paid_amount = coalesce(p_paid_amount, amount), pay_method = coalesce(p_method, pay_method),
         updated_at = now()
   where id = o.id returning * into o;

  insert into public.parade_log (actor, action, detail)
  values (coalesce(p_actor, 'system'), 'paid', jsonb_build_object('code', o.code, 'qty', o.qty, 'method', o.pay_method));

  return jsonb_build_object('ok', true, 'already', false, 'order', to_jsonb(o),
    'tickets', (select jsonb_agg(jsonb_build_object('number', t.number, 'token', t.token) order by t.number)
                  from public.parade_tickets t where t.order_id = o.id and t.status = 'valid'));
end $$;

-- Админ гараар тасалбар олгох (бэлэн, данс, үнэгүй…)
create or replace function public.parade_issue_manual(
  p_name text, p_phone text, p_email text, p_qty int, p_method text,
  p_amount int default null, p_note text default null, p_actor text default null)
returns jsonb language plpgsql as $$
declare
  s public.parade_settings;
  o public.parade_orders;
  v_avail int;
begin
  select * into s from public.parade_settings where id = 1 for update;
  if p_qty is null or p_qty < 1 or p_qty > 100 then raise exception 'BAD_QTY'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'BAD_INPUT'; end if;
  v_avail := public.parade_available();
  if p_qty > v_avail then raise exception 'SOLD_OUT:%', greatest(v_avail, 0); end if;

  insert into public.parade_orders (code, access_key, name, phone, email, qty, unit_price, amount,
                                    status, source, pay_method, expires_at, note, created_by)
  values (public.parade_code(), public.parade_token() || public.parade_token(), trim(p_name), coalesce(trim(p_phone), ''),
          nullif(lower(trim(coalesce(p_email, ''))), ''), p_qty, s.price,
          coalesce(p_amount, case when p_method = 'free' then 0 else s.price * p_qty end),
          'pending', 'manual', coalesce(p_method, 'cash'), now() + interval '5 minutes', p_note, p_actor)
  returning * into o;

  return public.parade_finalize_order(o.id, null, null, null, p_actor);
end $$;

-- QR уншуулах: орох / хоол / ундаа / зөвхөн харах
create or replace function public.parade_scan(p_code text, p_mode text, p_actor text default null)
returns jsonb language plpgsql as $$
declare
  v_code text := trim(coalesce(p_code, ''));
  v_token text;
  v_num int;
  t public.parade_tickets;
  o public.parade_orders;
  v_prev timestamptz;
begin
  if v_code ~* '[?&]t=([a-z0-9]+)' then
    v_token := lower(substring(v_code from '(?i)[?&]t=([a-z0-9]+)'));
  elsif v_code ~ '^[0-9]{1,7}$' then
    v_num := v_code::int;
  else
    v_token := lower(v_code);
  end if;

  if v_token is not null then
    select * into t from public.parade_tickets where token = v_token for update;
  else
    select * into t from public.parade_tickets where number = v_num
     order by (status = 'valid') desc, created_at desc limit 1 for update;
  end if;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  select * into o from public.parade_orders where id = t.order_id;

  if t.status <> 'valid' then
    return jsonb_build_object('result', 'cancelled', 'ticket', to_jsonb(t), 'order_code', o.code, 'name', o.name, 'phone', o.phone);
  end if;

  if p_mode in ('entry', 'food', 'drink') then
    v_prev := case p_mode when 'entry' then t.entry_at when 'food' then t.food_at else t.drink_at end;
    if v_prev is not null then
      return jsonb_build_object('result', 'already', 'at', v_prev, 'ticket', to_jsonb(t),
                                'order_code', o.code, 'name', o.name, 'phone', o.phone);
    end if;
    if p_mode = 'entry' then
      update public.parade_tickets set entry_at = now(), entry_by = p_actor where id = t.id returning * into t;
    elsif p_mode = 'food' then
      update public.parade_tickets set food_at = now(), food_by = p_actor where id = t.id returning * into t;
    else
      update public.parade_tickets set drink_at = now(), drink_by = p_actor where id = t.id returning * into t;
    end if;
    return jsonb_build_object('result', 'ok', 'ticket', to_jsonb(t), 'order_code', o.code, 'name', o.name, 'phone', o.phone);
  end if;

  return jsonb_build_object('result', 'info', 'ticket', to_jsonb(t), 'order_code', o.code, 'name', o.name, 'phone', o.phone);
end $$;

-- Сугалаа: хүчинтэй (эсвэл ирсэн) тасалбараас санамсаргүй нэгийг сонгоно, өмнө хожсоныг давтахгүй
create or replace function public.parade_draw(p_prize text, p_pool text, p_actor text default null)
returns jsonb language plpgsql as $$
declare
  t public.parade_tickets;
  o public.parade_orders;
  d public.parade_draws;
begin
  if coalesce(trim(p_prize), '') = '' then raise exception 'BAD_INPUT'; end if;
  select * into t from public.parade_tickets x
   where x.status = 'valid'
     and (p_pool <> 'entered' or x.entry_at is not null)
     and not exists (select 1 from public.parade_draws d2 where d2.ticket_id = x.id and not d2.voided)
   order by random() limit 1;
  if not found then raise exception 'NO_CANDIDATES'; end if;
  select * into o from public.parade_orders where id = t.order_id;
  insert into public.parade_draws (prize, pool, ticket_id, number, holder_name, phone, drawn_by)
  values (trim(p_prize), coalesce(p_pool, 'all'), t.id, t.number, o.name, o.phone, p_actor)
  returning * into d;
  return to_jsonb(d);
end $$;

-- Цуцалсан захиалга/тасалбарыг сэргээх (QR код хэвээр; дугаар нь өөр хүнд очсон бол шинэ дугаар олгоно)
create or replace function public.parade_restore(p_order_id uuid, p_ticket_id uuid default null, p_actor text default null)
returns jsonb language plpgsql as $$
declare
  s public.parade_settings;
  o public.parade_orders;
  t public.parade_tickets;
  v_cnt int; v_avail int; v_new int; v_renum int := 0;
begin
  select * into s from public.parade_settings where id = 1 for update;
  select * into o from public.parade_orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if o.paid_at is null then raise exception 'NOT_PAID'; end if;
  if o.status = 'refund' then raise exception 'IS_REFUND'; end if;

  select count(*) into v_cnt from public.parade_tickets
   where order_id = o.id and status = 'cancelled' and (p_ticket_id is null or id = p_ticket_id);
  if v_cnt = 0 then raise exception 'NOTHING_TO_RESTORE'; end if;

  v_avail := public.parade_available(o.id);
  if v_cnt > v_avail then raise exception 'SOLD_OUT:%', greatest(v_avail, 0); end if;

  for t in select * from public.parade_tickets
            where order_id = o.id and status = 'cancelled' and (p_ticket_id is null or id = p_ticket_id)
            order by number loop
    if not exists (select 1 from public.parade_tickets x where x.number = t.number and x.status = 'valid') then
      update public.parade_tickets set status = 'valid', cancelled_at = null where id = t.id;
    else
      select n into v_new from generate_series(s.start_no, s.start_no + s.total - 1) as n
       where not exists (select 1 from public.parade_tickets x where x.number = n and x.status = 'valid')
       order by n limit 1;
      if v_new is null then raise exception 'NO_NUMBERS'; end if;
      update public.parade_tickets set status = 'valid', cancelled_at = null, number = v_new where id = t.id;
      v_renum := v_renum + 1;
    end if;
  end loop;

  update public.parade_orders
     set status = 'paid', note = concat_ws(' · ', note, 'Сэргээсэн: ' || coalesce(p_actor, '')), updated_at = now()
   where id = o.id returning * into o;
  insert into public.parade_log (actor, action, detail)
  values (coalesce(p_actor, 'system'), 'restore', jsonb_build_object('code', o.code, 'restored', v_cnt, 'renumbered', v_renum));

  return jsonb_build_object('ok', true, 'restored', v_cnt, 'renumbered', v_renum, 'order', to_jsonb(o),
    'tickets', (select jsonb_agg(jsonb_build_object('number', x.number, 'token', x.token) order by x.number)
                  from public.parade_tickets x where x.order_id = o.id and x.status = 'valid'));
end $$;

-- Самбарын тоо баримт
create or replace function public.parade_stats() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'total', s.total, 'price', s.price,
    'sold', (select count(*) from public.parade_tickets where status = 'valid'),
    'sold_online', (select count(*) from public.parade_tickets t join public.parade_orders o on o.id = t.order_id
                     where t.status = 'valid' and o.source = 'online'),
    'sold_manual', (select count(*) from public.parade_tickets t join public.parade_orders o on o.id = t.order_id
                     where t.status = 'valid' and o.source = 'manual'),
    'revenue', (select coalesce(sum(o.paid_amount), 0) from public.parade_orders o where o.status = 'paid'),
    'revenue_qpay', (select coalesce(sum(o.paid_amount), 0) from public.parade_orders o where o.status = 'paid' and o.pay_method = 'qpay'),
    'pending_orders', (select count(*) from public.parade_orders where status = 'pending' and expires_at >= now()),
    'pending_qty', (select coalesce(sum(qty), 0) from public.parade_orders where status = 'pending' and expires_at >= now()),
    'refund_orders', (select count(*) from public.parade_orders where status = 'refund'),
    'email_errors', (select count(*) from public.parade_orders where status = 'paid' and email_error is not null),
    'available', greatest(public.parade_available(), 0),
    'entered', (select count(*) from public.parade_tickets where status = 'valid' and entry_at is not null),
    'food', (select count(*) from public.parade_tickets where status = 'valid' and food_at is not null),
    'drink', (select count(*) from public.parade_tickets where status = 'valid' and drink_at is not null),
    'paid_orders', (select count(*) from public.parade_orders where status = 'paid'),
    'by_day', coalesce((select jsonb_agg(x order by x.day) from (
        select to_char(t.created_at at time zone 'Asia/Ulaanbaatar', 'YYYY-MM-DD') as day, count(*) as qty
          from public.parade_tickets t where t.status = 'valid' group by 1) x), '[]'::jsonb),
    'now', now())
  from public.parade_settings s where s.id = 1
$$;

-- ---------- 4. Функцуудыг зөвхөн Edge Function (service_role) дуудна ----------
do $$
declare f text;
begin
  foreach f in array array[
    'parade_token()', 'parade_code()', 'parade_sales_close(public.parade_settings)', 'parade_available(uuid)',
    'parade_public_info()', 'parade_create_order(text,text,text,int,text,text)',
    'parade_finalize_order(uuid,text,int,text,text)', 'parade_issue_manual(text,text,text,int,text,int,text,text)',
    'parade_scan(text,text,text)', 'parade_draw(text,text,text)', 'parade_stats()', 'parade_restore(uuid,uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- API-ийн схемийн кэшийг шинэчилнэ (шинэ баганууд шууд ажиллана)
notify pgrst, 'reload schema';
