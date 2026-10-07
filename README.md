# SILVER — 대전 어르신 맞춤 복지 찾기

대전광역시 노인복지 사업을 어르신이 스스로 찾아볼 수 있도록 만든 웹 서비스입니다.
2026 정보과학 프로젝트 (대전과학고등학교).

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 전체와 복지 데이터 |
| `config.js` | Supabase 접속 정보 |
| `supabaseClient.js` | 데이터베이스 연결 |
| `supabaseFeatures.js` | 로그인 · 즐겨찾기 · 수혜 이력 |

별도의 빌드 과정이 없는 정적 사이트입니다.

## 로컬에서 실행

`file://` 로 직접 열면 로그인이 동작하지 않습니다. 반드시 웹서버로 띄우세요.

```bash
python -m http.server 8000
```

그 다음 http://127.0.0.1:8000 으로 접속합니다.
VS Code 를 쓰신다면 Live Server 확장의 `Go Live` 도 같습니다.

## 데이터베이스

Supabase(PostgreSQL)를 씁니다. 두 테이블을 사용합니다.

- `favorites` — 사용자가 별표한 복지
- `welfare_status` — 복지별 수혜 상태(이미받음 / 신청함)

두 테이블 모두 RLS(행 수준 보안)가 켜져 있고, `auth.uid() = user_id`
정책으로 **각자 자기 기록만** 읽고 쓸 수 있습니다.

`config.js` 의 키는 publishable key 로, 공개되는 것을 전제로 설계된 키입니다.
실제 데이터 보호는 위의 RLS 정책이 담당합니다.

## 배포

Vercel 정적 배포. `main` 에 push 하면 자동으로 반영됩니다.

배포 주소가 바뀌면 Supabase 대시보드의
Authentication → URL Configuration 에서 Site URL 과 Redirect URLs 를
새 주소로 갱신해야 이메일 인증 링크가 정상 동작합니다.
