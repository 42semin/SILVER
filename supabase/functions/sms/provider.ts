// provider.ts — 실제 문자 발송
//
// SMS_PROVIDER 비밀값으로 고릅니다.
//   "solapi"  : 솔라피(구 CoolSMS) REST API v4. 국내 발송. 발신번호 사전등록이 법으로 필요합니다.
//               SOLAPI_API_KEY / SOLAPI_API_SECRET / SMS_SENDER(등록한 발신번호)
//   "console" : 보내지 않고 Edge Function 로그에만 남깁니다 (개발·시연용, 기본값)
//
// 서명(HMAC-SHA256)도 Web Crypto 표준 API 로 만듭니다.

type Env = { get(name: string): string | undefined };

export interface SmsResult { ok: boolean; detail?: string }

export async function sendSms(env: Env, to: string, text: string): Promise<SmsResult> {
  const provider = (env.get("SMS_PROVIDER") || "console").toLowerCase();
  if (provider === "solapi") return solapi(env, to, text);
  // 개발용: 번호는 가려서 로그에 남깁니다.
  console.log(`[SMS:console] to=${to.slice(0, 3)}****${to.slice(-4)}\n${text}`);
  return { ok: true, detail: "console" };
}

async function solapi(env: Env, to: string, text: string): Promise<SmsResult> {
  const apiKey = env.get("SOLAPI_API_KEY");
  const secret = env.get("SOLAPI_API_SECRET");
  const from = (env.get("SMS_SENDER") || "").replace(/\D/g, "");
  if (!apiKey || !secret || !from) return { ok: false, detail: "provider_not_configured" };

  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replaceAll("-", "");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(date + salt)));
  const signature = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");

  const res = await fetch("https://api.solapi.com/messages/v4/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    // 글자 수에 따라 SMS/LMS 는 솔라피가 알아서 고릅니다.
    body: JSON.stringify({ message: { to, from, text } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("[SMS:solapi] failed", res.status, body.slice(0, 300));
    return { ok: false, detail: `http_${res.status}` };
  }
  return { ok: true };
}
