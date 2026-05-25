const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
};

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
};

const DEFAULT_RELEASE_MONTHS = 6;
const CARD_LAYOUTS = ["standard", "full", "square"];
const CARD_LAYOUT_ALIASES = {
  landscape: "standard",
  poster: "standard",
  portrait: "full",
  classic: "full",
  free: "full",
  links: "square",
};
const DEFAULT_CARD_LAYOUT = "standard";

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

      if (url.pathname === "/app" && request.method === "GET") {
        const liffStateRoute = parseLiffStateCardRoute(url);
        if (liffStateRoute) {
          const storage = createWasabiClient(env);
          return html(await renderPublicCardHtml(storage, liffStateRoute.slug, url.origin, liffStateRoute.layout, env.LINE_LIFF_ID || ""));
        }
        return html(renderAppHtml(env, url));
      }

      if (url.pathname.startsWith("/app/card/") && request.method === "GET") {
        const storage = createWasabiClient(env);
        const route = parseCardRoute(url.pathname.slice("/app".length));
        return html(await renderPublicCardHtml(storage, route.slug, url.origin, route.layout, env.LINE_LIFF_ID || ""));
      }

      if (url.pathname.startsWith("/card/") && request.method === "GET") {
        const storage = createWasabiClient(env);
        const route = parseCardRoute(url.pathname);
        return html(await renderPublicCardHtml(storage, route.slug, url.origin, route.layout, env.LINE_LIFF_ID || ""));
      }

      if (url.pathname.startsWith("/asset/") && request.method === "GET") {
        const storage = createWasabiClient(env);
        const key = decodeURIComponent(url.pathname.slice("/asset/".length));
        if (!normalizePrefix(key).startsWith("card-assets/")) return text("not_found", { status: 404 });
        const asset = await storage.getObject(key);
        if (!asset.exists) return text("not_found", { status: 404 });
        return withCors(new Response(asset.body, {
          headers: {
            "content-type": asset.contentType || "application/octet-stream",
            "cache-control": "public, max-age=31536000, immutable",
          },
        }));
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

      if (url.pathname === "/api/tenants/resolve" && request.method === "GET") {
        const storage = createWasabiClient(env);
        const tenant = await resolveTenant(storage, {
          tenantId: url.searchParams.get("tenantId"),
          storeCode: url.searchParams.get("storeCode"),
        });
        return json({ ok: true, tenant: publicTenant(tenant) });
      }

      if (url.pathname === "/api/auth/line-login" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        const result = await handleLineLogin({ request, env, storage, payload });
        return json(result);
      }

      if (url.pathname === "/api/auth/session" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        const result = await handleSessionCheck({ env, storage, payload });
        return json(result);
      }

      if (url.pathname === "/api/member/profile/upsert" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        return json(await upsertMemberProfile({ env, storage, payload }));
      }

      if (url.pathname === "/api/cards/me" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        return json(await getMyBusinessCard({ env, storage, payload, origin: url.origin }));
      }

      if (url.pathname === "/api/cards/recognize" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        return json(await recognizeBusinessCard({ env, storage, payload, origin: url.origin }));
      }

      if (url.pathname === "/api/cards/library/list" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        return json(await listLibraryCards({ env, storage, payload, origin: url.origin }));
      }

      if (url.pathname === "/api/cards/library/create" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        return json(await createLibraryCardFromScan({ env, storage, payload, origin: url.origin }));
      }

      if (url.pathname === "/api/cards/library/upsert" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        return json(await upsertLibraryCard({ env, storage, payload, origin: url.origin }));
      }

      if (url.pathname === "/api/cards/upsert" && request.method === "POST") {
        const payload = await readJson(request);
        const storage = createWasabiClient(env);
        return json(await upsertBusinessCard({ env, storage, payload, origin: url.origin }));
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

function renderAppHtml(env, url) {
  const storeCode = cleanCode(url.searchParams.get("storeCode") || "DEMO");
  const referralCode = cleanCode(url.searchParams.get("ref") || url.searchParams.get("referralCode") || "");
  const liffId = env.LINE_LIFF_ID || "";
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SDKSYS Member</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.5.13/cropper.min.css">
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.5.13/cropper.min.js"></script>
  <style>
    :root {
      color-scheme: light;
      --ink: #1f2933;
      --muted: #607080;
      --line: #d8e0e8;
      --accent: #06c755;
      --accent-dark: #049545;
      --paper: #ffffff;
      --soft: #f4f7fa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: #ffe8f1;
    }
    body.cropper-open {
      overflow: hidden;
      background: #020617;
    }
    body.cropper-open main {
      visibility: hidden;
      pointer-events: none;
    }
    main {
      width: min(540px, 100%);
      margin: 0 auto;
      min-height: 100vh;
      padding: 0 0 86px;
      background: #ffe8f1;
    }
    .app-header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 74px;
      padding: 16px 26px;
      border-bottom: 1px solid #f1d7e2;
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(10px);
    }
    .app-header strong {
      font-size: 24px;
      font-weight: 900;
    }
    .round-icon {
      width: 42px;
      min-height: 42px;
      border: 2px solid #111827;
      border-radius: 999px;
      background: #fff;
      color: #111827;
      font-size: 22px;
      font-weight: 900;
    }
    .app-view { display: none; padding: 24px 26px; }
    .app-view.active { display: block; }
    .home-profile {
      display: grid;
      grid-template-columns: 56px minmax(0, 1fr) 98px;
      gap: 14px;
      align-items: center;
      margin-top: 8px;
    }
    .avatar {
      width: 54px;
      height: 54px;
      border: 3px solid white;
      border-radius: 999px;
      object-fit: cover;
      background: #eef2f7;
      box-shadow: 0 5px 14px rgba(15, 23, 42, .12);
    }
    .profile-name {
      margin: 0 0 5px;
      color: #111827;
      font-size: 21px;
      font-weight: 900;
    }
    .role-pill {
      display: inline-flex;
      align-items: center;
      margin-left: 6px;
      padding: 4px 8px;
      border-radius: 999px;
      color: #e12b7b;
      background: #fff1f7;
      font-size: 12px;
      font-weight: 800;
    }
    .points {
      color: #e83f9a;
      font-size: 26px;
      line-height: 1;
      font-weight: 500;
    }
    .qr-card {
      display: grid;
      gap: 7px;
      justify-items: center;
      padding: 10px 8px;
      border-radius: 14px;
      background: white;
    }
    .qr-box {
      width: 64px;
      height: 64px;
      border: 1px solid #d8e0e8;
      display: block;
      object-fit: contain;
      padding: 3px;
      background: #fff;
    }
    .share-mini {
      min-height: 34px;
      border-radius: 8px;
      background: #e83f9a;
      font-size: 13px;
    }
    .quick-actions {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 16px;
      margin: 58px 0 28px;
      text-align: center;
    }
    .quick-action button {
      width: 56px;
      min-height: 56px;
      border-radius: 999px;
      background: var(--accent);
      font-size: 25px;
    }
    .quick-action span {
      display: block;
      margin-top: 8px;
      color: #172033;
      font-size: 14px;
      font-weight: 800;
    }
    .section-title {
      margin: 28px 0 16px;
      color: #172033;
      font-size: 26px;
      font-weight: 900;
      letter-spacing: 0;
    }
    .advice-card, .setting-item {
      padding: 22px;
      border: 1px solid #ffe6ad;
      border-radius: 26px;
      background: white;
      box-shadow: 0 8px 20px rgba(15, 23, 42, .05);
    }
    .setting-list {
      display: grid;
      gap: 20px;
      margin-top: 18px;
    }
    .setting-item {
      width: 100%;
      min-height: 82px;
      border-color: #f3dfe7;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #0f172a;
      font-size: 20px;
      font-weight: 900;
      text-align: left;
      cursor: pointer;
    }
    .invite-button {
      min-height: 70px;
      border-radius: 18px;
      background: #2f6ff2;
      box-shadow: 0 10px 18px rgba(47, 111, 242, .2);
      font-size: 19px;
      font-weight: 900;
    }
    .bottom-nav {
      position: fixed;
      left: 50%;
      bottom: 0;
      z-index: 20;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      width: min(540px, 100%);
      transform: translateX(-50%);
      padding: 10px 24px 8px;
      border-radius: 24px 24px 0 0;
      border: 1px solid #eef2f7;
      background: rgba(255, 255, 255, .96);
      box-shadow: 0 -8px 24px rgba(15, 23, 42, .08);
    }
    .nav-button {
      min-height: 52px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #94a3b8;
      font-size: 13px;
      font-weight: 800;
    }
    .nav-button.active { color: #0f172a; background: #f1f5f9; }
    button {
      width: 100%;
      min-height: 46px;
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: white;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { filter: brightness(.97); }
    button:disabled { cursor: not-allowed; background: #9aa8b4; }
    button.is-processing {
      position: relative;
      pointer-events: none;
      filter: saturate(.85);
    }
    button.is-processing::after {
      content: "";
      width: 16px;
      height: 16px;
      margin-left: 8px;
      border: 2px solid rgba(255,255,255,.55);
      border-top-color: #fff;
      border-radius: 999px;
      display: inline-block;
      vertical-align: -3px;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .action-busy {
      position: fixed;
      left: 50%;
      bottom: 92px;
      z-index: 80;
      transform: translateX(-50%) translateY(14px);
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      max-width: min(480px, calc(100% - 32px));
      padding: 10px 16px;
      border-radius: 999px;
      background: rgba(15, 23, 42, .94);
      color: #fff;
      font-size: 15px;
      font-weight: 800;
      box-shadow: 0 18px 42px rgba(15, 23, 42, .25);
      opacity: 0;
      pointer-events: none;
      transition: opacity .16s ease, transform .16s ease;
    }
    .action-busy.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .action-busy::before {
      content: "";
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,.45);
      border-top-color: #fff;
      border-radius: 999px;
      animation: spin .7s linear infinite;
    }
    .status {
      min-height: 44px;
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 8px;
      background: var(--soft);
      color: var(--muted);
      line-height: 1.5;
      word-break: break-word;
    }
    .sr-only, #loginButton { display: none; }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
    }
    .row strong {
      color: var(--ink);
      text-align: right;
      word-break: break-word;
    }
    .member {
      display: none;
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .member.visible { display: block; }
    .copy-row {
      display: grid;
      gap: 10px;
      margin: 14px 0 18px;
    }
    .copy-row input {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--ink);
      background: white;
    }
    .secondary-button {
      min-height: 40px;
      background: var(--accent);
      color: #fff;
      font-size: 14px;
    }
    .secondary-button:hover { background: var(--accent-dark); }
    .downlines {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .downline-item {
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--soft);
      color: var(--ink);
      line-height: 1.45;
    }
    .downline-item small {
      display: block;
      color: var(--muted);
      margin-top: 2px;
    }
    .card-sdk {
      display: none;
      margin-top: 18px;
    }
    .card-sdk.visible { display: block; }
    .card-sdk h2 {
      margin: 0 0 12px;
      font-size: 22px;
      letter-spacing: 0;
    }
    .card-sdk p {
      margin: 0 0 16px;
      color: var(--muted);
      line-height: 1.65;
    }
    .card-tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      margin: 14px 0 18px;
      border-bottom: 1px solid #e5edf5;
      background: #fff;
      border-radius: 18px 18px 0 0;
      overflow: hidden;
    }
    .card-tab {
      min-height: 58px;
      border: 0;
      border-radius: 0;
      background: #fff;
      color: #8a98aa;
      font-size: 15px;
      font-weight: 900;
    }
    .card-tab.active {
      color: #2563eb;
      border-bottom: 2px solid #2563eb;
    }
    .card-tab-panel { display: none; }
    .card-tab-panel.active { display: block; }
    .form-grid {
      display: grid;
      gap: 10px;
    }
    .field label {
      display: block;
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }
    .field input, .field textarea, .field select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 11px;
      color: var(--ink);
      background: white;
      font: inherit;
    }
    .field textarea {
      min-height: 80px;
      resize: vertical;
    }
    .file-picker {
      display: block;
      width: 100%;
      border: 1px dashed #9aa8b4;
      border-radius: 8px;
      padding: 12px;
      background: #fbfdff;
      color: var(--muted);
    }
    .hidden-file {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }
    .cropper-modal {
      position: fixed;
      inset: 0;
      z-index: 2000;
      display: none;
      flex-direction: column;
      width: 100vw;
      height: 100dvh;
      margin: 0 auto;
      background: #020617;
    }
    .cropper-modal.visible { display: flex; }
    .cropper-stage {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #020617;
    }
    .cropper-stage img {
      display: block;
      max-width: 100%;
      max-height: 100%;
    }
    .cropper-toolbar {
      flex-shrink: 0;
      display: grid;
      gap: 10px;
      padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
      background: #020617;
      box-shadow: 0 -12px 30px rgba(0, 0, 0, .45);
    }
    .cropper-container,
    .cropper-wrap-box,
    .cropper-canvas,
    .cropper-drag-box,
    .cropper-crop-box {
      max-width: 100%;
    }
    .cropper-tools {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .cropper-actions {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 10px;
    }
    .cropper-toolbar button {
      min-height: 44px;
      border-radius: 8px;
      background: rgba(255, 255, 255, .1);
      color: #fff;
      font-weight: 800;
    }
    .cropper-toolbar .confirm-crop { background: var(--accent); }
    .button-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 12px;
    }
    .scan-panel {
      margin: 16px 0;
      padding: 18px;
      border-radius: 18px;
      background: #fff;
      border: 1px solid #e5edf5;
    }
    .scan-title {
      margin: 0 0 14px;
      color: #172033;
      font-size: 22px;
      font-weight: 900;
    }
    .scan-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .scan-action {
      min-height: 112px;
      border: 1px solid #cfe4ff;
      border-radius: 16px;
      background: #eef6ff;
      color: #2563eb;
      font-size: 15px;
      font-weight: 900;
    }
    .scan-action span {
      display: block;
      margin-bottom: 8px;
      font-size: 30px;
    }
    .url-grid {
      display: grid;
      gap: 8px;
      margin: 14px 0;
    }
    .url-grid label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }
    .url-grid input, .url-grid select {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      color: var(--ink);
      background: white;
      font: inherit;
    }
    .compact-grid {
      display: grid;
      grid-template-columns: minmax(0,1fr) 82px;
      gap: 10px;
    }
    .button-editor {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }
    .button-item {
      display: grid;
      grid-template-columns: 42px minmax(0,1fr) 46px 46px;
      gap: 8px;
      align-items: center;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfdff;
    }
    .button-item input[type="color"] {
      width: 42px;
      height: 42px;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
    }
    .button-fields {
      display: grid;
      gap: 7px;
    }
    .button-fields input {
      width: 100%;
      min-height: 36px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 7px 9px;
      color: var(--ink);
      background: white;
      font: inherit;
    }
    .icon-button {
      width: 46px;
      min-height: 42px;
      border: 1px solid var(--line);
      background: white;
      color: var(--ink);
    }
    .danger-button {
      background: #fff1f3;
      color: #dc2626;
      border-color: #ffe0e5;
    }
    .ecard-panel {
      display: grid;
      gap: 18px;
      margin-top: 14px;
      padding: 16px;
      border: 1px solid #e5edf5;
      border-radius: 18px;
      background: #f8fafc;
    }
    .ecard-block {
      display: grid;
      gap: 10px;
    }
    .ecard-title {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--ink);
      font-size: 15px;
      font-weight: 800;
    }
    .ecard-segment {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      padding: 5px;
      border-radius: 14px;
      background: #e9eef4;
    }
    .ecard-segment label {
      min-width: 0;
      cursor: pointer;
    }
    .ecard-segment input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .ecard-segment span {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      border-radius: 10px;
      color: #607080;
      font-size: 13px;
      font-weight: 800;
      text-align: center;
    }
    .ecard-segment input:checked + span {
      background: #ffffff;
      color: #2563eb;
      box-shadow: 0 4px 14px rgba(30, 41, 59, 0.08);
    }
    .ecard-upload-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 66px;
      gap: 10px;
    }
    .ecard-upload-row input {
      min-width: 0;
      border: 0;
      border-radius: 999px;
      padding: 12px 14px;
      color: var(--ink);
      background: #ffffff;
      font: inherit;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
    }
    .ecard-upload-row button {
      min-height: 44px;
      border-radius: 14px;
      background: #172033;
      font-size: 15px;
    }
    .ecard-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .toggle {
      position: relative;
      width: 50px;
      height: 30px;
      flex: 0 0 auto;
    }
    .toggle input {
      position: absolute;
      opacity: 0;
    }
    .toggle span {
      position: absolute;
      inset: 0;
      border-radius: 999px;
      background: #d8e0e8;
      transition: background .18s ease;
    }
    .toggle span::after {
      content: "";
      position: absolute;
      top: 4px;
      left: 4px;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: white;
      transition: transform .18s ease;
      box-shadow: 0 2px 6px rgba(15, 23, 42, .16);
    }
    .toggle input:checked + span {
      background: #2563eb;
    }
    .toggle input:checked + span::after {
      transform: translateX(20px);
    }
    .ecard-note {
      margin: 0;
      color: #7b8aa0;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.55;
    }
    .detail-editor {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .save-config-button {
      margin-top: 14px;
      background: var(--accent);
      box-shadow: 0 12px 26px rgba(6, 199, 85, 0.22);
    }
    .card-preview {
      display: none;
      margin-top: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: white;
    }
    .card-preview.visible { display: block; }
    .card-preview img {
      width: 100%;
      height: auto;
      max-height: none;
      object-fit: contain;
      display: block;
      background: var(--soft);
    }
    .card-preview-body {
      padding: 14px;
    }
    .card-preview-title {
      font-size: 20px;
      font-weight: 800;
      color: var(--ink);
    }
    .card-preview-meta {
      margin-top: 4px;
      color: var(--muted);
      line-height: 1.45;
    }
    .card-preview-links {
      display: grid;
      gap: 6px;
      margin-top: 10px;
      color: var(--ink);
      line-height: 1.45;
      word-break: break-word;
    }
    .card-list-header {
      display: grid;
      gap: 12px;
      margin: 18px 0 12px;
    }
    .card-search {
      width: 100%;
      min-height: 46px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 14px;
      background: #fff;
      font: inherit;
    }
    .library-list {
      display: grid;
      gap: 10px;
    }
    .library-card {
      width: 100%;
      min-height: 74px;
      display: grid;
      grid-template-columns: 54px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      padding: 12px;
      border: 1px solid #e5edf5;
      border-radius: 14px;
      background: #fff;
      color: var(--ink);
      text-align: left;
      box-shadow: 0 10px 24px rgba(25, 42, 61, .06);
    }
    .library-card img, .library-thumb {
      width: 54px;
      height: 54px;
      border-radius: 12px;
      object-fit: cover;
      background: #eef2f7;
    }
    .library-thumb {
      display: grid;
      place-items: center;
      color: #9aa8b4;
      font-size: 24px;
      font-weight: 900;
    }
    .library-card strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 16px;
    }
    .library-card small {
      display: block;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .library-detail {
      display: none;
      margin-top: 16px;
    }
    .library-detail.visible { display: block; }
    code {
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--soft);
      color: var(--ink);
    }
    @media (max-width: 760px) {
      .app-view { padding: 22px 20px; }
      .app-header { padding: 14px 20px; }
      .quick-actions { gap: 10px; }
      .quick-action button { width: 50px; min-height: 50px; }
    }
  </style>
