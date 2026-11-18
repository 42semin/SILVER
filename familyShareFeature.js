/* =======================================================================
   familyShareFeature.js
   가족 그룹 · 결과 공유 링크 · 문자로 보내기

   [피드백] 2112 검사 결과 URL 공유 / 2111 가족 문자 공유 / 2311 가족 그룹(자녀 대신 조회)

   [회원과 비회원의 차이]
     · 결과 링크 만들기 / 링크로 보기 ........ 회원·비회원 모두 (보는 사람은 로그인 필요 없음)
     · 내 휴대전화의 문자 앱으로 보내기 ....... 회원·비회원 모두 (sms: 링크, 서버가 번호를 받지 않음)
     · 등록된 번호로 서버가 문자 보내기 ....... 회원만 (번호는 암호화 보관, Edge Function 'sms')
     · 가족 그룹 (아이디로 추가 / 초대 링크) .... 회원만

   [불러오는 순서] profileFeature.js 보다 뒤 — 맨 마지막
     이 파일은 본체의 P · resetP · syncLiving · showResult · renderMyPage · switchTab ·
     mineIntro · mineResult · mineReview 와 supabaseClient.js 의 db 를 가져다 씁니다.
   ======================================================================= */

(function () {
  "use strict";
  if (typeof db === "undefined") return;           // DB 연결이 없으면 이 기능만 꺼집니다

  const SITE = window.location.origin + window.location.pathname;
  const G_SHARES  = "silver.guest.shares";          // 비회원이 만든 링크 {token, key, exp}
  const G_INVITE  = "silver.pendingInvite";         // 로그인 전에 연 초대 링크

  // 서버 문자 발송 스위치
  //   국내 문자 발송은 발신번호 사전등록이 필요합니다. 등록이 끝나고 Edge Function 'sms' 를
  //   배포한 뒤 true 로 바꾸세요. false 인 동안에는 문자 서버를 아예 부르지 않고,
  //   번호 등록·문자 보내기 버튼은 흐리게 보이며 누르면 '준비 중' 안내만 띄웁니다.
  //   (자기 휴대전화 문자 앱을 여는 sms: 링크는 서버가 필요 없어 그대로 씁니다)
  const SMS_ENABLED = false;
  const smsComingSoon = () => {
    toast("문자 보내기는 준비 중입니다. 지금은 ‘내 휴대전화 문자로 보내기’나 주소 복사를 써 주세요.");
    const t = document.querySelector(".toast");                 // 잠깐만 보이고 사라지게
    if (t) setTimeout(() => { if (t.isConnected) t.remove(); }, 3500);
  };
  const soonBtn = (label, extra) =>
    `<button class="fs-btn soon ${extra || ""}" type="button" aria-disabled="true" data-soon>${label} <span class="fs-soontag">준비 중</span></button>`;
  const bindSoon = (root) => root.querySelectorAll("[data-soon]").forEach((b) => { b.onclick = smsComingSoon; });

  let me = null;                                    // 지금 로그인한 사용자

  /* ---------- 작은 도구 ---------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toast = (m, a, f) => { if (window.showToast) window.showToast(esc(m), a, f); else alert(m); };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 막혀 있어도 계속 */ } };
  const dayStr = (t) => { const d = new Date(t); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
  const shareUrl = (t) => SITE + "?s=" + encodeURIComponent(t);
  const inviteUrl = (t) => SITE + "?invite=" + encodeURIComponent(t);
  const smsHref = (text) => "sms:?&body=" + encodeURIComponent(text);   // 안드로이드·아이폰 모두 열림
  const openLogin = () => { const b = document.querySelector(".authbtn.primary"); if (b) b.click(); };

  // 서버(SQL 함수·Edge Function)가 돌려주는 오류 코드를 쉬운 말로
  const ERR = {
    login_required: "로그인하셔야 쓸 수 있습니다.",
    no_such_id: "그 아이디를 쓰는 회원이 없습니다. 글자를 다시 확인해 주세요.",
    self: "내 아이디는 넣을 수 없습니다.",
    already_member: "이미 이 가족에 계신 분입니다.",
    group_full: "한 가족 그룹에는 20명까지 들어올 수 있습니다.",
    too_many_groups: "가족 그룹은 5개까지 들어갈 수 있습니다.",
    not_member: "이 가족 그룹의 구성원이 아닙니다.",
    owner_only: "그룹을 만든 분만 할 수 있습니다.",
    no_such_request: "이미 처리된 요청입니다.",
    invite_invalid: "초대 링크의 기한(3일)이 지났거나 정원이 찼습니다. 새 링크를 받아 주세요.",
    too_large: "보낼 내용이 너무 큽니다.",
    too_many_tries: "인증번호를 너무 많이 틀렸습니다. 처음부터 다시 받아 주세요.",
    too_many: "짧은 시간에 너무 많이 보냈습니다. 잠시 뒤 다시 해 주세요.",
    bad_phone: "휴대전화 번호(010으로 시작)를 다시 확인해 주세요.",
    wrong_code: "인증번호가 맞지 않습니다.",
    expired: "인증번호 기한(5분)이 지났습니다. 다시 받아 주세요.",
    sms_failed: "문자를 보내지 못했습니다. 잠시 뒤 다시 해 주세요.",
    no_recipient: "받으실 분을 골라 주세요.",
    no_share: "링크 기한이 지났습니다. 창을 닫고 다시 만들어 주세요.",
    sms_unavailable: "문자 보내는 서버가 아직 준비되지 않았습니다. 대신 ‘내 휴대전화 문자로 보내기’를 써 주세요.",
  };
  function errText(e) {
    const m = String((e && (e.message || e.code)) || e || "");
    if (e && e.code === "23505") return "이미 다른 분이 쓰는 아이디입니다. 다른 아이디를 골라 주세요.";
    if (e && e.code === "23514") return "아이디는 영문 소문자·숫자·밑줄(_)로 4~20자, 이름은 1~20자로 적어 주세요.";
    for (const k of Object.keys(ERR)) if (m.includes(k)) return ERR[k];
    // 가족공유_문자.sql 을 아직 실행하지 않은 데이터베이스
    if ((e && (e.code === "PGRST202" || e.code === "PGRST205" || e.code === "42P01")) || /Could not find the (function|table)/.test(m)) {
      return "서버 준비가 아직 끝나지 않았습니다. 관리자에게 알려 주세요. (가족공유_문자.sql 미적용)";
    }
    if (/fetch|network/i.test(m)) return "인터넷 연결을 확인해 주세요.";
    return "문제가 생겼습니다. 잠시 뒤 다시 해 주세요. (" + m + ")";
  }

  async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args || {});
    if (error) throw error;
    return data;
  }

  // Edge Function 'sms' 부르기 — 회원 로그인 토큰이 함께 갑니다
  async function sms(action, payload) {
    let res;
    try {
      res = await db.functions.invoke("sms", { body: Object.assign({ action }, payload || {}) });
    } catch (e) { throw new Error("sms_unavailable"); }
    if (res.error) {
      let code = "sms_unavailable";
      try { const j = await res.error.context.json(); if (j && j.error) code = j.error; } catch (e) { /* 함수가 아직 없음 */ }
      throw new Error(code);
    }
    return res.data;
  }

  /* -------------------------------------------------------------------
     1) 스타일
     ------------------------------------------------------------------- */
  const style = document.createElement("style");
  style.textContent = `
    .fs-ov{position:fixed;inset:0;background:rgba(40,35,20,.45);display:flex;align-items:center;justify-content:center;z-index:1100;padding:16px}
    .fs-sheet{background:#fff;border-radius:22px;padding:26px 24px;width:100%;max-width:520px;max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.2);font-family:var(--ui)}
    .fs-sheet h2{font-size:25px;margin:0 0 8px;color:#2b2620}
    .fs-sheet h3{font-size:20px;margin:22px 0 10px;color:#2b2620}
    .fs-x{float:right;background:none;border:none;font-size:26px;cursor:pointer;color:#999;line-height:1}
    .fs-desc{font-family:var(--read);font-size:18px;line-height:1.6;color:#4a4134;margin:0 0 14px}
    .fs-note{font-family:var(--read);font-size:16px;line-height:1.6;color:#6b6455;background:#F7F4EC;border-radius:14px;padding:12px 14px;margin-top:14px}
    .fs-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    .fs-in{flex:1 1 180px;min-width:0;box-sizing:border-box;font-size:19px;padding:13px 14px;border:2px solid #d9d3c6;border-radius:12px;font-family:var(--ui)}
    .fs-in:focus{outline:none;border-color:#17B0A0}
    .fs-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:var(--ui);font-size:18px;font-weight:800;padding:13px 18px;border-radius:14px;border:2px solid #17B0A0;background:#fff;color:#0e7d71;cursor:pointer;text-decoration:none}
    .fs-btn.pri{background:#17B0A0;color:#fff}
    .fs-btn.wide{display:flex;width:100%;margin-top:10px;box-sizing:border-box}
    .fs-btn.danger{border-color:#e0b4ae;color:#a33a2c}
    .fs-btn.sm{font-size:16px;padding:9px 13px;border-radius:11px}
    .fs-btn:disabled{opacity:.55;cursor:default}
    .fs-btn.soon{border-color:#cfc8b8;background:#f3f0e8;color:#8a8273;cursor:not-allowed}
    .fs-soontag{font-size:14px;font-weight:800;padding:3px 8px;border-radius:999px;background:#e4ded0;color:#6b6455}
    .fs-msg{font-size:17px;margin-top:10px;min-height:22px;font-family:var(--read)}
    .fs-msg.err{color:#c0392b}.fs-msg.ok{color:#2e7d32}
    .fs-check{display:flex;align-items:center;gap:12px;font-size:19px;padding:12px 14px;border:2px solid var(--line);border-radius:14px;margin-bottom:8px;cursor:pointer}
    .fs-check input{width:24px;height:24px;flex:none}
    .fs-check.off{opacity:.55;cursor:default}
    .fs-check small{color:#7a7264;font-size:15px}

    .fs-banner{background:#EAF3FF;border:2px solid #b9d3f5;border-radius:18px;padding:16px 18px;margin:18px auto 0;font-family:var(--read);font-size:19px;line-height:1.6;color:#23426b}
    .fs-banner.fam{background:#FFF6E5;border-color:#F2D98C;color:#5c4710}
    .fs-banner .fs-btn{margin-top:10px}
    .fs-recs{background:#fff;border:1px solid var(--line);border-radius:22px;padding:20px 24px;margin:0 auto 20px}
    .fs-recs h3{font-size:20px;margin:0 0 8px}
    .fs-recs p{font-family:var(--read);font-size:18px;margin:6px 0;line-height:1.6}
    .fs-sharebtn{flex:1 1 100%;font-family:var(--ui);font-size:20px;font-weight:800;padding:16px 20px;border-radius:14px;border:none;background:#2f6fd0;color:#fff;cursor:pointer}
    .fs-sharebtn:hover{filter:brightness(1.07)}

    .fs-fam .mybox{text-align:left}
    .fs-card{border:2px solid var(--line);border-radius:18px;padding:16px 18px;margin-top:14px;background:#fff}
    .fs-card h3{font-size:21px;margin:0 0 10px;color:#2b2620}
    .fs-card p{font-family:var(--read);font-size:18px;line-height:1.6;margin:4px 0 10px;color:#4a4134}
    .fs-mem{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-top:1px dashed var(--line);font-size:19px}
    .fs-mem:first-of-type{border-top:none}
    .fs-mem .nm{font-weight:800}
    .fs-mem .hd{color:#7a7264;font-size:16px}
    .fs-mem .sp{flex:1}
    .fs-req{background:#FFF8E1;border-color:#F2D98C}
  `;
  document.head.appendChild(style);

  /* ---------- 떠 있는 창(시트) ---------- */
  function openSheet(html) {
    closeSheet();
    const ov = document.createElement("div");
    ov.className = "fs-ov";
    ov.innerHTML = `<div class="fs-sheet" role="dialog" aria-modal="true">
      <button class="fs-x" type="button" aria-label="닫기">✕</button>${html}</div>`;
    ov.addEventListener("click", (e) => { if (e.target === ov) closeSheet(); });
    ov.querySelector(".fs-x").onclick = closeSheet;
    document.body.appendChild(ov);
    return ov.querySelector(".fs-sheet");
  }
  function closeSheet() { document.querySelectorAll(".fs-ov").forEach((o) => o.remove()); }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t);
      t.select(); try { document.execCommand("copy"); } catch (e2) { /* 그래도 안 되면 그냥 둠 */ } t.remove();
    }
    if (btn) { const o = btn.textContent; btn.textContent = "✅ 복사했어요"; setTimeout(() => { btn.textContent = o; }, 1600); }
  }

  /* -------------------------------------------------------------------
     2) '남의 결과 보기' 모드 — 공유 링크 / 가족 결과
        내 답(P)을 잠깐 맡겨 두고, 받은 답으로 같은 판정 엔진을 돌립니다.
        '내 화면으로 돌아가기'를 누르면 내 답이 그대로 돌아옵니다.
     ------------------------------------------------------------------- */
  let VIEW = null, backupP = null;
  window.SILVER_VIEW = null;

  function loadIntoP(saved) {
    resetP();
    saved = clone(saved || {});
    Object.keys(saved).forEach((k) => {
      if (!(k in P)) return;                                        // 모르는 항목은 무시
      if (saved[k] && typeof saved[k] === "object" && !Array.isArray(saved[k]) && P[k]) Object.assign(P[k], saved[k]);
      else P[k] = saved[k];
    });
    if (!Array.isArray(P.interests)) P.interests = [];
    if (P.B.living === undefined || P.B.living === null) {
      P.B.living = P.B.alone ? "alone" : P.B.couple ? "couple" : P.B.grand ? "grand" : null;
    }
    if (typeof syncLiving === "function") syncLiving();
  }

  function enterView(data, ctx) {
    if (!VIEW) backupP = clone(P);
    VIEW = ctx; window.SILVER_VIEW = ctx;
    loadIntoP(data);
    closeSheet();
    switchTab("mine");
    if (typeof mineReview !== "undefined" && mineReview) mineReview.hidden = true;
    showResult();
  }

  function exitView() {
    if (!VIEW) return;
    VIEW = null; window.SILVER_VIEW = null;
    P = backupP || P; backupP = null;
    stripParam("s");
    switchTab("mine");
    if (P.age !== null && P.age !== undefined && P.age !== "") showResult();
    else { mineResult.hidden = true; mineReview.hidden = true; mineIntro.hidden = false; }
  }

  function stripParam(name) {
    const u = new URL(window.location.href);
    if (!u.searchParams.has(name)) return;
    u.searchParams.delete(name);
    history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
  }

  // 결과 화면이 그려진 '뒤'에 덧붙입니다 (profileFeature.js 와 같은 방식)
  const _showResult = showResult;
  showResult = function () {
    _showResult();
    decorateResult();
  };

  function decorateResult() {
    const rsum = mineResult.querySelector(".rsum");
    if (!rsum) return;
    if (!VIEW) {
      const box = rsum.querySelector(".rsumbtns") || rsum;
      if (!box.querySelector(".fs-sharebtn")) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "fs-sharebtn";
        b.textContent = "📤 이 결과를 가족에게 보내기 (링크·문자)";
        b.onclick = openSharePanel;
        box.appendChild(b);
      }
      return;
    }
    // 남의 결과는 읽기만 — 고치기·저장 버튼을 치웁니다
    rsum.querySelectorAll("#editBtn, #redoBtn, .saveprof, .fs-sharebtn").forEach((x) => x.remove());

    const ban = document.createElement("div");
    if (VIEW.kind === "shared") {
      ban.className = "fs-banner";
      ban.innerHTML = `📨 <b>${esc(VIEW.sender || "가족")}</b>님이 ${dayStr(VIEW.created)}에 보낸 결과입니다.
        로그인하지 않아도 보실 수 있고, 이 링크는 <b>${dayStr(VIEW.expires)}</b>까지 열립니다.<br>
        <button class="fs-btn" type="button">🙋 나도 내 복지 찾아보기</button>`;
    } else {
      ban.className = "fs-banner fam";
      ban.innerHTML = `👨‍👩‍👧 가족 <b>${esc(VIEW.name)}</b>님이 저장해 두신 답으로 찾은 결과입니다. (보기만 됩니다)<br>
        <button class="fs-btn" type="button">↩ 내 화면으로 돌아가기</button>`;
    }
    ban.querySelector("button").onclick = exitView;
    mineResult.prepend(ban);

    if (VIEW.records) {
      const nm = (id) => { const d = DATA.find((x) => x.id === Number(id)); return d ? d.name : null; };
      const list = (ids) => ids.map(nm).filter(Boolean).map(esc).join(" · ") || "없음";
      const st = VIEW.records.st || {};
      const r = document.createElement("div");
      r.className = "fs-recs";
      r.innerHTML = `<h3>📌 ${esc(VIEW.name)}님의 기록</h3>
        <p>✅ <b>이미 받고 계신 복지</b>: ${list(Object.keys(st).filter((k) => st[k] === "received"))}</p>
        <p>📨 <b>신청하신 복지</b>: ${list(Object.keys(st).filter((k) => st[k] === "applied"))}</p>
        <p>⭐ <b>별표한 복지</b>: ${list(VIEW.records.fav || [])}</p>`;
      rsum.after(r);
    }
  }

  /* -------------------------------------------------------------------
     3) 결과 공유 링크 만들기 + 보내기
     ------------------------------------------------------------------- */
  const shareCache = new Map();          // 같은 답이면 링크를 새로 만들지 않습니다

  async function getShareFor(data) {
    const key = (me ? me.id : "guest") + "|" + JSON.stringify(data);
    const hit = shareCache.get(key);
    if (hit && new Date(hit.expires_at).getTime() > Date.now() + 3600e3) return hit;
    const rows = await rpc("create_shared_result", { p_data: data });
    const s = rows && rows[0];
    if (!s) throw new Error("no_share");
    shareCache.set(key, s);
    if (s.manage_key) {                  // 비회원 — 나중에 지울 수 있게 이 기기에 열쇠를 보관
      const list = lsGet(G_SHARES, []).filter((x) => new Date(x.exp).getTime() > Date.now());
      list.push({ token: s.token, key: s.manage_key, exp: s.expires_at, at: new Date().toISOString() });
      lsSet(G_SHARES, list.slice(-30));
    }
    return s;
  }

  async function deleteShare(token) {
    const g = lsGet(G_SHARES, []).find((x) => x.token === token);
    const ok = await rpc("delete_shared_result", { p_token: token, p_manage_key: g ? g.key : null });
    lsSet(G_SHARES, lsGet(G_SHARES, []).filter((x) => x.token !== token));
    shareCache.forEach((v, k) => { if (v.token === token) shareCache.delete(k); });
    return ok;
  }

  async function openSharePanel() {
    const sheet = openSheet(`<h2>📤 결과 보내기</h2><p class="fs-desc">링크를 만드는 중입니다…</p>`);
    let s;
    try { s = await getShareFor(clone(P)); }
    catch (e) { sheet.querySelector(".fs-desc").textContent = errText(e); return; }

    const url = shareUrl(s.token);
    const msg = "대전 어르신 맞춤 복지 찾기 결과입니다.\n" + url;
    const days = Math.round((new Date(s.expires_at) - Date.now()) / 86400e3);
    sheet.innerHTML = `<button class="fs-x" type="button" aria-label="닫기">✕</button>
      <h2>📤 결과 보내기</h2>
      <p class="fs-desc">이 링크를 받으신 분은 <b>로그인하지 않아도</b> 같은 결과를 보실 수 있습니다.
        링크는 <b>${days}일 뒤</b> 저절로 열리지 않게 됩니다.</p>
      <div class="fs-row">
        <input class="fs-in" readonly value="${esc(url)}" aria-label="결과 링크">
        <button class="fs-btn" type="button" data-a="copy">📋 복사</button>
      </div>
      <a class="fs-btn wide" href="${esc(smsHref(msg))}">💬 내 휴대전화 문자로 보내기</a>
      ${navigator.share ? `<button class="fs-btn wide" type="button" data-a="native">📲 카카오톡 등 다른 앱으로 보내기</button>` : ""}
      <div id="fsSmsBox"></div>
      <button class="fs-btn wide danger sm" type="button" data-a="del">🗑 이 링크 지우기 (더는 열리지 않게)</button>
      <div class="fs-msg" id="fsShareMsg"></div>`;
    sheet.querySelector(".fs-x").onclick = closeSheet;
    sheet.querySelector('[data-a="copy"]').onclick = (e) => copyText(url, e.currentTarget);
    const nat = sheet.querySelector('[data-a="native"]');
    if (nat) nat.onclick = () => navigator.share({ title: "복지 찾기 결과", text: "대전 어르신 맞춤 복지 찾기 결과입니다.", url }).catch(() => {});
    sheet.querySelector('[data-a="del"]').onclick = async () => {
      try { await deleteShare(s.token); closeSheet(); toast("링크를 지웠습니다. 이제 그 주소로는 결과가 열리지 않습니다."); }
      catch (e) { sheet.querySelector("#fsShareMsg").textContent = errText(e); }
    };
    fillSmsBox(sheet.querySelector("#fsSmsBox"), s.token);
  }

  // 회원 전용: 등록된 번호(나·가족)로 서버가 문자를 보냅니다
  async function fillSmsBox(box, token) {
    if (!SMS_ENABLED) {
      // 비회원에게는 아직 없는 기능을 내세우지 않습니다
      if (!me) { box.innerHTML = ""; return; }
      box.innerHTML = `<h3>📱 등록된 번호로 문자 보내기</h3>${soonBtn("✉ 나·가족에게 문자 보내기", "wide")}`;
      bindSoon(box);
      return;
    }
    if (!me) {
      box.innerHTML = `<div class="fs-note">🔒 <b>회원</b>은 등록한 전화번호(나·가족)로 문자를 바로 보내실 수 있습니다.
        비회원은 전화번호를 따로 받지 않고, 위의 <b>‘내 휴대전화 문자로 보내기’</b>로 직접 보내시면 됩니다.
        <button class="fs-btn wide sm" type="button">로그인하기</button></div>`;
      box.querySelector("button").onclick = () => { closeSheet(); openLogin(); };
      return;
    }
    box.innerHTML = `<h3>📱 등록된 번호로 문자 보내기</h3><p class="fs-desc">불러오는 중…</p>`;
    let st = { registered: false }, fam = { groups: [] }, smsOk = true;
    try { st = await sms("phone_status"); } catch (e) { smsOk = false; }
    try { fam = await rpc("my_family"); } catch (e) { /* 가족 표가 아직 없어도 계속 */ }
    if (!smsOk) { box.innerHTML = `<div class="fs-note">${esc(ERR.sms_unavailable)}</div>`; return; }

    const seen = new Set(), people = [];
    (fam.groups || []).forEach((g) => (g.members || []).forEach((m) => {
      if (m.is_me || seen.has(m.user_id)) return;
      seen.add(m.user_id); people.push(m);
    }));
    const meRow = st.registered
      ? `<label class="fs-check"><input type="checkbox" value="me" checked> 나 <small>(010-****-${esc(st.last4)})</small></label>`
      : `<div class="fs-check off">나 <small>— 번호를 아직 등록하지 않으셨습니다</small>
           <button class="fs-btn sm" type="button" data-a="reg" style="margin-left:auto">번호 등록</button></div>`;
    const famRows = people.map((m) => m.has_phone
      ? `<label class="fs-check"><input type="checkbox" value="${esc(m.user_id)}"> ${esc(m.name)} <small>(가족)</small></label>`
      : `<div class="fs-check off">${esc(m.name)} <small>— 문자 받을 번호가 없습니다</small></div>`).join("");

    box.innerHTML = `<h3>📱 등록된 번호로 문자 보내기</h3>
      ${meRow}${famRows}
      ${people.length ? "" : `<p class="fs-desc" style="font-size:16px">가족 그룹을 만들면 가족에게도 보낼 수 있습니다 (마이페이지).</p>`}
      <button class="fs-btn wide pri" type="button" data-a="send">✉ 고른 분께 문자 보내기</button>
      <div class="fs-msg" id="fsSmsMsg"></div>`;
    const reg = box.querySelector('[data-a="reg"]');
    if (reg) reg.onclick = () => openPhoneSheet(() => openSharePanel());
    const msgEl = box.querySelector("#fsSmsMsg");
    box.querySelector('[data-a="send"]').onclick = async (ev) => {
      const to = [...box.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
      if (!to.length) { msgEl.className = "fs-msg err"; msgEl.textContent = ERR.no_recipient; return; }
      const btn = ev.currentTarget;              // await 뒤에는 ev.currentTarget 이 비므로 미리 잡아 둡니다
      btn.disabled = true;
      msgEl.className = "fs-msg"; msgEl.textContent = "보내는 중…";
      try {
        const r = await sms("send_share", { token, to });
        const ok = r.results.filter((x) => x.ok).map((x) => x.name);
        const bad = r.results.filter((x) => !x.ok).map((x) => x.name);
        msgEl.className = "fs-msg " + (bad.length ? "err" : "ok");
        msgEl.textContent = (ok.length ? `✅ ${ok.join(", ")}에게 보냈습니다. ` : "") +
                            (bad.length ? `⚠ ${bad.join(", ")}에게는 보내지 못했습니다.` : "");
      } catch (e) {
        msgEl.className = "fs-msg err"; msgEl.textContent = errText(e);
      } finally { btn.disabled = false; }
    };
  }

  /* -------------------------------------------------------------------
     4) 내 전화번호 등록 (회원) — 인증번호로 본인 번호인지 확인합니다
     ------------------------------------------------------------------- */
  function openPhoneSheet(onDone) {
    const sheet = openSheet(`<h2>📱 내 전화번호 등록</h2>
      <p class="fs-desc">결과 링크를 문자로 받을 번호입니다. 본인 번호인지 확인하려고 인증번호를 보내 드립니다.</p>
      <div class="fs-row">
        <input class="fs-in" id="fsPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="010-1234-5678">
        <button class="fs-btn pri" type="button" id="fsSend">인증번호 받기</button>
      </div>
      <div class="fs-row" id="fsCodeRow" style="margin-top:10px;display:none">
        <input class="fs-in" id="fsCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="인증번호 6자리">
        <button class="fs-btn pri" type="button" id="fsVerify">확인</button>
      </div>
      <div class="fs-msg" id="fsPMsg"></div>
      <div class="fs-note">🔒 번호는 <b>암호화</b>해서 보관합니다. 암호를 푸는 열쇠는 데이터베이스와 따로 보관하며,
        문자를 보내는 순간에만 서버 안에서 풀어 씁니다. 화면에는 <b>끝 네 자리</b>만 보입니다.
        마이페이지에서 언제든 지우실 수 있습니다.</div>`);
    const $ = (s) => sheet.querySelector(s);
    const say = (t, k) => { $("#fsPMsg").textContent = t; $("#fsPMsg").className = "fs-msg" + (k ? " " + k : ""); };
    $("#fsSend").onclick = async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true; say("보내는 중…");
      try {
        const r = await sms("phone_start", { phone: $("#fsPhone").value });
        $("#fsCodeRow").style.display = "flex"; $("#fsCode").focus();
        say(`010-****-${r.last4} 로 인증번호를 보냈습니다. 5분 안에 넣어 주세요.`, "ok");
      } catch (e) { say(errText(e), "err"); }
      finally { btn.disabled = false; }
    };
    $("#fsVerify").onclick = async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await sms("phone_verify", { code: $("#fsCode").value });
        closeSheet(); toast("전화번호를 등록했습니다.");
        if (onDone) onDone();
      } catch (e) { say(errText(e), "err"); btn.disabled = false; }
    };
  }

  /* -------------------------------------------------------------------
     5) 마이페이지 — 우리 가족
     ------------------------------------------------------------------- */
  const _renderMyPage = renderMyPage;
  renderMyPage = function () {
    _renderMyPage();
    const body = document.getElementById("myBody");
    if (!body) return;
    // 회원이면 '로그인하지 않은 상태' 안내 대신 가족 칸이 보이므로, 비회원 안내 문구를 바로잡습니다
    const warn = body.querySelector(".mybox.warn");
    if (warn && !me) {
      warn.innerHTML = `지금은 <b>로그인하지 않은 상태</b>입니다. 별표와 기록은 <b>이 기기에만</b> 저장됩니다.<br>
        로그인하시면 다른 휴대전화·컴퓨터에서도 그대로 보이고, <b>가족 그룹</b>과 <b>문자 보내기</b>를 쓰실 수 있습니다.
        <button class="go" id="myLoginBtn2">로그인하러 가기</button>`;
      warn.querySelector("#myLoginBtn2").onclick = openLogin;
    }
    const sec = document.createElement("div");
    sec.className = "mysec fs-fam";
    sec.innerHTML = `<div class="myhead"><h2>👨‍👩‍👧 우리 가족</h2>
      <span class="note">가족끼리 서로의 맞춤 복지 결과와 기록을 볼 수 있습니다.</span></div>
      <div class="mywrap"><div class="mybox" id="fsFamBody">불러오는 중…</div></div>`;
    body.appendChild(sec);
    fillFamily(sec.querySelector("#fsFamBody"));
  };
  window.renderMyPage = renderMyPage;

  async function fillFamily(el) {
    if (!me) { fillGuestFamily(el); return; }
    let prof = null, fam = { groups: [], requests: [] }, shares = [];
    try {
      const [p, f, s] = await Promise.all([
        db.from("member_profile").select("handle, display_name").eq("user_id", me.id).maybeSingle(),
        rpc("my_family"),
        db.from("shared_results").select("token, created_at, expires_at")
          .eq("owner_id", me.id).gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false }).limit(10),
      ]);
      if (p.error) throw p.error;
      prof = p.data; fam = f || fam; shares = s.data || [];
    } catch (e) {
      el.innerHTML = `가족 기능을 불러오지 못했습니다. ${esc(errText(e))}`;
      return;
    }
    if (!el.isConnected) return;

    let h = "";
    // (가) 내 아이디
    if (!prof) {
      h += `<div class="fs-card"><h3>① 먼저 내 아이디를 정해 주세요</h3>
        <p>가족이 이 <b>아이디</b>로 나를 찾아 가족 그룹에 추가합니다. 이메일은 가족에게도 보이지 않습니다.</p>
        ${profileForm("", (me.email || "").split("@")[0].slice(0, 20))}</div>`;
    } else {
      h += `<div class="fs-card"><h3>🙋 내 아이디: <span style="color:#0e7d71">${esc(prof.handle)}</span></h3>
        <p>가족에게 보이는 이름: <b>${esc(prof.display_name)}</b> · 가족에게 이 아이디를 알려 주시면 추가할 수 있습니다.</p>
        <button class="fs-btn sm" type="button" data-a="editprof">이름·아이디 고치기</button>
        <div data-slot="profform" hidden>${profileForm(prof.handle, prof.display_name)}</div></div>`;
    }

    // (나) 내 전화번호
    h += `<div class="fs-card" id="fsPhoneCard"><h3>📱 내 전화번호</h3><p>확인하는 중…</p></div>`;

    // (다) 받은 요청
    (fam.requests || []).forEach((r) => {
      h += `<div class="fs-card fs-req"><h3>📩 ${esc(r.inviter_name)}님이 ‘${esc(r.group_name)}’에 초대하셨습니다</h3>
        <p>수락하시면 그 가족과 <b>서로의</b> 맞춤 복지 결과·별표·기록을 볼 수 있습니다.</p>
        <div class="fs-row"><button class="fs-btn pri" data-req="${esc(r.id)}" data-ok="1">수락하기</button>
        <button class="fs-btn" data-req="${esc(r.id)}" data-ok="0">거절하기</button></div></div>`;
    });

    // (라) 내 가족 그룹
    (fam.groups || []).forEach((g) => {
      const owner = g.my_role === "owner";
      h += `<div class="fs-card" data-group="${esc(g.id)}"><h3>🏠 ${esc(g.name)} <small style="color:#7a7264;font-size:16px">${(g.members || []).length}명</small></h3>`;
      (g.members || []).forEach((m) => {
        h += `<div class="fs-mem"><span class="nm">${esc(m.name)}${m.is_me ? " (나)" : ""}</span>
          <span class="hd">${m.handle ? esc(m.handle) : ""}${m.role === "owner" ? " · 👑 만든 분" : ""}</span><span class="sp"></span>
          ${m.is_me ? "" : `<button class="fs-btn sm pri" data-view="${esc(m.user_id)}" data-name="${esc(m.name)}">결과 보기</button>`}
          ${owner && !m.is_me ? `<button class="fs-btn sm danger" data-kick="${esc(m.user_id)}" data-name="${esc(m.name)}">내보내기</button>` : ""}</div>`;
      });
      h += `<div class="fs-row" style="margin-top:12px">
          <input class="fs-in" data-handle placeholder="가족의 아이디" autocapitalize="off" autocomplete="off">
          <button class="fs-btn pri" data-a="add">아이디로 추가</button></div>
        <div class="fs-row" style="margin-top:8px">
          <button class="fs-btn" data-a="invite">🔗 초대 링크 만들기</button>
          <button class="fs-btn danger" data-a="leave">그룹 나가기</button></div>
        <div class="fs-msg" data-msg></div></div>`;
    });

    // (마) 새 그룹
    if (prof) {
      h += `<div class="fs-card"><h3>➕ 새 가족 그룹 만들기</h3>
        <div class="fs-row"><input class="fs-in" id="fsNewGroup" maxlength="30" placeholder="예: 우리 가족">
        <button class="fs-btn pri" type="button" data-a="newgroup">만들기</button></div>
        <div class="fs-msg" id="fsNewMsg"></div></div>`;
    }

    // (바) 내가 만든 결과 링크
    if (shares.length) {
      h += `<div class="fs-card"><h3>📤 내가 보낸 결과 링크</h3>` + shares.map((s) =>
        `<div class="fs-mem"><span>${dayStr(s.created_at)}에 만든 링크 <span class="hd">· ${dayStr(s.expires_at)}까지</span></span><span class="sp"></span>
          <button class="fs-btn sm" data-copy="${esc(s.token)}">주소 복사</button>
          <button class="fs-btn sm danger" data-delshare="${esc(s.token)}">지우기</button></div>`).join("") + `</div>`;
    }
    el.innerHTML = h;
    bindFamily(el, prof);
    fillPhoneCard(el.querySelector("#fsPhoneCard"));
  }

  function profileForm(handle, name) {
    return `<div class="fs-row" style="margin-top:8px">
        <input class="fs-in" data-f="handle" value="${esc(handle)}" maxlength="20" autocapitalize="off" autocomplete="off"
          placeholder="아이디 (영문 소문자·숫자 4~20자)">
        <input class="fs-in" data-f="name" value="${esc(name)}" maxlength="20" placeholder="가족에게 보일 이름 (예: 홍길동)">
        <button class="fs-btn pri" type="button" data-a="saveprof">저장</button></div>
      <div class="fs-msg" data-profmsg></div>`;
  }

  function bindFamily(el, prof) {
    const rerender = () => { if (window.refreshMyPage) window.refreshMyPage(); };
    const q = (s) => el.querySelectorAll(s);

    const ep = el.querySelector('[data-a="editprof"]');
    if (ep) ep.onclick = () => { el.querySelector('[data-slot="profform"]').hidden = false; ep.remove(); };
    q('[data-a="saveprof"]').forEach((b) => b.onclick = async () => {
      const wrap = b.closest(".fs-card");
      const handle = wrap.querySelector('[data-f="handle"]').value.trim().toLowerCase();
      const name = wrap.querySelector('[data-f="name"]').value.trim();
      const msg = wrap.querySelector("[data-profmsg]");
      if (!/^[a-z0-9_]{4,20}$/.test(handle)) { msg.className = "fs-msg err"; msg.textContent = "아이디는 영문 소문자·숫자·밑줄(_)로 4~20자로 적어 주세요."; return; }
      if (!name) { msg.className = "fs-msg err"; msg.textContent = "가족에게 보일 이름을 적어 주세요."; return; }
      b.disabled = true;
      const { error } = await db.from("member_profile").upsert(
        { user_id: me.id, handle, display_name: name, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      b.disabled = false;
      if (error) { msg.className = "fs-msg err"; msg.textContent = errText(error); return; }
      rerender();
    });

    q("[data-req]").forEach((b) => b.onclick = async () => {
      try { await rpc("respond_family_request", { p_request: b.dataset.req, p_accept: b.dataset.ok === "1" }); rerender(); }
      catch (e) { toast(errText(e)); }
    });

    q("[data-view]").forEach((b) => b.onclick = () => viewFamily(b.dataset.view, b.dataset.name));

    q("[data-kick]").forEach((b) => b.onclick = async () => {
      if (!confirm(`${b.dataset.name}님을 이 가족 그룹에서 내보낼까요?`)) return;
      const gid = b.closest("[data-group]").dataset.group;
      try { await rpc("remove_family_member", { p_group: gid, p_user: b.dataset.kick }); rerender(); }
      catch (e) { toast(errText(e)); }
    });

    q("[data-group]").forEach((card) => {
      const gid = card.dataset.group;
      const msg = card.querySelector("[data-msg]");
      const say = (t, k) => { msg.textContent = t; msg.className = "fs-msg" + (k ? " " + k : ""); };
      card.querySelector('[data-a="add"]').onclick = async () => {
        const handle = card.querySelector("[data-handle]").value.trim();
        if (!handle) { say("가족의 아이디를 적어 주세요.", "err"); return; }
        try {
          const name = await rpc("request_family_member", { p_group: gid, p_handle: handle });
          say(`✅ ${name}님께 요청을 보냈습니다. 그분이 마이페이지에서 ‘수락하기’를 누르시면 들어옵니다.`, "ok");
          card.querySelector("[data-handle]").value = "";
        } catch (e) { say(errText(e), "err"); }
      };
      card.querySelector('[data-a="invite"]').onclick = async () => {
        try {
          const t = await rpc("create_family_invite", { p_group: gid });
          openInviteShare(inviteUrl(t), card.querySelector("h3").firstChild.textContent.replace("🏠", "").trim());
        } catch (e) { say(errText(e), "err"); }
      };
      card.querySelector('[data-a="leave"]').onclick = async () => {
        if (!confirm("이 가족 그룹에서 나갈까요? 나가시면 서로의 결과를 더는 볼 수 없습니다.")) return;
        try { await rpc("leave_family_group", { p_group: gid }); rerender(); }
        catch (e) { say(errText(e), "err"); }
      };
    });

    const ng = el.querySelector('[data-a="newgroup"]');
    if (ng) ng.onclick = async () => {
      try { await rpc("create_family_group", { p_name: el.querySelector("#fsNewGroup").value }); rerender(); }
      catch (e) { const m = el.querySelector("#fsNewMsg"); m.className = "fs-msg err"; m.textContent = errText(e); }
    };

    q("[data-copy]").forEach((b) => b.onclick = () => copyText(shareUrl(b.dataset.copy), b));
    q("[data-delshare]").forEach((b) => b.onclick = async () => {
      try { await deleteShare(b.dataset.delshare); rerender(); } catch (e) { toast(errText(e)); }
    });
  }

  async function fillPhoneCard(card) {
    if (!card) return;
    if (!SMS_ENABLED) {
      card.innerHTML = `<h3>📱 내 전화번호</h3>
        <p>번호를 등록해 결과 링크를 문자로 받는 기능을 준비하고 있습니다.</p>${soonBtn("번호 등록하기")}`;
      bindSoon(card);
      return;
    }
    let st;
    try { st = await sms("phone_status"); }
    catch (e) { card.querySelector("p").textContent = ERR.sms_unavailable; return; }
    if (!card.isConnected) return;
    if (!st.registered) {
      card.innerHTML = `<h3>📱 내 전화번호</h3>
        <p>번호를 등록하시면 결과 링크를 <b>문자로</b>받으실 수 있고, 가족도 나에게 보낼 수 있습니다. 번호는 암호화해서 보관합니다.</p>
        <button class="fs-btn pri" type="button">번호 등록하기</button>`;
      card.querySelector("button").onclick = () => openPhoneSheet(() => window.refreshMyPage && window.refreshMyPage());
      return;
    }
    card.innerHTML = `<h3>📱 내 전화번호: 010-****-${esc(st.last4)}</h3>
      <label class="fs-check"><input type="checkbox" ${st.allow_family_sms ? "checked" : ""}> 가족이 보내는 결과 문자 받기</label>
      <div class="fs-row"><button class="fs-btn sm" data-a="change">번호 바꾸기</button>
      <button class="fs-btn sm danger" data-a="del">번호 지우기</button></div>`;
    card.querySelector("input").onchange = async (e) => {
      try { await sms("phone_pref", { allow_family_sms: e.target.checked }); }
      catch (err) { toast(errText(err)); e.target.checked = !e.target.checked; }
    };
    card.querySelector('[data-a="change"]').onclick = () => openPhoneSheet(() => window.refreshMyPage && window.refreshMyPage());
    card.querySelector('[data-a="del"]').onclick = async () => {
      if (!confirm("등록한 전화번호를 지울까요? 지우면 문자를 받을 수 없습니다.")) return;
      try { await sms("phone_delete"); window.refreshMyPage && window.refreshMyPage(); } catch (e) { toast(errText(e)); }
    };
  }

  function fillGuestFamily(el) {
    const mine = lsGet(G_SHARES, []).filter((x) => new Date(x.exp).getTime() > Date.now());
    el.innerHTML = `가족 그룹은 <b>회원</b>만 만들 수 있습니다. 로그인하시면
      <b>아이디로 가족을 추가</b>하거나 <b>초대 링크</b>로 모여, 서로의 맞춤 복지 결과를 보실 수 있습니다.<br>
      (결과를 링크로 보내는 것은 로그인하지 않아도 됩니다 — 결과 화면의 <b>📤 보내기</b> 버튼)
      <button class="go" type="button" data-a="login">로그인하러 가기</button>
      ${mine.length ? `<div class="fs-card"><h3>📤 이 기기에서 만든 결과 링크</h3>` + mine.map((s) =>
        `<div class="fs-mem"><span>${dayStr(s.at || Date.now())}에 만든 링크 <span class="hd">· ${dayStr(s.exp)}까지</span></span><span class="sp"></span>
          <button class="fs-btn sm" data-copy="${esc(s.token)}">주소 복사</button>
          <button class="fs-btn sm danger" data-delshare="${esc(s.token)}">지우기</button></div>`).join("") + `</div>` : ""}`;
    el.querySelector('[data-a="login"]').onclick = openLogin;
    el.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => copyText(shareUrl(b.dataset.copy), b));
    el.querySelectorAll("[data-delshare]").forEach((b) => b.onclick = async () => {
      try { await deleteShare(b.dataset.delshare); window.refreshMyPage && window.refreshMyPage(); } catch (e) { toast(errText(e)); }
    });
  }

  function openInviteShare(url, groupName) {
    const msg = `‘${groupName}’ 가족 그룹에 초대합니다. 아래 링크를 눌러 합류해 주세요 (3일 안에).\n${url}`;
    const sheet = openSheet(`<h2>🔗 초대 링크</h2>
      <p class="fs-desc">이 링크를 받은 분이 <b>로그인한 뒤 ‘합류하기’</b>를 누르면 가족이 됩니다.
        <b>3일</b> 동안, <b>5명</b>까지 쓸 수 있습니다. 가족에게만 보내 주세요.</p>
      <div class="fs-row"><input class="fs-in" readonly value="${esc(url)}" aria-label="초대 링크">
        <button class="fs-btn" type="button" data-a="copy">📋 복사</button></div>
      <a class="fs-btn wide" href="${esc(smsHref(msg))}">💬 내 휴대전화 문자로 보내기</a>
      ${navigator.share ? `<button class="fs-btn wide" type="button" data-a="native">📲 카카오톡 등 다른 앱으로 보내기</button>` : ""}`);
    sheet.querySelector('[data-a="copy"]').onclick = (e) => copyText(url, e.currentTarget);
    const nat = sheet.querySelector('[data-a="native"]');
    if (nat) nat.onclick = () => navigator.share({ title: "가족 그룹 초대", text: msg }).catch(() => {});
  }

  // 가족의 저장된 답으로 결과 보기 (RLS '가족은 읽기' 정책 덕분에 읽힙니다)
  async function viewFamily(uid, name) {
    try {
      const [p, f, s] = await Promise.all([
        db.from("profile_info").select("data").eq("user_id", uid).maybeSingle(),
        db.from("favorites").select("welfare_id").eq("user_id", uid),
        db.from("welfare_status").select("welfare_id,status").eq("user_id", uid),
      ]);
      if (p.error) throw p.error;
      if (!p.data) {
        toast(`${name}님은 아직 답을 저장하지 않으셨습니다. 결과 화면의 ‘💾 이 정보 저장하기’를 누르시면 가족이 볼 수 있습니다.`);
        return;
      }
      const st = {};
      (s.data || []).forEach((r) => { st[r.welfare_id] = r.status; });
      enterView(p.data.data, { kind: "family", name, records: { fav: (f.data || []).map((r) => r.welfare_id), st } });
    } catch (e) { toast(errText(e)); }
  }

  /* -------------------------------------------------------------------
     6) 주소로 들어온 경우 — ?s=결과링크 / ?invite=초대링크
     ------------------------------------------------------------------- */
  async function openSharedFromUrl(token) {
    try {
      const rows = await rpc("get_shared_result", { p_token: token });
      const r = rows && rows[0];
      if (!r) { stripParam("s"); toast("이 결과 링크는 기한이 지났거나 지워졌습니다. 보내신 분께 새 링크를 부탁해 주세요."); return; }
      enterView(r.data, { kind: "shared", sender: r.sender_name, created: r.created_at, expires: r.expires_at });
    } catch (e) { toast(errText(e)); }
  }

  let inviteShown = "";
  async function handlePendingInvite() {
    const p = lsGet(G_INVITE, null);
    if (!p || !p.token) return;
    if (Date.now() - (p.at || 0) > 3 * 86400e3) { lsSet(G_INVITE, null); return; }
    const stateKey = p.token + "|" + (me ? me.id : "guest");
    if (inviteShown === stateKey) return;
    inviteShown = stateKey;
    let info;
    try { info = (await rpc("peek_family_invite", { p_token: p.token }) || [])[0]; } catch (e) { return; }
    if (!info) { lsSet(G_INVITE, null); toast(ERR.invite_invalid); return; }

    const sheet = openSheet(`<h2>👨‍👩‍👧 가족 그룹 초대</h2>
      <p class="fs-desc"><b>${esc(info.inviter_name)}</b>님이 <b>‘${esc(info.group_name)}’</b> 가족 그룹에 초대하셨습니다.</p>
      <p class="fs-desc">합류하시면 이 가족과 <b>서로의</b> 맞춤 복지 결과·별표·기록을 볼 수 있습니다. 언제든 나가실 수 있습니다.</p>
      ${me ? `<button class="fs-btn wide pri" type="button" data-a="join">합류하기</button>`
           : `<button class="fs-btn wide pri" type="button" data-a="login">로그인하고 합류하기</button>
              <p class="fs-desc" style="font-size:16px;margin-top:10px">회원이 아니시면 로그인 창에서 ‘회원가입’을 누르세요. 가입 후 이 화면이 다시 뜹니다.</p>`}
      <button class="fs-btn wide" type="button" data-a="no">초대 받지 않기</button>
      <div class="fs-msg" id="fsInvMsg"></div>`);
    const j = sheet.querySelector('[data-a="join"]');
    if (j) j.onclick = async () => {
      try {
        await rpc("join_family_by_invite", { p_token: p.token });
        lsSet(G_INVITE, null); closeSheet();
        toast(`‘${info.group_name}’ 가족이 되었습니다.`);
        switchTab("my");
      } catch (e) { sheet.querySelector("#fsInvMsg").className = "fs-msg err"; sheet.querySelector("#fsInvMsg").textContent = errText(e); }
    };
    const l = sheet.querySelector('[data-a="login"]');
    if (l) l.onclick = () => { closeSheet(); openLogin(); };
    sheet.querySelector('[data-a="no"]').onclick = () => { lsSet(G_INVITE, null); closeSheet(); };
  }

  const qs = new URLSearchParams(window.location.search);
  if (qs.get("invite")) {
    lsSet(G_INVITE, { token: qs.get("invite"), at: Date.now() });
    stripParam("invite");
  }
  const sharedToken = qs.get("s");

  /* -------------------------------------------------------------------
     7) 로그인 상태 따라가기
     ------------------------------------------------------------------- */
  let firstAuth = true;
  db.auth.onAuthStateChange((event, session) => {
    const prev = me ? me.id : null;
    me = session ? session.user : null;
    // 로그아웃하면 가족 결과 보기는 닫습니다 (공유 링크 보기는 그대로)
    if (!me && VIEW && VIEW.kind === "family") exitView();
    if (firstAuth || prev !== (me ? me.id : null)) {
      firstAuth = false;
      setTimeout(handlePendingInvite, 0);   // supabase 콜백 안에서 바로 DB 를 부르면 멈출 수 있어 한 박자 뒤에
      if (window.refreshMyPage) setTimeout(window.refreshMyPage, 0);
    }
  });

  if (sharedToken) openSharedFromUrl(sharedToken);
})();
