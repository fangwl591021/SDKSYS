const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
};

const DEFAULT_RELEASE_MONTHS = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return text("SDKSYS Worker ready");
      }

      if (url.pathname === "/health" && request.method === "GET") {
        return json({
          ok: true,
          service: "sdksys",
          storage: "wasabi",
          bucket: env.WASABI_BUCKET,
          basePrefix: normalizePrefix(env.WASABI_BASE_PREFIX),
        });
      }

      if (url.pathname === "/api/system/storage" && request.method === "GET") {
        return json({
          provider: "wasabi",
          bucket: env.WASABI_BUCKET,
          region: env.WASABI_REGION,
          endpoint: env.WASABI_ENDPOINT,
          basePrefix: normalizePrefix(env.WASABI_BASE_PREFIX),
          secretConfigured: Boolean(env.WASABI_ACCESS_KEY_ID && env.WASABI_SECRET_ACCESS_KEY),
        });
      }

      if (url.pathname === "/api/auth/line-login" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        const result = await handleLineLogin({ request, env, storage, payload });
        return json(result);
      }

      if (url.pathname === "/api/admin/tenants/upsert" && request.method === "POST") {
        requireSystemApiKey(request, env);
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        return json(await upsertTenant(storage, payload));
      }

      if (url.pathname === "/api/member-number/preview" && request.method === "POST") {
        requireSystemApiKey(request, env);
        const payload = await readJson(request);
        assertString(payload.storeCode, "storeCode");
        assertString(payload.tenantId, "tenantId");
        assertString(payload.userId, "userId");
        assertSecret(env.MEMBER_NO_SECRET, "MEMBER_NO_SECRET");

        return json({
          memberNo: await createMemberNo({
            storeCode: payload.storeCode,
            tenantId: payload.tenantId,
            userId: payload.userId,
            secret: env.MEMBER_NO_SECRET,
          }),
        });
      }

      if (url.pathname === "/api/storage/head" && request.method === "POST") {
        requireSystemApiKey(request, env);
        const payload = await readJson(request);
        assertString(payload.key, "key");
        return json(await createWasabiClient(env).head(payload.key));
      }

      if (url.pathname === "/api/storage/get-json" && request.method === "POST") {
        requireSystemApiKey(request, env);
        const payload = await readJson(request);
        assertString(payload.key, "key");
        return json(await createWasabiClient(env).getJson(payload.key));
      }

      if (url.pathname === "/api/storage/put-json" && request.method === "POST") {
        requireSystemApiKey(request, env);
        const payload = await readJson(request);
        assertString(payload.key, "key");
        if (!payload.value || typeof payload.value !== "object" || Array.isArray(payload.value)) {
          throw httpError(400, "value must be a JSON object");
        }
        return json(await createWasabiClient(env).putJson(payload.key, payload.value));
      }

      if (url.pathname === "/api/storage/list" && request.method === "POST") {
        requireSystemApiKey(request, env);
        const payload = await readJson(request);
        assertString(payload.prefix, "prefix");
        return json(await createWasabiClient(env).list(payload.prefix, payload.maxKeys));
      }

      return json({ ok: false, error: "not_found" }, { status: 404 });
    } catch (error) {
      const status = error.status || 500;
      return json({
        ok: false,
        error: error.code || "internal_error",
        message: error.message || "Unexpected error",
      }, { status });
    }
  },
};

