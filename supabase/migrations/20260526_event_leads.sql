-- 360 Booth Ireland — Event Lead Scanner Tables
-- Run this in: Supabase Dashboard → SQL Editor → New Query → Run

-- ── scan_config: stores the scheduler settings set from the dashboard ───────
create table if not exists public.scan_config (
  id text primary key default 'main',
  is_active boolean default false,
  schedule_type text default 'manual',        -- 'manual' | 'weekly' | 'monthly' | 'biannual'
  frequency_label text default 'Manual only',
  next_run_at timestamptz,
  last_run_at timestamptz,
  custom_terms text default '',               -- comma-separated extra search terms
  event_types text[] default array['wedding','corporate','birthday','party','fundraiser'],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Insert default row
insert into public.scan_config (id, is_active, schedule_type, frequency_label)
values ('main', false, 'manual', 'Manual only')
on conflict (id) do nothing;

-- ── event_leads: stores leads found by the cron scanner before import ────────
create table if not exists public.event_leads (
  id text primary key,
  name text not null,
  email text default '',
  phone text default '',
  source text default 'Event Scrape',
  service text default '360 Booth',
  status text default 'New',
  date text,
  notes text default '',
  imported boolean default false,             -- true once user imports to b360_leads
  scan_run_id text,                           -- groups leads from the same scan run
  scan_run_at timestamptz default now(),
  created_at timestamptz default now()
);

-- ── RLS Policies ─────────────────────────────────────────────────────────────
alter table public.scan_config enable row level security;
alter table public.event_leads enable row level security;

-- Authenticated users can read/write scan_config (owner dashboard)
create policy "Authenticated users can manage scan_config"
  on public.scan_config
  for all
  to authenticated
  using (true)
  with check (true);

-- Authenticated users can read event_leads (to see + import pending leads)
create policy "Authenticated users can read event_leads"
  on public.event_leads
  for select
  to authenticated
  using (true);

-- Authenticated users can update event_leads (to mark as imported)
create policy "Authenticated users can update event_leads"
  on public.event_leads
  for update
  to authenticated
  using (true);

-- Service role (cron) can insert event_leads (bypasses RLS automatically)
-- No policy needed for service role — it bypasses RLS by default.

-- ── updated_at trigger for scan_config ───────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scan_config_updated_at on public.scan_config;
create trigger scan_config_updated_at
  before update on public.scan_config
  for each row execute function public.set_updated_at();
