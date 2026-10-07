// supabaseClient.js — Supabase 연결(client) 만들기

// CDN 라이브러리가 못 불러와졌는지 먼저 확인합니다.
if (typeof supabase === "undefined" || !supabase.createClient) {
  alert("데이터베이스 라이브러리를 불러오지 못했습니다.\n인터넷 연결을 확인해 주세요.");
  throw new Error("supabase-js 라이브러리 로드 실패 (CDN 차단 또는 네트워크 오류)");
}

// 접속 정보가 비어 있는지도 확인합니다.
if (typeof SUPABASE_URL === "undefined" || !SUPABASE_URL ||
    typeof SUPABASE_KEY === "undefined" || !SUPABASE_KEY) {
  alert("접속 정보(config.js)가 비어 있습니다. 관리자에게 알려 주세요.");
  throw new Error("config.js 의 SUPABASE_URL / SUPABASE_KEY 가 없습니다");
}

// 라이브러리(전역 supabase)에서 createClient 함수를 꺼냅니다.
const { createClient } = supabase;

// 실제로 우리가 쓸 연결 객체를 만듭니다. 이름은 db 로 지었어요.
const db = createClient(SUPABASE_URL, SUPABASE_KEY);
