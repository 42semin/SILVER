-- ============================================================
--  가족 그룹 · 결과 공유 링크 · 문자 전송 — 표 + 권한 + 보안
--
--  [쓰는 법]
--   Supabase 대시보드 → SQL Editor → New query →
--   이 파일 내용을 전부 붙여넣고 RUN
--   (권한설정.sql, 내정보저장_권한.sql 을 먼저 실행해 둔 상태여야 합니다)
--
--  여러 번 실행해도 안전하게 만들어 두었습니다.
--
--  [설계 원칙]
--   1) 표에 직접 쓰는 권한은 주지 않고, 꼭 필요한 일만 함수(RPC)로 엽니다.
--      함수 안에서 "이 사람이 그 가족의 구성원인가"를 먼저 따집니다.
--   2) 가족끼리 읽을 수 있는 것은 '읽기(select)'뿐입니다. 남의 정보를 고치지 못합니다.
--   3) 전화번호는 이 데이터베이스에 '암호문'으로만 들어옵니다.
--      암호화·복호화는 Edge Function(supabase/functions/sms)이 하고,
--      암호 키는 데이터베이스가 아니라 Edge Function 비밀값(Secrets)에 따로 둡니다.
--      → DB 가 통째로 새어 나가도 키 없이는 번호를 읽을 수 없습니다.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

