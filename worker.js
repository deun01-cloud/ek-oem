/**
 * EK OEM — Unified Cloudflare Worker
 * ─────────────────────────────────────
 * 역할 1: Notion API CORS 프록시   → /notion/*
 * 역할 2: R2 파일 업로드/조회/삭제  → /r2/*
 * 역할 3: Claude API 프록시        → /claude       ★추가
 * 역할 4: 이미지 검색 프록시        → /imgsearch    ★추가
 *
 * 환경변수 (Worker Settings → Variables & Secrets):
 *   NOTION_TOKEN     : Notion Integration Token (secret_xxx)
 *   PEXELS_KEY       : Pexels API 키 (이미지 검색 — 무료, pexels.com/api)   ★변경
 *   GOOGLE_CSE_KEY   : (선택) Pexels 미설정 시 폴백용 Google 키            ★선택
 *   GOOGLE_CSE_CX    : (선택) 폴백용 Google 검색엔진 ID                    ★선택
 *
 * R2 바인딩 (Worker Settings → Bindings → R2 bucket):
 *   변수명: EK_FILES  / 버킷명: ek-files
 */

const NOTION_VERSION = "2022-06-28";
const NOTION_BASE    = "https://api.notion.com/v1";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";   // ★추가
const ANTHROPIC_VERSION = "2023-06-01";                            // ★추가

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  // x-anthropic-key 추가 (앱이 Claude 호출 시 보내는 헤더)
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Notion-Version, X-File-Name, X-File-Type, X-Encoding, x-anthropic-key",
};

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path.startsWith("/notion"))    return handleNotion(request, env, url, path);
    if (path.startsWith("/r2"))        return handleR2(request, env, url, path);
    if (path === "/claude")            return handleClaude(request, env);      // ★추가
    if (path === "/imgsearch")         return handleImageSearch(request, env, url); // ★추가

    return json({ ok: true, routes: ["/notion/*", "/r2/upload", "/r2/list", "/r2/file/:key", "/claude", "/imgsearch"] });
  },
};

// ══════════════════════════════════════
// Notion API 프록시
// ══════════════════════════════════════
async function handleNotion(request, env, url, path) {
  const token = env.NOTION_TOKEN;
  if (!token) return json({ error: "NOTION_TOKEN not configured in Worker environment" }, 500);

  const notionPath = path.replace(/^\/notion/, "");
  const notionUrl  = NOTION_BASE + notionPath + url.search;

  let body = undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.text();
  }

  const res = await fetch(notionUrl, {
    method: request.method,
    headers: {
      "Authorization":  `Bearer ${token}`,
      "Content-Type":   "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body,
  });

  const data = await res.json();
  return json(data, res.status);
}

// ══════════════════════════════════════
// Claude API 프록시  ★추가
// ──────────────────────────────────────
// 앱(callClaudeAPI)이 보내는 요청:
//   POST /claude
//   headers: { x-anthropic-key: <키> }
//   body:    { model, max_tokens, messages, tools? }  ← 그대로 Anthropic에 전달
// 웹 검색을 쓰면 body.tools에 web_search 도구가 들어옵니다.
// ══════════════════════════════════════
async function handleClaude(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  // 키는 앱이 헤더로 보냄(우선) → 없으면 Worker 환경변수(ANTHROPIC_KEY) 폴백
  const key = request.headers.get("x-anthropic-key") || env.ANTHROPIC_KEY;
  if (!key) return json({ error: "Anthropic API 키가 없습니다 (헤더 x-anthropic-key 또는 환경변수 ANTHROPIC_KEY)" }, 400);

  let body;
  try { body = await request.text(); }
  catch (e) { return json({ error: "본문 읽기 실패: " + e.message }, 400); }

  const res = await fetch(ANTHROPIC_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body,
  });

  const data = await res.json();
  return json(data, res.status);
}

