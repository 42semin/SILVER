// supabase/functions/sms/index.ts — 회원 전화번호 등록 · 결과 링크 문자 보내기
//
// 브라우저는 전화번호 평문을 '등록할 때 한 번'만 보냅니다(HTTPS).
// 이 함수가 받자마자 AES-256-GCM 으로 암호화해 DB 에 넣고, 문자를 보낼 때만 메모리에서 풀어 씁니다.
// 브라우저로는 끝 4자리만 돌려줍니다.
//
// 동작(action)
//   phone_status              내 번호 등록 여부, 끝 4자리, 가족 문자 받기 설정
//   phone_start   {phone}     인증번호 문자 보내기 (5분 유효)
//   phone_verify  {code}      인증번호 확인 → 번호 저장
//   phone_pref    {allow_family_sms}
//   phone_delete              번호 지우기
//   send_share    {token, to:["me" | 가족 user_id, ...]}   공유 링크를 문자로 보내기
//
// 비밀값(Secrets) — `supabase secrets set` 으로만 넣습니다. 저장소·DB 에 두지 않습니다.
//   PHONE_ENC_KEYS, PHONE_ENC_ACTIVE_KID, PHONE_HMAC_KEY   (crypto.ts 참고)
//   SMS_PROVIDER, SOLAPI_API_KEY, SOLAPI_API_SECRET, SMS_SENDER   (provider.ts 참고)
//   SITE_URL       문자에 넣을 사이트 주소 (예: https://silver-lilac.vercel.app)
//   ALLOWED_ORIGINS 쉼표로 구분한 허용 출처 (CORS)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 Supabase 가 자동으로 넣어 줍니다.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { normalizeKrMobile, PhoneCrypto, randomCode, safeEqual } from "./crypto.ts";
import { sendSms } from "./provider.ts";

const env = Deno.env;

// 발송 한도 — 문자 폭탄·요금 폭탄을 막습니다.
const LIMIT = {
  otpPerUser10m: 3,     // 인증번호: 한 회원이 10분에 3번
  otpPerPhoneDay: 5,    // 인증번호: 한 번호로 하루 5번
  sharePerUserDay: 20,  // 공유 문자: 한 회원이 하루 20통
  sharePerPhoneDay: 10, // 공유 문자: 한 번호가 하루 10통까지만 받음
  otpTries: 5,          // 인증번호 틀릴 수 있는 횟수
};

class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? (origin || "*") : allowed[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" },
  });
}

let cryptoBox: PhoneCrypto | null = null;
function box(): PhoneCrypto {
  if (!cryptoBox) cryptoBox = new PhoneCrypto(env);   // 비밀값이 없으면 여기서 멈춥니다
  return cryptoBox;
}

async function countSince(admin: SupabaseClient, col: "user_id" | "phone_hash", val: string,
                          kind: "otp" | "share", ms: number): Promise<number> {
  const { count, error } = await admin.from("sms_log")
    .select("id", { count: "exact", head: true })
    .eq(col, val).eq("kind", kind)
    .gte("created_at", new Date(Date.now() - ms).toISOString());
  if (error) throw error;
  return count ?? 0;
}

