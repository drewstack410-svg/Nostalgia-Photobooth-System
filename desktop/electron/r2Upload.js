/**
 * Cloudflare R2 uploads (S3-compatible PutObject, AWS Signature V4).
 * Node-only — used by Electron main and the Vite /api/r2-upload proxy.
 * Secrets stay here; the renderer never sees the access key.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

function resolveEnvPaths() {
  const projectEnv = path.join(__dirname, "..", ".env");
  let userEnv = "";
  let packaged = "";
  try {
    const { app } = require("electron");
    if (app?.getPath) {
      userEnv = path.join(app.getPath("userData"), ".env");
    }
  } catch (_) {
    /* vite / node, or app path not ready */
  }
  try {
    if (process.resourcesPath) {
      packaged = path.join(process.resourcesPath, ".env");
    }
  } catch (_) {
    /* ignore */
  }
  return { userEnv, packaged, projectEnv };
}

/**
 * Installer .env is copied to %APPDATA% so operators can edit it.
 * Only the first launch used to copy, so a rebuild never replaced a
 * stale AppData file. Refresh when the packaged copy is newer.
 */
function syncPackagedEnvToUserData() {
  const { userEnv, packaged } = resolveEnvPaths();
  if (!userEnv || !packaged || packaged === "." || !fs.existsSync(packaged)) {
    return;
  }
  try {
    const needCopy =
      !fs.existsSync(userEnv) ||
      fs.statSync(packaged).mtimeMs > fs.statSync(userEnv).mtimeMs;
    if (!needCopy) return;
    fs.copyFileSync(packaged, userEnv);
    console.log("[R2] Updated userData .env from packaged resources");
  } catch (err) {
    console.warn("[R2] Could not copy .env to userData:", err.message);
  }
}

function envFileCandidates() {
  const { userEnv, packaged, projectEnv } = resolveEnvPaths();
  const out = [];
  if (userEnv) out.push(userEnv);
  if (packaged && packaged !== ".") out.push(packaged);
  out.push(
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "desktop", ".env"),
  );
  try {
    if (process.execPath) {
      out.push(path.join(path.dirname(process.execPath), ".env"));
    }
  } catch (_) {
    /* ignore */
  }
  // Project desktop/.env last so `npm run electron:dev` always uses the
  // file you just edited, even if an old AppData copy still exists.
  out.push(projectEnv);
  return out;
}

/**
 * Electron IPC + contextBridge often delivers a Uint8Array, an
 * ArrayBuffer, a Node Buffer JSON shape, or a numeric-keyed object.
 * `Buffer.from(mystery)` is not safe for all of those.
 */
function toNodeBuffer(bytes) {
  if (bytes == null) {
    throw new Error("No bytes");
  }
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (typeof bytes === "string") {
    return Buffer.from(bytes, "base64");
  }
  if (typeof bytes === "object") {
    if (bytes.type === "Buffer" && Array.isArray(bytes.data)) {
      return Buffer.from(bytes.data);
    }
    const len = Number(bytes.byteLength ?? bytes.length ?? 0);
    if (len > 0 && bytes.buffer instanceof ArrayBuffer) {
      return Buffer.from(bytes.buffer, bytes.byteOffset || 0, len);
    }
    if (len > 0 && typeof bytes[0] === "number") {
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = bytes[i] & 0xff;
      return out;
    }
  }
  throw new Error(`Cannot convert ${typeof bytes} to Buffer`);
}

function extFromContentType(contentType) {
  const type = (contentType || "").toLowerCase();
  if (type.includes("json")) return "json";
  if (type.includes("mp4") || type.includes("m4v") || type.includes("avc")) {
    return "mp4";
  }
  if (type.includes("webm")) return "webm";
  if (type.includes("png")) return "png";
  if (type.includes("gif")) return "gif";
  if (type.includes("webp")) return "webp";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  return "bin";
}

function loadEnvFile(filePath, { override = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (override || !process.env[key]) process.env[key] = val;
  }
  return true;
}