async function handleLineLogin({ env, storage, payload }) {
  assertString(payload.idToken, "idToken");
  const lineProfile = await verifyLineIdToken(env, payload.idToken);
  const tenant = await resolveTenant(storage, payload);
  const now = new Date().toISOString();
  const userId = await createUserId(lineProfile.sub, env.MEMBER_NO_SECRET);
  const tenantMemberId = await createTenantMemberId(tenant.tenantId, userId, env.MEMBER_NO_SECRET);
  const memberKey = `tenant-members/${tenant.tenantId}/${tenantMemberId}.json`;
  const existingMember = (await storage.getJson(memberKey)).value;
  const memberNo = existingMember?.memberNo || await createMemberNo({
    storeCode: tenant.storeCode,
    tenantId: tenant.tenantId,
    userId,
    secret: env.MEMBER_NO_SECRET,
  });
  const referralCode = existingMember?.referralCode || await createReferralCode(tenant.tenantId, tenantMemberId, env.MEMBER_NO_SECRET);
  const releaseMonths = getReleaseMonths(tenant);
  const previousLastActiveAt = existingMember?.lastActiveAt || null;

  const user = {
    userId,
    lineUserId: lineProfile.sub,
    displayName: lineProfile.name || lineProfile.displayName || null,
    pictureUrl: lineProfile.picture || null,
    email: lineProfile.email || null,
    updatedAt: now,
    createdAt: existingMember?.createdAt || now,
  };

  const member = {
    tenantMemberId,
    tenantId: tenant.tenantId,
    userId,
    memberNo,
    role: existingMember?.role || "member",
    status: existingMember?.status || "active",
    referralCode,
    joinedByReferralCode: existingMember?.joinedByReferralCode || payload.referralCode || null,
    lastActiveAt: now,
    createdAt: existingMember?.createdAt || now,
    updatedAt: now,
  };

  await storage.putJson(`users/${userId}.json`, user);
  await storage.putJson(memberKey, member);
  await storage.putJson(`referral-codes/${tenant.tenantId}/${referralCode}.json`, {
    tenantId: tenant.tenantId,
    tenantMemberId,
    referralCode,
    status: "active",
    updatedAt: now,
  });
  await recordActivity(storage, tenant.tenantId, tenantMemberId, "line_login", now);

  const attribution = await applyReferralAttribution({
    storage,
    tenant,
    member,
    referralCode: payload.referralCode,
    previousLastActiveAt,
    releaseMonths,
    now,
  });

  return {
    ok: true,
    tenant: publicTenant(tenant),
    member: publicMember(member),
    attribution,
  };
}

async function upsertTenant(storage, payload) {
  assertString(payload.tenantId, "tenantId");
  assertString(payload.storeCode, "storeCode");
  assertString(payload.name, "name");
  const now = new Date().toISOString();
  const plan = payload.plan || "free";
  const tenant = {
    tenantId: cleanId(payload.tenantId),
    storeCode: cleanCode(payload.storeCode),
    name: payload.name,
    tenantType: payload.tenantType || "personal",
    plan,
    status: payload.status || "active",
    affiliateReleaseMonths: normalizeReleaseMonths(plan, payload.affiliateReleaseMonths),
    createdAt: payload.createdAt || now,
    updatedAt: now,
  };

  await storage.putJson(`tenants/${tenant.tenantId}.json`, tenant);
  await storage.putJson(`tenant-index/store-codes/${tenant.storeCode}.json`, {
    tenantId: tenant.tenantId,
    storeCode: tenant.storeCode,
    updatedAt: now,
  });

  return { ok: true, tenant };
}

async function resolveTenant(storage, payload) {
  let tenantId = payload.tenantId ? cleanId(payload.tenantId) : null;
  if (!tenantId && payload.storeCode) {
    const index = (await storage.getJson(`tenant-index/store-codes/${cleanCode(payload.storeCode)}.json`)).value;
    tenantId = index?.tenantId || null;
  }
  if (!tenantId) {
    throw httpError(400, "tenantId or storeCode is required", "tenant_required");
  }
  const tenant = (await storage.getJson(`tenants/${tenantId}.json`)).value;
  if (!tenant || tenant.status !== "active") {
    throw httpError(404, "Tenant not found or inactive", "tenant_not_found");
  }
  return tenant;
}

