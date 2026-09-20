-- Demo HR database (tables live in the public schema).
drop table if exists leave_requests, salaries, employees, departments, offices cascade;
drop type if exists leave_type, leave_state;

create type leave_type as enum ('vacation', 'sick', 'parental', 'unpaid');
create type leave_state as enum ('requested', 'approved', 'rejected');

create table offices (
  id       integer generated always as identity primary key,
  city     text not null,
  country  text not null
);
comment on table offices is 'Company office locations';

create table departments (
  id      integer generated always as identity primary key,
  name    text not null unique,
  budget  numeric(12,2) not null
);
comment on table departments is 'Organisational departments';
comment on column departments.budget is 'Annual budget in USD';

create table employees (
  id             integer generated always as identity primary key,
  full_name      text not null,
  email          text not null unique,
  job_title      text not null,
  level          text not null check (level in ('junior', 'mid', 'senior', 'lead', 'director')),
  department_id  integer not null references departments(id),
  office_id      integer not null references offices(id),
  manager_id     integer references employees(id),
  remote         boolean not null default false,
  hired_on       date not null,
  left_on        date
);
comment on table employees is 'Everyone who works or has worked at the company';
comment on column employees.left_on is 'Last working day; null while still employed';
comment on column employees.level is 'Seniority level';

create table salaries (
  id            integer generated always as identity primary key,
  employee_id   integer not null references employees(id),
  amount        numeric(10,2) not null,
  effective_on  date not null
);
comment on table salaries is 'Salary history; the latest row per employee is the current salary';
comment on column salaries.amount is 'Annual gross salary in USD';

create table leave_requests (
  id           integer generated always as identity primary key,
  employee_id  integer not null references employees(id),
  kind         leave_type not null,
  state        leave_state not null default 'requested',
  starts_on    date not null,
  days         integer not null check (days > 0)
);
comment on table leave_requests is 'Time-off requests made by employees';

select setseed(0.17);

insert into offices(city, country) values
  ('Berlin', 'Germany'), ('Austin', 'United States'), ('Bengaluru', 'India'), ('Lisbon', 'Portugal'), ('Toronto', 'Canada');

insert into departments(name, budget) values
  ('Engineering', 4200000), ('Sales', 2100000), ('Marketing', 1300000), ('Finance', 800000), ('Support', 950000), ('People', 600000);

insert into employees(full_name, email, job_title, level, department_id, office_id, remote, hired_on, left_on)
select n.first || ' ' || n.last,
       lower(n.first || '.' || n.last || g) || '@acme.test',
       (array['Engineer','Analyst','Manager','Specialist','Designer','Coordinator'])[1 + floor(random()*6)::int],
       (array['junior','mid','mid','senior','senior','lead','director'])[1 + floor(random()*7)::int],
       1 + floor(random()*6)::int, 1 + floor(random()*5)::int, random() < 0.3,
       current_date - (floor(random()*3000)::int),
       case when random() < 0.12 then current_date - (floor(random()*300)::int) end
from generate_series(1, 320) g
cross join lateral (
  select (array['Nora','Felix','Anika','Raj','Ines','Tomas','Grace','Hugo','Lena','Samir','Yuki','Diego'])[1 + floor(random()*12 + g*0)::int] as first,
         (array['Weber','Nguyen','Costa','Iyer','Martin','Olsen','Haddad','Sato','Brown','Mendes'])[1 + floor(random()*10 + g*0)::int] as last
) n;

update employees e set manager_id = m.id
from (select id, department_id from employees where level in ('lead', 'director')) m
where m.department_id = e.department_id and m.id <> e.id and e.level not in ('director') and random() < 0.5;

insert into salaries(employee_id, amount, effective_on)
select e.id,
       round((case e.level when 'junior' then 55000 when 'mid' then 80000 when 'senior' then 115000 when 'lead' then 145000 else 190000 end
              * (0.85 + random()*0.3) * (1 + 0.04 * s))::numeric, 2),
       e.hired_on + (s * 365)
from employees e cross join generate_series(0, 3) s
where e.hired_on + (s * 365) <= current_date;

insert into leave_requests(employee_id, kind, state, starts_on, days)
select 1 + floor(random()*320)::int,
       (array['vacation','vacation','vacation','sick','sick','parental','unpaid'])[1 + floor(random()*7)::int]::leave_type,
       (array['requested','approved','approved','approved','rejected'])[1 + floor(random()*5)::int]::leave_state,
       current_date - (floor(random()*500)::int) + 30, 1 + floor(random()*14)::int
from generate_series(1, 1200);

create view headcount_by_department as
select d.name as department, count(*) filter (where e.left_on is null) as active_employees
from departments d left join employees e on e.department_id = d.id group by d.name;

analyze;