</head>
<body>
  <main>
    <header class="app-header">
      <strong>LINE商機引擎</strong>
      <button class="round-icon" id="refreshLoginButton" type="button" aria-label="重新登入">↔</button>
    </header>

    <button id="loginButton" type="button">LINE Login</button>

    <section class="app-view active" id="homeView">
      <div class="status" id="status">準備中</div>
      <div class="home-profile">
        <img class="avatar" id="profileAvatar" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
        <div>
          <div class="profile-name"><span id="homeName">會員</span><span class="role-pill" id="homeRole">總管</span></div>
          <div style="color:#607080;font-weight:800;">可用點數</div>
          <div><span class="points" id="homePoints">11,425</span> <span style="font-weight:800;">點</span></div>
        </div>
        <div class="qr-card">
          <div style="font-size:12px;font-weight:800;color:#64748b;">專屬 QR</div>
          <img class="qr-box" id="referralQr" alt="專屬 QR" src="">
          <button class="share-mini" id="homeShareReferral" type="button">分享↗</button>
        </div>
      </div>
      <div class="quick-actions">
        <div class="quick-action"><button id="homeOpenCardButton" type="button">▣</button><span>名片酷</span></div>
        <div class="quick-action"><button type="button">↪</button><span>發名片</span></div>
        <div class="quick-action"><button type="button">◖</button><span>站內公告</span></div>
        <div class="quick-action"><button type="button">▤</button><span>跟進</span></div>
        <div class="quick-action"><button type="button">✉</button><span>收件匣</span></div>
      </div>
      <h2 class="section-title">💡 AI 上手建議</h2>
      <div class="advice-card">
        <div style="font-size:19px;font-weight:900;margin-bottom:8px;">今天先跟進 3 位名片客戶</div>
        <div style="color:#47617d;line-height:1.7;">從剛掃進來、尚未聯繫的人開始，先傳合作說明或安排一次簡短訪談。</div>
      </div>
      <h2 class="section-title">🎧 今日業務助理</h2>
      <div class="advice-card">
        <div style="font-size:18px;font-weight:900;margin-bottom:8px;">等待登入資料同步</div>
        <div style="color:#7890aa;line-height:1.7;">登入完成後會顯示會員、推薦與名片狀態。</div>
      </div>
    </section>

    <section class="app-view" id="cardsView">
      <h1 class="section-title">名片酷</h1>
      <p>掃描別人的實體名片後，AI 會自動建立名片庫資料，方便搜尋、跟進與分享。</p>
      <div id="libraryListSection">
        <div class="scan-panel">
          <div class="scan-title">▣ 掃描建立名片</div>
          <div class="scan-actions">
            <button class="scan-action" id="libraryCaptureButton" type="button"><span>▣</span>拍照掃描</button>
            <button class="scan-action" id="libraryUploadButton" type="button"><span>▧</span>相簿上傳</button>
          </div>
        </div>
        <input class="hidden-file" id="libraryCameraFile" type="file" accept="image/*" capture="environment">
        <input class="hidden-file" id="libraryAlbumFile" type="file" accept="image/*">

        <div class="card-list-header">
          <input class="card-search" id="librarySearchInput" placeholder="搜尋姓名、公司或電話">
        </div>
        <div class="library-list" id="libraryList"></div>
      </div>

      <div class="library-detail" id="libraryDetail">
        <button class="secondary-button" id="backToLibraryListButton" type="button" style="margin-bottom:14px;">← 回名片庫</button>
        <h2>名片詳細資料</h2>
        <div class="card-tabs">
          <button class="card-tab active" type="button" data-library-tab="info">📋 聯絡資料</button>
          <button class="card-tab" type="button" data-library-tab="edit">✏️ 編輯內容</button>
          <button class="card-tab" type="button" data-library-tab="ecard">🪪 數位名片</button>
        </div>
        <div class="card-tab-panel active" id="libraryTabInfo">
          <div class="detail-editor">
            <div class="form-grid">
              <div class="field"><label for="libraryName">姓名</label><input id="libraryName"></div>
              <div class="field"><label for="libraryTitle">職稱</label><input id="libraryTitle"></div>
              <div class="field"><label for="libraryCompany">公司</label><input id="libraryCompany"></div>
              <div class="field"><label for="libraryPhone">電話</label><input id="libraryPhone"></div>
              <div class="field"><label for="libraryEmail">Email</label><input id="libraryEmail"></div>
              <div class="field"><label for="libraryWebsite">網站</label><input id="libraryWebsite"></div>
              <div class="field"><label for="libraryAddress">地址</label><input id="libraryAddress"></div>
            </div>
          </div>
        </div>
        <div class="card-tab-panel" id="libraryTabEdit">
          <div class="detail-editor">
            <div class="field"><label for="libraryIntro">介紹 / 備註</label><textarea id="libraryIntro"></textarea></div>
          </div>
        </div>
        <div class="card-tab-panel" id="libraryTabEcard">
          <div class="ecard-panel">
            <div class="ecard-block">
              <div class="ecard-title">▦ 名片版型</div>
              <div class="ecard-segment" id="libraryEcardLayoutSegment">
                <label><input type="radio" name="library-ecard-layout" value="standard" checked><span>標準(Mega)</span></label>
                <label><input type="radio" name="library-ecard-layout" value="full"><span>滿版(Giga)</span></label>
                <label><input type="radio" name="library-ecard-layout" value="square"><span>正方(1:1)</span></label>
              </div>
            </div>
            <div class="ecard-block">
              <div class="ecard-title">▣ 封面圖片</div>
              <div class="ecard-upload-row">
                <input id="libraryEcardImageUrl" placeholder="https://">
                <button id="uploadLibraryEcardImageButton" type="button">上傳</button>
              </div>
              <input id="libraryEcardCoverFile" type="file" accept="image/*" hidden>
            </div>
            <div class="ecard-block">
              <div class="ecard-toggle-row">
                <div class="ecard-title">▷ 影片版名片</div>
                <label class="toggle"><input id="libraryEcardVideoEnabled" type="checkbox"><span></span></label>
              </div>
              <input id="libraryEcardVideoUrl" class="file-picker" placeholder="影片網址，例如 https://...mp4">
              <p class="ecard-note">開啟後分享名片會使用 LINE Flex video hero，封面圖片會作為縮圖。</p>
            </div>
          </div>
          <div class="card-preview" id="libraryPreview">
            <img id="libraryPreviewImage" alt="">
            <div class="card-preview-body">
              <div class="card-preview-title" id="libraryPreviewTitle"></div>
              <div class="card-preview-meta" id="libraryPreviewMeta"></div>
              <div class="card-preview-meta" id="libraryPreviewIntro"></div>
              <div class="card-preview-links" id="libraryPreviewLinks"></div>
            </div>
          </div>
          <div class="detail-editor">
            <div class="form-grid">
              <div class="compact-grid">
                <div class="field">
                  <label for="libraryShareLabel">分享標籤</label>
                  <input id="libraryShareLabel" placeholder="分享">
                </div>
                <div class="field">
                  <label for="libraryShareColor">顏色</label>
                  <input id="libraryShareColor" type="color" value="#ef4444">
                </div>
              </div>
              <div class="field">
                <label>底部按鈕設定</label>
                <div class="button-editor" id="libraryButtonEditor"></div>
                <button class="secondary-button" id="addLibraryButton" type="button" style="margin-top: 10px;">+ 新增按鈕</button>
              </div>
            </div>
          </div>
          <div class="url-grid">
            <label>標準<input id="libraryPublicUrlStandard" type="text" readonly></label>
            <label>滿版<input id="libraryPublicUrlFull" type="text" readonly></label>
            <label>正方<input id="libraryPublicUrlSquare" type="text" readonly></label>
            <label>目前分享網址<input id="libraryPublicUrl" type="text" readonly></label>
          </div>
        </div>
        <div class="button-row">
          <button class="secondary-button" id="saveLibraryCardButton" type="button">儲存變更</button>
          <button class="secondary-button" id="shareLibraryCardButton" type="button">傳送名片</button>
        </div>
      </div>
    </section>

    <section class="app-view" id="settingsView">
      <h1 class="section-title">設定與參數</h1>
      <div id="settingsList">
        <button class="invite-button" id="copyReferralLink" type="button">⌯ 產生我的專屬邀約連結</button>
        <div class="setting-list">
          <button class="setting-item" id="openCardSettingsButton" type="button"><span>♟ 我的專屬名片設定</span><span>⌄</span></button>
          <button class="setting-item" id="openProfileSettingsButton" type="button"><span>● 會員註冊 / 資料維護</span><span>⌄</span></button>
          <button class="setting-item" type="button"><span>● 本機 GPT API Key</span><span>⌄</span></button>
          <button class="setting-item" type="button"><span>● 個人 AI 助理核心</span><span>⌄</span></button>
          <button class="setting-item" type="button"><span>⌯ 個人社群連結</span><span>⌄</span></button>
          <button class="setting-item" type="button"><span>▻ Telegram 接收設定</span><span>⌄</span></button>
        </div>
      </div>

      <div class="member" id="member">
        <div class="row"><span>會員編號</span><strong id="memberNo"></strong></div>
        <div class="row"><span>我的推薦碼</span><strong id="myReferralCode"></strong></div>
        <div class="row"><span>歸屬狀態</span><strong id="attribution"></strong></div>
        <div class="copy-row">
          <input id="referralLink" type="text" readonly aria-label="Referral link">
        </div>
        <div class="row"><span>直接下線</span><strong id="downlineCount">0</strong></div>
        <div class="downlines" id="downlines"></div>
      </div>

      <div class="card-sdk" id="profileSdk">
          <button class="secondary-button" id="backFromProfileButton" type="button" style="margin-bottom:14px;">← 回設定</button>
          <h2>會員註冊資料</h2>
          <p>這裡是個人會員資料，和名片上的聯絡資料分開保存。</p>
          <div class="detail-editor">
            <div class="form-grid">
              <div class="field"><label for="profileName">姓名</label><input id="profileName" autocomplete="name"></div>
              <div class="field"><label for="profileBirthday">生日</label><input id="profileBirthday" type="date"></div>
              <div class="field"><label for="profilePhone">電話</label><input id="profilePhone" autocomplete="tel"></div>
              <div class="field"><label for="profileResidence">居住地</label><input id="profileResidence"></div>
              <div class="field"><label for="profileIndustry">行業別</label><input id="profileIndustry"></div>
            </div>
          </div>
          <button class="save-config-button" id="saveProfileButton" type="button">▣ 儲存會員資料</button>
      </div>

      <div class="card-sdk" id="cardSdk">
          <button class="secondary-button" id="backToSettingsButton" type="button" style="margin-bottom:14px;">← 回設定</button>
          <h2>我的名片</h2>
          <p>拍照或上傳名片，AI 只抽欄位，圖片與資料都存到 Wasabi。</p>
          <div class="scan-panel">
            <div class="scan-title">▣ 掃描建立名片</div>
            <div class="scan-actions">
              <button class="scan-action" id="captureCardButton" type="button"><span>▣</span>拍照掃描</button>
              <button class="scan-action" id="uploadCardPhotoButton" type="button"><span>▧</span>相簿上傳</button>
            </div>
          </div>
          <div class="button-row">
            <button class="secondary-button" id="recognizeCardButton" type="button">AI 辨識</button>
            <button class="secondary-button" id="saveCardButton" type="button">儲存名片設定</button>
          </div>
          <input class="hidden-file" id="cardCameraFile" type="file" accept="image/*" capture="environment">
          <input class="hidden-file" id="cardAlbumFile" type="file" accept="image/*">
          <input class="hidden-file" id="cardImageFile" type="file" accept="image/*">
          <input id="ecardCoverFile" type="file" accept="image/*" hidden>
          <div class="card-tabs">
            <button class="card-tab active" type="button" data-card-tab="contact">📋 聯絡資料</button>
            <button class="card-tab" type="button" data-card-tab="content">✏️ 編輯內容</button>
            <button class="card-tab" type="button" data-card-tab="ecard">🪪 數位名片</button>
          </div>

          <div class="card-tab-panel active" id="cardTabContact">
            <div class="detail-editor" id="detailEditor">
              <div class="form-grid">
                <div class="field"><label for="cardName">姓名</label><input id="cardName" autocomplete="name"></div>
                <div class="field"><label for="cardTitle">職稱</label><input id="cardTitle"></div>
                <div class="field"><label for="cardCompany">公司</label><input id="cardCompany" autocomplete="organization"></div>
                <div class="field"><label for="cardPhone">電話</label><input id="cardPhone" autocomplete="tel"></div>
                <div class="field"><label for="cardEmail">Email</label><input id="cardEmail" autocomplete="email"></div>
                <div class="field"><label for="cardWebsite">網站</label><input id="cardWebsite" autocomplete="url"></div>
                <div class="field"><label for="cardAddress">地址</label><input id="cardAddress"></div>
              </div>
            </div>
          </div>

          <div class="card-tab-panel" id="cardTabContent">
            <div class="detail-editor">
              <div class="form-grid">
                <div class="field"><label for="cardIntro">介紹</label><textarea id="cardIntro"></textarea></div>
              </div>
            </div>
          </div>

          <div class="card-tab-panel" id="cardTabEcard">
            <div class="ecard-panel">
              <div class="ecard-block">
                <div class="ecard-title">▦ 名片版型</div>
                <div class="ecard-segment" id="ecardLayoutSegment">
                  <label><input type="radio" name="ecard-layout" value="standard" checked><span>標準(Mega)</span></label>
                  <label><input type="radio" name="ecard-layout" value="full"><span>滿版(Giga)</span></label>
                  <label><input type="radio" name="ecard-layout" value="square"><span>正方(1:1)</span></label>
                </div>
              </div>
              <div class="ecard-block">
                <div class="ecard-title">▣ 封面圖片</div>
                <div class="ecard-upload-row">
                  <input id="ecardImageUrl" placeholder="https://">
                  <button id="uploadEcardImageButton" type="button">上傳</button>
                </div>
              </div>
              <div class="ecard-block">
                <div class="ecard-toggle-row">
                  <div class="ecard-title">▻ 影片版名片</div>
                  <label class="toggle"><input id="ecardVideoEnabled" type="checkbox"><span></span></label>
                </div>
                <input id="ecardVideoUrl" class="file-picker" placeholder="影片網址，例如 https://...mp4">
                <p class="ecard-note">開啟後分享名片會使用 LINE Flex video hero，封面圖片會作為縮圖。</p>
              </div>
            </div>
            <div class="card-preview" id="cardPreview">
              <img id="cardPreviewImage" alt="">
              <div class="card-preview-body">
                <div class="card-preview-title" id="cardPreviewTitle"></div>
                <div class="card-preview-meta" id="cardPreviewMeta"></div>
              </div>
            </div>
            <div class="detail-editor">
              <div class="form-grid">
                <div class="compact-grid">
                  <div class="field">
                    <label for="cardShareLabel">分享標籤</label>
                    <input id="cardShareLabel" placeholder="分享">
                  </div>
                  <div class="field">
                    <label for="cardShareColor">顏色</label>
                    <input id="cardShareColor" type="color" value="#ef4444">
                  </div>
                </div>
                <div class="field">
                  <label>底部按鈕設定</label>
                  <div class="button-editor" id="cardButtonEditor"></div>
                  <button class="secondary-button" id="addCardButton" type="button" style="margin-top: 10px;">+ 新增按鈕</button>
                </div>
              </div>
            </div>
            <button class="save-config-button" id="saveEcardConfigButton" type="button">▣ 儲存名片設定</button>
            <div class="url-grid">
              <label>標準<input id="publicCardUrlStandard" type="text" readonly></label>
              <label>滿版<input id="publicCardUrlFull" type="text" readonly></label>
              <label>正方<input id="publicCardUrlSquare" type="text" readonly></label>
              <button class="secondary-button" id="shareCardButton" type="button">分享名片</button>
            </div>
          </div>
        </div>
    </section>

    <nav class="bottom-nav">
      <button class="nav-button active" id="navHome" type="button">⌂<br>首頁</button>
      <button class="nav-button" id="navCards" type="button">♟<br>名片酷</button>
      <button class="nav-button" type="button">◎<br>配對</button>
      <button class="nav-button" id="navSettings" type="button">●<br>設定</button>
    </nav>
  </main>
  <div class="cropper-modal" id="cardCropperModal" aria-hidden="true">
    <div class="cropper-stage">
      <img id="cardCropperImage" alt="裁切名片照片">
    </div>
    <div class="cropper-toolbar">
      <div class="cropper-tools">
        <button id="cropZoomOutButton" type="button">縮小</button>
        <button id="cropResetButton" type="button">重置</button>
        <button id="cropZoomInButton" type="button">放大</button>
      </div>
      <div class="cropper-actions">
        <button id="cropCancelButton" type="button">取消</button>
        <button class="confirm-crop" id="cropConfirmButton" type="button">確認裁切</button>
      </div>
    </div>
  </div>
  <div class="action-busy" id="actionBusy" role="status" aria-live="polite">處理中...</div>
  <script>
    const config = ${JSON.stringify({ storeCode, referralCode, liffId })};
    const statusEl = document.getElementById("status");
    const actionBusyEl = document.getElementById("actionBusy");
    const loginButton = document.getElementById("loginButton");
    const memberEl = document.getElementById("member");
    const cardSdkEl = document.getElementById("cardSdk");
    const profileSdkEl = document.getElementById("profileSdk");
    const homeView = document.getElementById("homeView");
    const cardsView = document.getElementById("cardsView");
    const settingsView = document.getElementById("settingsView");
    const settingsList = document.getElementById("settingsList");
    const navHome = document.getElementById("navHome");
    const navCards = document.getElementById("navCards");
    const navSettings = document.getElementById("navSettings");
    let currentIdToken = "";
    let currentSessionToken = "";
    let currentMember = null;
    let currentCard = null;
    let activeCardLayout = "standard";
    let selectedCardImages = {};
    let selectedRecognizeFile = null;
    let selectedRecognizeImageDataUrl = "";
    let scanTarget = "self";
    let libraryCards = [];
    let libraryCardsLoaded = false;
    let currentLibraryCard = null;
    let cardCropper = null;
    let lastCardUploadImage = "";
    let cardButtons = [];
    let activeLibraryLayout = "standard";
    let libraryButtons = [];
    let selectedLibraryImages = {};
    let processingCount = 0;
    let processingHideTimer = null;
    let processingButtonTimer = null;
    let processingButton = null;

    function setStatus(text) {
      statusEl.textContent = text;
      const message = String(text || "");
      if (/正在|處理中/.test(message)) {
        showProcessing(message);
      } else if (/完成|已|失敗|請|無法|尚未|準備/.test(message)) {
        hideProcessing();
      }
    }

    function showProcessing(message = "處理中...") {
      if (processingHideTimer) clearTimeout(processingHideTimer);
      actionBusyEl.textContent = message;
      actionBusyEl.classList.add("visible");
    }

    function hideProcessing() {
      if (processingCount > 0) return;
      if (processingHideTimer) clearTimeout(processingHideTimer);
      processingHideTimer = setTimeout(() => {
        if (processingCount <= 0) actionBusyEl.classList.remove("visible");
      }, 220);
    }

    function markButtonProcessing(button) {
      if (!button || button.matches(".nav-button, .round-icon, .icon-button") || button.id === "loginButton") return;
      if (processingButton && processingButton !== button) clearButtonProcessing(processingButton);
      processingButton = button;
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.classList.add("is-processing");
      button.disabled = true;
      button.textContent = "處理中...";
    }

    function clearButtonProcessing(button) {
      if (!button) return;
      if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
      button.classList.remove("is-processing");
      button.disabled = false;
      if (processingButton === button) processingButton = null;
    }

    function finishTransientButton(button) {
      if (processingButtonTimer) clearTimeout(processingButtonTimer);
      processingButtonTimer = setTimeout(() => {
        if (processingCount <= 0) {
          clearButtonProcessing(button);
          hideProcessing();
        }
      }, 700);
    }

    document.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button || button.disabled) return;
      showProcessing("處理中...");
      markButtonProcessing(button);
      finishTransientButton(button);
    }, true);

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      processingCount += 1;
      showProcessing("資料處理中...");
      try {
        return await nativeFetch(...args);
      } finally {
        processingCount = Math.max(0, processingCount - 1);
        if (processingCount <= 0) {
          clearButtonProcessing(processingButton);
          hideProcessing();
        }
      }
    };

    function escapeHtmlClient(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function avatarPlaceholder(name) {
      const initial = String(name || "會員").trim().slice(0, 1).toUpperCase() || "會";
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108"><rect width="108" height="108" rx="54" fill="#dbeafe"/><text x="54" y="65" text-anchor="middle" font-family="Arial, sans-serif" font-size="42" font-weight="800" fill="#2563eb">' + initial.replace(/[<>&]/g, "") + '</text></svg>';
      return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
    }

    function renderProfileAvatar(member) {
      const avatar = document.getElementById("profileAvatar");
      const name = member?.profile?.name || member?.displayName || member?.memberNo || "會員";
      const fallback = avatarPlaceholder(name);
      avatar.alt = name;
      avatar.onerror = () => {
        avatar.onerror = null;
        avatar.src = fallback;
      };
      avatar.src = member?.pictureUrl || fallback;
    }

    function buildReferralLink(referralCode) {
      const referralLink = new URL("/app", location.origin);
      referralLink.searchParams.set("storeCode", config.storeCode);
      referralLink.searchParams.set("ref", referralCode);
      return referralLink;
    }

    function renderReferralQr(url) {
      const qr = document.getElementById("referralQr");
      if (!url) {
        qr.removeAttribute("src");
        return;
      }
      qr.src = "https://api.qrserver.com/v1/create-qr-code/?size=128x128&margin=0&data=" + encodeURIComponent(url);
    }

    async function getClientLineProfile() {
      try {
        if (!window.liff || !liff.isLoggedIn()) return null;
        const profile = await liff.getProfile();
        return {
          userId: profile.userId || "",
          displayName: profile.displayName || "",
          pictureUrl: profile.pictureUrl || "",
        };
      } catch (error) {
        return null;
      }
    }

    async function boot() {
      if (!config.liffId) {
        loginButton.disabled = true;
        setStatus("尚未設定 LINE_LIFF_ID，請先在 Worker secret 或變數加入 LIFF ID。");
        return;
      }
      try {
        await liff.init({ liffId: config.liffId });
        if (!liff.isLoggedIn()) {
          setStatus("正在開啟 LINE 登入...");
          liff.login({ redirectUri: location.href });
          return;
        }
        if (await restoreSession()) return;
        await submitIdToken();
      } catch (error) {
        setStatus(error.message || "LIFF 初始化失敗");
      }
    }

    async function restoreSession() {
      let token = "";
      try {
        token = sessionStorage.getItem("SDKSYS_SESSION_" + config.storeCode) || "";
      } catch (error) {}
      if (!token) return false;
      setStatus("正在檢查登入狀態...");
      try {
        const response = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionToken: token, storeCode: config.storeCode }),
        });
        const result = await response.json();
        if (!result.ok) {
          try { sessionStorage.removeItem("SDKSYS_SESSION_" + config.storeCode); } catch (error) {}
          return false;
        }
        currentSessionToken = token;
        hydrateLoginState(result);
        setStatus("登入完成");
        return true;
      } catch (error) {
        return false;
      }
    }

    function hydrateLoginState(result) {
      document.getElementById("memberNo").textContent = result.member.memberNo;
      document.getElementById("myReferralCode").textContent = result.member.referralCode;
      document.getElementById("attribution").textContent = result.attribution?.result || result.attribution?.status || "active";
      fillProfileForm(result.member.profile || {});
      document.getElementById("homeName").textContent = result.member.profile?.name || result.member.displayName || result.member.memberNo || "會員";
      document.getElementById("homeRole").textContent = result.member.role === "admin" ? "總管" : "會員";
      renderProfileAvatar(result.member);
      const referralLink = buildReferralLink(result.member.referralCode);
      document.getElementById("referralLink").value = referralLink.toString();
      renderReferralQr(referralLink.toString());
      renderDownlines(result.downlines || []);
      currentMember = result.member;
    }

    async function submitIdToken() {
      const idToken = liff.getIDToken();
      if (!idToken) {
        await restartLineLogin();
        return;
      }
      currentIdToken = idToken;
      setStatus("正在檢查登入狀態...");
      const clientLineProfile = await getClientLineProfile();
      const response = await fetch("/api/auth/line-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeCode: config.storeCode,
          referralCode: config.referralCode || undefined,
          lineProfile: clientLineProfile || undefined,
        }),
      });
      const result = await response.json();
      if (!result.ok) {
        if (shouldRefreshLineLogin(result)) {
          await restartLineLogin();
          return;
        }
        setStatus(result.message || result.error || "登入失敗");
        return;
      }
      currentSessionToken = result.sessionToken || "";
      try {
        sessionStorage.setItem("SDKSYS_SESSION_" + config.storeCode, currentSessionToken);
      } catch (error) {}
      hydrateLoginState(result);
      setStatus("登入完成");
    }

    function shouldRefreshLineLogin(result) {
      const text = String((result && (result.message || result.error)) || "").toLowerCase();
      return text.includes("expired") || text.includes("idtoken") || text.includes("line_verify_failed");
    }

    async function restartLineLogin() {
      setStatus("LINE 登入已過期，正在重新登入...");
      try { sessionStorage.removeItem("SDKSYS_SESSION_" + config.storeCode); } catch (error) {}
      try {
        if (window.liff && liff.isLoggedIn()) liff.logout();
      } catch (error) {}
      liff.login({ redirectUri: location.href });
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function imageToCanvasDataUrl(src, maxSize, quality) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = src;
      });
    }

    async function compressCardImage(file, maxSize = 1280) {
      const dataUrl = await readFileAsDataUrl(file);
      let quality = 0.86;
      let output = await imageToCanvasDataUrl(dataUrl, maxSize, quality);
      while (output.length > 950000 && quality > 0.42) {
        quality -= 0.12;
        output = await imageToCanvasDataUrl(dataUrl, maxSize, quality);
      }
      return output;
    }

    function normalizeLayoutName(value) {
      const aliases = { landscape: "standard", poster: "standard", portrait: "full", classic: "full", free: "full", links: "square" };
      const layout = String(value || "standard").toLowerCase();
      return aliases[layout] || (["standard", "full", "square"].includes(layout) ? layout : "standard");
    }

    function getSelectedLayout() {
      const checked = document.querySelector('input[name="ecard-layout"]:checked');
      return normalizeLayoutName(checked ? checked.value : activeCardLayout);
    }

    function cleanImageUrlInput(value) {
      const text = String(value || "").trim();
      if (!text || text.startsWith("data:image/")) return "";
      return text;
    }

    function cleanShareLabelInput(value) {
      const text = String(value || "").trim();
      if (!text || /^https?:\\/\\//i.test(text) || /^\\/?card\\//i.test(text) || text.includes(".workers.dev")) return "分享";
      return text.slice(0, 16);
    }

    function setSelectedLayout(layout) {
      const normalized = normalizeLayoutName(layout);
      const input = document.querySelector('input[name="ecard-layout"][value="' + normalized + '"]');
      if (input) input.checked = true;
      activeCardLayout = normalized;
      return normalized;
    }
    function getCardFormData() {
      return {
        name: document.getElementById("cardName").value.trim(),
        title: document.getElementById("cardTitle").value.trim(),
        company: document.getElementById("cardCompany").value.trim(),
        phone: document.getElementById("cardPhone").value.trim(),
        email: document.getElementById("cardEmail").value.trim(),
        website: document.getElementById("cardWebsite").value.trim(),
        address: document.getElementById("cardAddress").value.trim(),
        intro: document.getElementById("cardIntro").value.trim(),
        shareLabel: cleanShareLabelInput(document.getElementById("cardShareLabel").value),
        shareColor: document.getElementById("cardShareColor").value,
        layout: getSelectedLayout(),
        imageUrl: cleanImageUrlInput(document.getElementById("ecardImageUrl").value),
        videoEnabled: document.getElementById("ecardVideoEnabled").checked,
        videoUrl: document.getElementById("ecardVideoUrl").value.trim(),
        buttons: getCardButtons(),
      };
    }

    function baseCardFields(card) {
      card = card || {};
      return {
        name: card.name || "",
        title: card.title || "",
        company: card.company || "",
        phone: card.phone || "",
        email: card.email || "",
        website: card.website || "",
        address: card.address || "",
        intro: card.intro || "",
        shareLabel: cleanShareLabelInput(card.shareLabel),
        shareColor: card.shareColor || "#ef4444",
        buttons: Array.isArray(card.buttons) ? card.buttons : [],
        imageUrl: card.imageUrl || "",
        imageKey: card.imageKey || "",
        videoEnabled: Boolean(card.videoEnabled),
        videoUrl: card.videoUrl || "",
      };
    }

    function getEffectiveLayoutCard(card, layout) {
      layout = normalizeLayoutName(layout);
      const base = baseCardFields(card);
      const override = card && card.layouts && card.layouts[layout] ? card.layouts[layout] : {};
      const merged = { ...base, ...override };
      if (!merged.imageUrl && base.imageUrl) merged.imageUrl = base.imageUrl;
      if (!merged.imageKey && base.imageKey) merged.imageKey = base.imageKey;
      if ((!Array.isArray(merged.buttons) || !merged.buttons.length) && Array.isArray(base.buttons)) merged.buttons = base.buttons;
      return { ...merged, layout, publicUrls: card?.publicUrls || {}, publicUrl: card?.publicUrls?.[layout] || card?.publicUrl || "" };
    }

    function saveCurrentLayoutDraft() {
      if (!currentCard) currentCard = {};
      const layout = normalizeLayoutName(activeCardLayout);
      activeCardLayout = layout;
      currentCard.layouts = { ...(currentCard.layouts || {}) };
      currentCard.layouts[layout] = {
        ...(currentCard.layouts[layout] || {}),
        ...getCardFormData(),
        layout,
      };
    }

    function fillCardForm(card, layout) {
      card = card || {};
      activeCardLayout = setSelectedLayout(layout || card.layout || activeCardLayout || "standard");
      const view = getEffectiveLayoutCard(card, activeCardLayout);
      document.getElementById("cardName").value = view.name || "";
      document.getElementById("cardTitle").value = view.title || "";
      document.getElementById("cardCompany").value = view.company || "";
      document.getElementById("cardPhone").value = view.phone || "";
      document.getElementById("cardEmail").value = view.email || "";
      document.getElementById("cardWebsite").value = view.website || "";
      document.getElementById("cardAddress").value = view.address || "";
      document.getElementById("cardIntro").value = view.intro || "";
      if (view.name && !currentMember?.profile?.name) document.getElementById("homeName").textContent = view.name;
      document.getElementById("cardShareLabel").value = cleanShareLabelInput(view.shareLabel);
      document.getElementById("cardShareColor").value = view.shareColor || "#ef4444";
      document.getElementById("ecardImageUrl").value = view.imageUrl || "";
      document.getElementById("ecardVideoEnabled").checked = Boolean(view.videoEnabled);
      document.getElementById("ecardVideoUrl").value = view.videoUrl || "";
      cardButtons = Array.isArray(view.buttons) && view.buttons.length ? view.buttons.slice(0, 6) : defaultCardButtons(view);
      renderCardButtonEditor();
      const urls = card.publicUrls || {};
      document.getElementById("publicCardUrlStandard").value = urls.standard || urls.poster || card.publicUrl || "";
      document.getElementById("publicCardUrlFull").value = urls.full || urls.free || urls.classic || card.publicUrl || "";
      document.getElementById("publicCardUrlSquare").value = urls.square || urls.links || card.publicUrl || "";
      renderCardPreview(view);
    }

    function renderCardPreview(card) {
      const preview = document.getElementById("cardPreview");
      const previewImage = selectedCardImages[activeCardLayout] || card?.imageUrl || "";
      if (!card || (!card.name && !card.company && !previewImage)) {
        preview.classList.remove("visible");
        return;
      }
      document.getElementById("cardPreviewImage").src = previewImage;
      document.getElementById("cardPreviewImage").style.display = previewImage ? "block" : "none";
      document.getElementById("cardPreviewTitle").textContent = card.name || "未命名名片";
      document.getElementById("cardPreviewMeta").textContent = [card.company, card.title, card.phone, card.email].filter(Boolean).join(" / ");
      preview.classList.add("visible");
    }

    function cleanPhoneForLink(value) {
      return String(value || "").replace(/[^0-9+]/g, "");
    }

    function defaultCardButtons(card) {
      const buttons = [];
      const phone = cleanPhoneForLink(card && card.phone);
      if (phone) buttons.push({ label: "行動電話", url: "tel:" + phone, color: "#9b1c0c" });
      if (card && card.address) buttons.push({ label: "店家地址", url: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(card.address), color: "#1f2937" });
      return buttons.length ? buttons.slice(0, 6) : [
        { label: "加LINE好友", url: "https://line.me/R/ti/p/", color: "#06c755" },
        { label: "店家地址", url: "https://www.google.com/maps", color: "#1f2937" },
        { label: "行動電話", url: "tel:", color: "#9b1c0c" },
      ];
    }

    function getCardButtons() {
      return cardButtons.map((button) => ({
        label: String(button.label || "").trim(),
        url: String(button.url || "").trim(),
        color: String(button.color || "#06c755").trim(),
      })).filter((button) => button.label && button.url).slice(0, 6);
    }

    function renderCardButtonEditor() {
      const editor = document.getElementById("cardButtonEditor");
      editor.innerHTML = "";
      cardButtons.forEach((button, index) => {
        const row = document.createElement("div");
        row.className = "button-item";

        const color = document.createElement("input");
        color.type = "color";
        color.value = button.color || "#06c755";
        color.addEventListener("input", () => { cardButtons[index].color = color.value; });

        const fields = document.createElement("div");
        fields.className = "button-fields";
        const label = document.createElement("input");
        label.placeholder = "按鈕文字";
        label.value = button.label || "";
        label.addEventListener("input", () => { cardButtons[index].label = label.value; });
        const url = document.createElement("input");
        url.placeholder = "https:// / tel: / mailto:";
        url.value = button.url || "";
        url.addEventListener("input", () => { cardButtons[index].url = url.value; });
        fields.append(label, url);

        const move = document.createElement("button");
        move.type = "button";
        move.className = "icon-button";
        move.textContent = index === 0 ? "↓" : "↑";
        move.addEventListener("click", () => {
          const target = index === 0 ? 1 : index - 1;
          if (target < 0 || target >= cardButtons.length) return;
          const current = cardButtons[index];
          cardButtons[index] = cardButtons[target];
          cardButtons[target] = current;
          renderCardButtonEditor();
        });

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "icon-button danger-button";
        remove.textContent = "刪";
        remove.addEventListener("click", () => {
          cardButtons.splice(index, 1);
          renderCardButtonEditor();
        });

        row.append(color, fields, move, remove);
        editor.appendChild(row);
      });
    }

    function selectedPublicCardUrl(card) {
      const layout = getSelectedLayout();
      const urls = (card && card.publicUrls) || {};
      const aliases = { standard: "poster", full: "free", square: "links" };
      return urls[layout] || urls[aliases[layout]] || card?.publicUrl || "";
    }

    async function loadMyCard() {
      if (!currentSessionToken) return;
      if (currentCard) return;
      const response = await fetch("/api/cards/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionToken: currentSessionToken, storeCode: config.storeCode }),
      });
      const result = await response.json();
      if (result.ok && result.card) {
        currentCard = result.card;
        fillCardForm(currentCard);
      }
    }

    async function loadLibraryCards() {
      if (!currentSessionToken) return;
      if (libraryCardsLoaded) return;
      const response = await fetch("/api/cards/library/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionToken: currentSessionToken, storeCode: config.storeCode }),
      });
      const result = await response.json();
      if (!result.ok) {
        setStatus(result.message || result.error || "名片庫載入失敗");
        return;
      }
      libraryCards = Array.isArray(result.cards) ? result.cards : [];
      libraryCardsLoaded = true;
      renderLibraryList();
    }

    function libraryCardTitle(card) {
      return card?.name || card?.company || "未命名名片";
    }

    function renderLibraryList() {
      const list = document.getElementById("libraryList");
      const query = String(document.getElementById("librarySearchInput").value || "").trim().toLowerCase();
      const cards = libraryCards.filter((card) => {
        if (!query) return true;
        return [card.name, card.company, card.title, card.phone, card.email, card.website, card.address, card.intro].join(" ").toLowerCase().includes(query);
      });
      if (!cards.length) {
        list.innerHTML = '<div class="advice-card" style="text-align:center;color:#7890aa;font-weight:800;">目前沒有名片資料</div>';
        return;
      }
      list.innerHTML = "";
      for (const card of cards) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "library-card";
        if (card.imageUrl) {
          const image = document.createElement("img");
          image.src = card.imageUrl;
          image.alt = "";
          button.appendChild(image);
        } else {
          const thumb = document.createElement("div");
          thumb.className = "library-thumb";
          thumb.textContent = "名";
          button.appendChild(thumb);
        }
        const meta = [card.company, card.title, card.phone].filter(Boolean).join(" / ") || "掃描名片";
        const body = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = libraryCardTitle(card);
        const sub = document.createElement("small");
        sub.textContent = meta;
        body.append(title, sub);
        const arrow = document.createElement("span");
        arrow.textContent = "›";
        button.append(body, arrow);
        button.addEventListener("click", () => openLibraryDetail(card.cardId));
        list.appendChild(button);
      }
    }

    function showLibraryTab(tab) {
      const target = ["info", "edit", "ecard"].includes(tab) ? tab : "info";
      document.querySelectorAll("[data-library-tab]").forEach((button) => {
        button.classList.toggle("active", button.dataset.libraryTab === target);
      });
      document.getElementById("libraryTabInfo").classList.toggle("active", target === "info");
      document.getElementById("libraryTabEdit").classList.toggle("active", target === "edit");
      document.getElementById("libraryTabEcard").classList.toggle("active", target === "ecard");
    }

    function setSelectedLibraryLayout(layout) {
      const normalized = normalizeLayoutName(layout);
      const input = document.querySelector('input[name="library-ecard-layout"][value="' + normalized + '"]');
      if (input) input.checked = true;
      activeLibraryLayout = normalized;
      return normalized;
    }

    function getSelectedLibraryLayout() {
      const input = document.querySelector('input[name="library-ecard-layout"]:checked');
      return normalizeLayoutName(input ? input.value : activeLibraryLayout);
    }

    function getLibraryButtons() {
      return libraryButtons.map((button) => ({
        label: String(button.label || "").trim(),
        url: String(button.url || "").trim(),
        color: String(button.color || "#06c755").trim(),
      })).filter((button) => button.label && button.url).slice(0, 6);
    }

    function renderLibraryButtonEditor() {
      const editor = document.getElementById("libraryButtonEditor");
      editor.innerHTML = "";
      libraryButtons.forEach((button, index) => {
        const row = document.createElement("div");
        row.className = "button-item";

        const color = document.createElement("input");
        color.type = "color";
        color.value = button.color || "#06c755";
        color.addEventListener("input", () => { libraryButtons[index].color = color.value; });

        const fields = document.createElement("div");
        fields.className = "button-fields";
        const label = document.createElement("input");
        label.placeholder = "按鈕文字";
        label.value = button.label || "";
        label.addEventListener("input", () => { libraryButtons[index].label = label.value; });
        const url = document.createElement("input");
        url.placeholder = "https:// / tel: / mailto:";
        url.value = button.url || "";
        url.addEventListener("input", () => { libraryButtons[index].url = url.value; });
        fields.append(label, url);

        const move = document.createElement("button");
        move.type = "button";
        move.textContent = index === 0 ? "↓" : "↑";
        move.addEventListener("click", () => {
          const target = index === 0 ? 1 : index - 1;
          if (target < 0 || target >= libraryButtons.length) return;
          const current = libraryButtons[index];
          libraryButtons[index] = libraryButtons[target];
          libraryButtons[target] = current;
          renderLibraryButtonEditor();
        });

        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "刪";
        remove.className = "danger-button";
        remove.addEventListener("click", () => {
          libraryButtons.splice(index, 1);
          renderLibraryButtonEditor();
        });

        row.append(color, fields, move, remove);
        editor.appendChild(row);
      });
    }

    function saveCurrentLibraryLayoutDraft() {
      if (!currentLibraryCard) return;
      const layout = normalizeLayoutName(activeLibraryLayout);
      activeLibraryLayout = layout;
      currentLibraryCard.layouts = { ...(currentLibraryCard.layouts || {}) };
      currentLibraryCard.layouts[layout] = {
        ...(currentLibraryCard.layouts[layout] || {}),
        ...getLibraryFormData(),
        layout,
      };
    }

    function fillLibraryForm(card, layout) {
      currentLibraryCard = card || null;
      activeLibraryLayout = setSelectedLibraryLayout(layout || card?.layout || activeLibraryLayout || "standard");
      const view = getEffectiveLayoutCard(card || {}, activeLibraryLayout);
      document.getElementById("libraryName").value = view.name || "";
      document.getElementById("libraryTitle").value = view.title || "";
      document.getElementById("libraryCompany").value = view.company || "";
      document.getElementById("libraryPhone").value = view.phone || "";
      document.getElementById("libraryEmail").value = view.email || "";
      document.getElementById("libraryWebsite").value = view.website || "";
      document.getElementById("libraryAddress").value = view.address || "";
      document.getElementById("libraryIntro").value = view.intro || "";
      document.getElementById("libraryShareLabel").value = cleanShareLabelInput(view.shareLabel);
      document.getElementById("libraryShareColor").value = view.shareColor || "#ef4444";
      document.getElementById("libraryEcardImageUrl").value = view.imageUrl || "";
      document.getElementById("libraryEcardVideoEnabled").checked = Boolean(view.videoEnabled);
      document.getElementById("libraryEcardVideoUrl").value = view.videoUrl || "";
      libraryButtons = Array.isArray(view.buttons) && view.buttons.length ? view.buttons.slice(0, 6) : defaultCardButtons(view);
      renderLibraryButtonEditor();
      const urls = card?.publicUrls || {};
      document.getElementById("libraryPublicUrlStandard").value = urls.standard || card?.publicUrl || "";
      document.getElementById("libraryPublicUrlFull").value = urls.full || urls.free || urls.classic || card?.publicUrl || "";
      document.getElementById("libraryPublicUrlSquare").value = urls.square || urls.links || card?.publicUrl || "";
      document.getElementById("libraryPublicUrl").value = view.publicUrl || card?.publicUrl || "";
      renderLibraryPreview(view);
    }

    function renderLibraryPreview(card) {
      const preview = document.getElementById("libraryPreview");
      const previewImage = selectedLibraryImages[activeLibraryLayout] || card?.imageUrl || "";
      document.getElementById("libraryPreviewImage").src = previewImage;
      document.getElementById("libraryPreviewImage").style.display = previewImage ? "block" : "none";
      document.getElementById("libraryPreviewTitle").textContent = libraryCardTitle(card);
      document.getElementById("libraryPreviewMeta").textContent = [card?.company, card?.title].filter(Boolean).join(" / ");
      document.getElementById("libraryPreviewIntro").textContent = card?.intro || "";
      const links = document.getElementById("libraryPreviewLinks");
      links.innerHTML = "";
      [
        ["電話", card?.phone],
        ["Email", card?.email],
        ["網站", card?.website],
        ["地址", card?.address],
      ].forEach(([label, value]) => {
        if (!value) return;
        const row = document.createElement("div");
        row.textContent = label + "：" + value;
        links.appendChild(row);
      });
      preview.classList.toggle("visible", Boolean(card && (card.name || card.company || previewImage)));
    }

    function getLibraryFormData() {
      return {
        name: document.getElementById("libraryName").value.trim(),
        title: document.getElementById("libraryTitle").value.trim(),
        company: document.getElementById("libraryCompany").value.trim(),
        phone: document.getElementById("libraryPhone").value.trim(),
        email: document.getElementById("libraryEmail").value.trim(),
        website: document.getElementById("libraryWebsite").value.trim(),
        address: document.getElementById("libraryAddress").value.trim(),
        intro: document.getElementById("libraryIntro").value.trim(),
        shareLabel: cleanShareLabelInput(document.getElementById("libraryShareLabel").value),
        shareColor: document.getElementById("libraryShareColor").value,
        layout: getSelectedLibraryLayout(),
        imageUrl: cleanImageUrlInput(document.getElementById("libraryEcardImageUrl").value),
        videoEnabled: document.getElementById("libraryEcardVideoEnabled").checked,
        videoUrl: document.getElementById("libraryEcardVideoUrl").value.trim(),
        buttons: getLibraryButtons(),
      };
    }

    function openLibraryDetail(cardId) {
      const card = libraryCards.find((item) => item.cardId === cardId);
      if (!card) return;
      selectedLibraryImages = {};
      fillLibraryForm(card);
      document.getElementById("libraryListSection").style.display = "none";
      document.getElementById("libraryDetail").classList.add("visible");
      showLibraryTab("info");
      setTimeout(() => document.getElementById("libraryDetail").scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }

    function closeLibraryDetail() {
      currentLibraryCard = null;
      selectedLibraryImages = {};
      document.getElementById("libraryListSection").style.display = "";
      document.getElementById("libraryDetail").classList.remove("visible");
    }

    async function saveLibraryCard() {
      if (!currentLibraryCard || !currentSessionToken) return false;
      saveCurrentLibraryLayoutDraft();
      const layout = activeLibraryLayout;
      const card = { ...currentLibraryCard, ...getLibraryFormData(), layout };
      setStatus("正在儲存名片資料...");
      const response = await fetch("/api/cards/library/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionToken: currentSessionToken,
          storeCode: config.storeCode,
          cardId: currentLibraryCard.cardId,
          card,
          imageDataUrl: selectedLibraryImages[layout] || undefined,
          imageDataUrls: selectedLibraryImages,
        }),
      });
      const result = await response.json();
      if (!result.ok) {
        setStatus(result.message || result.error || "名片儲存失敗");
        return false;
      }
      const index = libraryCards.findIndex((item) => item.cardId === result.card.cardId);
      if (index >= 0) libraryCards[index] = result.card;
      else libraryCards.unshift(result.card);
      selectedLibraryImages = {};
      document.getElementById("libraryEcardCoverFile").value = "";
      fillLibraryForm(result.card);
      renderLibraryList();
      setStatus("名片資料已儲存");
      return true;
    }

    async function uploadLibraryEcardImage() {
      const file = document.getElementById("libraryEcardCoverFile").files[0];
      if (!file || !currentLibraryCard) return;
      selectedLibraryImages[activeLibraryLayout] = await compressCardImage(file, 1600);
      renderLibraryPreview({ ...getEffectiveLayoutCard(currentLibraryCard || {}, activeLibraryLayout), ...getLibraryFormData(), imageUrl: selectedLibraryImages[activeLibraryLayout] });
      setStatus("正在上傳名片封面...");
      await saveLibraryCard();
    }

    async function shareLibraryCard() {
      const saved = await saveLibraryCard();
      if (!saved) return;
      const liveCard = getEffectiveLayoutCard(currentLibraryCard || {}, activeLibraryLayout);
      const shareUrl = liveCard.publicUrl || currentLibraryCard?.publicUrl || "";
      if (!shareUrl) {
        setStatus("這張名片尚未建立分享網址");
        return;
      }
      try {
        if (window.liff && liff.isApiAvailable && liff.isApiAvailable("shareTargetPicker")) {
          await liff.shareTargetPicker([buildCardFlexMessage(liveCard, shareUrl)]);
          setStatus("已開啟 LINE 分享");
          return;
        }
        setStatus("LINE 目前不支援開啟分享名單，請從 LINE LIFF 內開啟。");
      } catch (error) {}
      await navigator.clipboard.writeText(shareUrl);
      setStatus("名片網址已複製");
    }

    async function createLibraryCardFromImage(imageDataUrl) {
      if (!imageDataUrl) return;
      setStatus("AI 正在建立名片庫資料...");
      const response = await fetch("/api/cards/library/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionToken: currentSessionToken,
          storeCode: config.storeCode,
          imageDataUrl,
        }),
      });
      const result = await response.json();
      if (!result.ok) {
        setStatus(result.message || result.error || "名片建立失敗");
        return;
      }
      libraryCards.unshift(result.card);
      renderLibraryList();
      openLibraryDetail(result.card.cardId);
      selectedRecognizeImageDataUrl = "";
      selectedRecognizeFile = null;
      setStatus("名片建立完成，請確認資料。");
    }

    async function recognizeImageDataUrl(imageDataUrl) {
      const file = selectedRecognizeFile || document.getElementById("cardImageFile").files[0];
      imageDataUrl = imageDataUrl || selectedRecognizeImageDataUrl || selectedCardImages[activeCardLayout];
      if (!imageDataUrl && file) {
        imageDataUrl = await compressCardImage(file, 1600);
      }
      if (!imageDataUrl) {
        setStatus("請先拍照或上傳名片圖片。");
        return;
      }
      setStatus("AI 正在辨識名片...");
      const response = await fetch("/api/cards/recognize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idToken: currentIdToken,
          sessionToken: currentSessionToken,
          storeCode: config.storeCode,
          imageDataUrl,
        }),
      });
      const result = await response.json();
      if (!result.ok) {
        setStatus(result.message || result.error || "名片辨識失敗");
        return;
      }
      selectedCardImages[activeCardLayout] = imageDataUrl;
      currentCard = currentCard || {};
      currentCard.layouts = { ...(currentCard.layouts || {}) };
      selectedRecognizeImageDataUrl = imageDataUrl;
      currentCard.layouts[activeCardLayout] = {
        ...getEffectiveLayoutCard(currentCard, activeCardLayout),
        ...(result.card || {}),
        imageUrl: getEffectiveLayoutCard(currentCard, activeCardLayout).imageUrl,
      };
      fillCardForm(currentCard, activeCardLayout);
      showCardEditorTab("contact");
      setStatus("辨識完成，請確認資料後儲存。");
    }

    async function recognizeSelectedCard() {
      await recognizeImageDataUrl(selectedRecognizeImageDataUrl || selectedCardImages[activeCardLayout]);
    }

    async function saveBusinessCard(options = {}) {
      if (!currentSessionToken) return;
      saveCurrentLayoutDraft();
      const layout = activeCardLayout;
      const card = { ...(currentCard || {}), ...getCardFormData(), layout };
      if (!options.quiet) setStatus("正在儲存名片設定...");
      const response = await fetch("/api/cards/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idToken: currentIdToken,
          sessionToken: currentSessionToken,
          storeCode: config.storeCode,
          card,
          imageDataUrl: selectedCardImages[layout] || undefined,
          imageDataUrls: selectedCardImages,
        }),
      });
      const result = await response.json();
      if (!result.ok) {
        setStatus(result.message || result.error || "名片儲存失敗");
        return false;
      }
      currentCard = result.card;
      selectedCardImages = {};
      selectedRecognizeFile = null;
      selectedRecognizeImageDataUrl = "";
      document.getElementById("cardImageFile").value = "";
      document.getElementById("cardCameraFile").value = "";
      document.getElementById("cardAlbumFile").value = "";
      document.getElementById("ecardCoverFile").value = "";
      fillCardForm(currentCard, layout);
      if (!options.quiet) setStatus("名片設定已儲存。");
      return true;
    }

    async function uploadEcardImage() {
      const file = document.getElementById("ecardCoverFile").files[0];
      if (!file) return;
      selectedCardImages[activeCardLayout] = await compressCardImage(file, 1600);
      renderCardPreview({ ...getEffectiveLayoutCard(currentCard || {}, activeCardLayout), ...getCardFormData(), imageUrl: selectedCardImages[activeCardLayout] });
      setStatus("正在上傳封面圖片...");
      const saved = await saveBusinessCard({ quiet: true });
      if (saved) setStatus("封面圖片已上傳並儲存。");
    }
    function flexText(value, fallback, limit = 120) {
      const text = String(value || fallback || " ").replace(/\\s+/g, " ").trim();
      return (text || " ").slice(0, limit);
    }

    function appendShareMode(url) {
      if (!url) return "";
      try {
        const parsed = new URL(url);
        parsed.searchParams.set("share", "1");
        return parsed.toString();
      } catch (error) {
        return url + (url.includes("?") ? "&" : "?") + "share=1";
      }
    }

    function flexHttpsUri(value, fallback) {
      const uri = String(value || "").trim();
      if (/^https:\\/\\//i.test(uri) || /^tel:/i.test(uri)) return uri;
      if (/^[\\w.-]+\\.[a-z]{2,}(\\/.*)?$/i.test(uri)) return "https://" + uri;
      return fallback || "";
    }

    function buildCardFlexMessage(card, url) {
      card = card || {};
      const name = flexText(card.name, "我的名片", 80);
      const meta = [card.company, card.title].filter(Boolean).join(" / ");
      const intro = flexText(card.intro || meta || url, "點擊查看完整名片", 180);
      const shareLabel = cleanShareLabelInput(card.shareLabel);
      const shareColor = card.shareColor || "#ef4444";
      const shareActionUrl = appendShareMode(url);
      const actionButtons = Array.isArray(card.buttons) ? card.buttons : getCardButtons();
      const buttons = actionButtons
        .map((button) => ({ ...button, url: flexHttpsUri(button.url, url) }))
        .filter((button) => button.url)
        .slice(0, 4);
      const bubble = {
        type: "bubble",
        size: card.layout === "full" ? "giga" : "mega",
        header: {
          type: "box",
          layout: "horizontal",
          paddingAll: "12px",
          contents: [
            { type: "filler", flex: 1 },
            {
              type: "box",
              layout: "vertical",
              flex: 0,
              backgroundColor: shareColor,
              cornerRadius: "100px",
              paddingTop: "6px",
              paddingBottom: "6px",
              paddingStart: "14px",
              paddingEnd: "14px",
              contents: [{ type: "text", text: shareLabel, color: "#ffffff", weight: "bold", size: "sm", align: "center", flex: 0 }],
              action: { type: "uri", uri: shareActionUrl || url },
            },
          ],
        },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            { type: "text", text: name, weight: "bold", size: "xl", wrap: true, align: "center", color: "#1f2933" },
            { type: "text", text: flexText(meta, "SDK 名片王", 100), size: "sm", color: "#607080", wrap: true, align: "center" },
            { type: "separator", margin: "md" },
            { type: "text", text: intro, size: "sm", color: "#364756", wrap: true, margin: "md" },
          ],
          action: { type: "uri", uri: url },
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: buttons.map((button) => ({
            type: "button",
            style: "primary",
            height: "sm",
            color: button.color || "#06C755",
            action: { type: "uri", label: flexText(button.label, "開啟", 20), uri: button.url || url },
          })),
        },
      };
      if (card.videoEnabled && card.videoUrl && /^https:\\/\\//i.test(card.videoUrl) && card.imageUrl && /^https:\\/\\//i.test(card.imageUrl)) {
        bubble.hero = {
          type: "video",
          url: card.videoUrl,
          previewUrl: card.imageUrl,
          altContent: {
            type: "image",
            url: card.imageUrl,
            size: "full",
            aspectRatio: card.layout === "square" ? "1:1" : (card.layout === "full" ? "2:3" : "800:533"),
            aspectMode: "fit",
          },
          aspectRatio: card.layout === "square" ? "1:1" : (card.layout === "full" ? "2:3" : "800:533"),
          action: { type: "uri", uri: url },
        };
      } else if (card.imageUrl && /^https:\\/\\//i.test(card.imageUrl)) {
        bubble.hero = {
          type: "image",
          url: card.imageUrl,
          size: "full",
          aspectRatio: card.layout === "square" ? "1:1" : (card.layout === "full" ? "2:3" : "800:533"),
          aspectMode: "fit",
          action: { type: "uri", uri: url },
        };
      }
      return {
        type: "flex",
        altText: name + " 的名片",
        contents: bubble,
      };
    }

    async function shareBusinessCard() {
      saveCurrentLayoutDraft();
      await saveBusinessCard({ quiet: true });
      const liveCard = { ...getEffectiveLayoutCard(currentCard || {}, activeCardLayout), ...getCardFormData(), publicUrls: currentCard?.publicUrls || {} };
      if (selectedCardImages[activeCardLayout]) liveCard.imageUrl = selectedCardImages[activeCardLayout];
      const url = selectedPublicCardUrl(liveCard);
      if (!url) {
        setStatus("請先儲存名片");
        return;
      }
      try {
        if (window.liff && liff.isApiAvailable && liff.isApiAvailable("shareTargetPicker")) {
          await liff.shareTargetPicker([buildCardFlexMessage(liveCard, url)]);
          setStatus("已開啟 LINE 分享");
          return;
        }
        setStatus("LINE 目前不支援開啟分享名單，請從 LINE LIFF 內開啟。");
      } catch (error) {
        setStatus("LINE 分享失敗：" + (error.message || error));
      }
      try {
        await navigator.clipboard.writeText(url);
        setStatus("名片連結已複製");
      } catch (error) {
        location.href = "https://social-plugins.line.me/lineit/share?url=" + encodeURIComponent(url);
      }
    }

    function renderDownlines(downlines) {
      document.getElementById("downlineCount").textContent = String(downlines.length);
      const list = document.getElementById("downlines");
      list.innerHTML = "";
      if (!downlines.length) {
        const empty = document.createElement("div");
        empty.className = "downline-item";
        empty.textContent = "目前沒有直接下線";
        list.appendChild(empty);
        return;
      }
      for (const item of downlines) {
        const node = document.createElement("div");
        node.className = "downline-item";
        node.textContent = item.memberNo || item.tenantMemberId;
        const small = document.createElement("small");
        small.textContent = item.assignedAt ? "歸屬時間 " + item.assignedAt : "已歸屬";
        node.appendChild(small);
        list.appendChild(node);
      }
    }

    function createSafeCropper(imgElement, ratio) {
      const parent = imgElement.parentElement;
      if (parent) {
        parent.style.display = "flex";
        parent.style.alignItems = "center";
        parent.style.justifyContent = "center";
        parent.style.width = "100%";
        parent.style.height = "100%";
        parent.style.position = "relative";
      }
      imgElement.style.display = "block";
      imgElement.style.maxWidth = "100%";
      imgElement.style.maxHeight = "100%";
      const freeRatio = ratio === null || ratio === undefined || Number.isNaN(Number(ratio));
      return new Cropper(imgElement, {
        aspectRatio: freeRatio ? NaN : ratio,
        viewMode: 1,
        dragMode: "move",
        autoCropArea: 0.92,
        cropBoxMovable: true,
        cropBoxResizable: true,
        toggleDragModeOnDblclick: true,
        zoomable: true,
        zoomOnTouch: true,
        zoomOnWheel: true,
        wheelZoomRatio: 0.08,
        movable: true,
        scalable: true,
        responsive: true,
        restore: false,
        guides: true,
        center: true,
        highlight: false,
        background: false,
      });
    }

    function closeCardCropper() {
      const modal = document.getElementById("cardCropperModal");
      modal.classList.remove("visible");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("cropper-open");
      if (cardCropper) {
        cardCropper.destroy();
        cardCropper = null;
      }
      document.getElementById("cardCropperImage").src = "";
    }

    function zoomCardCropper(delta) {
      if (!cardCropper) return;
      try { cardCropper.zoom(Number(delta) || 0); } catch (error) {}
    }

    function resetCardCropper() {
      if (!cardCropper) return;
      try { cardCropper.reset(); } catch (error) {}
    }

    async function openCardCropperFromFile(file, input) {
      selectedRecognizeFile = file || null;
      selectedRecognizeImageDataUrl = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (event) => {
        lastCardUploadImage = event.target.result || "";
        if (!lastCardUploadImage) return;
        if (!window.Cropper) {
          selectedRecognizeImageDataUrl = await compressCardImage(file, 1600);
          if (scanTarget === "library") {
            await createLibraryCardFromImage(selectedRecognizeImageDataUrl);
          } else {
            selectedCardImages[activeCardLayout] = selectedRecognizeImageDataUrl;
            renderCardPreview({ ...getEffectiveLayoutCard(currentCard || {}, activeCardLayout), ...getCardFormData(), imageUrl: selectedRecognizeImageDataUrl });
            await recognizeImageDataUrl(selectedRecognizeImageDataUrl);
          }
          if (input) input.value = "";
          return;
        }
        const modal = document.getElementById("cardCropperModal");
        const img = document.getElementById("cardCropperImage");
        document.body.classList.add("cropper-open");
        modal.classList.add("visible");
        modal.setAttribute("aria-hidden", "false");
        img.onload = () => {
          if (cardCropper) cardCropper.destroy();
          setTimeout(() => {
            try {
              cardCropper = createSafeCropper(img, NaN);
              setStatus("請裁切名片範圍，確認後會自動 AI 辨識。");
            } catch (error) {
              cardCropper = null;
              setStatus("裁切器載入失敗，可按確認直接辨識原圖。");
            }
          }, 120);
        };
        img.src = lastCardUploadImage;
        if (input) input.value = "";
      };
      reader.readAsDataURL(file);
    }

    async function confirmCardCrop() {
      const button = document.getElementById("cropConfirmButton");
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "處理中...";
      let imageDataUrl = lastCardUploadImage;
      try {
        if (cardCropper) {
          let quality = 0.82;
          imageDataUrl = cardCropper.getCroppedCanvas({
            maxWidth: 1200,
            maxHeight: 1200,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: "high",
          }).toDataURL("image/jpeg", quality);
          while (imageDataUrl.length > 900000 && quality > 0.35) {
            quality -= 0.14;
            imageDataUrl = cardCropper.getCroppedCanvas({ maxWidth: 1200, maxHeight: 1200 }).toDataURL("image/jpeg", quality);
          }
        }
        if (!imageDataUrl) {
          setStatus("找不到可辨識的圖片，請重新選擇照片。");
          return;
        }
        selectedRecognizeImageDataUrl = imageDataUrl;
        closeCardCropper();
        if (scanTarget === "library") {
          await createLibraryCardFromImage(imageDataUrl);
        } else {
          selectedCardImages[activeCardLayout] = imageDataUrl;
          renderCardPreview({ ...getEffectiveLayoutCard(currentCard || {}, activeCardLayout), ...getCardFormData(), imageUrl: imageDataUrl });
          await recognizeImageDataUrl(imageDataUrl);
        }
      } finally {
        button.disabled = false;
        button.textContent = original || "確認裁切";
        if (!document.getElementById("cardCropperModal").classList.contains("visible")) {
          document.body.classList.remove("cropper-open");
        }
      }
    }

    function setRecognizeFile(file, input, target = "self") {
      if (!file) return;
      scanTarget = target;
      openCardCropperFromFile(file, input);
    }

    function showView(name) {
      const isSettings = name === "settings";
      const isCards = name === "cards";
      homeView.classList.toggle("active", !isSettings && !isCards);
      cardsView.classList.toggle("active", isCards);
      settingsView.classList.toggle("active", isSettings);
      navHome.classList.toggle("active", !isSettings && !isCards);
      navCards.classList.toggle("active", isCards);
      navSettings.classList.toggle("active", isSettings);
      if (!isSettings) closeCardSettings();
      if (isCards) loadLibraryCards();
    }

    function openCardSettings() {
      showView("settings");
      settingsList.style.display = "none";
      memberEl.classList.remove("visible");
      profileSdkEl.classList.remove("visible");
      cardSdkEl.classList.add("visible");
      loadMyCard();
      showCardEditorTab("contact");
      setTimeout(() => cardSdkEl.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }

    function closeCardSettings() {
      settingsList.style.display = "";
      cardSdkEl.classList.remove("visible");
      profileSdkEl.classList.remove("visible");
    }

    function openProfileSettings() {
      showView("settings");
      settingsList.style.display = "none";
      memberEl.classList.remove("visible");
      cardSdkEl.classList.remove("visible");
      profileSdkEl.classList.add("visible");
      setTimeout(() => profileSdkEl.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    }

    function fillProfileForm(profile) {
      profile = profile || {};
      document.getElementById("profileName").value = profile.name || "";
      document.getElementById("profileBirthday").value = profile.birthday || "";
      document.getElementById("profilePhone").value = profile.phone || "";
      document.getElementById("profileResidence").value = profile.residence || "";
      document.getElementById("profileIndustry").value = profile.industry || "";
    }

    function getProfileFormData() {
      return {
        name: document.getElementById("profileName").value.trim(),
        birthday: document.getElementById("profileBirthday").value.trim(),
        phone: document.getElementById("profilePhone").value.trim(),
        residence: document.getElementById("profileResidence").value.trim(),
        industry: document.getElementById("profileIndustry").value.trim(),
      };
    }

    async function saveMemberProfile() {
      if (!currentSessionToken) {
        setStatus("登入完成後才能儲存會員資料");
        return;
      }
      setStatus("正在儲存會員資料...");
      const response = await fetch("/api/member/profile/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionToken: currentSessionToken,
          storeCode: config.storeCode,
          profile: getProfileFormData(),
        }),
      });
      const result = await response.json();
      if (!result.ok) {
        setStatus(result.message || result.error || "會員資料儲存失敗");
        return;
      }
      currentMember = result.member;
      fillProfileForm(result.member.profile || {});
      document.getElementById("homeName").textContent = result.member.profile?.name || result.member.displayName || result.member.memberNo || "會員";
      renderProfileAvatar(result.member);
      setStatus("會員資料已儲存");
    }

    function showCardEditorTab(tab) {
      const target = ["contact", "content", "ecard"].includes(tab) ? tab : "ecard";
      document.querySelectorAll("[data-card-tab]").forEach((button) => {
        button.classList.toggle("active", button.dataset.cardTab === target);
      });
      document.getElementById("cardTabContact").classList.toggle("active", target === "contact");
      document.getElementById("cardTabContent").classList.toggle("active", target === "content");
      document.getElementById("cardTabEcard").classList.toggle("active", target === "ecard");
    }

    async function copyReferralLinkToClipboard() {
      const input = document.getElementById("referralLink");
      if (!input.value) {
        setStatus("登入完成後才會產生邀約連結");
        return;
      }
      input.select();
      try {
        await navigator.clipboard.writeText(input.value);
        setStatus("推薦連結已複製");
      } catch (error) {
        document.execCommand("copy");
        setStatus("推薦連結已複製");
      }
    }

    document.getElementById("copyReferralLink").addEventListener("click", copyReferralLinkToClipboard);
    document.getElementById("homeShareReferral").addEventListener("click", copyReferralLinkToClipboard);
    document.getElementById("openCardSettingsButton").addEventListener("click", openCardSettings);
    document.getElementById("openProfileSettingsButton").addEventListener("click", openProfileSettings);
    document.getElementById("homeOpenCardButton").addEventListener("click", () => showView("cards"));
    document.getElementById("navCards").addEventListener("click", () => showView("cards"));
    document.getElementById("backToSettingsButton").addEventListener("click", closeCardSettings);
    document.getElementById("backFromProfileButton").addEventListener("click", closeCardSettings);
    document.getElementById("saveProfileButton").addEventListener("click", saveMemberProfile);
    document.getElementById("navHome").addEventListener("click", () => showView("home"));
    document.getElementById("navSettings").addEventListener("click", () => showView("settings"));
    document.getElementById("refreshLoginButton").addEventListener("click", restartLineLogin);
    document.querySelectorAll("[data-card-tab]").forEach((button) => {
      button.addEventListener("click", () => showCardEditorTab(button.dataset.cardTab));
    });

    loginButton.addEventListener("click", async () => {
      if (!config.liffId) return;
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return;
      }
      await submitIdToken();
    });

    document.getElementById("recognizeCardButton").addEventListener("click", recognizeSelectedCard);
    document.getElementById("saveCardButton").addEventListener("click", () => saveBusinessCard());
    document.getElementById("saveEcardConfigButton").addEventListener("click", () => saveBusinessCard());
    document.getElementById("shareCardButton").addEventListener("click", shareBusinessCard);
    document.getElementById("libraryCaptureButton").addEventListener("click", () => document.getElementById("libraryCameraFile").click());
    document.getElementById("libraryUploadButton").addEventListener("click", () => document.getElementById("libraryAlbumFile").click());
    document.getElementById("libraryCameraFile").addEventListener("change", (event) => setRecognizeFile(event.target.files[0], event.target, "library"));
    document.getElementById("libraryAlbumFile").addEventListener("change", (event) => setRecognizeFile(event.target.files[0], event.target, "library"));
    document.getElementById("librarySearchInput").addEventListener("input", renderLibraryList);
    document.getElementById("backToLibraryListButton").addEventListener("click", closeLibraryDetail);
    document.getElementById("saveLibraryCardButton").addEventListener("click", saveLibraryCard);
    document.getElementById("shareLibraryCardButton").addEventListener("click", shareLibraryCard);
    document.querySelectorAll("[data-library-tab]").forEach((button) => {
      button.addEventListener("click", () => showLibraryTab(button.dataset.libraryTab));
    });
    document.querySelectorAll('input[name="library-ecard-layout"]').forEach((input) => {
      input.addEventListener("change", (event) => {
        saveCurrentLibraryLayoutDraft();
        activeLibraryLayout = normalizeLayoutName(event.target.value);
        fillLibraryForm(currentLibraryCard || {}, activeLibraryLayout);
      });
    });
    ["libraryEcardImageUrl", "libraryEcardVideoUrl"].forEach((id) => {
      document.getElementById(id).addEventListener("input", () => {
        renderLibraryPreview({ ...getEffectiveLayoutCard(currentLibraryCard || {}, activeLibraryLayout), ...getLibraryFormData() });
      });
    });
    document.getElementById("libraryEcardVideoEnabled").addEventListener("change", () => saveCurrentLibraryLayoutDraft());
    document.getElementById("uploadLibraryEcardImageButton").addEventListener("click", () => document.getElementById("libraryEcardCoverFile").click());
    document.getElementById("libraryEcardCoverFile").addEventListener("change", uploadLibraryEcardImage);
    document.getElementById("addLibraryButton").addEventListener("click", () => {
      libraryButtons.push({ label: "新增按鈕", url: "https://", color: "#06c755" });
      renderLibraryButtonEditor();
    });
    document.getElementById("captureCardButton").addEventListener("click", () => document.getElementById("cardCameraFile").click());
    document.getElementById("uploadCardPhotoButton").addEventListener("click", () => document.getElementById("cardAlbumFile").click());
    document.getElementById("cardCameraFile").addEventListener("change", (event) => setRecognizeFile(event.target.files[0], event.target, "self"));
    document.getElementById("cardAlbumFile").addEventListener("change", (event) => setRecognizeFile(event.target.files[0], event.target, "self"));
    document.getElementById("cropCancelButton").addEventListener("click", closeCardCropper);
    document.getElementById("cropConfirmButton").addEventListener("click", confirmCardCrop);
    document.getElementById("cropZoomOutButton").addEventListener("click", () => zoomCardCropper(-0.12));
    document.getElementById("cropZoomInButton").addEventListener("click", () => zoomCardCropper(0.12));
    document.getElementById("cropResetButton").addEventListener("click", resetCardCropper);
    document.getElementById("uploadEcardImageButton").addEventListener("click", () => document.getElementById("ecardCoverFile").click());
    document.getElementById("ecardCoverFile").addEventListener("change", uploadEcardImage);
    document.getElementById("cardImageFile").addEventListener("change", (event) => setRecognizeFile(event.target.files[0], event.target, "self"));
    document.querySelectorAll('input[name="ecard-layout"]').forEach((input) => {
      input.addEventListener("change", (event) => {
        saveCurrentLayoutDraft();
        activeCardLayout = normalizeLayoutName(event.target.value);
        fillCardForm(currentCard || {}, activeCardLayout);
      });
    });
    ["ecardImageUrl", "ecardVideoUrl"].forEach((id) => {
      document.getElementById(id).addEventListener("input", () => {
        renderCardPreview({ ...getEffectiveLayoutCard(currentCard || {}, activeCardLayout), ...getCardFormData() });
      });
    });
    document.getElementById("ecardVideoEnabled").addEventListener("change", () => saveCurrentLayoutDraft());
    document.getElementById("addCardButton").addEventListener("click", () => {
      cardButtons.push({ label: "新增按鈕", url: "https://", color: "#06c755" });
      renderCardButtonEditor();
    });
    boot();
  </script>
