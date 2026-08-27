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

function envFileCandidates() {
  return [
    path.join(__dirname, "..", ".env"),
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "desktop", ".env"),
  ];
}

function loadEnvFile(filePath) {
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
    if (!process.env[key]) process.env[key] = val;
  }
  return true;
}

function loadEnvFromDisk() {
  for (const candidate of envFileCandidates()) {
    if (loadEnvFile(candidate)) return candidate;
  }
  return "";
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
  const ext = type.includes("mp4")
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

function httpsPut(url, headers, body) {
  return httpsRequest({ method: "PUT", url, headers, body, timeoutMs: 30000 });
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
 * @param {string} opts.imageDataUrl
 * @param {string} [opts.folder]
 * @param {string} [opts.publicId]
 * @returns {Promise<{success:boolean,url?:string,publicId?:string,error?:string}>}
 */
async function uploadToR2({ imageDataUrl, folder, publicId }) {
  const cfg = getR2Config();
  if (!cfg.ok) {
    return {
      success: false,
      error: `Cloudflare R2 is not configured. Missing: ${cfg.missing.join(", ")}`,
    };
  }

  try {
    const { contentType, body, ext } = parseDataUrl(imageDataUrl);
    const key = objectKey(folder || cfg.folder, publicId, ext);
    const region = "auto";
    const service = "s3";
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);
    const host = new URL(cfg.endpoint).host;
    const canonicalUri = `/${encodePath(`${cfg.bucket}/${key}`)}`;
    const putUrl = `${cfg.endpoint}/${encodePath(`${cfg.bucket}/${key}`)}`;

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

    const res = await httpsPut(
      putUrl,
      {
        Host: host,
        "Content-Type": contentType,
        "Content-Length": body.length,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        Authorization: authorization,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      body,
    );

    if (res.status < 200 || res.status >= 300) {
      console.error("[R2] Upload failed:", res.status, res.text);
      return {
        success: false,
        error: `R2 upload failed (HTTP ${res.status}): ${res.text || "no body"}`,
      };
    }

    const url = `${cfg.publicUrl}/${key}`;
    console.log("[R2] Uploaded:", url);
    return { success: true, url, publicId: key };
  } catch (err) {
    console.error("[R2] Upload error:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

module.exports = {
  loadEnvFile,
  loadEnvFromDisk,
  getR2Config,
  pingR2,
  uploadToR2,
};