// ══════════════════════════════════════
// 이미지 검색 프록시  ★Pexels 우선 + Google CSE 폴백
// ──────────────────────────────────────
//  GET /imgsearch?q=검색어&n=12&page=1
//  → { images: [ {url, thumb, title, source, w, h}, ... ], query, provider }
//
//  환경변수:
//   PEXELS_KEY     : Pexels API 키 (우선 사용) — pexels.com/api 에서 무료 발급
//   GOOGLE_CSE_KEY : (선택) Pexels 키 없을 때 폴백
//   GOOGLE_CSE_CX  : (선택) 폴백용 검색엔진 ID
// ══════════════════════════════════════
async function handleImageSearch(request, env, url) {
  const q    = (url.searchParams.get("q") || "").trim();
  const n    = Math.min(parseInt(url.searchParams.get("n") || "12", 10) || 12, 30);
  const page = Math.max(parseInt(url.searchParams.get("page") || "1", 10) || 1, 1);

  if (!q) return json({ error: "검색어(q)가 없습니다." }, 400);

  // ── 1순위: Pexels ──────────────────────────
  if (env.PEXELS_KEY) {
    const api = new URL("https://api.pexels.com/v1/search");
    api.searchParams.set("query", q);
    api.searchParams.set("per_page", String(n));
    api.searchParams.set("page", String(page));
    api.searchParams.set("orientation", "portrait"); // 제안서 카드용 세로 컷 우선

    try {
      const r = await fetch(api.toString(), { headers: { Authorization: env.PEXELS_KEY } });
      const data = await r.json();
      if (data.error) return json({ error: "Pexels 오류: " + data.error }, 502);
      const images = (data.photos || []).map(p => ({
        url:    (p.src && (p.src.large || p.src.original)) || "",
        thumb:  (p.src && (p.src.medium || p.src.small)) || "",
        title:  p.alt || "",
        source: p.url || "",
        w:      p.width  || 0,
        h:      p.height || 0,
      }));
      return json({ images, query: q, provider: "pexels", page }, 200);
    } catch (e) {
      return json({ error: "Pexels 요청 실패: " + e.message }, 502);
    }
  }

  // ── 폴백: Google Custom Search ──────────────
  if (env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX) {
    const start = (page - 1) * 10 + 1;
    const api = new URL("https://www.googleapis.com/customsearch/v1");
    api.searchParams.set("key", env.GOOGLE_CSE_KEY);
    api.searchParams.set("cx",  env.GOOGLE_CSE_CX);
    api.searchParams.set("q",   q);
    api.searchParams.set("searchType", "image");
    api.searchParams.set("num", String(Math.min(n, 10)));
    api.searchParams.set("start", String(start));
    api.searchParams.set("safe", "active");
    api.searchParams.set("imgSize", "medium");
    try {
      const r = await fetch(api.toString());
      const data = await r.json();
      if (data.error) return json({ error: "Google 검색 오류: " + (data.error.message || "unknown") }, 502);
      const images = (data.items || []).map(it => ({
        url:    it.link,
        thumb:  (it.image && it.image.thumbnailLink) || it.link,
        title:  it.title || "",
        source: (it.image && it.image.contextLink) || "",
        w:      (it.image && it.image.width)  || 0,
        h:      (it.image && it.image.height) || 0,
      }));
      return json({ images, query: q, provider: "google", page }, 200);
    } catch (e) {
      return json({ error: "검색 요청 실패: " + e.message }, 502);
    }
  }

  return json({ error: "이미지 검색 키 미설정 — Worker 환경변수 PEXELS_KEY(권장) 또는 GOOGLE_CSE_KEY/CX를 등록하세요." }, 500);
}

// ══════════════════════════════════════
// R2 파일 스토리지
// ══════════════════════════════════════
async function handleR2(request, env, url, path) {
  const bucket = env.EK_FILES;
  if (!bucket) return json({ error: "R2 bucket not bound. Add R2 binding 'EK_FILES' in Worker settings." }, 500);

  if (request.method === "POST" && path === "/r2/upload") return uploadFile(request, bucket);
  if (request.method === "GET"  && path === "/r2/list")   return listFiles(url, bucket);
  if (request.method === "GET"  && path.startsWith("/r2/file/")) {
    return getFile(decodeURIComponent(path.replace("/r2/file/", "")), bucket);
  }
  if (request.method === "DELETE" && path.startsWith("/r2/file/")) {
    return deleteFile(decodeURIComponent(path.replace("/r2/file/", "")), bucket);
  }

  return json({ error: "Unknown R2 route" }, 404);
}

async function uploadFile(request, bucket) {
  try {
    const contentType = request.headers.get("X-File-Type") || "application/octet-stream";
    const fileName    = request.headers.get("X-File-Name")  || `file_${Date.now()}`;
    const isBase64    = request.headers.get("X-Encoding")   === "base64";

    let body;
    if (isBase64) {
      const text   = await request.text();
      const base64 = text.includes(",") ? text.split(",")[1] : text;
      body = base64ToArrayBuffer(base64);
    } else {
      body = await request.arrayBuffer();
    }

    const now = new Date();
    const key = `uploads/${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,"0")}/${String(now.getDate()).padStart(2,"0")}/${Date.now()}_${sanitize(fileName)}`;

    await bucket.put(key, body, {
      httpMetadata:   { contentType },
      customMetadata: { originalName: fileName, uploadedAt: now.toISOString() },
    });

    return json({ success: true, key, url: `/r2/file/${encodeURIComponent(key)}`, name: fileName, type: contentType, size: body.byteLength });
  } catch (e) {
    return json({ error: "Upload failed: " + e.message }, 500);
  }
}

async function getFile(key, bucket) {
  const obj = await bucket.get(key);
  if (!obj) return json({ error: "File not found" }, 404);
  return new Response(obj.body, {
    headers: { ...CORS, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream", "Cache-Control": "public, max-age=31536000" },
  });
}

async function listFiles(url, bucket) {
  const prefix = url.searchParams.get("prefix") || "uploads/";
  const limit  = parseInt(url.searchParams.get("limit") || "200");
  const listed = await bucket.list({ prefix, limit });
  return json({
    files: listed.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded, url: `/r2/file/${encodeURIComponent(o.key)}` })),
    truncated: listed.truncated,
  });
}

async function deleteFile(key, bucket) {
  await bucket.delete(key);
  return json({ success: true, deleted: key });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function sanitize(name) { return name.replace(/[^a-zA-Z0-9가-힣._-]/g, "_").slice(0, 100); }
function base64ToArrayBuffer(base64) {
  const binary = atob(base64); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
