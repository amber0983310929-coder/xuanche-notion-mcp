import { GatewayError } from "./http.js";

const COOKIE_NAME = "__Host-xuanche_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export async function requireSession(request, env) {
  const token = cookieValue(request.headers.get("cookie"), COOKIE_NAME);
  if (token && await verifySessionToken(token, sessionSecret(env))) {
    return { type: "session", subject: "owner" };
  }
  throw new GatewayError(401, "請先解鎖遊戲。");
}

export function authConfiguration(env) {
  return {
    passphrase: Boolean(env.PWA_ACCESS_KEY),
    sessionSecret: Boolean(sessionSecret(env)),
  };
}

export async function createOwnerSession(passphrase, env) {
  if (!env.PWA_ACCESS_KEY || !sessionSecret(env)) {
    throw new GatewayError(503, "PWA 尚未完成私人登入設定。");
  }
  if (!constantTimeEqual(String(passphrase || ""), String(env.PWA_ACCESS_KEY))) {
    throw new GatewayError(401, "通行詞不正確。");
  }
  const expiresAt = Math.floor(Date.now() / 1_000) + SESSION_SECONDS;
  const token = await createSessionToken({ version: 1, subject: "owner", expiresAt }, sessionSecret(env));
  return {
    expiresAt,
    cookie: `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`,
  };
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export async function createSessionToken(payload, secret) {
  if (!secret) throw new GatewayError(503, "PWA session secret is not configured.");
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(encoded, secret);
  return `${encoded}.${base64UrlBytes(signature)}`;
}

export async function verifySessionToken(token, secret, now = Math.floor(Date.now() / 1_000)) {
  if (!secret || typeof token !== "string") return false;
  const [encoded, encodedSignature, extra] = token.split(".");
  if (!encoded || !encodedSignature || extra !== undefined) return false;
  let payload;
  let signature;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
    signature = base64UrlToBytes(encodedSignature);
  } catch {
    return false;
  }
  const key = await importHmacKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(encoded));
  return valid && payload?.version === 1 && payload?.subject === "owner" &&
    Number.isInteger(payload?.expiresAt) && payload.expiresAt > now;
}

function sessionSecret(env) {
  return env.PWA_SESSION_SECRET || env.XUANCHE_API_KEY || "";
}

async function hmac(value, secret) {
  const key = await importHmacKey(secret, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function importHmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return part.slice(index + 1).trim();
  }
  return null;
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left));
  const b = new TextEncoder().encode(String(right));
  let diff = a.length ^ b.length;
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) diff |= (a[index] || 0) ^ (b[index] || 0);
  return diff === 0;
}

function base64UrlEncode(value) {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
