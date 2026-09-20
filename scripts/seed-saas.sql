-- Demo SaaS billing database, split across two schemas.
drop schema if exists billing cascade;
drop schema if exists app cascade;
create schema app;
create schema billing;

create type billing.invoice_status as enum ('draft', 'open', 'paid', 'void', 'uncollectible');
create type billing.plan_interval as enum ('monthly', 'yearly');

create table app.accounts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  industry    text not null,
  country     text not null,
  created_at  timestamptz not null
);
comment on table app.accounts is 'Customer organisations (tenants)';

create table app.users (
  id            bigint generated always as identity primary key,
  account_id    uuid not null references app.accounts(id),
  email         text not null unique,
  role          text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  last_seen_at  timestamptz,
  created_at    timestamptz not null
);
comment on table app.users is 'People who can sign in, each belonging to one account';

create table app.events (
  id           bigint generated always as identity primary key,
  user_id      bigint not null references app.users(id),
  name         text not null,
  properties   jsonb not null default '{}',
  occurred_at  timestamptz not null
);
comment on table app.events is 'Product usage events';
create index events_occurred_idx on app.events(occurred_at);
create index events_props_idx on app.events using gin (properties);

create table billing.plans (
  id        integer generated always as identity primary key,
  name      text not null,
  interval  billing.plan_interval not null,
  price     numeric(8,2) not null,
  seats     integer not null
);
comment on table billing.plans is 'Subscription plans on offer';
comment on column billing.plans.price is 'Price per billing interval in USD';

create table billing.subscriptions (
  id           bigint generated always as identity primary key,
  account_id   uuid not null references app.accounts(id),
  plan_id      integer not null references billing.plans(id),
  status       text not null check (status in ('trialing', 'active', 'past_due', 'canceled')),
  started_at   timestamptz not null,
  canceled_at  timestamptz
);
comment on table billing.subscriptions is 'Which plan each account is or was on';

create table billing.invoices (
  id               bigint generated always as identity primary key,
  subscription_id  bigint not null references billing.subscriptions(id),
  status           billing.invoice_status not null,
  amount_due       numeric(10,2) not null,
  amount_paid      numeric(10,2) not null default 0,
  issued_at        timestamptz not null,
  paid_at          timestamptz
);
comment on table billing.invoices is 'Invoices issued for subscriptions';
comment on column billing.invoices.amount_paid is 'Money actually collected, in USD';

select setseed(0.73);

insert into billing.plans(name, interval, price, seats) values
  ('Starter', 'monthly', 29, 3), ('Starter', 'yearly', 290, 3), ('Team', 'monthly', 99, 10),
  ('Team', 'yearly', 990, 10), ('Business', 'monthly', 299, 50), ('Business', 'yearly', 2990, 50);

insert into app.accounts(name, industry, country, created_at)
select (array['Blue','Red','North','Bright','Iron','Swift','Quiet','Lunar','Copper','Green'])[1 + floor(random()*10)::int] || ' ' ||
       (array['Labs','Works','Logistics','Health','Studio','Foods','Capital','Robotics','Media','Travel'])[1 + floor(random()*10)::int] || ' ' || g,
       (array['software','retail','healthcare','finance','education','manufacturing'])[1 + floor(random()*6)::int],
       (array['United States','Germany','India','Brazil','Japan','United Kingdom','Australia'])[1 + floor(random()*7)::int],
       now() - (random() * interval '1000 days')
from generate_series(1, 250) g;

insert into app.users(account_id, email, role, last_seen_at, created_at)
select a.id, 'user' || row_number() over () || '@' || replace(lower(a.name), ' ', '') || '.test',
       (array['owner','admin','member','member','member','viewer'])[1 + floor(random()*6)::int],
       case when random() < 0.85 then now() - (power(random(), 2) * interval '120 days') end,
       a.created_at + (random() * interval '60 days')
from app.accounts a cross join generate_series(1, 6) s where random() < 0.7;

insert into app.events(user_id, name, properties, occurred_at)
select u.id,
       (array['login','report_viewed','export_created','invite_sent','dashboard_shared','api_call'])[1 + floor(random()*6)::int],
       jsonb_build_object('device', (array['web','ios','android'])[1 + floor(random()*3)::int], 'duration_ms', floor(random()*5000)::int),
       now() - (power(random(), 1.5) * interval '90 days')
from app.users u cross join generate_series(1, 14);

insert into billing.subscriptions(account_id, plan_id, status, started_at, canceled_at)
select a.id, 1 + floor(random()*6)::int,
       (array['trialing','active','active','active','past_due','canceled'])[1 + floor(random()*6)::int],
       a.created_at + interval '1 day', null
from app.accounts a;
update billing.subscriptions set canceled_at = started_at + (random() * interval '400 days') where status = 'canceled';

insert into billing.invoices(subscription_id, status, amount_due, issued_at)
select s.id,
       (array['paid','paid','paid','paid','open','void','uncollectible'])[1 + floor(random()*7)::int]::billing.invoice_status,
       p.price, s.started_at + (n * interval '30 days')
from billing.subscriptions s join billing.plans p on p.id = s.plan_id
cross join generate_series(0, 11) n
where s.started_at + (n * interval '30 days') < now() and (p.interval = 'monthly' or n = 0);
update billing.invoices set amount_paid = amount_due, paid_at = issued_at + (random() * interval '10 days') where status = 'paid';

create materialized view billing.mrr_by_plan as
select p.name as plan, p.interval, count(*) as active_subscriptions,
       sum(case when p.interval = 'yearly' then p.price / 12 else p.price end)::numeric(12,2) as mrr
from billing.subscriptions s join billing.plans p on p.id = s.plan_id
where s.status = 'active' group by p.name, p.interval;
comment on materialized view billing.mrr_by_plan is 'Monthly recurring revenue from active subscriptions, per plan';

analyze;