grant usage on schema public to anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- 1) 회원 아이디 (가족을 '아이디로 직접 추가' 할 때 쓰는 이름)
--    이메일을 서로 보여 주지 않으려고 따로 아이디를 둡니다.
-- ────────────────────────────────────────────────────────────
create table if not exists public.member_profile (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  handle       text not null unique check (handle ~ '^[a-z0-9_]{4,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 20),
  updated_at   timestamptz not null default now()
);

alter table public.member_profile enable row level security;
revoke all on public.member_profile from anon;
grant select, insert, update, delete on public.member_profile to authenticated;


-- ────────────────────────────────────────────────────────────
-- 2) 가족 그룹 · 구성원 · 아이디로 보낸 요청 · 초대 링크
-- ────────────────────────────────────────────────────────────
create table if not exists public.family_groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 30),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  group_id  uuid not null references public.family_groups(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists family_members_user_idx on public.family_members (user_id);

-- 아이디로 추가하면 바로 들어가지 않고 '요청'이 갑니다.
-- 가족이 되면 서로의 건강·소득 답을 볼 수 있으므로, 받는 분이 수락해야 합니다.
create table if not exists public.family_requests (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.family_groups(id) on delete cascade,
  invitee_id uuid not null references auth.users(id) on delete cascade,
  inviter_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (group_id, invitee_id)
);

-- 초대 링크: 링크를 연 사람이 로그인 후 '합류하기'를 눌러야 들어갑니다.
create table if not exists public.family_invites (
  token      text primary key,
  group_id   uuid not null references public.family_groups(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_uses   int  not null default 5,
  uses       int  not null default 0
);

alter table public.family_groups   enable row level security;
alter table public.family_members  enable row level security;
alter table public.family_requests enable row level security;
alter table public.family_invites  enable row level security;

-- 표에 직접 쓰기는 막고(읽기만), 바꾸는 일은 아래 함수로만 합니다.
revoke all on public.family_groups, public.family_members,
              public.family_requests, public.family_invites from anon, authenticated;
grant select on public.family_groups, public.family_members,
                public.family_requests, public.family_invites to authenticated;


-- ────────────────────────────────────────────────────────────
-- 3) 결과 공유 링크 — 비회원·회원 모두 만들 수 있고, 링크만 있으면 로그인 없이 봅니다
--    token 은 추측할 수 없는 128비트 난수입니다.
-- ────────────────────────────────────────────────────────────
create table if not exists public.shared_results (
  token       text primary key,
  owner_id    uuid references auth.users(id) on delete cascade,   -- 비회원이면 null
  data        jsonb not null,
  manage_hash text,                                                -- 비회원이 지울 때 쓰는 열쇠의 해시
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists shared_results_owner_idx on public.shared_results (owner_id);

alter table public.shared_results enable row level security;
revoke all on public.shared_results from anon, authenticated;
grant select on public.shared_results to authenticated;          -- 내가 만든 링크 목록 보기용


-- ────────────────────────────────────────────────────────────
-- 4) 전화번호 (암호문) · 인증번호 · 문자 발송 기록
--    이 세 표는 브라우저(anon/authenticated)에서 아예 손댈 수 없습니다.
--    Edge Function 이 service_role 로만 읽고 씁니다.
-- ────────────────────────────────────────────────────────────
create table if not exists public.member_phones (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  phone_enc        text not null,   -- "키번호.IV.암호문" (AES-256-GCM, Edge Function 이 만듦)
  phone_hash       text not null,   -- HMAC-SHA256 (발송 횟수 제한용, 별도 키)
  last4            text not null check (last4 ~ '^[0-9]{4}$'),
  allow_family_sms boolean not null default true,
  verified_at      timestamptz not null default now()
);

create table if not exists public.phone_verifications (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  phone_enc  text not null,
  phone_hash text not null,
  last4      text not null,
  code_hash  text not null,
  attempts   int  not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sms_log (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('otp', 'share')),
  phone_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists sms_log_user_idx  on public.sms_log (user_id, created_at);
create index if not exists sms_log_phone_idx on public.sms_log (phone_hash, created_at);

alter table public.member_phones       enable row level security;
alter table public.phone_verifications enable row level security;
alter table public.sms_log             enable row level security;
revoke all on public.member_phones, public.phone_verifications, public.sms_log
  from anon, authenticated;
-- (정책을 하나도 만들지 않으므로 service_role 외에는 읽을 수 없습니다)


-- ────────────────────────────────────────────────────────────
-- 5) 도우미 함수
-- ────────────────────────────────────────────────────────────

-- 추측할 수 없는 링크용 토큰 (16바이트 난수 → base64url 22자)
create or replace function public._random_token()
returns text language sql volatile set search_path = '' as $$
  select rtrim(translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/', '-_'), '=');
$$;
revoke all on function public._random_token() from public, anon, authenticated;

-- 내가 이 그룹의 구성원인가
create or replace function public.is_group_member(p_group uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.family_members
                 where group_id = p_group and user_id = auth.uid());
$$;

-- 이 사람이 나와 같은 가족 그룹에 있는가
-- (security definer 로 family_members 의 RLS 를 건너뛰어 정책이 서로를 부르는 무한 반복을 막습니다)
create or replace function public.is_my_family(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.family_members a
    join public.family_members b on b.group_id = a.group_id
    where a.user_id = auth.uid() and b.user_id = p_user and p_user <> auth.uid());
$$;

revoke all on function public.is_group_member(uuid), public.is_my_family(uuid) from public, anon;
grant execute on function public.is_group_member(uuid), public.is_my_family(uuid) to authenticated;


-- ────────────────────────────────────────────────────────────
-- 6) 읽기 정책
-- ────────────────────────────────────────────────────────────
drop policy if exists "내 아이디" on public.member_profile;
create policy "내 아이디" on public.member_profile for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "가족 아이디 보기" on public.member_profile;
create policy "가족 아이디 보기" on public.member_profile for select to authenticated
  using (public.is_my_family(user_id));

drop policy if exists "내 그룹" on public.family_groups;
create policy "내 그룹" on public.family_groups for select to authenticated
  using (public.is_group_member(id));

drop policy if exists "내 그룹 구성원" on public.family_members;
create policy "내 그룹 구성원" on public.family_members for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "나에게 온 요청 / 우리 그룹 요청" on public.family_requests;
create policy "나에게 온 요청 / 우리 그룹 요청" on public.family_requests for select to authenticated
  using (invitee_id = auth.uid() or public.is_group_member(group_id));

drop policy if exists "우리 그룹 초대 링크" on public.family_invites;
create policy "우리 그룹 초대 링크" on public.family_invites for select to authenticated
  using (public.is_group_member(group_id));

drop policy if exists "내가 만든 공유 링크" on public.shared_results;
create policy "내가 만든 공유 링크" on public.shared_results for select to authenticated
  using (owner_id = auth.uid());

-- ★ 가족끼리 서로의 설문 답·별표·내 기록을 '읽기만' 할 수 있게 합니다.
--   기존 "내 정보만 / 내 즐겨찾기만 / 내 기록만" 정책(for all)은 그대로 두고,
--   select 정책을 하나 더 얹습니다. (정책은 OR 로 합쳐집니다)
drop policy if exists "가족은 읽기" on public.profile_info;
create policy "가족은 읽기" on public.profile_info for select to authenticated
  using (public.is_my_family(user_id));

drop policy if exists "가족은 읽기" on public.favorites;
create policy "가족은 읽기" on public.favorites for select to authenticated
  using (public.is_my_family(user_id));

drop policy if exists "가족은 읽기" on public.welfare_status;
create policy "가족은 읽기" on public.welfare_status for select to authenticated
  using (public.is_my_family(user_id));


-- ────────────────────────────────────────────────────────────
-- 7) 가족 그룹 함수 (RPC)
-- ────────────────────────────────────────────────────────────

