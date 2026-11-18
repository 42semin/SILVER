// crypto.ts — 전화번호 암호화 / 해시
//
// 암호 알고리즘은 직접 만들지 않습니다.
//   · 암호화: Web Crypto API 의 AES-256-GCM (Deno 런타임 표준, 인증 암호화)
//   · 해시  : Web Crypto API 의 HMAC-SHA-256
//   · base64: Deno 표준 라이브러리 @std/encoding
//
// 키는 코드·데이터베이스 어디에도 없습니다. Supabase Edge Function 비밀값(Secrets)으로만 받습니다.
//   PHONE_ENC_KEYS       {"k1":"<base64 32바이트>", "k2": ...}   ← 여러 개를 두면 키 교체(회전) 가능
//   PHONE_ENC_ACTIVE_KID "k1"                                     ← 새로 암호화할 때 쓸 키 번호
//   PHONE_HMAC_KEY       "<base64 32바이트>"                       ← 암호화 키와 다른, 별도의 키
//
// 저장 형식: "키번호.IV(base64).암호문+태그(base64)"
//   · IV 는 암호화할 때마다 새 12바이트 난수 (crypto.getRandomValues)
//   · AAD(추가 인증 데이터)에 user_id 를 넣어, 암호문을 다른 회원 행으로 옮겨 붙이면 복호화가 실패합니다.

import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1/base64";

type Env = { get(name: string): string | undefined };

const te = new TextEncoder();
const td = new TextDecoder();

function need(env: Env, name: string): string {
  const v = env.get(name);
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

function rawKey(b64: string, label: string): Uint8Array {
  const raw = decodeBase64(b64.trim());
  if (raw.length !== 32) throw new Error(`${label} must be 32 bytes (base64)`);
  return raw;
}

export class PhoneCrypto {
  private aesKeys = new Map<string, Promise<CryptoKey>>();
  private hmacKey: Promise<CryptoKey>;
  private activeKid: string;

  constructor(env: Env) {
    const keys = JSON.parse(need(env, "PHONE_ENC_KEYS")) as Record<string, string>;
    this.activeKid = need(env, "PHONE_ENC_ACTIVE_KID");
    for (const [kid, b64] of Object.entries(keys)) {
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(kid)) throw new Error("bad key id");
      this.aesKeys.set(kid, crypto.subtle.importKey(
        "raw", rawKey(b64, `PHONE_ENC_KEYS.${kid}`), { name: "AES-GCM" }, false, ["encrypt", "decrypt"],
      ));
    }
    if (!this.aesKeys.has(this.activeKid)) throw new Error("active key id not found in PHONE_ENC_KEYS");
    this.hmacKey = crypto.subtle.importKey(
      "raw", rawKey(need(env, "PHONE_HMAC_KEY"), "PHONE_HMAC_KEY"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
  }

  async encrypt(plain: string, userId: string): Promise<string> {
    const key = await this.aesKeys.get(this.activeKid)!;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: te.encode(userId) }, key, te.encode(plain),
    ));
    return `${this.activeKid}.${encodeBase64(iv)}.${encodeBase64(ct)}`;
  }

  async decrypt(blob: string, userId: string): Promise<string> {
    const [kid, ivB64, ctB64] = blob.split(".");
    const keyP = this.aesKeys.get(kid);
    if (!keyP || !ivB64 || !ctB64) throw new Error("unknown key id or bad ciphertext");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(ivB64), additionalData: te.encode(userId) },
      await keyP, decodeBase64(ctB64),
    );
    return td.decode(pt);
  }

  /** 같은 입력이면 같은 값이 나오는 키 있는 해시. 평문 없이 '같은 번호인지'만 셀 때 씁니다. */
  async hmac(message: string): Promise<string> {
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await this.hmacKey, te.encode(message)));
    return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** 지금 쓰는 키가 아닌 옛 키로 된 암호문인지 (키 교체 후 다시 암호화할 때) */
  isStale(blob: string): boolean {
    return !blob.startsWith(this.activeKid + ".");
  }
}

/** 010-1234-5678, +82 10 1234 5678 같은 입력을 01012345678 로 맞춥니다. 휴대전화가 아니면 null */
export function normalizeKrMobile(input: string): string | null {
  let d = String(input || "").replace(/\D/g, "");
  if (d.startsWith("82")) d = "0" + d.slice(2);
  return /^01[016789]\d{7,8}$/.test(d) ? d : null;
}

/** 6자리 인증번호 — 모듈로 편향 없이 */
export function randomCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

/** 두 문자열을 일정한 시간에 비교 (해시끼리 비교할 때) */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
