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
  let savedProfile = null;   // 불러온 '내 입력 정보' (없으면 null)

  /* 비회원 저장소 (피드백: 2112 비회원 맞춤 복지 검사 / 2210 메일인증 어려움)
     로그인한 분은 Supabase 에, 비회원은 이 브라우저에 저장합니다.
     어느 쪽이든 '저장해 둔 내 정보로 결과 보기' 는 똑같이 동작합니다. */
  const G_PROF = "silver.guest.profile";
  function guestLoad() {
    try { const v = localStorage.getItem(G_PROF); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }
  function guestSave(data) {
    try { localStorage.setItem(G_PROF, JSON.stringify(data)); return true; }
    catch (e) { return false; }
  }

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
    loadBtn.style.display = savedProfile ? "block" : "none";   // 비회원도 보입니다
  }

  /* -------------------------------------------------------------------
     3) 저장 — 지금 입력한 P 를 DB에 통째로 올립니다 (upsert = 있으면 덮어씀)
     ------------------------------------------------------------------- */
  // 저장이 끝났을 때 버튼을 잠깐 초록색으로 바꿔 보여 줍니다.
  function flashSaved(btn) {
    savedProfile = JSON.parse(JSON.stringify(P));
    refreshLoadBtn();
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = "✅ 저장했어요";
    btn.classList.add("done");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1800);
  }

  async function saveProfile(btn) {
    // 비회원 — 로그인 없이 이 기기에 저장합니다.
    if (!profUser) {
      if (guestSave(P)) {
        flashSaved(btn);
        if (window.showToast) {
          window.showToast(
            "답하신 내용을 이 기기에 저장했습니다. 다음에 오시면 설문 없이 바로 결과를 보실 수 있습니다.",
            "로그인하고 어디서나 보기",
            () => { const b = document.querySelector(".authbtn.primary"); if (b) b.click(); }
          );
        }
      } else {
        alert("이 브라우저에 저장할 수 없었습니다. 비밀(시크릿) 창을 쓰고 계시면 일반 창에서 다시 해 보세요.");
      }
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
      flashSaved(btn);
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
    const saved = JSON.parse(JSON.stringify(savedProfile));

    // A·B 는 객체이므로 통째로 바꾸지 않고 항목만 덮어씁니다.
    // (그래야 나중에 추가된 항목이 기본값으로 남아 오류가 나지 않습니다)
    Object.keys(saved).forEach((k) => {
      if (saved[k] && typeof saved[k] === "object" && !Array.isArray(saved[k]) && P[k]) {
        Object.assign(P[k], saved[k]);
      } else {
        P[k] = saved[k];
      }
    });

    // 예전에 저장한 정보에는 B.living 이 없습니다. 있던 값으로 되살립니다.
    if (P.B.living === undefined || P.B.living === null) {
      P.B.living = P.B.alone ? "alone" : P.B.couple ? "couple" : P.B.grand ? "grand" : null;
    }
    if (typeof syncLiving === "function") syncLiving();

    if (typeof showResult === "function") showResult(); // 판정 → 결과 화면
  }

  /* -------------------------------------------------------------------
     5) 로그인하면 '내 정보가 저장돼 있는지' DB에서 확인
        - RLS 덕분에 select 하면 '내 행'만 옵니다.
        - maybeSingle(): 행이 없으면 오류 대신 data=null 을 줍니다.
     ------------------------------------------------------------------- */
  async function fetchProfile() {
    // 비회원이면 이 기기에 저장해 둔 것을 읽습니다.
    if (!profUser) { savedProfile = guestLoad(); refreshLoadBtn(); return; }
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
    b.textContent = profUser ? "💾 이 정보 저장하기" : "💾 이 정보 저장하기 (이 기기에)";
    b.onclick = () => saveProfile(b);
    const redo = rsum.querySelector(".redo");   // '다시 입력하기' 버튼 옆에
    if (redo) redo.insertAdjacentElement("afterend", b);
    else rsum.appendChild(b);
  }

  /* -------------------------------------------------------------------
     7) 로그인 상태 추적 — 로그인/로그아웃 때마다 자동 실행
        (페이지가 처음 열릴 때도 INITIAL_SESSION 이벤트로 한 번 불립니다)
     ------------------------------------------------------------------- */
  // 먼저 비회원 저장본을 읽어 둡니다.
  // (인터넷이나 Supabase 가 막혀 아래 코드가 돌지 못해도 비회원 기능은 살아 있도록)
  fetchProfile();

  db.auth.onAuthStateChange((event, session) => {
    profUser = session ? session.user : null;
    fetchProfile();
  });

  // 혹시 이벤트가 늦을 때를 대비해 현재 세션도 한 번 확인
  db.auth.getSession().then(({ data }) => {
    if (data && data.session) { profUser = data.session.user; fetchProfile(); }
  });

})();
