/* =======================================================================
   profileFeature.js
   '내 입력 정보(인적사항 응답)'를 Supabase에 저장하고, 재접속 시 불러오기.

   [역할 나눔]
     - 즐겨찾기 / 수혜이력(이미받음·신청함) → supabaseFeatures.js 가 이미 담당
     - 내 입력 정보(나이·지역·가구·자격 등, 아래 코드의 P 객체) → 이 파일이 담당

   [불러오는 순서]  반드시 맨 마지막!
     1) supabase 라이브러리(CDN)
     2) config.js
     3) supabaseClient.js        → const db
     4) 프로그램 본체(<script> ...)→ P, resetP, showResult, startForm, mineResult …
     5) supabaseFeatures.js       → 로그인 + 즐겨찾기/수혜이력
     6) profileFeature.js         ← 이 파일!

   이 파일은 본체의 전역값(P, resetP, showResult, mineResult)과
   supabaseClient.js 의 db 를 그대로 가져다 씁니다. 그래서 가장 뒤여야 합니다.
   (supabaseFeatures.js 의 '안쪽' 변수인 currentUser 는 쓸 수 없으므로,
    이 파일은 로그인 상태를 스스로 따로 확인합니다.)
   ======================================================================= */

(function () {
  "use strict";

  /* -------------------------------------------------------------------
     0) 상태값 — 이 파일이 따로 관리합니다
     ------------------------------------------------------------------- */
  let profUser = null;       // 지금 로그인한 사용자 (없으면 null = 비회원)
  let savedProfile = null;   // DB에서 불러온 '내 입력 정보' (없으면 null)

  /* -------------------------------------------------------------------
     1) 큰 글씨 버튼 스타일 (어르신용) — JS로 삽입해 HTML은 안 건드림
     ------------------------------------------------------------------- */
  const style = document.createElement("style");
  style.textContent = `
    /* 시작 화면: '저장해 둔 내 정보 불러오기' 버튼 */
    .profbtn{
      display:block; margin:14px auto 0;
      font-family:"Pretendard","Nanum Gothic",sans-serif;
      font-size:21px; font-weight:800; padding:16px 32px;
      border:2px solid #17B0A0; border-radius:16px;
      background:#fff; color:#0e7d71; cursor:pointer;
    }
    .profbtn:hover{ background:#EAF8F5; }

    /* 결과 화면: '이 정보 저장하기' 버튼 */
    .saveprof{
      display:block; width:100%; margin-top:12px;
      font-family:"Pretendard","Nanum Gothic",sans-serif;
      font-size:20px; font-weight:800; padding:16px;
      border:none; border-radius:14px;
      background:#17B0A0; color:#fff; cursor:pointer;
    }
    .saveprof:hover{ filter:brightness(1.05); }
    .saveprof.done{ background:#2e7d32; }   /* 저장 완료 순간 초록색 */
    .saveprof:disabled{ opacity:.6; cursor:default; }
  `;
  document.head.appendChild(style);

  /* -------------------------------------------------------------------
     2) 시작 화면에 '불러오기' 버튼 넣기 (처음엔 숨김)
        - 로그인돼 있고 + 저장해 둔 정보가 있을 때만 보이게 합니다.
     ------------------------------------------------------------------- */
  const loadBtn = document.createElement("button");
  loadBtn.className = "profbtn";
  loadBtn.type = "button";
  loadBtn.textContent = "📂 저장해 둔 내 정보로 결과 보기";
  loadBtn.style.display = "none";
  loadBtn.onclick = restoreProfile;

  // '시작하겠습니다' 버튼 바로 아래에 끼워 넣기
  const startBtn = document.getElementById("startBtn");
  if (startBtn) startBtn.insertAdjacentElement("afterend", loadBtn);

  function refreshLoadBtn() {
    loadBtn.style.display = (profUser && savedProfile) ? "block" : "none";
  }

  /* -------------------------------------------------------------------
     3) 저장 — 지금 입력한 P 를 DB에 통째로 올립니다 (upsert = 있으면 덮어씀)
     ------------------------------------------------------------------- */
  async function saveProfile(btn) {
    if (!profUser) {
      alert("로그인하시면 입력하신 정보가 저장돼, 다음에 또 쓰실 수 있어요.\n오른쪽 위 '로그인' 단추를 눌러 주세요.");
      return;
    }
    if (btn) btn.disabled = true;
    try {
      const { error } = await db
        .from("profile_info")
        .upsert(
          { user_id: profUser.id, data: P, updated_at: new Date().toISOString() },
          { onConflict: "user_id" }   // user_id 가 기본키라 같은 사람이면 덮어씀
        );
      if (error) {
        console.warn("내 정보 저장 실패:", error.message);
        alert("저장에 실패했어요. 잠시 뒤 다시 시도해 주세요.");
        return;
      }
      // 방금 저장한 값을 기억해 둠(깊은 복사). 그래야 불러오기 버튼이 바로 켜집니다.
      savedProfile = JSON.parse(JSON.stringify(P));
      refreshLoadBtn();
      if (btn) {
        const old = btn.textContent;
        btn.textContent = "✅ 저장했어요";
        btn.classList.add("done");
        setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1800);
      }
    } catch (e) {
      console.warn("내 정보 저장 오류:", e.message);
      alert("저장 중 문제가 생겼어요: " + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* -------------------------------------------------------------------
     4) 불러오기 — DB의 내 정보를 P 에 채우고, 바로 결과 화면을 보여줍니다
        - resetP()로 먼저 기본값을 깔고 → 저장본을 덮어씌웁니다.
          (혹시 저장본에 빠진 항목이 있어도 오류 없이 안전하게 하려는 것)
     ------------------------------------------------------------------- */
  function restoreProfile() {
    if (!savedProfile) return;
    if (typeof resetP === "function") resetP();        // 기본값으로 초기화
    Object.assign(P, JSON.parse(JSON.stringify(savedProfile)));  // 저장본 덮어쓰기
    if (typeof showResult === "function") showResult(); // 판정 → 결과 화면
  }

  /* -------------------------------------------------------------------
     5) 로그인하면 '내 정보가 저장돼 있는지' DB에서 확인
        - RLS 덕분에 select 하면 '내 행'만 옵니다.
        - maybeSingle(): 행이 없으면 오류 대신 data=null 을 줍니다.
     ------------------------------------------------------------------- */
  async function fetchProfile() {
    if (!profUser) { savedProfile = null; refreshLoadBtn(); return; }
    try {
      const { data, error } = await db
        .from("profile_info")
        .select("data")
        .eq("user_id", profUser.id)
        .maybeSingle();
      if (error) { console.warn("내 정보 불러오기 실패:", error.message); savedProfile = null; }
      else savedProfile = data ? data.data : null;
    } catch (e) {
      console.warn("내 정보 불러오기 오류:", e.message);
      savedProfile = null;
    }
    refreshLoadBtn();
  }

  /* -------------------------------------------------------------------
     6) 결과 화면에 '저장' 버튼 붙이기
        - 본체의 showResult 를 가로채서, 결과가 그려진 "뒤"에 버튼을 넣습니다.
          (supabaseFeatures.js 가 openModal 을 가로챈 것과 같은 방식)
     ------------------------------------------------------------------- */
  const _showResult = showResult;      // 원본 보관
  showResult = function () {
    _showResult();                     // 원래대로 결과를 그림
    injectSaveButton();                // 그 뒤에 저장 버튼 추가
  };

  function injectSaveButton() {
    const rsum = mineResult.querySelector(".rsum");
    if (!rsum || rsum.querySelector(".saveprof")) return;   // 없거나 이미 있으면 패스
    const b = document.createElement("button");
    b.className = "saveprof";
    b.type = "button";
    b.textContent = profUser ? "💾 이 정보 저장하기" : "💾 로그인하고 내 정보 저장하기";
    b.onclick = () => saveProfile(b);
    const redo = rsum.querySelector(".redo");   // '다시 입력하기' 버튼 옆에
    if (redo) redo.insertAdjacentElement("afterend", b);
    else rsum.appendChild(b);
  }

  /* -------------------------------------------------------------------
     7) 로그인 상태 추적 — 로그인/로그아웃 때마다 자동 실행
        (페이지가 처음 열릴 때도 INITIAL_SESSION 이벤트로 한 번 불립니다)
     ------------------------------------------------------------------- */
  db.auth.onAuthStateChange((event, session) => {
    profUser = session ? session.user : null;
    fetchProfile();
  });

  // 혹시 이벤트가 늦을 때를 대비해 현재 세션도 한 번 확인
  db.auth.getSession().then(({ data }) => {
    if (data && data.session) { profUser = data.session.user; fetchProfile(); }
  });

})();
