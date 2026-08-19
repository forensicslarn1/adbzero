-- ADBZero CMS core schema
-- Apply this file in Supabase SQL Editor or with `supabase db push`.
-- This migration intentionally uses app_metadata.role = 'admin' for admin authorization.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table if not exists public.cms_contents (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  content_type text not null check (content_type in ('page', 'news', 'tutorial')),
  visibility text not null default 'public' check (visibility in ('public', 'authenticated', 'admin_private')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  publish_at timestamptz null,
  is_homepage boolean not null default false,
  featured_media_id uuid null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists cms_contents_single_homepage_idx
  on public.cms_contents (is_homepage)
  where is_homepage = true;

create index if not exists cms_contents_public_listing_idx
  on public.cms_contents (content_type, status, visibility, publish_at desc);

create table if not exists public.cms_content_i18n (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.cms_contents(id) on delete cascade,
  language text not null,
  title text not null,
  excerpt text null,
  body_json jsonb null,
  body_html text not null default '<p></p>',
  seo_title text null,
  seo_description text null,
  seo_keywords text null,
  seo_canonical_url text null,
  og_title text null,
  og_description text null,
  og_image_media_id uuid null,
  twitter_title text null,
  twitter_description text null,
  ai_summary text null,
  json_ld jsonb null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint cms_content_i18n_language_check check (language ~ '^[a-z]{2}$'),
  constraint cms_content_i18n_unique_language unique (content_id, language)
);

create index if not exists cms_content_i18n_language_idx
  on public.cms_content_i18n (language, content_id);

create table if not exists public.cms_taxonomies (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  taxonomy_type text not null check (taxonomy_type in ('category', 'tag')),
  name_i18n jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.cms_content_taxonomies (
  content_id uuid not null references public.cms_contents(id) on delete cascade,
  taxonomy_id uuid not null references public.cms_taxonomies(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (content_id, taxonomy_id)
);

create index if not exists cms_content_taxonomies_taxonomy_idx
  on public.cms_content_taxonomies (taxonomy_id, content_id);

create table if not exists public.cms_revisions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null references public.cms_contents(id) on delete cascade,
  language text not null,
  revision_number integer not null check (revision_number > 0),
  body_json jsonb null,
  body_html text null,
  change_note text null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (content_id, language, revision_number)
);

create table if not exists public.cms_media_assets (
  id uuid primary key default gen_random_uuid(),
  bucket text not null default 'cms-media',
  storage_path text not null unique,
  media_type text not null check (media_type in ('image', 'video', 'audio', 'document')),
  mime_type text not null,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  checksum_sha256 text null,
  width integer null,
  height integer null,
  duration_seconds numeric null,
  title_i18n jsonb not null default '{}'::jsonb,
  alt_i18n jsonb not null default '{}'::jsonb,
  caption_i18n jsonb not null default '{}'::jsonb,
  credit_i18n jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Supabase Storage bucket used by the CMS media workflow.
insert into storage.buckets (id, name, public)
values ('cms-media', 'cms-media', false)
on conflict (id) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.cms_resolve_slug_access(p_slug text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when c.id is null then 'not_found'
    when c.status <> 'published' then case when public.is_admin() then 'public' else 'not_found' end
    when c.publish_at is not null and c.publish_at > timezone('utc', now()) then 'not_found'
    when c.visibility = 'public' then 'public'
    when c.visibility = 'authenticated' and auth.uid() is not null then 'public'
    when c.visibility = 'authenticated' then 'auth_required'
    when c.visibility = 'admin_private' and public.is_admin() then 'public'
    else 'forbidden'
  end
  from public.cms_contents c
  where c.slug = trim(p_slug)
  limit 1;
$$;

grant execute on function public.cms_resolve_slug_access(text) to anon, authenticated;

-- Keep timestamps consistent for all CMS edits.
drop trigger if exists cms_contents_set_updated_at on public.cms_contents;
create trigger cms_contents_set_updated_at
before update on public.cms_contents
for each row execute function public.set_updated_at();

drop trigger if exists cms_content_i18n_set_updated_at on public.cms_content_i18n;
create trigger cms_content_i18n_set_updated_at
before update on public.cms_content_i18n
for each row execute function public.set_updated_at();

drop trigger if exists cms_taxonomies_set_updated_at on public.cms_taxonomies;
create trigger cms_taxonomies_set_updated_at
before update on public.cms_taxonomies
for each row execute function public.set_updated_at();

drop trigger if exists cms_media_assets_set_updated_at on public.cms_media_assets;
create trigger cms_media_assets_set_updated_at
before update on public.cms_media_assets
for each row execute function public.set_updated_at();

alter table public.cms_contents enable row level security;
alter table public.cms_content_i18n enable row level security;
alter table public.cms_taxonomies enable row level security;
alter table public.cms_content_taxonomies enable row level security;
alter table public.cms_revisions enable row level security;
alter table public.cms_media_assets enable row level security;

-- Public and authenticated readers can only see content that is currently publishable.
drop policy if exists cms_contents_public_read on public.cms_contents;
create policy cms_contents_public_read
on public.cms_contents for select
using (
  public.is_admin()
  or (
    status = 'published'
    and (publish_at is null or publish_at <= timezone('utc', now()))
    and (
      visibility = 'public'
      or (visibility = 'authenticated' and auth.uid() is not null)
    )
  )
);

drop policy if exists cms_contents_admin_insert on public.cms_contents;
create policy cms_contents_admin_insert
on public.cms_contents for insert to authenticated
with check (public.is_admin());

drop policy if exists cms_contents_admin_update on public.cms_contents;
create policy cms_contents_admin_update
on public.cms_contents for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists cms_contents_admin_delete on public.cms_contents;
create policy cms_contents_admin_delete
on public.cms_contents for delete to authenticated
using (public.is_admin());

-- Translation rows follow the visibility of their parent content.
drop policy if exists cms_content_i18n_read on public.cms_content_i18n;
create policy cms_content_i18n_read
on public.cms_content_i18n for select
using (
  exists (
    select 1 from public.cms_contents c
    where c.id = content_id
      and (
        public.is_admin()
        or (
          c.status = 'published'
          and (c.publish_at is null or c.publish_at <= timezone('utc', now()))
          and (c.visibility = 'public' or (c.visibility = 'authenticated' and auth.uid() is not null))
        )
      )
  )
);

drop policy if exists cms_content_i18n_admin_insert on public.cms_content_i18n;
create policy cms_content_i18n_admin_insert
on public.cms_content_i18n for insert to authenticated
with check (public.is_admin());

drop policy if exists cms_content_i18n_admin_update on public.cms_content_i18n;
create policy cms_content_i18n_admin_update
on public.cms_content_i18n for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists cms_content_i18n_admin_delete on public.cms_content_i18n;
create policy cms_content_i18n_admin_delete
on public.cms_content_i18n for delete to authenticated
using (public.is_admin());

-- Taxonomy names are safe to expose publicly; only admins can change them.
drop policy if exists cms_taxonomies_read on public.cms_taxonomies;
create policy cms_taxonomies_read
on public.cms_taxonomies for select
using (true);

drop policy if exists cms_taxonomies_admin_insert on public.cms_taxonomies;
create policy cms_taxonomies_admin_insert
on public.cms_taxonomies for insert to authenticated
with check (public.is_admin());

drop policy if exists cms_taxonomies_admin_update on public.cms_taxonomies;
create policy cms_taxonomies_admin_update
on public.cms_taxonomies for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists cms_taxonomies_admin_delete on public.cms_taxonomies;
create policy cms_taxonomies_admin_delete
on public.cms_taxonomies for delete to authenticated
using (public.is_admin());

drop policy if exists cms_content_taxonomies_read on public.cms_content_taxonomies;
create policy cms_content_taxonomies_read
on public.cms_content_taxonomies for select
using (true);

drop policy if exists cms_content_taxonomies_admin_insert on public.cms_content_taxonomies;
create policy cms_content_taxonomies_admin_insert
on public.cms_content_taxonomies for insert to authenticated
with check (public.is_admin());

drop policy if exists cms_content_taxonomies_admin_delete on public.cms_content_taxonomies;
create policy cms_content_taxonomies_admin_delete
on public.cms_content_taxonomies for delete to authenticated
using (public.is_admin());

-- Revision history and media metadata are private to administrators.
drop policy if exists cms_revisions_admin_all on public.cms_revisions;
create policy cms_revisions_admin_all
on public.cms_revisions for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists cms_media_assets_admin_all on public.cms_media_assets;
create policy cms_media_assets_admin_all
on public.cms_media_assets for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Storage access is also administrator-only. Public article images should be served
-- through the signed URL edge function rather than making the bucket public.
drop policy if exists cms_media_storage_admin_read on storage.objects;
create policy cms_media_storage_admin_read
on storage.objects for select to authenticated
using (bucket_id = 'cms-media' and public.is_admin());

drop policy if exists cms_media_storage_admin_insert on storage.objects;
create policy cms_media_storage_admin_insert
on storage.objects for insert to authenticated
with check (bucket_id = 'cms-media' and public.is_admin());

drop policy if exists cms_media_storage_admin_update on storage.objects;
create policy cms_media_storage_admin_update
on storage.objects for update to authenticated
using (bucket_id = 'cms-media' and public.is_admin())
with check (bucket_id = 'cms-media' and public.is_admin());

drop policy if exists cms_media_storage_admin_delete on storage.objects;
create policy cms_media_storage_admin_delete
on storage.objects for delete to authenticated
using (bucket_id = 'cms-media' and public.is_admin());

grant select on public.cms_contents, public.cms_content_i18n, public.cms_taxonomies, public.cms_content_taxonomies to anon, authenticated;
grant all on public.cms_contents, public.cms_content_i18n, public.cms_taxonomies, public.cms_content_taxonomies, public.cms_revisions, public.cms_media_assets to authenticated;
Add CMS core schema and RLS policies

