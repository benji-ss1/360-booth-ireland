create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  requested_slug text;
  fallback_slug text;
  derived_slug text;
  target_client_id uuid;
  first_name_value text;
  last_name_value text;
  email_domain text;
  full_name text;
begin
  requested_slug := nullif(lower(new.raw_user_meta_data ->> 'client_slug'), '');
  email_domain := lower(split_part(coalesce(new.email, ''), '@', 2));
  full_name := coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '');

  fallback_slug := case
    when email_domain in ('360boothireland.ie', '360boothireland.com') then 'boot360'
    else null
  end;

  derived_slug := coalesce(requested_slug, fallback_slug);
  if derived_slug is null then
    return new;
  end if;

  select id into target_client_id
  from public.clients
  where slug = derived_slug
  limit 1;

  if target_client_id is null then
    return new;
  end if;

  first_name_value := coalesce(
    nullif(new.raw_user_meta_data ->> 'first_name', ''),
    nullif(split_part(full_name, ' ', 1), ''),
    split_part(coalesce(new.email, ''), '@', 1)
  );

  last_name_value := coalesce(
    nullif(new.raw_user_meta_data ->> 'last_name', ''),
    case
      when position(' ' in full_name) > 0 then trim(substr(full_name, position(' ' in full_name) + 1))
      else ''
    end
  );

  insert into public.profiles (id, client_id, first_name, last_name, role, is_active)
  values (
    new.id,
    target_client_id,
    first_name_value,
    last_name_value,
    case when derived_slug = 'boot360' then 'owner' else 'viewer' end,
    true
  )
  on conflict (id) do update
  set client_id = excluded.client_id,
      first_name = coalesce(public.profiles.first_name, excluded.first_name),
      last_name = coalesce(public.profiles.last_name, excluded.last_name),
      role = case
        when public.profiles.role is null or public.profiles.role = 'viewer' then excluded.role
        else public.profiles.role
      end,
      is_active = true;

  return new;
end;
$$;

drop trigger if exists on_auth_user_profile_created on auth.users;

create trigger on_auth_user_profile_created
after insert on auth.users
for each row execute function public.handle_new_user();