async function applyReferralAttribution({ storage, tenant, member, referralCode, previousLastActiveAt, releaseMonths, now }) {
  const assignmentKey = `affiliate-assignments/${tenant.tenantId}/${member.tenantMemberId}.json`;
  const current = (await storage.getJson(assignmentKey)).value;
  const requestedCode = referralCode ? cleanCode(referralCode) : null;

  if (!requestedCode) {
    return current ? publicAttribution(current, "kept") : { status: "open", reason: "no_referral_code" };
  }

  const referralIndex = (await storage.getJson(`referral-codes/${tenant.tenantId}/${requestedCode}.json`)).value;
  if (!referralIndex || referralIndex.status !== "active") {
    return current ? publicAttribution(current, "kept_invalid_new_code") : { status: "open", reason: "invalid_referral_code" };
  }

  if (referralIndex.tenantMemberId === member.tenantMemberId) {
    return current ? publicAttribution(current, "kept_self_code") : { status: "open", reason: "self_referral_ignored" };
  }

  if (!current || current.status !== "active") {
    const created = newAssignment({ tenant, member, parentTenantMemberId: referralIndex.tenantMemberId, referralCode: requestedCode, now });
    await storage.putJson(assignmentKey, created);
    return publicAttribution(created, "assigned");
  }

  if (!isInactiveBeyond(previousLastActiveAt, releaseMonths, now)) {
    return publicAttribution(current, "kept_active_member");
  }

  const released = {
    ...current,
    status: "released",
    releasedAt: now,
    releaseReason: `inactive_${releaseMonths}_months`,
  };
  await storage.putJson(`affiliate-assignment-history/${tenant.tenantId}/${member.tenantMemberId}/${safeTime(now)}-released.json`, released);

  const reassigned = newAssignment({ tenant, member, parentTenantMemberId: referralIndex.tenantMemberId, referralCode: requestedCode, now });
  reassigned.previousParentTenantMemberId = current.parentTenantMemberId;
  reassigned.reassignedFromReleasedAt = now;
  await storage.putJson(assignmentKey, reassigned);
  return publicAttribution(reassigned, "reassigned_after_release");
}

function newAssignment({ tenant, member, parentTenantMemberId, referralCode, now }) {
  return {
    tenantId: tenant.tenantId,
    tenantMemberId: member.tenantMemberId,
    parentTenantMemberId,
    assignedByReferralCode: referralCode,
    status: "active",
    assignedAt: now,
    updatedAt: now,
    affects: "future_orders_only",
  };
}

async function recordActivity(storage, tenantId, tenantMemberId, eventType, now) {
  const date = new Date(now);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const eventId = `${safeTime(now)}-${randomId()}`;
  await storage.putJson(`activity/${tenantId}/${yyyy}/${mm}/${tenantMemberId}/${eventId}.json`, {
    tenantId,
    tenantMemberId,
    eventType,
    occurredAt: now,
  });
}

async function verifyLineIdToken(env, idToken) {
  assertSecret(env.LINE_LOGIN_CHANNEL_ID, "LINE_LOGIN_CHANNEL_ID");
  const body = new URLSearchParams({
    id_token: idToken,
    client_id: env.LINE_LOGIN_CHANNEL_ID,
  });
  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.sub) {
    throw httpError(401, result.error_description || "LINE idToken verification failed", "line_verify_failed");
  }
  return result;
}

function createWasabiClient(env) {
  assertSecret(env.WASABI_ACCESS_KEY_ID, "WASABI_ACCESS_KEY_ID");
  assertSecret(env.WASABI_SECRET_ACCESS_KEY, "WASABI_SECRET_ACCESS_KEY");

  const bucket = requiredEnv(env.WASABI_BUCKET, "WASABI_BUCKET");
  const region = requiredEnv(env.WASABI_REGION, "WASABI_REGION");
  const endpoint = requiredEnv(env.WASABI_ENDPOINT, "WASABI_ENDPOINT").replace(/\/+$/, "");
  const basePrefix = normalizePrefix(env.WASABI_BASE_PREFIX || "sdksys");

  return {
    async head(relativeKey) {
      const key = joinKey(basePrefix, relativeKey);
      const response = await signedWasabiFetch(env, { method: "HEAD", endpoint, region, bucket, key });
      if (response.status === 404) return { ok: true, exists: false, key };
      if (!response.ok) throw await wasabiError(response);
      return {
        ok: true,
        exists: true,
        key,
        size: Number(response.headers.get("content-length") || 0),
        contentType: response.headers.get("content-type"),
        lastModified: response.headers.get("last-modified"),
        etag: trimQuotes(response.headers.get("etag")),
      };
    },

    async getJson(relativeKey) {
      const key = joinKey(basePrefix, relativeKey);
      const response = await signedWasabiFetch(env, { method: "GET", endpoint, region, bucket, key });
      if (response.status === 404) return { ok: true, exists: false, key, value: null };
      if (!response.ok) throw await wasabiError(response);
      return { ok: true, exists: true, key, value: await response.json() };
    },

    async putJson(relativeKey, value) {
      const key = joinKey(basePrefix, relativeKey);
      const body = JSON.stringify(value, null, 2);
      const response = await signedWasabiFetch(env, {
        method: "PUT",
        endpoint,
        region,
        bucket,
        key,
        body,
        contentType: "application/json; charset=utf-8",
      });
      if (!response.ok) throw await wasabiError(response);
      return { ok: true, key, etag: trimQuotes(response.headers.get("etag")) };
    },

    async list(relativePrefix, maxKeys = 100) {
      const prefix = joinKey(basePrefix, relativePrefix);
      const params = new URLSearchParams({
        "list-type": "2",
        prefix,
        "max-keys": String(Math.min(Math.max(Number(maxKeys) || 100, 1), 1000)),
      });
      const response = await signedWasabiFetch(env, {
        method: "GET",
        endpoint,
        region,
        bucket,
        key: "",
        query: params,
      });
      if (!response.ok) throw await wasabiError(response);
      return { ok: true, prefix, list: parseListObjects(await response.text()) };
    },
  };
}