const MIN = 60_000, DAY = 86_400_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  try {
    const admin = createClient(env.get("SUPABASE_URL")!, env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── 회원 확인: 로그인 토큰이 없으면 문자 기능은 쓸 수 없습니다 ──
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: ud, error: ue } = await admin.auth.getUser(jwt);
    if (ue || !ud?.user) throw new HttpError(401, "login_required");
    const uid = ud.user.id;

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    switch (action) {
      case "phone_status": {
        const { data } = await admin.from("member_phones")
          .select("last4, allow_family_sms").eq("user_id", uid).maybeSingle();
        return json(req, 200, data ? { registered: true, ...data } : { registered: false });
      }

      case "phone_start": {
        const phone = normalizeKrMobile(body.phone);
        if (!phone) throw new HttpError(400, "bad_phone");
        const c = box();
        const phoneHash = await c.hmac("phone:" + phone);
        if (await countSince(admin, "user_id", uid, "otp", 10 * MIN) >= LIMIT.otpPerUser10m ||
            await countSince(admin, "phone_hash", phoneHash, "otp", DAY) >= LIMIT.otpPerPhoneDay) {
          throw new HttpError(429, "too_many");
        }
        const code = randomCode();
        const { error } = await admin.from("phone_verifications").upsert({
          user_id: uid,
          phone_enc: await c.encrypt(phone, uid),
          phone_hash: phoneHash,
          last4: phone.slice(-4),
          code_hash: await c.hmac(`otp:${uid}:${code}`),
          attempts: 0,
          expires_at: new Date(Date.now() + 5 * MIN).toISOString(),
        });
        if (error) throw error;
        await admin.from("sms_log").insert({ user_id: uid, kind: "otp", phone_hash: phoneHash });
        const r = await sendSms(env, phone, `[대전 어르신 복지 찾기] 인증번호 ${code}\n5분 안에 입력해 주세요.`);
        if (!r.ok) throw new HttpError(502, "sms_failed");
        return json(req, 200, { sent: true, last4: phone.slice(-4) });
      }

      case "phone_verify": {
        const code = String(body.code || "").replace(/\D/g, "");
        const { data: v } = await admin.from("phone_verifications").select("*").eq("user_id", uid).maybeSingle();
        if (!v || new Date(v.expires_at).getTime() < Date.now()) throw new HttpError(400, "expired");
        if (v.attempts >= LIMIT.otpTries) throw new HttpError(429, "too_many_tries");
        const c = box();
        if (!safeEqual(await c.hmac(`otp:${uid}:${code}`), v.code_hash)) {
          await admin.from("phone_verifications").update({ attempts: v.attempts + 1 }).eq("user_id", uid);
          throw new HttpError(400, "wrong_code");
        }
        const { error } = await admin.from("member_phones").upsert({
          user_id: uid, phone_enc: v.phone_enc, phone_hash: v.phone_hash, last4: v.last4,
          verified_at: new Date().toISOString(),
        });
        if (error) throw error;
        await admin.from("phone_verifications").delete().eq("user_id", uid);
        return json(req, 200, { registered: true, last4: v.last4 });
      }

      case "phone_pref": {
        const { error } = await admin.from("member_phones")
          .update({ allow_family_sms: !!body.allow_family_sms }).eq("user_id", uid);
        if (error) throw error;
        return json(req, 200, { ok: true });
      }

      case "phone_delete": {
        await admin.from("member_phones").delete().eq("user_id", uid);
        await admin.from("phone_verifications").delete().eq("user_id", uid);
        return json(req, 200, { ok: true });
      }

      case "send_share": {
        const token = String(body.token || "");
        const to: string[] = Array.isArray(body.to) ? body.to.map(String).slice(0, 10) : [];
        if (!token || to.length === 0) throw new HttpError(400, "bad_request");

        // 내가 만든, 아직 살아 있는 링크만 보낼 수 있습니다.
        const { data: share } = await admin.from("shared_results")
          .select("token, expires_at").eq("token", token).eq("owner_id", uid).maybeSingle();
        if (!share || new Date(share.expires_at).getTime() < Date.now()) throw new HttpError(404, "no_share");

        // 받는 사람: "me" 는 나, 나머지는 나와 같은 가족 그룹이면서 '가족 문자 받기'를 켜 둔 분만
        const ids = new Set<string>();
        if (to.includes("me")) ids.add(uid);
        const others = to.filter((x) => x !== "me" && /^[0-9a-f-]{36}$/i.test(x) && x !== uid);
        if (others.length) {
          const { data: mine } = await admin.from("family_members").select("group_id").eq("user_id", uid);
          const groups = (mine || []).map((r) => r.group_id);
          if (groups.length) {
            const { data: fam } = await admin.from("family_members")
              .select("user_id").in("group_id", groups).in("user_id", others);
            (fam || []).forEach((r) => ids.add(r.user_id));
          }
        }
        if (ids.size === 0) throw new HttpError(403, "no_recipient");

        const { data: phones } = await admin.from("member_phones")
          .select("user_id, phone_enc, phone_hash, allow_family_sms").in("user_id", [...ids]);
        const { data: names } = await admin.from("member_profile")
          .select("user_id, display_name").in("user_id", [...ids, uid]);
        const nameOf = (id: string) => (names || []).find((n) => n.user_id === id)?.display_name;

        const sender = nameOf(uid) || "가족";
        const site = (env.get("SITE_URL") || "https://silver-lilac.vercel.app").replace(/\/+$/, "");
        const text = `[대전 어르신 복지 찾기]\n${sender}님이 복지 찾기 결과를 보냈습니다.\n${site}/?s=${token}`;

        const c = box();
        const results: { to: string; name: string; ok: boolean; reason?: string }[] = [];
        for (const id of ids) {
          const label = id === uid ? "나" : (nameOf(id) || "가족");
          const ph = (phones || []).find((p) => p.user_id === id);
          if (!ph) { results.push({ to: id === uid ? "me" : id, name: label, ok: false, reason: "no_phone" }); continue; }
          if (id !== uid && !ph.allow_family_sms) {
            results.push({ to: id, name: label, ok: false, reason: "opted_out" }); continue;
          }
          if (await countSince(admin, "user_id", uid, "share", DAY) >= LIMIT.sharePerUserDay ||
              await countSince(admin, "phone_hash", ph.phone_hash, "share", DAY) >= LIMIT.sharePerPhoneDay) {
            results.push({ to: id === uid ? "me" : id, name: label, ok: false, reason: "too_many" }); continue;
          }
          const phone = await c.decrypt(ph.phone_enc, id);   // 평문은 이 줄부터 발송까지만 메모리에
          await admin.from("sms_log").insert({ user_id: uid, kind: "share", phone_hash: ph.phone_hash });
          const r = await sendSms(env, phone, text);
          results.push({ to: id === uid ? "me" : id, name: label, ok: r.ok, reason: r.ok ? undefined : "sms_failed" });
          // 옛 키로 된 암호문이면 지금 키로 다시 암호화해 둡니다 (키 교체)
          if (c.isStale(ph.phone_enc)) {
            await admin.from("member_phones").update({ phone_enc: await c.encrypt(phone, id) }).eq("user_id", id);
          }
        }
        return json(req, 200, { results });
      }

      default:
        throw new HttpError(400, "unknown_action");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.code });
    console.error("[sms] error", e instanceof Error ? e.message : e);
    return json(req, 500, { error: "server_error" });
  }
});
