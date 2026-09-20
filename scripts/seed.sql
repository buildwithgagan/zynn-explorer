-- Demo data for Postgres Explorer.  Usage:  createdb pgx_demo && psql -d pgx_demo -f scripts/seed.sql
drop schema if exists shop cascade;
create schema shop;
comment on schema shop is 'Demo e-commerce data';
set search_path = shop;

create type order_status as enum ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded');

create table customers (
  id          integer generated always as identity primary key,
  name        text not null,
  email       text not null unique,
  country     text not null,
  segment     text not null check (segment in ('consumer', 'small business', 'enterprise')),
  created_at  timestamptz not null default now()
);
comment on table customers is 'People and companies that buy from the shop';
comment on column customers.segment is 'Commercial segment of the customer';

create table categories (
  id    integer generated always as identity primary key,
  name  text not null unique
);

create table products (
  id           integer generated always as identity primary key,
  category_id  integer not null references categories(id),
  name         text not null,
  price        numeric(10,2) not null check (price >= 0),
  stock        integer not null default 0,
  active       boolean not null default true
);
comment on table products is 'Items for sale';
comment on column products.price is 'Current list price in USD';
comment on column products.stock is 'Units currently in the warehouse';

create table orders (
  id            integer generated always as identity primary key,
  customer_id   integer not null references customers(id),
  status        order_status not null default 'pending',
  total_amount  numeric(12,2) not null default 0,
  ordered_at    timestamptz not null,
  shipped_at    timestamptz
);
comment on table orders is 'Customer purchases; one row per checkout';
comment on column orders.total_amount is 'Order total in USD (revenue)';
create index orders_customer_idx on orders(customer_id);
create index orders_ordered_at_idx on orders(ordered_at desc);

create table order_items (
  order_id    integer not null references orders(id) on delete cascade,
  product_id  integer not null references products(id),
  quantity    integer not null check (quantity > 0),
  unit_price  numeric(10,2) not null,
  primary key (order_id, product_id)
);
comment on table order_items is 'Products and quantities inside each order';

create table reviews (
  id           integer generated always as identity primary key,
  product_id   integer not null references products(id),
  customer_id  integer not null references customers(id),
  rating       smallint not null check (rating between 1 and 5),
  body         text,
  created_at   timestamptz not null default now()
);
comment on table reviews is 'Product reviews written by customers';

select setseed(0.42);

insert into categories(name) values ('Audio'), ('Computers'), ('Home'), ('Outdoors'), ('Books'), ('Toys');

insert into customers(name, email, country, segment, created_at)
select n.first || ' ' || n.last,
       lower(n.first || '.' || n.last) || g || '@example.com',
       (array['United States','Germany','India','Brazil','Japan','United Kingdom','France','Canada'])[1 + floor(random()*8)::int],
       (array['consumer','consumer','consumer','small business','enterprise'])[1 + floor(random()*5)::int],
       now() - (random() * interval '900 days')
from generate_series(1, 400) g
cross join lateral (
  select (array['Ava','Liam','Noah','Mia','Kai','Zoe','Ivy','Leo','Maya','Omar','Priya','Chen','Sofia','Lucas','Emma','Arjun'])[1 + floor(random()*16 + g*0)::int] as first,
         (array['Smith','Garcia','Khan','Tanaka','Silva','Patel','Dubois','Novak','Kim','Okafor','Rossi','Berg'])[1 + floor(random()*12 + g*0)::int] as last
) n;

insert into products(category_id, name, price, stock, active)
select 1 + floor(random()*6)::int,
       (array['Aurora','Summit','Nimbus','Vertex','Pulse','Echo','Drift','Terra','Halo','Quartz'])[1 + floor(random()*10)::int]
         || ' ' ||
       (array['Headphones','Laptop','Lamp','Tent','Speaker','Backpack','Keyboard','Monitor','Blender','Puzzle'])[1 + floor(random()*10)::int]
         || ' ' || g,
       round((5 + random()*995)::numeric, 2),
       floor(random()*500)::int,
       random() > 0.1
from generate_series(1, 120) g;

insert into orders(customer_id, status, ordered_at)
select 1 + floor(random()*400)::int,
       (array['pending','paid','paid','shipped','delivered','delivered','delivered','cancelled','refunded'])[1 + floor(random()*9)::int]::order_status,
       now() - (power(random(), 1.6) * interval '720 days')
from generate_series(1, 6000);

update orders set shipped_at = ordered_at + (1 + random()*5) * interval '1 day'
where status in ('shipped', 'delivered');

insert into order_items(order_id, product_id, quantity, unit_price)
select o.id, p.id, 1 + floor(random()*4)::int, p.price
from orders o
cross join lateral (
  select id, price from products where o.id > 0 order by random() limit 1 + floor(random()*3)::int
) p
on conflict do nothing;

update orders o set total_amount = s.total
from (select order_id, sum(quantity * unit_price) as total from order_items group by 1) s
where s.order_id = o.id;

insert into reviews(product_id, customer_id, rating, body, created_at)
select 1 + floor(random()*120)::int, 1 + floor(random()*400)::int,
       (array[5,5,4,4,4,3,2,1])[1 + floor(random()*8)::int],
       (array['Great value','Works as described','Stopped working after a month','Love it','Not worth the price','Fast shipping, solid build'])[1 + floor(random()*6)::int],
       now() - (random() * interval '600 days')
from generate_series(1, 1500);

create view customer_revenue as
select c.id, c.name, c.country, count(o.id) as orders, coalesce(sum(o.total_amount), 0) as revenue
from customers c left join orders o on o.customer_id = c.id and o.status not in ('cancelled', 'refunded')
group by c.id;
comment on view customer_revenue is 'Lifetime order count and revenue per customer';

create function order_total(p_order_id integer) returns numeric
language sql stable as $$
  select coalesce(sum(quantity * unit_price), 0) from shop.order_items where order_id = p_order_id
$$;

create function touch_shipped_at() returns trigger language plpgsql as $$
begin
  if new.status = 'shipped' and new.shipped_at is null then new.shipped_at := now(); end if;
  return new;
end $$;
create trigger orders_touch_shipped before update on orders
for each row execute function touch_shipped_at();

analyze;