async function signedWasabiFetch(env, options) {
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(options.body || "");
  const host = new URL(options.endpoint).host;
  const encodedKey = encodeS3Key(options.key);
  const pathname = `/${options.bucket}${encodedKey ? `/${encodedKey}` : ""}`;
  const query = options.query ? `?${options.query.toString()}` : "";
  const url = `${options.endpoint}${pathname}${query}`;
  const signedHeaderValues = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  if (options.contentType) signedHeaderValues["content-type"] = options.contentType;

  const signedHeaders = Object.keys(signedHeaderValues).sort().join(";");
  const canonicalHeaders = Object.keys(signedHeaderValues)
    .sort()
    .map((name) => `${name}:${signedHeaderValues[name]}\n`)
    .join("");
  const canonicalRequest = [
    options.method,
    pathname,
    canonicalQueryString(options.query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await getSignatureKey(env.WASABI_SECRET_ACCESS_KEY, dateStamp, options.region, "s3");
  const signature = await hmacHex(signingKey, stringToSign);
  const requestHeaders = { ...signedHeaderValues };
  delete requestHeaders.host;
  requestHeaders.authorization = [
    `AWS4-HMAC-SHA256 Credential=${env.WASABI_ACCESS_KEY_ID}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  return fetch(url, {
    method: options.method,
    headers: requestHeaders,
    body: options.body,
  });
}

async function createUserId(lineUserId, secret) {
  assertSecret(secret, "MEMBER_NO_SECRET");
  const digest = await hmacHex(await importHmacKey(secret), `line:${lineUserId}`);
  return `usr_${base36FromHex(digest).slice(0, 14).toLowerCase()}`;
}

async function createTenantMemberId(tenantId, userId, secret) {
  const digest = await hmacHex(await importHmacKey(secret), `tm:${tenantId}:${userId}`);
  return `tm_${base36FromHex(digest).slice(0, 14).toLowerCase()}`;
}

async function createReferralCode(tenantId, tenantMemberId, secret) {
  const digest = await hmacHex(await importHmacKey(secret), `ref:${tenantId}:${tenantMemberId}`);
  return `R${base36FromHex(digest).slice(0, 7).toUpperCase()}`;
}

async function createMemberNo({ storeCode, tenantId, userId, secret }) {
  const digest = await hmacHex(await importHmacKey(secret), `${tenantId}:${userId}`);
  return `${cleanCode(storeCode)}-M${base36FromHex(digest).slice(0, 8).toUpperCase()}`;
}

function requireSystemApiKey(request, env) {
  assertSecret(env.SYSTEM_API_KEY, "SYSTEM_API_KEY");
  const key = request.headers.get("x-sdksys-api-key") || "";
  if (!timingSafeEqual(key, env.SYSTEM_API_KEY)) {
    throw httpError(401, "System API key is required", "unauthorized");
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

function publicTenant(tenant) {
  return {
    tenantId: tenant.tenantId,
    storeCode: tenant.storeCode,
    name: tenant.name,
    plan: tenant.plan,
  };
}

function publicMember(member) {
  return {
    tenantMemberId: member.tenantMemberId,
    memberNo: member.memberNo,
    role: member.role,
    status: member.status,
    referralCode: member.referralCode,
    lastActiveAt: member.lastActiveAt,
  };
}

function publicAttribution(assignment, result) {
  return {
    result,
    status: assignment.status,
    parentTenantMemberId: assignment.parentTenantMemberId,
    assignedByReferralCode: assignment.assignedByReferralCode,
    assignedAt: assignment.assignedAt,
    affects: assignment.affects,
  };
}

function getReleaseMonths(tenant) {
  return normalizeReleaseMonths(tenant.plan, tenant.affiliateReleaseMonths);
}

function normalizeReleaseMonths(plan, value) {
  if (plan !== "enterprise") return DEFAULT_RELEASE_MONTHS;
  if (value === "never") return "never";
  const months = Number(value || DEFAULT_RELEASE_MONTHS);
  return [3, 6, 12, 24].includes(months) ? months : DEFAULT_RELEASE_MONTHS;
}

function isInactiveBeyond(lastActiveAt, releaseMonths, now) {
  if (releaseMonths === "never") return false;
  if (!lastActiveAt) return false;
  const elapsed = Date.parse(now) - Date.parse(lastActiveAt);
  return elapsed >= releaseMonths * 31 * 24 * 60 * 60 * 1000;
}

function cleanCode(value) {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
}

function cleanId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 64);
}

function randomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

function safeTime(value) {
  return value.replace(/[^0-9]/g, "");
}

function base36FromHex(hexValue) {
  let output = "";
  for (let index = 0; index < hexValue.length; index += 10) {
    output += parseInt(hexValue.slice(index, index + 10), 16).toString(36);
  }
  return output;
}

function parseListObjects(xml) {
  const items = [];
  const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
  for (const item of contents) {
    items.push({
      key: xmlValue(item, "Key"),
      size: Number(xmlValue(item, "Size") || 0),
      lastModified: xmlValue(item, "LastModified"),
      etag: trimQuotes(xmlValue(item, "ETag")),
    });
  }
  return items;
}

function xmlValue(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function canonicalQueryString(query) {
  if (!query) return "";
  return [...query.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

async function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = await hmacBytes(await importHmacKey(`AWS4${secret}`), dateStamp);
  const kRegion = await hmacBytes(await crypto.subtle.importKey("raw", kDate, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), region);
  const kService = await hmacBytes(await crypto.subtle.importKey("raw", kRegion, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), service);
  return crypto.subtle.importKey("raw", await hmacBytes(await crypto.subtle.importKey("raw", kService, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), "aws4_request"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacBytes(key, value) {
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

async function hmacHex(key, value) {
  return hex(await hmacBytes(key, value));
}

async function sha256Hex(value) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(buffer));
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeS3Key(key) {
  return normalizePrefix(key).split("/").map(encodeURIComponent).join("/");
}

function joinKey(...parts) {
  return parts.map(normalizePrefix).filter(Boolean).join("/");
}

function normalizePrefix(value) {
  return String(value || "").replace(/^\/+|\/+$/g, "");
}

function trimQuotes(value) {
  return value ? value.replace(/^"|"$/g, "") : null;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(400, "Invalid JSON body", "invalid_json");
  }
}

function assertString(value, field) {
  if (!value || typeof value !== "string") {
    throw httpError(400, `${field} is required`, "invalid_request");
  }
}

function assertSecret(value, name) {
  if (!value) {
    throw httpError(500, `${name} is not configured`, "missing_secret");
  }
}

function requiredEnv(value, name) {
  if (!value) {
    throw httpError(500, `${name} is not configured`, "missing_config");
  }
  return value;
}

async function wasabiError(response) {
  const body = await response.text();
  return httpError(response.status, body || response.statusText, "wasabi_error");
}

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function json(body, init = {}) {
  return withCors(new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...(init.headers || {}),
    },
  }));
}

function text(body, init = {}) {
  return withCors(new Response(body, {
    ...init,
    headers: {
      ...TEXT_HEADERS,
      ...(init.headers || {}),
    },
  }));
}

function withCors(response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("access-control-allow-headers", "content-type,authorization,x-sdksys-api-key");
  return response;
}
