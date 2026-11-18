-- ============================================================
--  복지카드 앱 — 테이블 권한 + 보안 설정
--
--  [쓰는 법]
--   Supabase 대시보드 → SQL Editor → New query →
--   이 파일 내용을 전부 붙여넣고 RUN
--
--  여러 번 실행해도 안전하게 만들어 두었습니다.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1) 로그인한 사용자에게 테이블 사용 권한 주기
--
--    지금 콘솔에 뜨는 "permission denied for table favorites" 의
--    직접적인 원인입니다. RLS 정책이 아무리 잘 돼 있어도
--    이 GRANT 가 없으면 PostgreSQL 이 문 앞에서 막습니다.
-- ────────────────────────────────────────────────────────────
grant usage on schema public to authenticated;

grant select, insert, update, delete on public.favorites      to authenticated;
grant select, insert, update, delete on public.welfare_status to authenticated;

-- id 컬럼이 자동 증가(serial / identity) 라면 시퀀스 권한도 필요합니다.
grant usage, select on all sequences in schema public to authenticated;


-- ────────────────────────────────────────────────────────────
-- 2) 비회원(anon) 은 계속 막아 두기
--
--    로그인 안 한 사람이 남의 즐겨찾기를 보면 안 되므로
--    권한을 주지 않습니다. (지금도 막혀 있지만 확실히 해 둡니다)
-- ────────────────────────────────────────────────────────────
revoke all on public.favorites      from anon;
revoke all on public.welfare_status from anon;


-- ────────────────────────────────────────────────────────────
-- 3) 행 수준 보안(RLS) 켜기
--
--    2) 번으로 "로그인한 사람"까지는 걸렀지만,
--    로그인한 사람끼리 서로의 기록을 보는 건 아직 막지 못했습니다.
--    RLS 를 켜야 "내 행"만 보이게 됩니다.
-- ────────────────────────────────────────────────────────────
alter table public.favorites      enable row level security;
alter table public.welfare_status enable row level security;


-- ────────────────────────────────────────────────────────────
-- 4) 정책 — 자기 행만 읽고 / 넣고 / 고치고 / 지울 수 있게
--
--    auth.uid() 는 "지금 로그인한 사람의 id" 입니다.
--    using      → 이미 있는 행을 볼·고칠·지울 수 있는 조건
--    with check → 새로 넣거나 바꾼 행이 만족해야 하는 조건
--                 (이게 없으면 남의 id 로 행을 넣을 수 있습니다)
-- ────────────────────────────────────────────────────────────
drop policy if exists "내 즐겨찾기만" on public.favorites;
create policy "내 즐겨찾기만"
  on public.favorites
  for all
  to authenticated
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "내 기록만" on public.welfare_status;
create policy "내 기록만"
  on public.welfare_status
  for all
  to authenticated
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ────────────────────────────────────────────────────────────
-- 5) 중복 방지용 UNIQUE 인덱스
--
--    앱 코드가 upsert(..., { onConflict: "user_id,welfare_id" })
--    를 쓰고 있습니다. (user_id, welfare_id) 조합에 UNIQUE 가
--    없으면 권한을 고친 뒤에도 42P10 오류가 납니다.
-- ────────────────────────────────────────────────────────────
create unique index if not exists favorites_user_welfare_uniq
  on public.favorites (user_id, welfare_id);

create unique index if not exists welfare_status_user_welfare_uniq
  on public.welfare_status (user_id, welfare_id);


-- ────────────────────────────────────────────────────────────
-- 6) 확인 — 아래를 함께 실행하면 결과를 눈으로 볼 수 있습니다
-- ────────────────────────────────────────────────────────────

-- (가) 역할별 권한이 제대로 들어갔는지
select
  table_name   as "테이블",
  grantee      as "역할",
  string_agg(privilege_type, ', ' order by privilege_type) as "권한"
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('favorites', 'welfare_status')
  and grantee in ('anon', 'authenticated')
group by table_name, grantee
order by table_name, grantee;
-- 기대: authenticated 에 DELETE, INSERT, SELECT, UPDATE
--       anon 은 아예 안 나오거나 비어 있어야 정상

-- (나) RLS 가 켜졌는지
select relname as "테이블", relrowsecurity as "RLS 켜짐"
from pg_class
where relname in ('favorites', 'welfare_status');
-- 기대: 둘 다 true

-- (다) 정책이 붙었는지
select tablename as "테이블", policyname as "정책 이름", cmd as "대상"
from pg_policies
where schemaname = 'public'
  and tablename in ('favorites', 'welfare_status');
-- 기대: 테이블마다 1개씩, cmd = ALL
