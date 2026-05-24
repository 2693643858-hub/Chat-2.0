create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (char_length(username) >= 3),
  display_name text not null,
  avatar text not null,
  status text not null default 'offline',
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
  type text not null default 'direct' check (type in ('direct')),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  last_read_message_id uuid,
  last_read_at timestamptz,
  pinned boolean not null default false,
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  text text not null check (char_length(trim(text)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

grant usage on schema public to anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant update on public.profiles to authenticated;
grant select, insert, update, delete on public.friendships to authenticated;
grant select on public.conversations to authenticated;
grant select, update on public.conversation_members to authenticated;
grant select, insert on public.messages to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
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

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  fallback_username text;
  fallback_display_name text;
begin
  fallback_username := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_]+', '', 'g'));
  fallback_display_name := coalesce(new.raw_user_meta_data->>'display_name', fallback_username, 'New User');

  insert into public.profiles (id, username, display_name, avatar)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'username', ''), fallback_username),
    fallback_display_name,
    coalesce(nullif(new.raw_user_meta_data->>'avatar', ''), upper(left(fallback_display_name, 2)))
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

create or replace function public.is_conversation_member(target_conversation_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_members cm
    where cm.conversation_id = target_conversation_id
      and cm.user_id = auth.uid()
  );
$$;

grant execute on function public.create_direct_conversation(uuid) to authenticated;
grant execute on function public.is_conversation_member(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Profiles are readable" on public.profiles;
create policy "Profiles are readable"
on public.profiles for select
using (true);

drop policy if exists "Users update own profile" on public.profiles;
create policy "Users update own profile"
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

drop policy if exists "Friendships are visible to participants" on public.friendships;
create policy "Friendships are visible to participants"
on public.friendships for select
to authenticated
using (requester_id = auth.uid() or addressee_id = auth.uid());

drop policy if exists "Users can request friendships" on public.friendships;
create policy "Users can request friendships"
on public.friendships for insert
to authenticated
with check (requester_id = auth.uid() and status = 'pending');

drop policy if exists "Users can accept incoming friendships" on public.friendships;
create policy "Users can accept incoming friendships"
on public.friendships for update
to authenticated
using (addressee_id = auth.uid())
with check (addressee_id = auth.uid() and status = 'accepted');

drop policy if exists "Users can delete their friendships" on public.friendships;
create policy "Users can delete their friendships"
on public.friendships for delete
to authenticated
using (requester_id = auth.uid() or addressee_id = auth.uid());

drop policy if exists "Conversation members can read conversations" on public.conversations;
create policy "Conversation members can read conversations"
on public.conversations for select
to authenticated
using (public.is_conversation_member(id));

drop policy if exists "Conversation members can read member rows" on public.conversation_members;
create policy "Conversation members can read member rows"
on public.conversation_members for select
to authenticated
using (public.is_conversation_member(conversation_id));

drop policy if exists "Users can update own read state" on public.conversation_members;
create policy "Users can update own read state"
on public.conversation_members for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Conversation members can read messages" on public.messages;
create policy "Conversation members can read messages"
on public.messages for select
to authenticated
using (public.is_conversation_member(conversation_id));

drop policy if exists "Conversation members can send messages" on public.messages;
create policy "Conversation members can send messages"
on public.messages for insert
to authenticated
with check (
  sender_id = auth.uid()
  and public.is_conversation_member(conversation_id)
);

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