function loadEnvFromDisk() {
  syncPackagedEnvToUserData();
  let loaded = "";
  const seen = new Set();
  for (const candidate of envFileCandidates()) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (loadEnvFile(candidate, { override: true })) loaded = candidate;
  }
  return loaded;
}

function getR2Config() {
  loadEnvFromDisk();
  const accountId = (process.env.R2_ACCOUNT_ID || "").trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (process.env.R2_BUCKET || "").trim();
  const endpoint = (
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "")
  )
    .trim()
    .replace(/\/+$/, "");
  const publicUrl = (
    process.env.VITE_R2_PUBLIC_URL ||
    process.env.R2_PUBLIC_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const folder = (
    process.env.VITE_R2_FOLDER ||
    process.env.R2_FOLDER ||
    "nostalgia-photobooth"
  ).trim();

  const missing = [];
  if (!accountId) missing.push("R2_ACCOUNT_ID");
  if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!bucket) missing.push("R2_BUCKET");
  if (!publicUrl) missing.push("VITE_R2_PUBLIC_URL");

  return {
    ok: missing.length === 0,
    missing,
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint,
    publicUrl,
    folder,
  };
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(p) {
  return p
    .split("/")
    .map(encodeRfc3986)
    .join("/");
}

function parseDataUrl(imageDataUrl) {
  const match = /^data:([^,]+),(.*)$/s.exec(imageDataUrl || "");
  if (!match) {
    throw new Error("Expected a base64 data URL");
  }
  const meta = match[1];
  const payload = match[2];
  const isBase64 = /;base64$/i.test(meta);
  const contentType = (meta.replace(/;base64$/i, "").split(";")[0] || "").trim()
    || "image/jpeg";
  const body = Buffer.from(payload, isBase64 ? "base64" : "utf8");
  const type = contentType.toLowerCase();
  const ext = type.includes("json")
    ? "json"
    : type.includes("mp4")
      ? "mp4"
      : type.includes("webm")
        ? "webm"
        : type.includes("png")
          ? "png"
          : type.includes("gif")
            ? "gif"
            : type.includes("webp")
              ? "webp"
              : "jpg";
  return { contentType, body, ext };
}

