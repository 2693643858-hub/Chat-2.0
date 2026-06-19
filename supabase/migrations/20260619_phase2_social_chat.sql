create schema if not exists private;

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-attachments', 'chat-attachments', false, 52428800)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

alter table public.profiles
  drop constraint if exists profiles_status_check;
alter table public.profiles
  add constraint profiles_status_check check (status in ('online', 'away', 'offline', 'dnd'));
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

create table if not exists public.message_actions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  hidden boolean not null default false,
  favorited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists conversations_owner_idx on public.conversations (owner_id);
create index if not exists message_actions_user_idx on public.message_actions (user_id);

revoke all on public.message_actions from anon, authenticated;
grant update (display_name, avatar, status, bio, gender, birthday, homepage, privacy, updated_at)
  on public.profiles to authenticated;
grant update (title, avatar, description, announcement, settings, updated_at)
  on public.conversations to authenticated;
grant update (nickname, last_read_message_id, last_read_at, pinned, muted_until, archived)
  on public.conversation_members to authenticated;
grant update (recalled_at, metadata) on public.messages to authenticated;
grant select, insert, update, delete on public.message_actions to authenticated;

drop trigger if exists conversations_touch_updated_at on public.conversations;
create trigger conversations_touch_updated_at
before update on public.conversations
for each row execute function public.touch_updated_at();

drop trigger if exists message_actions_touch_updated_at on public.message_actions;
create trigger message_actions_touch_updated_at
before update on public.message_actions
for each row execute function public.touch_updated_at();

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

revoke all on function public.create_group_conversation(text, uuid[]) from public, anon, authenticated;
revoke all on function private.can_manage_conversation(uuid) from public, anon, authenticated;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;
grant execute on function private.can_manage_conversation(uuid) to authenticated;

alter table public.message_actions enable row level security;

drop policy if exists "Conversation managers can update conversations" on public.conversations;
create policy "Conversation managers can update conversations"
on public.conversations for update
to authenticated
using (private.can_manage_conversation(id))
with check (private.can_manage_conversation(id));

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

do $$
begin
  alter publication supabase_realtime add table public.message_actions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
