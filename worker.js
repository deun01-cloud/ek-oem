/**
 * EK OEM — Unified Cloudflare Worker
 * ─────────────────────────────────────
 * 역할 1: Notion API CORS 프록시  → /notion/*
 * 역할 2: R2 파일 업로드/조회/삭제 → /r2/*
 *
 * 환경변수 (Worker Settings → Variables & Secrets):
 *   NOTION_TOKEN  : Notion Integration Token (secret_xxx)
 *
 * R2 바인딩 (Worker Settings → Bindings → R2 bucket):
 *   변수명: EK_FILES  / 버킷명: ek-files (직접 생성)
 */

const NOTION_VERSION = "2022-06-28";
const NOTION_BASE    = "https://api.notion.com/v1";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Notion-Version, X-File-Name, X-File-Type, X-Encoding",
};

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path.startsWith("/notion")) return handleNotion(request, env, url, path);
    if (path.startsWith("/r2"))     return handleR2(request, env, url, path);

    return json({ ok: true, routes: ["/notion/*", "/r2/upload", "/r2/list", "/r2/file/:key"] });
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