-- 새 그룹 만들기 — 만든 사람이 owner 가 됩니다
create or replace function public.create_family_group(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'login_required'; end if;
  if (select count(*) from public.family_members where user_id = v_uid) >= 5 then
    raise exception 'too_many_groups';
  end if;
  insert into public.family_groups (name, created_by)
  values (coalesce(nullif(btrim(p_name), ''), '우리 가족'), v_uid)
  returning id into v_id;
  insert into public.family_members (group_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
end $$;

-- 아이디로 가족 추가 요청 — 받는 분이 수락해야 들어옵니다. 받는 분의 이름을 돌려줍니다.
create or replace function public.request_family_member(p_group uuid, p_handle text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_target uuid; v_name text;
begin
  if v_uid is null then raise exception 'login_required'; end if;
  if not public.is_group_member(p_group) then raise exception 'not_member'; end if;
  select user_id, display_name into v_target, v_name
    from public.member_profile where handle = lower(btrim(p_handle));
  if v_target is null then raise exception 'no_such_id'; end if;
  if v_target = v_uid then raise exception 'self'; end if;
  if exists (select 1 from public.family_members where group_id = p_group and user_id = v_target) then
    raise exception 'already_member';
  end if;
  if (select count(*) from public.family_members where group_id = p_group) >= 20 then
    raise exception 'group_full';
  end if;
  insert into public.family_requests (group_id, invitee_id, inviter_id)
  values (p_group, v_target, v_uid)
  on conflict (group_id, invitee_id) do update set inviter_id = excluded.inviter_id, created_at = now();
  return v_name;
end $$;

-- 받은 요청에 답하기
create or replace function public.respond_family_request(p_request uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_group uuid;
begin
  select group_id into v_group from public.family_requests
   where id = p_request and invitee_id = v_uid;
  if v_group is null then raise exception 'no_such_request'; end if;
  if p_accept then
    insert into public.family_members (group_id, user_id) values (v_group, v_uid)
    on conflict do nothing;
  end if;
  delete from public.family_requests where id = p_request;
end $$;

-- 초대 링크 만들기 — 3일 동안, 5명까지
create or replace function public.create_family_invite(p_group uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text := public._random_token();
begin
  if not public.is_group_member(p_group) then raise exception 'not_member'; end if;
  delete from public.family_invites where expires_at < now();
  insert into public.family_invites (token, group_id, created_by, expires_at)
  values (v_token, p_group, auth.uid(), now() + interval '3 days');
  return v_token;
end $$;

-- 초대 링크 미리 보기 — 로그인 전에도 "누가 어느 가족에 초대했는지"만 보여 줍니다
create or replace function public.peek_family_invite(p_token text)
returns table (group_name text, inviter_name text)
language sql stable security definer set search_path = '' as $$
  select g.name, coalesce(mp.display_name, '가족')
    from public.family_invites i
    join public.family_groups g on g.id = i.group_id
    left join public.member_profile mp on mp.user_id = i.created_by
   where i.token = p_token and i.expires_at > now() and i.uses < i.max_uses;
$$;

-- 초대 링크로 합류하기
create or replace function public.join_family_by_invite(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_inv public.family_invites;
begin
  if v_uid is null then raise exception 'login_required'; end if;
  select * into v_inv from public.family_invites where token = p_token for update;
  if v_inv.token is null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
    raise exception 'invite_invalid';
  end if;
  if exists (select 1 from public.family_members where group_id = v_inv.group_id and user_id = v_uid) then
    return v_inv.group_id;                     -- 이미 들어와 있으면 그대로
  end if;
  if (select count(*) from public.family_members where group_id = v_inv.group_id) >= 20 then
    raise exception 'group_full';
  end if;
  insert into public.family_members (group_id, user_id) values (v_inv.group_id, v_uid);
  update public.family_invites set uses = uses + 1 where token = p_token;
  delete from public.family_requests where group_id = v_inv.group_id and invitee_id = v_uid;
  return v_inv.group_id;
end $$;

-- 그룹 나가기 — owner 가 나가면 가장 먼저 들어온 분이 owner 를 물려받고,
--               아무도 남지 않으면 그룹을 지웁니다
create or replace function public.leave_family_group(p_group uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_role text; v_next uuid;
begin
  delete from public.family_members where group_id = p_group and user_id = v_uid
  returning role into v_role;
  if v_role is null then return; end if;
  if v_role = 'owner' then
    select user_id into v_next from public.family_members
     where group_id = p_group order by joined_at limit 1;
    if v_next is null then
      delete from public.family_groups where id = p_group;
    else
      update public.family_members set role = 'owner' where group_id = p_group and user_id = v_next;
    end if;
  end if;
end $$;

-- 구성원 내보내기 — owner 만
create or replace function public.remove_family_member(p_group uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.family_members
                 where group_id = p_group and user_id = auth.uid() and role = 'owner') then
    raise exception 'owner_only';
  end if;
  if p_user = auth.uid() then raise exception 'self'; end if;
  delete from public.family_members where group_id = p_group and user_id = p_user;
end $$;

-- 마이페이지에 한 번에 그릴 내용: 내 그룹·구성원·받은 요청
-- has_phone: 그 가족이 번호를 등록하고 '가족 문자 받기'를 켜 두었는지 (번호 자체는 주지 않습니다)
create or replace function public.my_family()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.name,
        'my_role', me.role,
        'members', (
          select jsonb_agg(jsonb_build_object(
            'user_id', m.user_id, 'role', m.role, 'is_me', m.user_id = auth.uid(),
            'name', coalesce(p.display_name, '이름 없음'), 'handle', p.handle,
            'has_phone', exists (select 1 from public.member_phones ph
                                 where ph.user_id = m.user_id and ph.allow_family_sms))
            order by m.joined_at)
          from public.family_members m
          left join public.member_profile p on p.user_id = m.user_id
          where m.group_id = g.id)
      ) order by g.created_at)
      from public.family_members me
      join public.family_groups g on g.id = me.group_id
      where me.user_id = auth.uid()), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'group_name', g.name,
        'inviter_name', coalesce(p.display_name, '가족')) order by r.created_at)
      from public.family_requests r
      join public.family_groups g on g.id = r.group_id
      left join public.member_profile p on p.user_id = r.inviter_id
      where r.invitee_id = auth.uid()), '[]'::jsonb)
  );
