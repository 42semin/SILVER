-- ============================================================
--  '내 입력 정보(인적사항)' 저장용 표 + 권한/보안 설정
--
--  [쓰는 법]
--   Supabase 대시보드 → SQL Editor → New query →
--   이 파일 내용을 전부 붙여넣고 RUN
--
--  * 즐겨찾기(favorites)·수혜이력(welfare_status) 표는 이미 만들어
--    두셨으니, 여기서는 '입력 정보' 표만 새로 만듭니다.
--  * 여러 번 실행해도 안전하게 만들어 두었습니다.
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- 1) 표 만들기
--    - 사용자 한 명당 '한 줄'만 있으면 됩니다. (그때그때 덮어씀)
--      그래서 user_id 를 기본키(primary key)로 두었습니다.
--    - 입력 항목이 여러 개(나이·지역·가구·자격…)라, 칸을 하나하나
--      만들지 않고 data 라는 칸 하나에 JSON 으로 통째로 담습니다.
--      → 나중에 질문 항목이 늘어도 표를 고칠 필요가 없습니다.
-- ────────────────────────────────────────────────────────────
create table if not exists public.profile_info (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);


-- ────────────────────────────────────────────────────────────
-- 2) 로그인한 사용자에게 사용 권한 주기
--    (이게 없으면 favorites 때처럼 "permission denied" 가 납니다)
-- ────────────────────────────────────────────────────────────
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profile_info to authenticated;


-- ────────────────────────────────────────────────────────────
-- 3) 비회원(anon) 은 막아 두기
-- ────────────────────────────────────────────────────────────
revoke all on public.profile_info from anon;


-- ────────────────────────────────────────────────────────────
-- 4) 행 수준 보안(RLS) — 내 행만 읽고/쓰게
--    auth.uid() = 지금 로그인한 사람의 id
-- ────────────────────────────────────────────────────────────
alter table public.profile_info enable row level security;

drop policy if exists "내 정보만" on public.profile_info;
create policy "내 정보만"
  on public.profile_info
  for all
  to authenticated
  using      (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ────────────────────────────────────────────────────────────
-- 5) 확인 — 정책이 잘 붙었는지 눈으로 보기
-- ────────────────────────────────────────────────────────────
select tablename as "테이블", policyname as "정책 이름", cmd as "대상"
from pg_policies
where schemaname = 'public' and tablename = 'profile_info';
-- 기대: 한 줄, cmd = ALL