function objectKey(folder, publicId, ext) {
  const id = (publicId || `nostalgia_${Date.now()}`).replace(/^\/+/, "");
  const withExt = /\.[a-z0-9]+$/i.test(id) ? id : `${id}.${ext}`;
  const prefix = (folder || "").replace(/^\/+|\/+$/g, "");
  if (withExt.startsWith(`${prefix}/`)) return withExt;
  return prefix ? `${prefix}/${withExt}` : withExt;
}

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function httpsRequest({ method, url, headers, body, timeoutMs = 4000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

function httpsPut(url, headers, body, timeoutMs = 30000) {
  return httpsRequest({ method: "PUT", url, headers, body, timeoutMs });
}

/**
 * Live check: signed HeadBucket against the S3 API, plus a GET of the
 * public r2.dev (or custom) URL. Does not upload anything.
 */
async function pingR2() {
  const envPath = loadEnvFromDisk();
  const cfg = getR2Config();
  const result = {
    configured: cfg.ok,
    connected: false,
    apiOk: false,
    publicOk: false,
    bucket: cfg.bucket || undefined,
    publicUrl: cfg.publicUrl || undefined,
    missing: cfg.missing,
    error: undefined,
  };

  if (!cfg.ok) {
    result.error = `Missing ${cfg.missing.join(", ")}${
      envPath ? ` (read ${envPath})` : " (.env not found next to the desktop app)"
    }`;
    return result;
  }

  try {
    const host = new URL(cfg.endpoint).host;
    const canonicalUri = `/${encodePath(cfg.bucket)}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const region = "auto";
    const service = "s3";
    const headersToSign = {
      host,
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": amzDate,
    };
    const signedHeaderNames = Object.keys(headersToSign).sort();
    const canonicalHeaders = signedHeaderNames
      .map((n) => `${n}:${headersToSign[n]}\n`)
      .join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      "HEAD",
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders,
      EMPTY_SHA256,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = crypto
      .createHmac(
        "sha256",
        signingKey(cfg.secretAccessKey, dateStamp, region, service),
      )
      .update(stringToSign, "utf8")
      .digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const apiRes = await httpsRequest({
      method: "HEAD",
      url: `${cfg.endpoint}${canonicalUri}`,
      headers: {
        Host: host,
        "x-amz-content-sha256": EMPTY_SHA256,
        "x-amz-date": amzDate,
        Authorization: authorization,
      },
    });

    if (apiRes.status >= 200 && apiRes.status < 300) {
      result.apiOk = true;
    } else {
      result.error = `Cloudflare API returned HTTP ${apiRes.status}${
        apiRes.status === 403
          ? " (bad Access Key / Secret, or token cannot access this bucket)"
          : apiRes.status === 404
            ? " (bucket name not found — check R2_BUCKET)"
            : ""
      }`;
    }
  } catch (err) {
    result.error =
      err instanceof Error ? err.message : `API check failed: ${String(err)}`;
  }

  if (cfg.publicUrl) {
    try {
      const pubRes = await httpsRequest({
        method: "GET",
        url: cfg.publicUrl,
        headers: { "User-Agent": "nostalgia-photobooth" },
      });
      // r2.dev root is often 401 until public access is enabled, or
      // 404 with no index object. Any HTTP response means DNS/TLS worked.
      if (pubRes.status === 401 || pubRes.status === 403) {
        result.publicOk = false;
        result.error = [
          result.error,
          `Public URL returned HTTP ${pubRes.status} — enable Public development URL on bucket ${cfg.bucket}`,
        ]
          .filter(Boolean)
          .join("; ");
      } else {
        result.publicOk = pubRes.status > 0;
      }
    } catch (err) {
      result.publicOk = false;
      result.error = [
        result.error,
        `Public URL unreachable (${err instanceof Error ? err.message : String(err)})`,
      ]
        .filter(Boolean)
        .join("; ");
    }
  }

  result.connected = result.apiOk && result.publicOk;
  return result;
}

/**
 * @param {object} opts
 * @param {Buffer|Uint8Array|ArrayBuffer} opts.body
 * @param {string} [opts.contentType]
 * @param {string} [opts.folder]
 * @param {string} [opts.publicId]
 * @returns {Promise<{success:boolean,url?:string,publicId?:string,error?:string}>}
 */
async function uploadBuffer({ body, contentType, folder, publicId }) {
  const cfg = getR2Config();
  if (!cfg.ok) {
    return {
      success: false,
      error: `Cloudflare R2 is not configured. Missing: ${cfg.missing.join(", ")}`,
    };
  }

  try {
    const buf = toNodeBuffer(body);
    if (!buf.length) {
      return { success: false, error: "Empty upload body" };
    }
    const type =
      (contentType || "application/octet-stream").split(";")[0].trim() ||
      "application/octet-stream";
    const ext = extFromContentType(type);
    const key = objectKey(folder || cfg.folder, publicId, ext);
    const region = "auto";
    const service = "s3";
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(buf);
    const host = new URL(cfg.endpoint).host;
    const canonicalUri = `/${encodePath(`${cfg.bucket}/${key}`)}`;
    const putUrl = `${cfg.endpoint}/${encodePath(`${cfg.bucket}/${key}`)}`;

    const headersToSign = {
      host,
      "content-type": type,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedHeaderNames = Object.keys(headersToSign).sort();
    const canonicalHeaders = signedHeaderNames
      .map((n) => `${n}:${headersToSign[n]}\n`)
      .join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      "PUT",
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = crypto
      .createHmac(
        "sha256",
        signingKey(cfg.secretAccessKey, dateStamp, region, service),
      )
      .update(stringToSign, "utf8")
      .digest("hex");

    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const timeoutMs = Math.min(
      180000,
      Math.max(45000, 15000 + Math.ceil(buf.length / 4000)),
    );
    const res = await httpsPut(
      putUrl,
      {
        Host: host,
        "Content-Type": type,
        "Content-Length": buf.length,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        Authorization: authorization,
        "Cache-Control":
          ext === "json"
            ? "public, max-age=300"
            : "public, max-age=31536000, immutable",
      },
      buf,
      timeoutMs,
    );

    if (res.status < 200 || res.status >= 300) {
      console.error("[R2] Upload failed:", res.status, res.text);
      return {
        success: false,
        error: `R2 upload failed (HTTP ${res.status}): ${res.text || "no body"}`,
      };
    }

    const url = `${cfg.publicUrl}/${key}`;
    console.log("[R2] Uploaded:", url, `(${buf.length} bytes)`);
    return { success: true, url, publicId: key };
  } catch (err) {
    console.error("[R2] Upload error:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.imageDataUrl
 * @param {string} [opts.folder]
 * @param {string} [opts.publicId]
 * @returns {Promise<{success:boolean,url?:string,publicId?:string,error?:string}>}
 */
async function uploadToR2({ imageDataUrl, folder, publicId }) {
  try {
    const { contentType, body } = parseDataUrl(imageDataUrl);
    return await uploadBuffer({
      body,
      contentType,
      folder,
      publicId,
    });
  } catch (err) {
    console.error("[R2] Upload error:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function galleryCorsOrigins(cfg) {
  const origins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
  const gallery = (
    process.env.VITE_GALLERY_BASE_URL ||
    cfg.publicUrl ||
    ""
  ).trim();
  try {
    if (gallery) origins.add(new URL(gallery).origin);
  } catch (_) {
    /* ignore */
  }
  return [...origins];
}

function corsConfigurationXml(origins) {
  const rules = origins
    .map(
      (origin) => `  <CORSRule>
    <AllowedOrigin>${origin}</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <ExposeHeader>Content-Type</ExposeHeader>
    <ExposeHeader>Content-Length</ExposeHeader>
    <ExposeHeader>Accept-Ranges</ExposeHeader>
    <MaxAgeSeconds>86400</MaxAgeSeconds>
  </CORSRule>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
${rules}
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>86400</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
`;
}

/**
 * Public r2.dev objects are readable, but browsers still need CORS
 * when the Vercel gallery origin fetches them. Apply GET/HEAD rules
 * so phones are not blocked after a bucket swap.
 */
async function ensureR2Cors() {
  const cfg = getR2Config();
  if (!cfg.ok) {
    return { ok: false, error: `Missing ${cfg.missing.join(", ")}` };
  }
  try {
    const body = Buffer.from(corsConfigurationXml(galleryCorsOrigins(cfg)), "utf8");
    const payloadHash = sha256Hex(body);
    const host = new URL(cfg.endpoint).host;
    const canonicalUri = `/${encodePath(cfg.bucket)}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const region = "auto";
    const service = "s3";
    const contentType = "application/xml";
    const headersToSign = {
      host,
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    const signedHeaderNames = Object.keys(headersToSign).sort();
    const canonicalHeaders = signedHeaderNames
      .map((n) => `${n}:${headersToSign[n]}\n`)
      .join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [
      "PUT",
      canonicalUri,
      "cors=",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = crypto
      .createHmac(
        "sha256",
        signingKey(cfg.secretAccessKey, dateStamp, region, service),
      )
      .update(stringToSign, "utf8")
      .digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await httpsPut(
      `${cfg.endpoint}${canonicalUri}?cors`,
      {
        Host: host,
        "Content-Type": contentType,
        "Content-Length": body.length,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        Authorization: authorization,
      },
      body,
      15000,
    );
    if (res.status < 200 || res.status >= 300) {
      const hint =
        res.status === 403
          ? " (API token needs Admin Read & Write on the bucket to set CORS)"
          : "";
      return {
        ok: false,
        error: `PutBucketCors HTTP ${res.status}${hint}: ${res.text || "no body"}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

module.exports = {
  loadEnvFile,
  loadEnvFromDisk,
  getR2Config,
  pingR2,
  ensureR2Cors,
  toNodeBuffer,
  uploadBuffer,
  uploadToR2,
};