</body>
</html>`;
}

async function handleLineLogin({ env, storage, payload }) {
  assertString(payload.idToken, "idToken");
  const lineProfile = await verifyLineIdToken(env, payload.idToken);
  const clientLineProfile = normalizeClientLineProfile(payload.lineProfile, lineProfile.sub);
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
    displayName: lineProfile.name || lineProfile.displayName || clientLineProfile.displayName || existingMember?.displayName || null,
    pictureUrl: lineProfile.picture || clientLineProfile.pictureUrl || existingMember?.pictureUrl || null,
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
    displayName: user.displayName,
    pictureUrl: user.pictureUrl,
    profile: normalizeMemberProfile(existingMember?.profile || {}),
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
  const downlines = await getReferralDownlines(storage, tenant.tenantId, tenantMemberId);

  return {
    ok: true,
    tenant: publicTenant(tenant),
    member: publicMember(member),
    attribution,
    downlines,
    sessionToken: await createSessionToken(env, {
      tenantId: tenant.tenantId,
      tenantMemberId,
      userId,
    }),
    sessionExpiresAt: new Date(Date.now() + sessionMaxAgeMs()).toISOString(),
  };
}

async function handleSessionCheck({ env, storage, payload }) {
  const session = await getSessionContext({ env, storage, payload });
  return {
    ok: true,
    tenant: publicTenant(session.tenant),
    member: publicMember(session.member),
    attribution: { result: "session", status: "active" },
    downlines: [],
  };
}

async function getSessionContext({ env, storage, payload }) {
  if (payload.sessionToken) {
    const session = await verifySessionToken(env, payload.sessionToken);
    const tenant = (await storage.getJson(`tenants/${session.tenantId}.json`)).value;
    if (!tenant || tenant.status !== "active") {
      throw httpError(404, "Tenant not found or inactive", "tenant_not_found");
    }
    const member = (await storage.getJson(`tenant-members/${session.tenantId}/${session.tenantMemberId}.json`)).value;
    if (!member || member.status !== "active" || member.userId !== session.userId) {
      throw httpError(401, "Session member is not active", "session_member_invalid");
    }
    return {
      lineProfile: { sub: session.userId, name: "" },
      tenant,
      userId: session.userId,
      tenantMemberId: session.tenantMemberId,
      member,
    };
  }

  assertString(payload.idToken, "idToken");
  const lineProfile = await verifyLineIdToken(env, payload.idToken);
  const tenant = await resolveTenant(storage, payload);
  const userId = await createUserId(lineProfile.sub, env.MEMBER_NO_SECRET);
  const tenantMemberId = await createTenantMemberId(tenant.tenantId, userId, env.MEMBER_NO_SECRET);
  const member = (await storage.getJson(`tenant-members/${tenant.tenantId}/${tenantMemberId}.json`)).value;
  if (!member || member.status !== "active") {
    throw httpError(401, "Login is required before card operations", "login_required");
  }
  return { lineProfile, tenant, userId, tenantMemberId, member };
}

async function upsertMemberProfile({ env, storage, payload }) {
  const session = await getSessionContext({ env, storage, payload });
  const now = new Date().toISOString();
  const profile = normalizeMemberProfile(payload.profile || {});
  const memberKey = `tenant-members/${session.tenant.tenantId}/${session.tenantMemberId}.json`;
  const member = {
    ...session.member,
    profile,
    updatedAt: now,
  };
  await storage.putJson(memberKey, member);

  const user = (await storage.getJson(`users/${session.userId}.json`)).value || {};
  await storage.putJson(`users/${session.userId}.json`, {
    ...user,
    displayName: profile.name || user.displayName || null,
    phone: profile.phone || user.phone || null,
    profile,
    updatedAt: now,
  });

  return { ok: true, member: publicMember(member) };
}

async function getMyBusinessCard({ env, storage, payload, origin }) {
  const session = await getSessionContext({ env, storage, payload });
  const card = await readBusinessCard(storage, session.tenant.tenantId, session.tenantMemberId, origin);
  return { ok: true, card };
}

async function recognizeBusinessCard({ env, storage, payload, origin }) {
  await getSessionContext({ env, storage, payload });
  assertString(payload.imageDataUrl, "imageDataUrl");
  assertSecret(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  validateImageDataUrl(payload.imageDataUrl);

  const extracted = await callOpenAICardOcr(env, payload.imageDataUrl);
  const card = normalizeBusinessCard(extracted, origin);
  return { ok: true, card };
}

async function listLibraryCards({ env, storage, payload, origin }) {
  const session = await getSessionContext({ env, storage, payload });
  const prefix = libraryCardPrefix(session.tenant.tenantId, session.tenantMemberId);
  const listed = await storage.list(prefix, 500);
  const cards = [];
  for (const item of listed.list || []) {
    if (!item.key.endsWith(".json")) continue;
    const relativeKey = storage.relativeKey(item.key);
    const card = (await storage.getJson(relativeKey)).value;
    if (card && card.status !== "deleted") cards.push(publicLibraryCard(card, origin));
  }
  cards.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  return { ok: true, cards };
}

async function createLibraryCardFromScan({ env, storage, payload, origin }) {
  const session = await getSessionContext({ env, storage, payload });
  assertString(payload.imageDataUrl, "imageDataUrl");
  assertSecret(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  validateImageDataUrl(payload.imageDataUrl);
  const extracted = await callOpenAICardOcr(env, payload.imageDataUrl);
  const card = normalizeBusinessCard(extracted, origin);
  card.sourceType = "scanned_contact";
  card.status = "active";
  return saveLibraryCardRecord({ storage, session, input: card, imageDataUrl: payload.imageDataUrl, origin });
}

async function upsertLibraryCard({ env, storage, payload, origin }) {
  const session = await getSessionContext({ env, storage, payload });
  const cardId = cleanId(payload.cardId || payload.card?.cardId || "");
  if (!cardId) throw httpError(400, "cardId is required", "card_id_required");
  const existing = (await storage.getJson(libraryCardKey(session.tenant.tenantId, session.tenantMemberId, cardId))).value;
  if (!existing || existing.status === "deleted") throw httpError(404, "Library card not found", "library_card_not_found");
  const input = { ...existing, ...normalizeBusinessCard(payload.card || {}, origin), cardId };
  if (payload.imageDataUrl) validateImageDataUrl(payload.imageDataUrl);
  return saveLibraryCardRecord({ storage, session, input, imageDataUrl: payload.imageDataUrl || "", imageDataUrls: payload.imageDataUrls || {}, origin, existing });
}

async function saveLibraryCardRecord({ storage, session, input, imageDataUrl = "", imageDataUrls = {}, origin, existing = null }) {
  const now = new Date().toISOString();
  const cardId = cleanId(input.cardId || existing?.cardId || `card-${safeTime(now)}-${randomId()}`);
  const previous = existing || (await storage.getJson(libraryCardKey(session.tenant.tenantId, session.tenantMemberId, cardId))).value || {};
  const normalized = normalizeBusinessCard({ ...previous, ...input }, origin);
  const slug = previous.publicSlug || normalized.publicSlug || createCardSlug(`lib-${cardId}`);
  const publicUrls = createCardUrls(origin, slug);
  const activeLayout = normalizeCardLayout(normalized.layout || input.layout || previous.layout || DEFAULT_CARD_LAYOUT);
  let layouts = normalizeCardLayouts(previous.layouts, previous, origin);
  const incomingLayouts = normalizeCardLayouts(normalized.layouts, normalized, origin);
  for (const layout of CARD_LAYOUTS) {
    if (incomingLayouts[layout]) layouts[layout] = { ...(layouts[layout] || {}), ...incomingLayouts[layout], layout };
  }
  layouts[activeLayout] = {
    ...layoutBaseFromCard(previous),
    ...(layouts[activeLayout] || {}),
    ...layoutBaseFromCard(normalized),
    layout: activeLayout,
  };

  const uploadMap = imageDataUrls && typeof imageDataUrls === "object" ? imageDataUrls : {};
  const uploadedLayouts = new Set();
  for (const layout of CARD_LAYOUTS) {
    if (!uploadMap[layout]) continue;
    validateImageDataUrl(uploadMap[layout]);
    const uploaded = await uploadCardAsset({
      storage,
      tenantId: session.tenant.tenantId,
      tenantMemberId: `${session.tenantMemberId}/library/${cardId}/${layout}`,
      imageDataUrl: uploadMap[layout],
      origin,
    });
    layouts[layout] = { ...(layouts[layout] || layoutBaseFromCard(normalized)), layout, imageUrl: uploaded.url, imageKey: uploaded.key };
    uploadedLayouts.add(layout);
  }

  if (imageDataUrl && !uploadedLayouts.has(activeLayout)) {
    validateImageDataUrl(imageDataUrl);
    const uploaded = await uploadCardAsset({
      storage,
      tenantId: session.tenant.tenantId,
      tenantMemberId: `${session.tenantMemberId}/library/${cardId}/${activeLayout}`,
      imageDataUrl,
      origin,
    });
    layouts[activeLayout].imageUrl = uploaded.url;
    layouts[activeLayout].imageKey = uploaded.key;
    uploadedLayouts.add(activeLayout);
  }

  if (normalized.imageUrl && !uploadedLayouts.has(activeLayout)) {
    layouts[activeLayout].imageUrl = normalized.imageUrl;
  }

  const sharedImageUrl = layouts[activeLayout]?.imageUrl || normalized.imageUrl || previous.imageUrl || "";
  const sharedImageKey = layouts[activeLayout]?.imageKey || normalized.imageKey || previous.imageKey || "";
  for (const layout of CARD_LAYOUTS) {
    if (!layouts[layout]) layouts[layout] = { ...layoutBaseFromCard(normalized), layout };
    if (!layouts[layout].imageUrl && sharedImageUrl) layouts[layout].imageUrl = sharedImageUrl;
    if (!layouts[layout].imageKey && sharedImageKey) layouts[layout].imageKey = sharedImageKey;
    layouts[layout] = normalizeCardLayoutRecord(layouts[layout], origin, layout);
  }
  const standard = layouts.standard || layouts[activeLayout] || layoutBaseFromCard(normalized);
  const card = {
    ...normalized,
    tenantId: session.tenant.tenantId,
    ownerTenantMemberId: session.tenantMemberId,
    ownerUserId: session.userId,
    cardId,
    cardKind: "library",
    sourceType: cleanText(input.sourceType || previous.sourceType || "scanned_contact", 60),
    status: input.status || previous.status || "active",
    publicSlug: slug,
    publicUrl: publicUrls[DEFAULT_CARD_LAYOUT],
    publicUrls,
    imageUrl: standard.imageUrl || normalized.imageUrl || previous.imageUrl || "",
    imageKey: standard.imageKey || normalized.imageKey || previous.imageKey || "",
    layout: activeLayout,
    buttons: normalizeCardButtons(standard.buttons || normalized.buttons, standard),
    layouts,
    createdAt: previous.createdAt || now,
    updatedAt: now,
  };
  await storage.putJson(libraryCardKey(session.tenant.tenantId, session.tenantMemberId, cardId), card);
  await storage.putJson(`card-index/public-slugs/${slug}.json`, {
    tenantId: session.tenant.tenantId,
    tenantMemberId: session.tenantMemberId,
    cardId,
    cardKind: "library",
    publicSlug: slug,
    status: "published",
    updatedAt: now,
  });
  return { ok: true, card: publicLibraryCard(card, origin) };
}

async function upsertBusinessCard({ env, storage, payload, origin }) {
  const session = await getSessionContext({ env, storage, payload });
  const now = new Date().toISOString();
  const existing = (await storage.getJson(`business-cards/${session.tenant.tenantId}/${session.tenantMemberId}.json`)).value || {};
  const input = normalizeBusinessCard(payload.card || {}, origin);
  const slug = existing.publicSlug || createCardSlug(session.member.memberNo);
  const publicUrls = createCardUrls(origin, slug);
  const activeLayout = normalizeCardLayout(input.layout || payload.card?.layout || DEFAULT_CARD_LAYOUT);
  const layouts = normalizeCardLayouts(existing.layouts, existing, origin);
  const incomingLayouts = normalizeCardLayouts(input.layouts, input, origin);
  for (const layout of CARD_LAYOUTS) {
    if (incomingLayouts[layout]) layouts[layout] = { ...(layouts[layout] || {}), ...incomingLayouts[layout], layout };
  }
  layouts[activeLayout] = {
    ...layoutBaseFromCard(existing),
    ...(layouts[activeLayout] || {}),
    ...layoutBaseFromCard(input),
    layout: activeLayout,
  };

  const imageDataUrls = payload.imageDataUrls && typeof payload.imageDataUrls === "object" ? payload.imageDataUrls : {};
  const uploadedLayouts = new Set();
  for (const layout of CARD_LAYOUTS) {
    if (!imageDataUrls[layout]) continue;
    validateImageDataUrl(imageDataUrls[layout]);
    const uploaded = await uploadCardAsset({
      storage,
      tenantId: session.tenant.tenantId,
      tenantMemberId: session.tenantMemberId,
      imageDataUrl: imageDataUrls[layout],
      origin,
    });
    layouts[layout] = { ...(layouts[layout] || layoutBaseFromCard(input)), layout, imageUrl: uploaded.url, imageKey: uploaded.key };
    uploadedLayouts.add(layout);
  }

  if (payload.imageDataUrl && !uploadedLayouts.has(activeLayout)) {
    validateImageDataUrl(payload.imageDataUrl);
    const uploaded = await uploadCardAsset({
      storage,
      tenantId: session.tenant.tenantId,
      tenantMemberId: session.tenantMemberId,
      imageDataUrl: payload.imageDataUrl,
      origin,
    });
    layouts[activeLayout].imageUrl = uploaded.url;
    layouts[activeLayout].imageKey = uploaded.key;
    uploadedLayouts.add(activeLayout);
  }

  if (input.imageUrl && !uploadedLayouts.has(activeLayout)) {
    layouts[activeLayout].imageUrl = input.imageUrl;
  }

  for (const layout of CARD_LAYOUTS) {
    if (!layouts[layout]) layouts[layout] = { ...layoutBaseFromCard(input), layout };
    layouts[layout] = normalizeCardLayoutRecord(layouts[layout], origin, layout);
  }
  const standard = layouts.standard || layouts[activeLayout] || layoutBaseFromCard(input);

  const card = {
    tenantId: session.tenant.tenantId,
    tenantMemberId: session.tenantMemberId,
    memberNo: session.member.memberNo,
    publicSlug: slug,
    publicUrl: publicUrls[DEFAULT_CARD_LAYOUT],
    publicUrls,
    name: standard.name || input.name || session.lineProfile.name || "",
    title: standard.title || input.title || "",
    company: standard.company || input.company || session.tenant.name || "",
    phone: standard.phone || input.phone || "",
    email: standard.email || input.email || "",
    website: normalizeUrl(standard.website || input.website),
    address: standard.address || input.address || "",
    intro: standard.intro || input.intro || "",
    shareLabel: normalizeShareLabel(standard.shareLabel || input.shareLabel),
    shareColor: standard.shareColor || input.shareColor || "#ef4444",
    layout: activeLayout,
    buttons: normalizeCardButtons(standard.buttons || input.buttons, standard),
    imageUrl: standard.imageUrl || "",
    imageKey: standard.imageKey || "",
    videoEnabled: Boolean(standard.videoEnabled || input.videoEnabled),
    videoUrl: standard.videoUrl || input.videoUrl || "",
    layouts,
    status: "published",
    updatedAt: now,
    createdAt: existing.createdAt || now,
  };

  await storage.putJson(`business-cards/${session.tenant.tenantId}/${session.tenantMemberId}.json`, card);
  await storage.putJson(`card-index/public-slugs/${slug}.json`, {
    tenantId: session.tenant.tenantId,
    tenantMemberId: session.tenantMemberId,
    publicSlug: slug,
    status: "published",
    updatedAt: now,
  });

  return { ok: true, card };
}

async function readBusinessCard(storage, tenantId, tenantMemberId, origin) {
  const card = (await storage.getJson(`business-cards/${tenantId}/${tenantMemberId}.json`)).value;
  if (!card) return null;
  const publicUrls = { ...createCardUrls(origin, card.publicSlug), ...(card.publicUrls || {}) };
  publicUrls.standard = publicUrls.standard || publicUrls.poster;
  publicUrls.full = publicUrls.full || publicUrls.free || publicUrls.classic;
  publicUrls.free = publicUrls.full;
  publicUrls.classic = publicUrls.full;
  publicUrls.square = publicUrls.square || publicUrls.links;
  const layouts = normalizeCardLayouts(card.layouts, card, origin);
  return {
    ...card,
    publicUrl: card.publicUrl || publicUrls[DEFAULT_CARD_LAYOUT],
    publicUrls,
    shareLabel: normalizeShareLabel(card.shareLabel),
    shareColor: card.shareColor || "#ef4444",
    layout: normalizeCardLayout(card.layout),
    buttons: normalizeCardButtons(card.buttons, card),
    layouts,
  };
}

async function renderPublicCardHtml(storage, slug, origin, layout = DEFAULT_CARD_LAYOUT, liffId = "") {
  const index = (await storage.getJson(`card-index/public-slugs/${slug}.json`)).value;
  if (!index || index.status !== "published") {
    return renderPublicCardShell(null, origin);
  }
  const card = index.cardKind === "library" && index.cardId
    ? await readLibraryCard(storage, index.tenantId, index.tenantMemberId, index.cardId, origin)
    : await readBusinessCard(storage, index.tenantId, index.tenantMemberId, origin);
  return renderPublicCardShell(card, origin, normalizeCardLayout(layout), liffId);
}

async function readLibraryCard(storage, tenantId, ownerTenantMemberId, cardId, origin) {
  const card = (await storage.getJson(libraryCardKey(tenantId, ownerTenantMemberId, cardId))).value;
  if (!card || card.status === "deleted") return null;
  return publicLibraryCard(card, origin);
}

function renderPublicCardShell(card, origin, layout = DEFAULT_CARD_LAYOUT, liffId = "") {
  if (!card) {
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Card not found</title></head><body style="font-family:system-ui;padding:32px;">Card not found</body></html>`;
  }
  layout = normalizeCardLayout(layout);
  card = getLayoutCard(card, layout);
  const title = card.name || "Business Card";
  const meta = [card.company, card.title].filter(Boolean).join(" / ");
  const phoneHref = card.phone ? `tel:${card.phone.replace(/[^0-9+]/g, "")}` : "";
  const emailHref = card.email ? `mailto:${card.email}` : "";
  const websiteHref = normalizeUrl(card.website);
  const mapHref = card.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(card.address)}` : "";
  const websiteText = websiteHref ? websiteHref.replace(/^https?:\/\//i, "") : "";
  const shareLabel = normalizeShareLabel(card.shareLabel);
  const shareColor = safeCssColor(card.shareColor, "#ef4444");
  const buttons = normalizeCardButtons(card.buttons, card);
  const actionHtml = buttons.map((button) => `<a href="${escapeHtml(normalizeActionUrl(button.url))}" style="background:${escapeHtml(safeCssColor(button.color, "#06c755"))}">${escapeHtml(button.label)}</a>`).join("");
  const hasVideo = Boolean(card.videoEnabled && /^https:\/\//i.test(card.videoUrl || ""));
  const image = hasVideo
    ? `<video src="${escapeHtml(card.videoUrl)}" ${card.imageUrl ? `poster="${escapeHtml(card.imageUrl)}"` : ""} controls playsinline muted></video>`
    : card.imageUrl ? `<img src="${escapeHtml(card.imageUrl)}" alt="">` : `<div class="visual-empty">${escapeHtml(String(title).slice(0, 1).toUpperCase())}</div>`;
  const bodyClass = `layout-${layout}`;
  const currentUrl = card.publicUrls?.[layout] || card.publicUrl || "";
  const sharePayload = {
    liffId,
    url: currentUrl,
    card: {
      name: title,
      meta,
      intro: card.intro || "",
      imageUrl: card.imageUrl || "",
      videoEnabled: Boolean(card.videoEnabled),
      videoUrl: card.videoUrl || "",
      shareLabel,
      shareColor,
      buttons,
    },
  };
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(meta || card.intro || "")}">
  ${card.imageUrl ? `<meta property="og:image" content="${escapeHtml(card.imageUrl)}">` : ""}
  ${liffId ? `<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>` : ""}
  <style>
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#1f2933; background:#eef3f5; }
    main { width:min(760px, calc(100% - 28px)); margin:0 auto; padding:24px 0; }
    .share-status { position:fixed; left:50%; bottom:22px; z-index:20; transform:translateX(-50%); display:none; align-items:center; gap:10px; max-width:min(420px, calc(100% - 28px)); padding:10px 16px; border-radius:999px; color:#fff; background:rgba(15,23,42,.94); font-weight:900; box-shadow:0 18px 38px rgba(15,23,42,.25); }
    .share-status.visible { display:flex; }
    .share-status::before { content:""; width:16px; height:16px; border:2px solid rgba(255,255,255,.45); border-top-color:#fff; border-radius:999px; animation:spin .7s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .card-shell { position:relative; background:white; border:1px solid #d8e0e8; border-radius:20px; overflow:hidden; box-shadow:0 18px 44px rgba(25,42,61,.12); }
    .share-head { min-height:52px; display:flex; justify-content:flex-end; align-items:center; padding:10px 12px; }
    .share-badge { appearance:none; border:0; display:inline-flex; flex:0 0 auto; width:auto; max-width:max-content; align-items:center; justify-content:center; min-height:32px; border-radius:999px; padding:6px 16px; color:white; font:inherit; font-weight:900; line-height:1.2; white-space:nowrap; text-decoration:none; background:${escapeHtml(shareColor)}; cursor:pointer; }
    .hero { background:#f8fbff; display:flex; align-items:center; justify-content:center; overflow:hidden; }
    .hero img, .hero video { width:100%; height:auto; display:block; }
    .visual-empty { width:120px; height:120px; border-radius:8px; background:#06c755; color:white; display:flex; align-items:center; justify-content:center; font-size:44px; font-weight:900; }
    h1 { margin:0; letter-spacing:0; line-height:1.08; }
    .meta { color:#364756; line-height:1.45; }
    .intro { white-space:pre-line; line-height:1.65; color:#1f2a44; }
    .contacts { display:grid; gap:7px; color:#364756; font-size:15px; }
    .contacts a { color:#1f2933; text-decoration:none; word-break:break-word; }
    .actions { display:grid; gap:10px; }
    .actions a { display:block; text-decoration:none; text-align:center; padding:13px 16px; border-radius:8px; font-weight:900; color:white; }
    .layout-standard main { width:min(430px, calc(100% - 24px)); }
    .layout-standard .hero { aspect-ratio:800/533; background:#fff; }
    .layout-standard .hero img, .layout-standard .hero video { height:100%; object-fit:contain; background:#fff; }
    .layout-standard .body { padding:24px 26px 12px; text-align:center; }
    .layout-standard h1 { font-size:30px; margin-bottom:12px; }
    .layout-standard .intro { margin:14px 0 0; text-align:left; }
    .layout-standard .actions { padding:22px 26px 26px; }
    .layout-full main { width:min(860px, calc(100% - 28px)); }
    .layout-full .physical { display:grid; grid-template-columns:minmax(0,1fr) 38%; min-height:340px; }
    .layout-full .share-head { position:absolute; top:0; right:0; z-index:2; }
    .layout-full .info { padding:64px 34px 30px; display:flex; flex-direction:column; justify-content:space-between; border-left:8px solid #06c755; }
    .layout-full .brand { color:#607080; font-weight:800; }
    .layout-full h1 { font-size:40px; margin:8px 0; }
    .layout-full .meta { font-size:18px; }
    .layout-full .intro { margin-top:18px; color:#607080; }
    .layout-full .hero { min-height:340px; padding:18px; }
    .layout-full .hero img, .layout-full .hero video { max-height:520px; object-fit:contain; border-radius:6px; box-shadow:0 10px 28px rgba(25,42,61,.10); }
    .layout-full .actions { grid-template-columns:repeat(2,minmax(0,1fr)); margin-top:16px; }
    .layout-square main { width:min(520px, calc(100% - 24px)); }
    .layout-square .card-shell { padding-bottom:22px; }
    .layout-square .square-frame { width:100%; aspect-ratio:1/1; display:grid; grid-template-rows:auto minmax(0,1fr) auto; }
    .layout-square .hero { min-height:0; }
    .layout-square .hero img, .layout-square .hero video { height:100%; object-fit:contain; background:#fff; }
    .layout-square .profile { padding:18px 26px; text-align:center; }
    .layout-square h1 { font-size:28px; margin-bottom:8px; }
    .layout-square .intro { margin-top:10px; color:#607080; }
    .layout-square .actions { padding:0 26px; }
    @media (max-width: 680px) {
      .layout-full .physical { grid-template-columns:1fr; }
      .layout-full .hero { order:-1; min-height:220px; }
      .layout-full .info { padding:64px 24px 24px; }
      h1 { font-size:32px; }
      .layout-full .actions { grid-template-columns:1fr; }
    }
  </style>
</head>
<body class="${escapeHtml(bodyClass)}">
  <main>
    ${layout === "full" ? `
      <section class="card-shell physical">
        <div class="share-head"><button class="share-badge" id="publicShareButton" type="button">${escapeHtml(shareLabel)}</button></div>
        <div class="info">
          <div>
            <div class="brand">${escapeHtml(card.company || "SDKSYS")}</div>
            <h1>${escapeHtml(title)}</h1>
            <div class="meta">${escapeHtml(card.title || "")}</div>
            <div class="intro">${escapeHtml(card.intro || "")}</div>
          </div>
          <div>
            <div class="contacts">
              ${card.phone ? `<a href="${escapeHtml(phoneHref)}">${escapeHtml(card.phone)}</a>` : ""}
              ${card.email ? `<a href="${escapeHtml(emailHref)}">${escapeHtml(card.email)}</a>` : ""}
              ${websiteHref ? `<a href="${escapeHtml(websiteHref)}">${escapeHtml(websiteText)}</a>` : ""}
              ${card.address ? `<a href="${escapeHtml(mapHref)}">${escapeHtml(card.address)}</a>` : ""}
            </div>
            ${actionHtml ? `<div class="actions">${actionHtml}</div>` : ""}
          </div>
        </div>
        <div class="hero">${image}</div>
      </section>
    ` : layout === "square" ? `
      <section class="card-shell">
        <div class="square-frame">
          <div class="share-head"><button class="share-badge" id="publicShareButton" type="button">${escapeHtml(shareLabel)}</button></div>
          <div class="hero">${image}</div>
          <div class="profile">
            <h1>${escapeHtml(title)}</h1>
            <div class="meta">${escapeHtml(meta)}</div>
            <div class="intro">${escapeHtml(card.intro || "")}</div>
          </div>
        </div>
        ${actionHtml ? `<div class="actions">${actionHtml}</div>` : ""}
      </section>
    ` : `
      <section class="card-shell">
        <div class="share-head"><button class="share-badge" id="publicShareButton" type="button">${escapeHtml(shareLabel)}</button></div>
        <div class="hero">${image}</div>
        <div class="body">
          <h1>${escapeHtml(title)}</h1>
          <div class="meta">${escapeHtml(meta)}</div>
          <div class="intro">${escapeHtml(card.intro || "")}</div>
        </div>
        ${actionHtml ? `<div class="actions">${actionHtml}</div>` : ""}
      </section>
    `}
  </main>
  <div class="share-status" id="shareStatus">正在開啟 LINE 分享...</div>
  <script>
    const shareConfig = ${JSON.stringify(sharePayload)};
    const shareStatus = document.getElementById("shareStatus");

    function setPublicShareStatus(text) {
      if (!shareStatus) return;
      shareStatus.textContent = text || "正在開啟 LINE 分享...";
      shareStatus.classList.add("visible");
    }

    function closeLiffWindowSoon() {
      setTimeout(() => {
        try {
          if (window.liff && liff.closeWindow) liff.closeWindow();
        } catch (error) {}
      }, 450);
    }

    function publicFlexText(value, fallback, limit = 120) {
      const text = String(value || fallback || " ").replace(/\\s+/g, " ").trim();
      return (text || " ").slice(0, limit);
    }

    function appendPublicShareMode(url) {
      if (!url) return "";
      try {
        const parsed = new URL(url);
        parsed.searchParams.set("share", "1");
        return parsed.toString();
      } catch (error) {
        return url + (url.includes("?") ? "&" : "?") + "share=1";
      }
    }

    function openPublicShareInLiff() {
      if (!shareConfig.liffId) return false;
      try {
        const target = new URL(appendPublicShareMode(shareConfig.url || location.href), location.origin);
        target.searchParams.set("viaLiff", "1");
        location.href = "https://liff.line.me/" + encodeURIComponent(shareConfig.liffId) + target.pathname + target.search + target.hash;
        return true;
      } catch (error) {
        return false;
      }
    }

    function getPublicShareParam(name) {
      const params = new URLSearchParams(location.search);
      const direct = params.get(name);
      if (direct !== null) return direct;
      const state = params.get("liff.state");
      if (!state) return null;
      try {
        const stateUrl = new URL(state.startsWith("/") ? state : "/" + state, location.origin);
        return stateUrl.searchParams.get(name);
      } catch (error) {
        return null;
      }
    }

    function publicFlexHttpsUri(value, fallback) {
      const uri = String(value || "").trim();
      if (/^https:\\/\\//i.test(uri) || /^tel:/i.test(uri)) return uri;
      if (/^[\\w.-]+\\.[a-z]{2,}(\\/.*)?$/i.test(uri)) return "https://" + uri;
      return fallback || "";
    }

    function buildPublicShareMessage() {
      const card = shareConfig.card || {};
      const shareActionUrl = appendPublicShareMode(shareConfig.url);
      const name = publicFlexText(card.name, "我的名片", 80);
      const meta = publicFlexText(card.meta, "SDK 名片王", 100);
      const shareLabel = publicFlexText(card.shareLabel, "分享", 16).replace(/^https?:\\/\\/.*/i, "分享");
      const shareColor = card.shareColor || "#ef4444";
      const buttons = (Array.isArray(card.buttons) ? card.buttons : [])
        .filter((button) => button && button.label && button.url)
        .map((button) => ({ ...button, url: publicFlexHttpsUri(button.url, shareConfig.url) }))
        .filter((button) => button.url)
        .slice(0, 4);
      const bubble = {
        type: "bubble",
        size: "${layout === "full" ? "giga" : "mega"}",
        header: {
          type: "box",
          layout: "horizontal",
          paddingAll: "12px",
          contents: [
            { type: "filler", flex: 1 },
            {
              type: "box",
              layout: "vertical",
              flex: 0,
              backgroundColor: shareColor,
              cornerRadius: "100px",
              paddingTop: "6px",
              paddingBottom: "6px",
              paddingStart: "14px",
              paddingEnd: "14px",
              contents: [{ type: "text", text: shareLabel, color: "#ffffff", weight: "bold", size: "sm", align: "center", flex: 0 }],
              action: { type: "uri", uri: shareActionUrl || shareConfig.url },
            },
          ],
        },
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            { type: "text", text: name, weight: "bold", size: "xl", wrap: true, align: "center", color: "#1f2933" },
            { type: "text", text: meta, size: "sm", color: "#607080", wrap: true, align: "center" },
            { type: "separator", margin: "md" },
            { type: "text", text: publicFlexText(card.intro || shareConfig.url, "點擊查看完整名片", 180), size: "sm", color: "#364756", wrap: true, margin: "md" },
          ],
          action: { type: "uri", uri: shareConfig.url },
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: buttons.map((button) => ({
            type: "button",
            style: "primary",
            height: "sm",
            color: button.color || "#06C755",
            action: { type: "uri", label: publicFlexText(button.label, "開啟", 20), uri: button.url || shareConfig.url },
          })),
        },
      };
      if (card.videoEnabled && card.videoUrl && /^https:\\/\\//i.test(card.videoUrl) && card.imageUrl && /^https:\\/\\//i.test(card.imageUrl)) {
        bubble.hero = {
          type: "video",
          url: card.videoUrl,
          previewUrl: card.imageUrl,
          altContent: {
            type: "image",
            url: card.imageUrl,
            size: "full",
            aspectRatio: "${layout === "square" ? "1:1" : (layout === "full" ? "2:3" : "800:533")}",
            aspectMode: "fit",
          },
          aspectRatio: "${layout === "square" ? "1:1" : (layout === "full" ? "2:3" : "800:533")}",
          action: { type: "uri", uri: shareConfig.url },
        };
      } else if (card.imageUrl && /^https:\\/\\//i.test(card.imageUrl)) {
        bubble.hero = {
          type: "image",
          url: card.imageUrl,
          size: "full",
          aspectRatio: "${layout === "square" ? "1:1" : (layout === "full" ? "2:3" : "800:533")}",
          aspectMode: "fit",
          action: { type: "uri", uri: shareConfig.url },
        };
      }
      return { type: "flex", altText: name + " 的名片", contents: bubble };
    }

    async function sharePublicCard() {
      setPublicShareStatus("正在開啟 LINE 分享...");
      try {
        if (shareConfig.liffId && window.liff) {
          await liff.init({ liffId: shareConfig.liffId });
          if (liff.isApiAvailable && liff.isApiAvailable("shareTargetPicker")) {
            await liff.shareTargetPicker([buildPublicShareMessage()]);
            setPublicShareStatus("分享完成，正在關閉...");
            closeLiffWindowSoon();
            return;
          }
        }
      } catch (error) {}
      if (shareConfig.liffId && getPublicShareParam("viaLiff") !== "1") {
        if (openPublicShareInLiff()) return;
      }
      setPublicShareStatus("無法開啟通訊錄，改用網址分享...");
      location.href = "https://social-plugins.line.me/lineit/share?url=" + encodeURIComponent(shareConfig.url || location.href);
    }

    document.getElementById("publicShareButton")?.addEventListener("click", sharePublicCard);
    if (getPublicShareParam("share") === "1") {
      setTimeout(sharePublicCard, 350);
    }
  </script>
</body>
</html>`;
}

async function callOpenAICardOcr(env, imageDataUrl) {
  const body = {
    model: env.OPENAI_VISION_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: [
            "Extract business card fields from this image.",
            "Return only strict JSON with these keys:",
            "name,title,company,phone,email,website,address,intro.",
            "Use empty strings when unknown. Do not invent data.",
            "intro should be a concise one or two sentence service summary if visible."
          ].join(" "),
        },
        { type: "input_image", image_url: imageDataUrl, detail: "high" },
      ],
    }],
    max_output_tokens: 800,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) {
    throw httpError(502, result.error?.message || `OpenAI HTTP ${response.status}`, "openai_error");
  }
  const text = extractResponseText(result);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw httpError(502, "OpenAI did not return JSON", "openai_parse_error");
  try {
    return JSON.parse(match[0]);
  } catch {
    throw httpError(502, "OpenAI returned invalid JSON", "openai_parse_error");
  }
}

function extractResponseText(result) {
  if (typeof result.output_text === "string") return result.output_text;
  const chunks = [];
  for (const item of result.output || []) {
    for (const part of item.content || []) {
      if (part.type === "output_text" && part.text) chunks.push(part.text);
      else if (typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

async function uploadCardAsset({ storage, tenantId, tenantMemberId, imageDataUrl, origin }) {
  const parsed = parseImageDataUrl(imageDataUrl);
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const ext = parsed.contentType.includes("png") ? "png" : "jpg";
  const key = `card-assets/${tenantId}/${tenantMemberId}/${yyyy}/${mm}/${safeTime(now.toISOString())}-${randomId()}.${ext}`;
  await storage.putObject(key, parsed.bytes, parsed.contentType);
  return {
    key,
    url: `${origin}/asset/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
  };
}

function normalizeBusinessCard(source, origin) {
  source = source || {};
  return {
    publicUrl: source.publicUrl || "",
    publicSlug: source.publicSlug || "",
    name: cleanText(source.name, 80),
    title: cleanText(source.title, 100),
    company: cleanText(source.company, 120),
    phone: cleanText(source.phone, 60),
    email: cleanText(source.email, 120),
    website: normalizeUrl(cleanText(source.website, 240)),
    address: cleanText(source.address, 240),
    intro: cleanText(source.intro, 600),
    shareLabel: normalizeShareLabel(source.shareLabel),
    shareColor: safeCssColor(source.shareColor, "#ef4444"),
    layout: normalizeCardLayout(source.layout),
    buttons: normalizeCardButtons(source.buttons, source),
    imageUrl: normalizeImageUrl(source.imageUrl),
    imageKey: cleanText(source.imageKey, 500),
    videoEnabled: Boolean(source.videoEnabled),
    videoUrl: normalizeUrl(cleanText(source.videoUrl, 500)),
    layouts: normalizeCardLayouts(source.layouts, source, origin),
  };
}

function layoutBaseFromCard(source) {
  source = source || {};
  return {
    name: cleanText(source.name, 80),
    title: cleanText(source.title, 100),
    company: cleanText(source.company, 120),
    phone: cleanText(source.phone, 60),
    email: cleanText(source.email, 120),
    website: normalizeUrl(cleanText(source.website, 240)),
    address: cleanText(source.address, 240),
    intro: cleanText(source.intro, 600),
    shareLabel: normalizeShareLabel(source.shareLabel),
    shareColor: safeCssColor(source.shareColor, "#ef4444"),
    buttons: normalizeCardButtons(source.buttons, source),
    imageUrl: normalizeImageUrl(source.imageUrl),
    imageKey: cleanText(source.imageKey, 500),
    videoEnabled: Boolean(source.videoEnabled),
    videoUrl: normalizeUrl(cleanText(source.videoUrl, 500)),
  };
}

function normalizeCardLayouts(layouts, fallback = {}, origin = "") {
  const normalized = {};
  const source = layouts && typeof layouts === "object" ? layouts : {};
  for (const layout of CARD_LAYOUTS) {
    const aliasKey = Object.entries(CARD_LAYOUT_ALIASES).find(([key, target]) => target === layout && source[key])?.[0];
    const record = source[layout] || (aliasKey ? source[aliasKey] : null);
    if (record) normalized[layout] = normalizeCardLayoutRecord(record, origin, layout);
  }
  if (!Object.keys(normalized).length && fallback && typeof fallback === "object") {
    const base = normalizeCardLayoutRecord(fallback, origin, DEFAULT_CARD_LAYOUT);
    for (const layout of CARD_LAYOUTS) normalized[layout] = { ...base, layout };
  }
  return normalized;
}

function normalizeCardLayoutRecord(source, origin = "", layout = DEFAULT_CARD_LAYOUT) {
  const base = layoutBaseFromCard(source);
  const imageUrl = normalizeImageUrl(source?.imageUrl);
  return {
    ...base,
    layout: normalizeCardLayout(layout || source?.layout),
    imageUrl,
    imageKey: cleanText(source?.imageKey, 500),
    videoEnabled: Boolean(source?.videoEnabled),
    videoUrl: normalizeUrl(cleanText(source?.videoUrl, 500)),
  };
}

function getLayoutCard(card, layout) {
  layout = normalizeCardLayout(layout);
  const base = layoutBaseFromCard(card);
  const override = card?.layouts?.[layout] || {};
  const merged = { ...base, ...override };
  if (!merged.imageUrl && base.imageUrl) merged.imageUrl = base.imageUrl;
  if (!merged.imageKey && base.imageKey) merged.imageKey = base.imageKey;
  return {
    ...card,
    ...merged,
    layout,
    publicUrl: card?.publicUrls?.[layout] || card?.publicUrl || "",
    publicUrls: card?.publicUrls || {},
    buttons: normalizeCardButtons(merged.buttons || base.buttons, merged),
  };
}

function parseCardRoute(pathname) {
  const parts = pathname.slice("/card/".length).split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  return {
    slug: cleanSlug(parts[0] || ""),
    layout: normalizeCardLayout(parts[1] || DEFAULT_CARD_LAYOUT),
  };
}

function parseLiffStateCardRoute(url) {
  const raw = url.searchParams.get("liff.state") || "";
  if (!raw) return null;
  try {
    const stateUrl = new URL(raw.startsWith("/") ? raw : `/${raw}`, url.origin);
    if (!stateUrl.pathname.startsWith("/card/")) return null;
    return parseCardRoute(stateUrl.pathname);
  } catch {
    return null;
  }
}

function normalizeCardLayout(value) {
  const layout = cleanSlug(value || DEFAULT_CARD_LAYOUT);
  if (CARD_LAYOUT_ALIASES[layout]) return CARD_LAYOUT_ALIASES[layout];
  return CARD_LAYOUTS.includes(layout) ? layout : DEFAULT_CARD_LAYOUT;
}

function createCardUrls(origin, slug) {
  const encoded = encodeURIComponent(slug);
  return {
    standard: `${origin}/card/${encoded}/standard`,
    full: `${origin}/card/${encoded}/full`,
    square: `${origin}/card/${encoded}/square`,
    poster: `${origin}/card/${encoded}/standard`,
    free: `${origin}/card/${encoded}/full`,
    classic: `${origin}/card/${encoded}/full`,
    links: `${origin}/card/${encoded}/square`,
  };
}

function normalizeCardButtons(buttons, fallback = {}) {
  const source = Array.isArray(buttons) ? buttons : [];
  const normalized = source.map((button) => ({
    label: cleanText(button.label || button.l, 24),
    url: normalizeActionUrl(button.url || button.u),
    color: safeCssColor(button.color || button.c, "#06c755"),
  })).filter((button) => button.label && button.url).slice(0, 6);
  if (normalized.length) return normalized;

  const defaults = [];
  const phone = cleanText(fallback.phone, 60).replace(/[^0-9+]/g, "");
  if (phone) defaults.push({ label: "行動電話", url: `tel:${phone}`, color: "#9b1c0c" });
  if (fallback.address) {
    defaults.push({
      label: "店家地址",
      url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fallback.address)}`,
      color: "#1f2937",
    });
  }
  return defaults.slice(0, 6);
}

function normalizeActionUrl(value) {
  const url = cleanText(value, 500);
  if (!url) return "";
  if (/^(https?:|mailto:|tel:|line:)/i.test(url)) return url;
  return `https://${url}`;
}

function safeCssColor(value, fallback) {
  const color = cleanText(value, 24);
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  return fallback;
}

function validateImageDataUrl(value) {
  const parsed = parseImageDataUrl(value);
  if (!["image/jpeg", "image/png", "image/webp"].includes(parsed.contentType)) {
    throw httpError(400, "Only jpg, png, and webp images are allowed", "invalid_image_type");
  }
  if (parsed.bytes.length > 1_200_000) {
    throw httpError(413, "Image is too large after compression", "image_too_large");
  }
}

function parseImageDataUrl(value) {
  const match = String(value || "").match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw httpError(400, "imageDataUrl must be a base64 data URL", "invalid_image");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return {
    contentType: match[1].toLowerCase(),
    bytes,
  };
}

function createCardSlug(memberNo) {
  return cleanSlug(String(memberNo || `card-${randomId()}`).toLowerCase());
}

function cleanSlug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 80);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function normalizeUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^(https?:|mailto:|tel:|line:)/i.test(url)) return url;
  return `https://${url}`;
}

function normalizeImageUrl(value) {
  const raw = cleanText(value, 500);
  if (!raw || /^data:image\//i.test(raw)) return "";
  const url = normalizeUrl(raw);
  return /^https:\/\//i.test(url) ? url : "";
}

function normalizeShareLabel(value) {
  const text = cleanText(value, 20);
  if (!text || /^https?:\/\//i.test(text) || /^\/?card\//i.test(text) || text.includes(".workers.dev")) return "分享";
  return text.slice(0, 16);
}

async function getReferralDownlines(storage, tenantId, parentTenantMemberId) {
  const assignments = await storage.list(`affiliate-assignments/${tenantId}/`, 1000);
  const downlines = [];

  for (const item of assignments.list) {
    const assignment = (await storage.getJson(storage.relativeKey(item.key))).value;
    if (!assignment || assignment.status !== "active" || assignment.parentTenantMemberId !== parentTenantMemberId) {
      continue;
    }
    const member = (await storage.getJson(`tenant-members/${tenantId}/${assignment.tenantMemberId}.json`)).value;
    downlines.push({
      tenantMemberId: assignment.tenantMemberId,
      memberNo: member?.memberNo || null,
      status: member?.status || "active",
      assignedAt: assignment.assignedAt,
    });
  }

  return downlines.sort((a, b) => String(b.assignedAt || "").localeCompare(String(a.assignedAt || "")));
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

function normalizeClientLineProfile(profile, verifiedLineUserId) {
  if (!profile || profile.userId !== verifiedLineUserId) return {};
  return {
    displayName: cleanText(profile.displayName, 120),
    pictureUrl: cleanHttpsUrl(profile.pictureUrl),
  };
}

function cleanHttpsUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : null;
  } catch (error) {
    return null;
  }
}

function createWasabiClient(env) {
  assertSecret(env.WASABI_ACCESS_KEY_ID, "WASABI_ACCESS_KEY_ID");
  assertSecret(env.WASABI_SECRET_ACCESS_KEY, "WASABI_SECRET_ACCESS_KEY");

  const bucket = requiredEnv(env.WASABI_BUCKET, "WASABI_BUCKET");
  const region = requiredEnv(env.WASABI_REGION, "WASABI_REGION");
  const endpoint = requiredEnv(env.WASABI_ENDPOINT, "WASABI_ENDPOINT").replace(/\/+$/, "");
  const basePrefix = normalizePrefix(env.WASABI_BASE_PREFIX || "sdksys");

  return {
    relativeKey(key) {
      const normalized = normalizePrefix(key);
      const prefix = `${basePrefix}/`;
      return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    },

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

    async getObject(relativeKey) {
      const key = joinKey(basePrefix, relativeKey);
      const response = await signedWasabiFetch(env, { method: "GET", endpoint, region, bucket, key });
      if (response.status === 404) return { ok: true, exists: false, key, body: null };
      if (!response.ok) throw await wasabiError(response);
      return {
        ok: true,
        exists: true,
        key,
        body: await response.arrayBuffer(),
        contentType: response.headers.get("content-type"),
        size: Number(response.headers.get("content-length") || 0),
      };
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

    async putObject(relativeKey, bytes, contentType) {
      const key = joinKey(basePrefix, relativeKey);
      const response = await signedWasabiFetch(env, {
        method: "PUT",
        endpoint,
        region,
        bucket,
        key,
        body: bytes,
        contentType: contentType || "application/octet-stream",
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
  const payloadHash = await sha256HexPayload(options.body || "");
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

function sessionMaxAgeMs() {
  return 30 * 24 * 60 * 60 * 1000;
}

async function createSessionToken(env, session) {
  assertSecret(env.MEMBER_NO_SECRET, "MEMBER_NO_SECRET");
  const payload = {
    v: 1,
    tenantId: session.tenantId,
    tenantMemberId: session.tenantMemberId,
    userId: session.userId,
    iat: Date.now(),
    exp: Date.now() + sessionMaxAgeMs(),
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacHex(await importHmacKey(env.MEMBER_NO_SECRET), `session:${encoded}`);
  return `${encoded}.${signature}`;
}

async function verifySessionToken(env, token) {
  assertSecret(env.MEMBER_NO_SECRET, "MEMBER_NO_SECRET");
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) {
    throw httpError(401, "Session token is required", "session_required");
  }
  const expected = await hmacHex(await importHmacKey(env.MEMBER_NO_SECRET), `session:${encoded}`);
  if (!timingSafeEqual(signature, expected)) {
    throw httpError(401, "Session token is invalid", "session_invalid");
  }
  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    throw httpError(401, "Session token is invalid", "session_invalid");
  }
  if (!payload || Number(payload.exp || 0) < Date.now()) {
    throw httpError(401, "Session token expired", "session_expired");
  }
  if (!payload.tenantId || !payload.tenantMemberId || !payload.userId) {
    throw httpError(401, "Session token is incomplete", "session_invalid");
  }
  return payload;
}

function base64UrlEncode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
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
    displayName: member.displayName || null,
    pictureUrl: member.pictureUrl || null,
    profile: normalizeMemberProfile(member.profile || {}),
    lastActiveAt: member.lastActiveAt,
  };
}

function libraryCardPrefix(tenantId, ownerTenantMemberId) {
  return `card-library/${tenantId}/${ownerTenantMemberId}/`;
}

function libraryCardKey(tenantId, ownerTenantMemberId, cardId) {
  return `${libraryCardPrefix(tenantId, ownerTenantMemberId)}${cleanId(cardId)}.json`;
}

function publicLibraryCard(card, origin = "") {
  const publicUrls = { ...createCardUrls(origin, card.publicSlug), ...(card.publicUrls || {}) };
  publicUrls.standard = publicUrls.standard || publicUrls.poster;
  publicUrls.full = publicUrls.full || publicUrls.free || publicUrls.classic;
  publicUrls.free = publicUrls.full;
  publicUrls.classic = publicUrls.full;
  publicUrls.square = publicUrls.square || publicUrls.links;
  const layouts = normalizeCardLayouts(card.layouts, card, origin);
  return {
    cardId: card.cardId,
    cardKind: "library",
    sourceType: card.sourceType || "scanned_contact",
    publicSlug: card.publicSlug,
    publicUrl: card.publicUrl || publicUrls[DEFAULT_CARD_LAYOUT],
    publicUrls,
    name: card.name || "",
    title: card.title || "",
    company: card.company || "",
    phone: card.phone || "",
    email: card.email || "",
    website: normalizeUrl(card.website),
    address: card.address || "",
    intro: card.intro || "",
    imageUrl: normalizeImageUrl(card.imageUrl),
    imageKey: card.imageKey || "",
    shareLabel: normalizeShareLabel(card.shareLabel),
    shareColor: card.shareColor || "#ef4444",
    layout: normalizeCardLayout(card.layout),
    buttons: normalizeCardButtons(card.buttons, card),
    videoEnabled: Boolean(card.videoEnabled),
    videoUrl: normalizeUrl(card.videoUrl),
    layouts,
    status: card.status || "active",
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function normalizeMemberProfile(profile) {
  profile = profile || {};
  return {
    name: cleanText(profile.name, 80),
    birthday: normalizeBirthday(profile.birthday),
    phone: cleanText(profile.phone, 60),
    residence: cleanText(profile.residence, 120),
    industry: cleanText(profile.industry, 120),
  };
}

function normalizeBirthday(value) {
  const text = cleanText(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

async function sha256HexPayload(value) {
  if (value instanceof Uint8Array) {
    const buffer = await crypto.subtle.digest("SHA-256", value);
    return hex(new Uint8Array(buffer));
  }
  if (value instanceof ArrayBuffer) {
    const buffer = await crypto.subtle.digest("SHA-256", value);
    return hex(new Uint8Array(buffer));
  }
  return sha256Hex(String(value || ""));
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

function html(body, init = {}) {
  return withCors(new Response(body, {
    ...init,
    headers: {
      ...HTML_HEADERS,
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
