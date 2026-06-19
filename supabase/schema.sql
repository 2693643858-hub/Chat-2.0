create extension if not exists pgcrypto;
create schema if not exists private;

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-attachments', 'chat-attachments', false, 52428800)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(trim(display_name)) between 1 and 32),
  avatar text not null check (char_length(trim(avatar)) between 1 and 8),
  status text not null default 'offline' check (status in ('online', 'away', 'offline', 'dnd')),
  bio text not null default '' check (char_length(bio) <= 160),
  gender text not null default 'unspecified' check (gender in ('unspecified', 'female', 'male', 'nonbinary')),
  birthday date,
  homepage text not null default '' check (char_length(homepage) <= 180),
  phone text,
  privacy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null,
  addressee_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_requester_id_fkey foreign key (requester_id) references public.profiles(id) on delete cascade,
  constraint friendships_addressee_id_fkey foreign key (addressee_id) references public.profiles(id) on delete cascade,
  constraint friendships_no_self check (requester_id <> addressee_id)
);

create unique index if not exists friendships_unique_pair_idx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'direct' check (type in ('direct', 'group')),
  title text not null default '',
  avatar text not null default '',
  description text not null default '',
  announcement text not null default '',
  owner_id uuid references public.profiles(id) on delete set null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  nickname text not null default '',
  last_read_message_id uuid,
  last_read_at timestamptz,
  pinned boolean not null default false,
  muted_until timestamptz,
  archived boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(trim(text)) between 1 and 2000),
  type text not null default 'text' check (type in ('text', 'image', 'file', 'audio', 'video', 'system')),
  attachment_path text,
  attachment_name text,
  attachment_size bigint,
  attachment_mime text,
  metadata jsonb not null default '{}'::jsonb,
  edited_at timestamptz,
  recalled_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.message_actions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  hidden boolean not null default false,
  favorited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

create index if not exists friendships_requester_idx
  on public.friendships (requester_id);

create index if not exists friendships_addressee_idx
  on public.friendships (addressee_id);

create index if not exists messages_sender_idx
  on public.messages (sender_id);

create index if not exists message_actions_user_idx
  on public.message_actions (user_id);