$$;


-- ────────────────────────────────────────────────────────────
-- 8) 결과 공유 함수 (RPC) — 비회원(anon)도 부를 수 있습니다
-- ────────────────────────────────────────────────────────────

-- 공유 링크 만들기: 회원 30일, 비회원 7일 뒤 자동으로 열리지 않습니다.
-- 비회원은 링크를 지울 때 쓸 manage_key 를 받아 이 기기에 보관합니다.
create or replace function public.create_shared_result(p_data jsonb)
returns table (token text, manage_key text, expires_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_token text := public._random_token();
        v_key text; v_exp timestamptz;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'bad_data'; end if;
  if octet_length(p_data::text) > 4000 then raise exception 'too_large'; end if;
  -- 만료된 링크 청소
  delete from public.shared_results s where s.expires_at < now();
  if v_uid is not null then
    if (select count(*) from public.shared_results s
         where s.owner_id = v_uid and s.created_at > now() - interval '1 day') >= 30 then
      raise exception 'too_many';
    end if;
    v_exp := now() + interval '30 days';
  else
    v_key := public._random_token();
    v_exp := now() + interval '7 days';
  end if;
  insert into public.shared_results (token, owner_id, data, manage_hash, expires_at)
  values (v_token, v_uid, p_data,
          case when v_key is null then null
               else encode(extensions.digest(v_key, 'sha256'), 'hex') end,
          v_exp);
  return query select v_token, v_key, v_exp;
end $$;

-- 공유 링크 열기 — 로그인하지 않아도 됩니다
create or replace function public.get_shared_result(p_token text)
returns table (data jsonb, created_at timestamptz, expires_at timestamptz, sender_name text)
language sql stable security definer set search_path = '' as $$
  select s.data, s.created_at, s.expires_at, p.display_name
    from public.shared_results s
    left join public.member_profile p on p.user_id = s.owner_id
   where s.token = p_token and s.expires_at > now();
$$;

-- 공유 링크 지우기 — 회원은 자기 링크, 비회원은 manage_key 로
create or replace function public.delete_shared_result(p_token text, p_manage_key text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.shared_results s
   where s.token = p_token
     and ((auth.uid() is not null and s.owner_id = auth.uid())
       or (p_manage_key is not null
           and s.manage_hash = encode(extensions.digest(p_manage_key, 'sha256'), 'hex')));
  get diagnostics n = row_count;
  return n > 0;
end $$;


-- ────────────────────────────────────────────────────────────
-- 9) 함수 실행 권한
--    Postgres 는 새 함수를 기본으로 PUBLIC 에게 열어 두므로, 먼저 닫고 필요한 만큼만 엽니다.
-- ────────────────────────────────────────────────────────────
revoke all on function
  public.create_family_group(text),
  public.request_family_member(uuid, text),
  public.respond_family_request(uuid, boolean),
  public.create_family_invite(uuid),
  public.peek_family_invite(text),
  public.join_family_by_invite(text),
  public.leave_family_group(uuid),
  public.remove_family_member(uuid, uuid),
  public.my_family(),
  public.create_shared_result(jsonb),
  public.get_shared_result(text),
  public.delete_shared_result(text, text)
from public, anon, authenticated;

-- 회원만
grant execute on function
  public.create_family_group(text),
  public.request_family_member(uuid, text),
  public.respond_family_request(uuid, boolean),
  public.create_family_invite(uuid),
  public.join_family_by_invite(text),
  public.leave_family_group(uuid),
  public.remove_family_member(uuid, uuid),
  public.my_family()
to authenticated;

-- 비회원도
grant execute on function
  public.peek_family_invite(text),
  public.create_shared_result(jsonb),
  public.get_shared_result(text),
  public.delete_shared_result(text, text)
to anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- 10) 확인
-- ────────────────────────────────────────────────────────────
select tablename as "테이블", policyname as "정책 이름", cmd as "대상"
from pg_policies
where schemaname = 'public'
  and tablename in ('member_profile','family_groups','family_members','family_requests',
                    'family_invites','shared_results','profile_info','favorites','welfare_status')
order by tablename, policyname;
-- 기대: profile_info / favorites / welfare_status 에 '가족은 읽기' 가 하나씩 더 붙어 있어야 합니다.
--       member_phones / phone_verifications / sms_log 는 정책이 없어야 정상입니다(service_role 전용).
