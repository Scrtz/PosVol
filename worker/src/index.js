import { PostalMime } from "postal-mime";

const ADDRESS_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const TTL_OPTIONS_MINUTES = [10, 30, 60, 60 * 24];
const PBKDF2_ITERATIONS = 100000;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function randomLocalPart(length = 10) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ADDRESS_CHARS[b % ADDRESS_CHARS.length];
  return out;
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, key, 256);
  return `${PBKDF2_ITERATIONS}:${bufToHex(salt)}:${bufToHex(bits)}`;
}

async function verifyPassword(password, stored) {
  const [iterStr, saltHex, hashHex] = (stored || "").split(":");
  if (!iterStr || !saltHex || !hashHex) return false;
  const iterations = Number(iterStr);
  const salt = hexToBytes(saltHex);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return bufToHex(bits) === hashHex;
}

function b64url(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new TextEncoder().encode(input);
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(env) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(env.AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signToken(payload, env) {
  const body = b64url(JSON.stringify(payload));
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verifyToken(token, env) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const key = await hmacKey(env);
  const valid = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), new TextEncoder().encode(body));
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  if (payload.exp && payload.exp < Date.now()) return null;
  return payload;
}

async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const payload = await verifyToken(token, env);
  return payload ? { id: payload.sub, username: payload.username } : null;
}

export default {
  async email(message, env, ctx) {
    const to = message.to.toLowerCase();
    const addr = await env.DB.prepare(
      "SELECT address FROM addresses WHERE address = ? AND (expires_at IS NULL OR expires_at > ?)"
    ).bind(to, Date.now()).first();
    if (!addr) {
      message.setReject("Endereço inexistente ou expirado");
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    await env.DB.prepare(
      `INSERT INTO messages (id, address, from_addr, subject, text_body, html_body, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), to,
      parsed.from?.address || message.from || "",
      parsed.subject || "(sem assunto)",
      parsed.text || "", parsed.html || "",
      Date.now()
    ).run();
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders(env) });

    try {
      if (path === "/api/auth/register" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim().toLowerCase();
        const password = body.password || "";
        if (username.length < 3 || password.length < 8) {
          return json({ error: "usuário precisa de 3+ caracteres e senha de 8+ caracteres" }, env, 400);
        }
        const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
        if (existing) return json({ error: "esse usuário já existe" }, env, 409);

        const id = crypto.randomUUID();
        const password_hash = await hashPassword(password);
        await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, username, password_hash, Date.now()).run();
        const token = await signToken({ sub: id, username, exp: Date.now() + TOKEN_TTL_MS }, env);
        return json({ token, username }, env);
      }

      if (path === "/api/auth/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || "").trim().toLowerCase();
        const password = body.password || "";
        const user = await env.DB.prepare("SELECT id, password_hash FROM users WHERE username = ?").bind(username).first();
        if (!user || !(await verifyPassword(password, user.password_hash))) {
          return json({ error: "usuário ou senha incorretos" }, env, 401);
        }
        const token = await signToken({ sub: user.id, username, exp: Date.now() + TOKEN_TTL_MS }, env);
        return json({ token, username }, env);
      }

      if (path === "/api/auth/me" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "não autenticado" }, env, 401);
        return json({ id: user.id, username: user.username }, env);
      }

      if (path === "/api/auth/me/addresses" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "não autenticado" }, env, 401);
        const { results } = await env.DB.prepare(
          "SELECT address, created_at FROM addresses WHERE user_id = ? ORDER BY created_at DESC"
        ).bind(user.id).all();
        return json({ addresses: results }, env);
      }

      if (path === "/api/auth/claim" && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "não autenticado" }, env, 401);
        const body = await request.json().catch(() => ({}));
        if (!body.address) return json({ error: "address é obrigatório" }, env, 400);
        const result = await env.DB.prepare(
          "UPDATE addresses SET user_id = ?, expires_at = NULL WHERE address = ?"
        ).bind(user.id, body.address).run();
        if (!result.meta.changes) return json({ error: "endereço não encontrado" }, env, 404);
        return json({ address: body.address, claimed: true, permanent: true }, env);
      }

      if (path === "/api/generate" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const permanent = body.permanent === true;
        const ttl = TTL_OPTIONS_MINUTES.includes(body.ttl_minutes) ? body.ttl_minutes : 30;
        const local = randomLocalPart();
        const address = `${local}@${env.MAIL_DOMAIN}`;
        const now = Date.now();
        const expiresAt = permanent ? null : now + ttl * 60 * 1000;

        const user = permanent ? await getUser(request, env) : null;

        await env.DB.prepare(
          "INSERT INTO addresses (id, address, created_at, expires_at, user_id) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), address, now, expiresAt, user?.id || null).run();

        return json({ address, created_at: now, expires_at: expiresAt, permanent, owned: !!user }, env);
      }

      if (path === "/api/renew" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const ttl = TTL_OPTIONS_MINUTES.includes(body.ttl_minutes) ? body.ttl_minutes : 30;
        if (!body.address) return json({ error: "address é obrigatório" }, env, 400);
        const expiresAt = Date.now() + ttl * 60 * 1000;
        const result = await env.DB.prepare("UPDATE addresses SET expires_at = ? WHERE address = ?")
          .bind(expiresAt, body.address).run();
        if (!result.meta.changes) return json({ error: "endereço não encontrado" }, env, 404);
        return json({ address: body.address, expires_at: expiresAt }, env);
      }

      const inboxMatch = path.match(/^\/api\/inbox\/([^/]+)$/);
      if (inboxMatch && request.method === "GET") {
        const address = decodeURIComponent(inboxMatch[1]);
        const addr = await env.DB.prepare("SELECT expires_at FROM addresses WHERE address = ?").bind(address).first();
        if (!addr) return json({ error: "endereço não encontrado" }, env, 404);
        const { results } = await env.DB.prepare(
          `SELECT id, from_addr, subject, received_at FROM messages WHERE address = ? ORDER BY received_at DESC LIMIT 100`
        ).bind(address).all();
        return json({ expires_at: addr.expires_at, messages: results }, env);
      }

      const msgMatch = path.match(/^\/api\/message\/([^/]+)$/);
      if (msgMatch && request.method === "GET") {
        const id = decodeURIComponent(msgMatch[1]);
        const msg = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first();
        if (!msg) return json({ error: "mensagem não encontrada" }, env, 404);
        return json(msg, env);
      }

      const delMatch = path.match(/^\/api\/address\/([^/]+)$/);
      if (delMatch && request.method === "DELETE") {
        const address = decodeURIComponent(delMatch[1]);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM addresses WHERE address = ?").bind(address),
          env.DB.prepare("DELETE FROM messages WHERE address = ?").bind(address),
        ]);
        return json({ deleted: true }, env);
      }

      return json({ error: "rota não encontrada" }, env, 404);
    } catch (err) {
      return json({ error: "erro interno", detail: String(err) }, env, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const now = Date.now();
    const retentionMs = (Number(env.RETENTION_HOURS) || 6) * 60 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM addresses WHERE expires_at IS NOT NULL AND expires_at < ? AND user_id IS NULL"
      ).bind(now),
      env.DB.prepare(
        `DELETE FROM messages WHERE received_at < ?
         AND address NOT IN (SELECT address FROM addresses WHERE expires_at IS NULL OR user_id IS NOT NULL)`
      ).bind(now - retentionMs),
    ]);
  },
};