do $$
begin
  alter table public.profiles
    drop constraint if exists profiles_status_check;
  alter table public.profiles
    add constraint profiles_status_check check (status in ('online', 'away', 'offline', 'dnd'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.profiles
    add column if not exists bio text not null default '';
  alter table public.profiles
    add column if not exists gender text not null default 'unspecified';
  alter table public.profiles
    add column if not exists birthday date;
  alter table public.profiles
    add column if not exists homepage text not null default '';
  alter table public.profiles
    add column if not exists phone text;
  alter table public.profiles
    add column if not exists privacy jsonb not null default '{}'::jsonb;
  alter table public.profiles
    drop constraint if exists profiles_bio_length;
  alter table public.profiles
    add constraint profiles_bio_length check (char_length(bio) <= 160);
  alter table public.profiles
    drop constraint if exists profiles_gender_check;
  alter table public.profiles
    add constraint profiles_gender_check check (gender in ('unspecified', 'female', 'male', 'nonbinary'));
  alter table public.profiles
    drop constraint if exists profiles_homepage_length;
  alter table public.profiles
    add constraint profiles_homepage_length check (char_length(homepage) <= 180);
end $$;

do $$
begin
  alter table public.conversations
    drop constraint if exists conversations_type_check;
  alter table public.conversations
    add constraint conversations_type_check check (type in ('direct', 'group'));
  alter table public.conversations
    add column if not exists title text not null default '';
  alter table public.conversations
    add column if not exists avatar text not null default '';
  alter table public.conversations
    add column if not exists description text not null default '';
  alter table public.conversations
    add column if not exists announcement text not null default '';
  alter table public.conversations
    add column if not exists owner_id uuid references public.profiles(id) on delete set null;
  alter table public.conversations
    add column if not exists settings jsonb not null default '{}'::jsonb;
  alter table public.conversations
    add column if not exists updated_at timestamptz not null default now();
end $$;

create index if not exists conversations_owner_idx
  on public.conversations (owner_id);

do $$
begin
  alter table public.conversation_members
    add column if not exists role text not null default 'member';
  alter table public.conversation_members
    add column if not exists nickname text not null default '';
  alter table public.conversation_members
    add column if not exists muted_until timestamptz;
  alter table public.conversation_members
    add column if not exists archived boolean not null default false;
  alter table public.conversation_members
    add column if not exists joined_at timestamptz not null default now();
  alter table public.conversation_members
    drop constraint if exists conversation_members_role_check;
  alter table public.conversation_members
    add constraint conversation_members_role_check check (role in ('owner', 'admin', 'member'));
end $$;

do $$
begin
  alter table public.messages
    add column if not exists type text not null default 'text';
  alter table public.messages
    add column if not exists attachment_path text;
  alter table public.messages
    add column if not exists attachment_name text;
  alter table public.messages
    add column if not exists attachment_size bigint;
  alter table public.messages
    add column if not exists attachment_mime text;
  alter table public.messages
    add column if not exists metadata jsonb not null default '{}'::jsonb;
  alter table public.messages
    add column if not exists edited_at timestamptz;
  alter table public.messages
    add column if not exists recalled_at timestamptz;
  alter table public.messages
    drop constraint if exists messages_type_check;
  alter table public.messages
    add constraint messages_type_check check (type in ('text', 'image', 'file', 'audio', 'video', 'system'));
end $$;

do $$
begin
  alter table public.profiles
    add constraint profiles_username_format check (username ~ '^[a-z0-9_]{3,24}$');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.profiles
    add constraint profiles_display_name_length check (char_length(trim(display_name)) between 1 and 32);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.profiles
    add constraint profiles_avatar_length check (char_length(trim(avatar)) between 1 and 8);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.messages
    add constraint messages_text_length check (char_length(trim(text)) between 1 and 2000);
exception
  when duplicate_object then null;
end $$;

revoke all on public.profiles from anon, authenticated;
revoke all on public.friendships from anon, authenticated;
revoke all on public.conversations from anon, authenticated;
revoke all on public.conversation_members from anon, authenticated;
revoke all on public.messages from anon, authenticated;
revoke all on public.message_actions from anon, authenticated;

grant usage on schema public to anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant update (display_name, avatar, status, bio, gender, birthday, homepage, privacy, updated_at) on public.profiles to authenticated;
grant select, insert, delete on public.friendships to authenticated;
grant update (status, updated_at) on public.friendships to authenticated;
grant select on public.conversations to authenticated;
grant update (title, avatar, description, announcement, settings, updated_at) on public.conversations to authenticated;
grant select on public.conversation_members to authenticated;
grant update (nickname, last_read_message_id, last_read_at, pinned, muted_until, archived) on public.conversation_members to authenticated;
grant select, insert on public.messages to authenticated;
grant update (recalled_at, metadata) on public.messages to authenticated;
grant select, insert, update, delete on public.message_actions to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists friendships_touch_updated_at on public.friendships;
create trigger friendships_touch_updated_at
before update on public.friendships
for each row execute function public.touch_updated_at();

drop trigger if exists conversations_touch_updated_at on public.conversations;
create trigger conversations_touch_updated_at
before update on public.conversations
for each row execute function public.touch_updated_at();

drop trigger if exists message_actions_touch_updated_at on public.message_actions;
create trigger message_actions_touch_updated_at
before update on public.message_actions
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_username text;
  fallback_username text;
  fallback_display_name text;
begin
  requested_username := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'username', ''), '[^a-z0-9_]+', '', 'g'));
  fallback_username := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_]+', '', 'g'));
  fallback_display_name := left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), fallback_username, 'New User'), 32);

  if fallback_username !~ '^[a-z0-9_]{3,24}$' then
    fallback_username := 'user_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  if requested_username !~ '^[a-z0-9_]{3,24}$' then
    requested_username := fallback_username;
  end if;

  insert into public.profiles (id, username, display_name, avatar)
  values (
    new.id,
    requested_username,
    fallback_display_name,
    left(coalesce(nullif(trim(new.raw_user_meta_data->>'avatar'), ''), upper(left(fallback_display_name, 2))), 8)
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.create_direct_conversation(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  conversation_id uuid;
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if other_user_id = current_user_id then
    raise exception 'Cannot chat with yourself';
  end if;

  if not exists (
    select 1
    from public.friendships
    where status = 'accepted'
      and (
        (requester_id = current_user_id and addressee_id = other_user_id)
        or (requester_id = other_user_id and addressee_id = current_user_id)
      )
  ) then
    raise exception 'Add this user as a friend before chatting';
  end if;

  select c.id into conversation_id
  from public.conversations c
  join public.conversation_members cm1 on cm1.conversation_id = c.id
  join public.conversation_members cm2 on cm2.conversation_id = c.id
  where c.type = 'direct'
    and cm1.user_id = current_user_id
    and cm2.user_id = other_user_id
  limit 1;

  if conversation_id is null then
    insert into public.conversations (type)
    values ('direct')
    returning id into conversation_id;

    insert into public.conversation_members (conversation_id, user_id, last_read_at)
    values
      (conversation_id, current_user_id, now()),
      (conversation_id, other_user_id, now());
  end if;

  return conversation_id;
end;
$$;

create or replace function public.create_group_conversation(group_title text, member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  conversation_id uuid;
  clean_title text := left(trim(coalesce(group_title, '')), 48);
  member_id uuid;
  unique_member_ids uuid[];
begin
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if clean_title = '' then
    raise exception 'Group name is required';
  end if;

  select array_agg(distinct id) into unique_member_ids
  from unnest(coalesce(member_ids, array[]::uuid[])) as id
  where id <> current_user_id;

  if coalesce(array_length(unique_member_ids, 1), 0) = 0 then
    raise exception 'Select at least one friend';
  end if;

  foreach member_id in array unique_member_ids loop
    if not exists (
      select 1
      from public.friendships
      where status = 'accepted'
        and (
          (requester_id = current_user_id and addressee_id = member_id)
          or (requester_id = member_id and addressee_id = current_user_id)
        )
    ) then
      raise exception 'Group members must be accepted friends';
    end if;
  end loop;

  insert into public.conversations (type, title, avatar, owner_id)
  values ('group', clean_title, upper(left(clean_title, 2)), current_user_id)
  returning id into conversation_id;

  insert into public.conversation_members (conversation_id, user_id, role, last_read_at)
  values (conversation_id, current_user_id, 'owner', now());

  foreach member_id in array unique_member_ids loop
    insert into public.conversation_members (conversation_id, user_id, role, last_read_at)
    values (conversation_id, member_id, 'member', now())
    on conflict (conversation_id, user_id) do nothing;
  end loop;

  insert into public.messages (conversation_id, sender_id, type, text, metadata)
  values (
    conversation_id,
    current_user_id,
    'system',
    '群聊已创建',
    jsonb_build_object('event', 'group_created')
  );

  return conversation_id;
end;
$$;

create or replace function private.is_conversation_member(target_conversation_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_members cm
    where cm.conversation_id = target_conversation_id
      and cm.user_id = (select auth.uid())
  );
$$;

create or replace function private.can_manage_conversation(target_conversation_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_members cm
    where cm.conversation_id = target_conversation_id
      and cm.user_id = (select auth.uid())
      and cm.role in ('owner', 'admin')
  );
$$;

grant usage on schema private to authenticated;

revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.create_direct_conversation(uuid) from public, anon, authenticated;
revoke all on function public.create_group_conversation(text, uuid[]) from public, anon, authenticated;
revoke all on function private.is_conversation_member(uuid) from public, anon, authenticated;
revoke all on function private.can_manage_conversation(uuid) from public, anon, authenticated;
grant execute on function public.create_direct_conversation(uuid) to authenticated;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;
grant execute on function private.is_conversation_member(uuid) to authenticated;
grant execute on function private.can_manage_conversation(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_actions enable row level security;

drop policy if exists "Profiles are readable" on public.profiles;
create policy "Profiles are readable"
on public.profiles for select
using (true);

drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
on public.profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists "Friendships are visible to participants" on public.friendships;
create policy "Friendships are visible to participants"
on public.friendships for select
to authenticated
using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));

drop policy if exists "Users can request friendships" on public.friendships;
create policy "Users can request friendships"
on public.friendships for insert
to authenticated
with check (requester_id = (select auth.uid()) and status = 'pending');

drop policy if exists "Users can accept incoming friendships" on public.friendships;
create policy "Users can accept incoming friendships"
on public.friendships for update
to authenticated
using (addressee_id = (select auth.uid()))
with check (addressee_id = (select auth.uid()) and status = 'accepted');

drop policy if exists "Users can delete their friendships" on public.friendships;
create policy "Users can delete their friendships"
on public.friendships for delete
to authenticated
using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));

