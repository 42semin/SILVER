/* =======================================================================
   supabaseFeatures.js
   로그인 + 즐겨찾기 저장 + 복지 수혜 이력(이미받음/신청함) 저장·불러오기

   [불러오는 순서]  아주 중요합니다.
     1) supabase 라이브러리(CDN)
     2) config.js
     3) supabaseClient.js        ← 여기서 const db = createClient(...) 가 만들어짐
     4) 프로그램 본체(<script> const CAT = {...} ...)
     5) supabaseFeatures.js      ← 이 파일! 반드시 "맨 마지막"에 불러오세요.

   이 파일은 앞에서 만든 db, 그리고 프로그램 본체의 favs·render·openModal·DATA·modal
   을 그대로 가져다 씁니다. 그래서 프로그램보다 뒤에 있어야 합니다.
   ======================================================================= */

(function () {
  "use strict";

  /* -------------------------------------------------------------------
     0) 상태값
     ------------------------------------------------------------------- */
  let currentUser = null;                 // 로그인한 사용자 (없으면 null = 비회원)
  const statusMap = {};                   // { 복지id: 'received' | 'applied' }
  let guestHintShown = false;             // 비회원 안내를 너무 자주 띄우지 않으려는 표시

  /* -------------------------------------------------------------------
     1) 화면(로그인 바 + 로그인 창) 만들기 — HTML을 직접 고치지 않도록 JS로 삽입
     ------------------------------------------------------------------- */
  // (1-a) 스타일 삽입
  const style = document.createElement("style");
  style.textContent = `
    .authbar{ display:flex; gap:10px; align-items:center; margin-left:auto; }
    .authbar .who{ font-size:17px; color:#2b2620; font-weight:700; }
    .authbtn{
      font-size:17px; padding:10px 18px; border-radius:12px; cursor:pointer;
      border:2px solid #3f7d4e; background:#fff; color:#3f7d4e; font-weight:700;
    }
    .authbtn.primary{ background:#3f7d4e; color:#fff; }
    .authbtn:hover{ filter:brightness(1.05); }

    .auth-overlay{
      position:fixed; inset:0; background:rgba(40,35,20,.45);
      display:none; align-items:center; justify-content:center; z-index:1000; padding:20px;
    }
    .auth-overlay.open{ display:flex; }
    .auth-modal{
      background:#fff; border-radius:20px; padding:28px 26px; width:100%; max-width:420px;
      box-shadow:0 20px 60px rgba(0,0,0,.2);
    }
    .auth-modal h2{ font-size:26px; margin:0 0 6px; color:#2b2620; }
    .auth-modal p.desc{ font-size:16px; color:#7a7264; margin:0 0 18px; }
    .auth-field{ margin-bottom:16px; }
    .auth-field label{ display:block; font-size:17px; font-weight:700; margin-bottom:6px; color:#2b2620; }
    .auth-field input{
      width:100%; box-sizing:border-box; font-size:19px; padding:14px 14px;
      border:2px solid #d9d3c6; border-radius:12px;
    }
    .auth-field input:focus{ outline:none; border-color:#3f7d4e; }
    .auth-submit{
      width:100%; font-size:20px; font-weight:800; padding:16px; margin-top:4px;
      border:none; border-radius:14px; background:#3f7d4e; color:#fff; cursor:pointer;
    }
    .auth-submit:disabled{ opacity:.6; cursor:default; }
    .auth-switch{ text-align:center; margin-top:16px; font-size:16px; color:#6b6459; }
    .auth-switch button{ background:none; border:none; color:#3f7d4e; font-weight:800; font-size:16px; cursor:pointer; text-decoration:underline; }
    .auth-msg{ font-size:16px; margin-top:10px; min-height:22px; }
    .auth-msg.err{ color:#c0392b; }
    .auth-msg.ok{ color:#2e7d32; }
    .auth-close{ float:right; background:none; border:none; font-size:24px; cursor:pointer; color:#999; }

    /* 상세 모달 안 '내 기록' 영역 */
    .m-status{ margin-top:14px; padding-top:14px; border-top:1px dashed #ddd; }
    .m-status .stitle{ font-size:17px; font-weight:800; margin-bottom:10px; color:#2b2620; }
    .m-status .sbtns{ display:flex; gap:10px; flex-wrap:wrap; }
    .statbtn{
      font-size:17px; padding:12px 16px; border-radius:12px; cursor:pointer;
      border:2px solid #d9d3c6; background:#fff; color:#2b2620; font-weight:700;
    }
    .statbtn.on.received{ background:#2e7d32; border-color:#2e7d32; color:#fff; }
    .statbtn.on.applied{ background:#1565c0; border-color:#1565c0; color:#fff; }
  `;
  document.head.appendChild(style);

  // (1-b) 헤더에 로그인 바 넣기
  const header = document.querySelector("header.top");
  const authBar = document.createElement("div");
  authBar.className = "authbar";
  if (header) {
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.flexWrap = "wrap";
    header.appendChild(authBar);
  }

  // (1-c) 로그인/회원가입 창(모달) 만들기
  const authOverlay = document.createElement("div");
  authOverlay.className = "auth-overlay";
  authOverlay.innerHTML = `
    <div class="auth-modal" role="dialog" aria-modal="true">
      <button class="auth-close" id="authClose" aria-label="닫기">✕</button>
      <h2 id="authTitle">로그인</h2>
      <p class="desc" id="authDesc">이메일과 비밀번호를 넣어 주세요.</p>
      <div class="auth-field">
        <label for="authEmail">이메일</label>
        <input id="authEmail" type="email" inputmode="email" placeholder="예: hong@naver.com" autocomplete="email">
      </div>
      <div class="auth-field">
        <label for="authPw">비밀번호</label>
        <input id="authPw" type="password" placeholder="6자 이상" autocomplete="current-password">
      </div>
      <button class="auth-submit" id="authSubmit">로그인</button>
      <div class="auth-msg" id="authMsg"></div>
      <div class="auth-switch">
        <span id="authSwitchText">아직 회원이 아니신가요?</span>
        <button id="authSwitch">회원가입</button>
      </div>
    </div>`;
  document.body.appendChild(authOverlay);

  const el = {
    title:  authOverlay.querySelector("#authTitle"),
    desc:   authOverlay.querySelector("#authDesc"),
    email:  authOverlay.querySelector("#authEmail"),
    pw:     authOverlay.querySelector("#authPw"),
    submit: authOverlay.querySelector("#authSubmit"),
    msg:    authOverlay.querySelector("#authMsg"),
    switchText: authOverlay.querySelector("#authSwitchText"),
    switchBtn:  authOverlay.querySelector("#authSwitch"),
    close:  authOverlay.querySelector("#authClose")
  };

  let mode = "login";   // "login" 또는 "signup"

  function setMode(m) {
    mode = m;
    el.msg.textContent = "";
    el.msg.className = "auth-msg";
    if (m === "login") {
      el.title.textContent = "로그인";
      el.desc.textContent = "이메일과 비밀번호를 넣어 주세요.";
      el.submit.textContent = "로그인";
      el.switchText.textContent = "아직 회원이 아니신가요?";
      el.switchBtn.textContent = "회원가입";
      el.pw.setAttribute("autocomplete", "current-password");
    } else {
      el.title.textContent = "회원가입";
      el.desc.textContent = "이메일과 비밀번호(6자 이상)로 가입합니다.";
      el.submit.textContent = "회원가입";
      el.switchText.textContent = "이미 회원이신가요?";
      el.switchBtn.textContent = "로그인";
      el.pw.setAttribute("autocomplete", "new-password");
    }
  }

  function openAuth(m) { setMode(m || "login"); authOverlay.classList.add("open"); el.email.focus(); }
  function closeAuth() { authOverlay.classList.remove("open"); }

  el.close.onclick = closeAuth;
  el.switchBtn.onclick = () => setMode(mode === "login" ? "signup" : "login");
  authOverlay.addEventListener("click", (e) => { if (e.target === authOverlay) closeAuth(); });

  // 제출(로그인 또는 회원가입)
  el.submit.onclick = async () => {
    const email = el.email.value.trim();
    const pw = el.pw.value;
    if (!email || !pw) { showMsg("이메일과 비밀번호를 모두 넣어 주세요.", "err"); return; }
    if (pw.length < 6) { showMsg("비밀번호는 6자 이상이어야 합니다.", "err"); return; }

    el.submit.disabled = true;
    showMsg("잠시만 기다려 주세요…", "");

    try {
      if (mode === "signup") {
        const { data, error } = await db.auth.signUp({
          email,
          password: pw,
          // 인증 메일의 링크를 눌렀을 때 "지금 이 페이지"로 돌아오게 합니다.
          // (대시보드의 Site URL 기본값인 localhost:3000 으로 가버리는 것을 막음)
          options: { emailRedirectTo: pageUrl() }
        });
        if (error) { showMsg(translateError(error.message), "err"); return; }
        // 이메일 확인(Confirm email)이 꺼져 있으면 session 이 바로 생깁니다.
        if (data.session) {
          showMsg("가입이 완료됐어요! 로그인되었습니다.", "ok");
          setTimeout(closeAuth, 800);
        } else {
          showMsg("가입 신청이 됐어요. 메일함에서 인증 링크를 눌러 주세요. (이 창은 켜 둔 채로)", "ok");
        }
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password: pw });
        if (error) { showMsg(translateError(error.message), "err"); return; }
        showMsg("로그인되었습니다.", "ok");
        setTimeout(closeAuth, 500);
      }
    } catch (e) {
      showMsg("문제가 생겼어요: " + e.message, "err");
    } finally {
      el.submit.disabled = false;
    }
  };

  // 지금 보고 있는 페이지의 주소(물음표·# 뒤는 떼고)를 돌려줍니다.
  function pageUrl() {
    return window.location.origin + window.location.pathname;
  }

  // 인증 링크를 누르고 돌아왔을 때, 주소 끝에 붙어 오는 결과를 읽어
  // 어르신이 알아볼 수 있는 말로 알려 줍니다.
  function handleAuthRedirect() {
    const hash = window.location.hash || "";
    const query = window.location.search || "";
    const src = hash.startsWith("#") ? hash.slice(1) : hash;
    const p = new URLSearchParams(src || query.replace(/^\?/, ""));

    const err  = p.get("error") || p.get("error_code");
    const desc = p.get("error_description") || "";

    if (err) {
      const d = (err + " " + desc).toLowerCase();
      let msg;
      if (d.includes("expired")) {
        msg = "인증 링크의 사용 기한이 지났어요. 다시 회원가입을 눌러 새 메일을 받아 주세요.";
      } else if (d.includes("already") || d.includes("used")) {
        msg = "이미 인증이 끝난 링크예요. 바로 로그인하시면 됩니다.";
      } else {
        msg = "인증 링크에 문제가 있었어요. 다시 시도해 주세요. (" + err + ")";
      }
      openAuth("login");
      showMsg(msg, "err");
      // 주소를 깨끗하게 정리해, 새로고침해도 같은 안내가 또 뜨지 않게 합니다.
      history.replaceState(null, "", pageUrl());
      return;
    }

    // 인증 성공으로 토큰을 들고 돌아온 경우
    if (p.get("access_token") || p.get("type") === "signup") {
      history.replaceState(null, "", pageUrl());
    }
  }

  function showMsg(text, kind) {
    el.msg.textContent = text;
    el.msg.className = "auth-msg" + (kind ? " " + kind : "");
  }

  // 영어 오류 메시지를 어르신도 알기 쉽게 바꿔 줍니다.
  function translateError(m) {
    m = (m || "").toLowerCase();
    // 서버에 아예 닿지 못한 경우(인터넷 끊김 / 데이터베이스 주소가 죽음)
    if (m.includes("failed to fetch") || m.includes("load failed") ||
        m.includes("networkerror") || m.includes("fetch failed") ||
        m.includes("err_name_not_resolved") || m.includes("network request failed")) {
      return "데이터베이스에 연결할 수 없어요. 인터넷 연결을 확인하시고, 잠시 뒤 다시 시도해 주세요.";
    }
    if (m.includes("already registered")) return "이미 가입된 이메일이에요. 로그인해 보세요.";
    if (m.includes("invalid login")) return "이메일이나 비밀번호가 맞지 않아요.";
    if (m.includes("email not confirmed")) return "메일함에서 인증 링크를 먼저 눌러 주세요.";
    if (m.includes("password")) return "비밀번호를 확인해 주세요(6자 이상).";
    return "안내: " + m;
  }

  /* -------------------------------------------------------------------
     2) 로그인 바(헤더 오른쪽) 다시 그리기
     ------------------------------------------------------------------- */
  function updateAuthBar() {
    authBar.innerHTML = "";
    if (currentUser) {
      const who = document.createElement("span");
      who.className = "who";
      // 이메일 앞부분만 이름처럼 보여줍니다.
      who.textContent = (currentUser.email || "회원").split("@")[0] + "님";
      const out = document.createElement("button");
      out.className = "authbtn";
      out.textContent = "로그아웃";
      out.onclick = async () => { await db.auth.signOut(); };
      authBar.appendChild(who);
      authBar.appendChild(out);
    } else {
      const login = document.createElement("button");
      login.className = "authbtn primary";
      login.textContent = "로그인";
      login.onclick = () => openAuth("login");
      const signup = document.createElement("button");
      signup.className = "authbtn";
      signup.textContent = "회원가입";
      signup.onclick = () => openAuth("signup");
      authBar.appendChild(login);
      authBar.appendChild(signup);
    }
  }

  /* -------------------------------------------------------------------
     3) 즐겨찾기 — 기존 toggleFav 를 가로채서 DB 저장을 덧붙임
        (원본은 메모리 Set 만 바꾸고, 화면 갱신은 호출한 쪽에서 render() 합니다)
     ------------------------------------------------------------------- */
  const _toggleFav = toggleFav;           // 원본 보관
  toggleFav = function (id) {
    _toggleFav(id);                       // 메모리 Set 토글 (원래 동작 그대로)
    const nowOn = favs.has(id);           // 토글 후 상태
    if (currentUser) {
      if (nowOn) {
        // 중복 방지: 이미 있으면 무시(ignoreDuplicates)
        db.from("favorites")
          .upsert({ user_id: currentUser.id, welfare_id: id },
                  { onConflict: "user_id,welfare_id", ignoreDuplicates: true })
          .then(({ error }) => { if (error) console.warn("즐겨찾기 저장 실패:", error.message); });
      } else {
        db.from("favorites")
          .delete()
          .eq("user_id", currentUser.id)
          .eq("welfare_id", id)
          .then(({ error }) => { if (error) console.warn("즐겨찾기 삭제 실패:", error.message); });
      }
    } else {
      hintLogin();                        // 비회원에게 저장 안내(1회)
    }
  };

  function hintLogin() {
    if (guestHintShown) return;
    guestHintShown = true;
    // 부드럽게 한 번만 안내
    setTimeout(() => {
      if (!currentUser) {
        const go = confirm("로그인하시면 즐겨찾기와 기록이 저장돼 다음에 또 볼 수 있어요.\n지금 로그인하시겠어요?");
        if (go) openAuth("login");
      }
    }, 200);
  }

  /* -------------------------------------------------------------------
     4) 복지 수혜 이력(이미받음/신청함) — 상세 모달에 버튼 추가
        기존 openModal 을 가로채서, 모달이 그려진 "뒤"에 내 기록 영역을 붙입니다.
     ------------------------------------------------------------------- */
  const _openModal = openModal;           // 원본 보관
  openModal = function (d) {
    _openModal(d);                        // 원래대로 모달을 그림
    injectStatusButtons(d);              // 그 뒤에 '내 기록' 버튼을 붙임
  };

  function injectStatusButtons(d) {
    // 이미 붙어 있으면 중복 방지
    if (modal.querySelector(".m-status")) return;
    const wrap = document.createElement("div");
    wrap.className = "m-status";
    wrap.innerHTML = `
      <div class="stitle">📌 내 기록</div>
      <div class="sbtns">
        <button class="statbtn received" data-s="received">✅ 이미 받고 있어요</button>
        <button class="statbtn applied"  data-s="applied">📨 신청했어요</button>
      </div>`;
    // m-actions 아래에 넣기 (없으면 모달 맨 끝)
    const actions = modal.querySelector(".m-actions");
    if (actions) actions.after(wrap); else modal.appendChild(wrap);

    // 버튼 클릭 연결
    wrap.querySelectorAll(".statbtn").forEach((b) => {
      b.onclick = () => setStatus(d.id, b.dataset.s);
    });
    paintStatus(d.id);                    // 현재 상태 색칠
  }

  function paintStatus(id) {
    const wrap = modal.querySelector(".m-status");
    if (!wrap) return;
    const cur = statusMap[id] || null;
    wrap.querySelectorAll(".statbtn").forEach((b) => {
      b.classList.toggle("on", b.dataset.s === cur);
    });
  }

  function setStatus(id, s) {
    const cur = statusMap[id] || null;
    const next = (cur === s) ? null : s;  // 같은 버튼을 다시 누르면 해제
    if (next === null) delete statusMap[id];
    else statusMap[id] = next;
    paintStatus(id);

    if (currentUser) {
      if (next === null) {
        db.from("welfare_status")
          .delete()
          .eq("user_id", currentUser.id)
          .eq("welfare_id", id)
          .then(({ error }) => { if (error) console.warn("기록 삭제 실패:", error.message); });
      } else {
        db.from("welfare_status")
          .upsert({ user_id: currentUser.id, welfare_id: id, status: next },
                  { onConflict: "user_id,welfare_id" })
          .then(({ error }) => { if (error) console.warn("기록 저장 실패:", error.message); });
      }
    } else {
      hintLogin();
    }
  }

  /* -------------------------------------------------------------------
     5) 불러오기 — 로그인하면 내 즐겨찾기·기록을 DB에서 가져와 화면에 반영
        (RLS 덕분에 select 하면 '내 것'만 옵니다)
     ------------------------------------------------------------------- */
  async function loadUserData() {
    if (!currentUser) return;
    try {
      const [favRes, stRes] = await Promise.all([
        db.from("favorites").select("welfare_id"),
        db.from("welfare_status").select("welfare_id,status")
      ]);
      if (favRes.error) console.warn("즐겨찾기 불러오기 실패:", favRes.error.message);
      if (stRes.error)  console.warn("기록 불러오기 실패:", stRes.error.message);

      favs.clear();
      (favRes.data || []).forEach((r) => favs.add(r.welfare_id));

      for (const k in statusMap) delete statusMap[k];
      (stRes.data || []).forEach((r) => { statusMap[r.welfare_id] = r.status; });

      render();                           // 별표 다시 그리기
    } catch (e) {
      console.warn("사용자 데이터 불러오기 오류:", e.message);
    }
  }

  function clearUserData() {
    favs.clear();
    for (const k in statusMap) delete statusMap[k];
    render();
  }

  /* -------------------------------------------------------------------
     6) 로그인 상태 감시 — 로그인/로그아웃될 때마다 자동 실행
        (페이지가 처음 열릴 때도 INITIAL_SESSION 이벤트로 한 번 불립니다)
     ------------------------------------------------------------------- */
  db.auth.onAuthStateChange((event, session) => {
    currentUser = session ? session.user : null;
    updateAuthBar();
    if (currentUser) loadUserData();
    else clearUserData();
  });

  // 혹시 이벤트가 늦을 때를 대비해 현재 세션도 한 번 확인
  db.auth.getSession().then(({ data }) => {
    if (data.session && !currentUser) {
      currentUser = data.session.user;
      updateAuthBar();
      loadUserData();
    } else if (!data.session) {
      updateAuthBar();
    }
  });

  // ESC 로 로그인 창 닫기
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAuth(); });

  /* -------------------------------------------------------------------
     7) 데이터베이스 연결 확인
        페이지가 열릴 때 한 번 확인해서, 연결이 안 되면 화면 맨 위에
        안내 띠를 띄웁니다. (콘솔만 보지 않아도 알 수 있게)
     ------------------------------------------------------------------- */
  function showDbBanner(text) {
    if (document.getElementById("dbBanner")) return;
    const b = document.createElement("div");
    b.id = "dbBanner";
    b.textContent = text;
    b.style.cssText =
      "position:sticky; top:0; z-index:1200; padding:14px 18px; " +
      "background:#fdecea; color:#8e2017; border-bottom:2px solid #e6b3ad; " +
      "font-size:18px; font-weight:700; line-height:1.5; text-align:center;";
    document.body.prepend(b);
  }

  async function checkDbConnection() {
    try {
      const res = await fetch(SUPABASE_URL + "/auth/v1/health", {
        headers: { apikey: SUPABASE_KEY }
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      console.log("[DB] 연결 정상:", SUPABASE_URL);
    } catch (e) {
      console.error("[DB] 연결 실패:", SUPABASE_URL, "-", e.message);
      console.error(
        "[DB] 확인할 점: ① Supabase 프로젝트가 일시정지(Paused) 상태인지 " +
        "② config.js 의 프로젝트 주소가 맞는지 ③ 인터넷 연결 상태"
      );
      showDbBanner(
        "⚠ 지금 데이터베이스에 연결되지 않아 로그인·즐겨찾기 저장이 되지 않습니다. " +
        "복지 정보 검색은 그대로 쓰실 수 있어요."
      );
    }
  }
  checkDbConnection();

  // 인증 메일 링크를 누르고 돌아온 경우의 결과 처리
  handleAuthRedirect();

})();