drop policy if exists "Conversation members can read conversations" on public.conversations;
create policy "Conversation members can read conversations"
on public.conversations for select
to authenticated
using (private.is_conversation_member(id));

drop policy if exists "Conversation managers can update conversations" on public.conversations;
create policy "Conversation managers can update conversations"
on public.conversations for update
to authenticated
using (private.can_manage_conversation(id))
with check (private.can_manage_conversation(id));

drop policy if exists "Conversation members can read member rows" on public.conversation_members;
create policy "Conversation members can read member rows"
on public.conversation_members for select
to authenticated
using (private.is_conversation_member(conversation_id));

drop policy if exists "Users can update own read state" on public.conversation_members;
create policy "Users can update own read state"
on public.conversation_members for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "Conversation members can read messages" on public.messages;
create policy "Conversation members can read messages"
on public.messages for select
to authenticated
using (private.is_conversation_member(conversation_id));

drop policy if exists "Conversation members can send messages" on public.messages;
create policy "Conversation members can send messages"
on public.messages for insert
to authenticated
with check (
  sender_id = (select auth.uid())
  and private.is_conversation_member(conversation_id)
);

drop policy if exists "Users can recall own messages" on public.messages;
create policy "Users can recall own messages"
on public.messages for update
to authenticated
using (sender_id = (select auth.uid()))
with check (sender_id = (select auth.uid()));

drop policy if exists "Users can read own message actions" on public.message_actions;
create policy "Users can read own message actions"
on public.message_actions for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "Users can create own message actions" on public.message_actions;
create policy "Users can create own message actions"
on public.message_actions for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists "Users can update own message actions" on public.message_actions;
create policy "Users can update own message actions"
on public.message_actions for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete own message actions" on public.message_actions;
create policy "Users can delete own message actions"
on public.message_actions for delete
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "Authenticated users can read chat attachments" on storage.objects;
create policy "Authenticated users can read chat attachments"
on storage.objects for select
to authenticated
using (bucket_id = 'chat-attachments');

drop policy if exists "Users can upload own chat attachments" on storage.objects;
create policy "Users can upload own chat attachments"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can update own chat attachments" on storage.objects;
create policy "Users can update own chat attachments"
on storage.objects for update
to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can delete own chat attachments" on storage.objects;
create policy "Users can delete own chat attachments"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'chat-attachments'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop function if exists public.is_conversation_member(uuid);

do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.friendships;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.conversation_members;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.message_actions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
