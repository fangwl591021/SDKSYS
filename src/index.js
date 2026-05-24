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
const CARD_LAYOUTS = ["standard", "free", "square"];
const CARD_LAYOUT_ALIASES = {
  poster: "standard",
  classic: "free",
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
        return html(renderAppHtml(env, url));
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
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
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
      background: linear-gradient(135deg, #f8fbff 0%, #eef6f0 52%, #f7f1e8 100%);
    }
    main {
      width: min(960px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(300px, 0.9fr);
      gap: 20px;
      align-items: stretch;
    }
    .panel, .card {
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 18px 50px rgba(25, 42, 61, 0.10);
    }
    .panel { padding: 28px; }
    .card { padding: 22px; }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(28px, 5vw, 44px);
      line-height: 1.08;
      letter-spacing: 0;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 20px;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 16px;
      color: var(--muted);
      line-height: 1.65;
    }
    .meta {
      display: grid;
      gap: 8px;
      margin: 22px 0;
    }
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
    button:hover { background: var(--accent-dark); }
    button:disabled {
      cursor: not-allowed;
      background: #9aa8b4;
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
      background: #233142;
      font-size: 14px;
    }
    .secondary-button:hover { background: #111827; }
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
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .card-sdk.visible { display: block; }
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
    .button-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 12px;
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
    .cropper {
      display: none;
      gap: 10px;
      margin-top: 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfdff;
    }
    .cropper.visible { display: grid; }
    .crop-stage {
      position: relative;
      width: 100%;
      aspect-ratio: 800 / 533;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #111827;
    }
    .crop-stage.square { aspect-ratio: 1 / 1; }
    .crop-stage img {
      position: absolute;
      left: 50%;
      top: 50%;
      max-width: none;
      transform-origin: center;
      user-select: none;
      pointer-events: none;
    }
    .crop-controls {
      display: grid;
      gap: 8px;
    }
    .crop-controls label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }
    .crop-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
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
      max-height: 180px;
      object-fit: cover;
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
    code {
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--soft);
      color: var(--ink);
    }
    @media (max-width: 760px) {
      main { width: min(100% - 24px, 960px); padding: 20px 0; }
      .shell { grid-template-columns: 1fr; }
      .panel, .card { padding: 20px; }
    }
  </style>
</head>
<body>
  <main>
    <div class="shell">
      <section class="panel">
        <h1>SDK 名片王</h1>
        <p>使用 LINE Login 建立租戶會員身份，會員編號會依商店隔離產生，不暴露平台 UID。</p>
        <div class="meta">
          <div class="row"><span>商店代碼</span><strong id="storeCode">${escapeHtml(storeCode)}</strong></div>
          <div class="row"><span>推薦碼</span><strong id="referralCode">${escapeHtml(referralCode || "未帶入")}</strong></div>
          <div class="row"><span>LIFF</span><strong>${liffId ? "已設定" : "尚未設定"}</strong></div>
        </div>
      </section>
      <aside class="card">
        <h2>會員登入</h2>
        <p>登入後會建立租戶會員、會員編號、推薦碼，並寫入 Wasabi。</p>
        <button id="loginButton" type="button">LINE Login</button>
        <div class="status" id="status">準備中</div>
        <div class="member" id="member">
          <div class="row"><span>會員編號</span><strong id="memberNo"></strong></div>
          <div class="row"><span>我的推薦碼</span><strong id="myReferralCode"></strong></div>
          <div class="row"><span>歸屬狀態</span><strong id="attribution"></strong></div>
          <div class="copy-row">
            <input id="referralLink" type="text" readonly aria-label="Referral link">
            <button class="secondary-button" id="copyReferralLink" type="button">Copy referral link</button>
          </div>
          <div class="row"><span>直接下線</span><strong id="downlineCount">0</strong></div>
          <div class="downlines" id="downlines"></div>
        </div>
        <div class="card-sdk" id="cardSdk">
          <h2>我的名片</h2>
          <p>拍照或上傳名片，AI 只抽欄位，圖片與資料都存到 Wasabi。</p>
          <input class="file-picker" id="cardImageFile" type="file" accept="image/*" capture="environment">
          <div class="cropper" id="cardCropper">
            <div class="crop-stage" id="cropStage"><img id="cropImage" alt=""></div>
            <div class="crop-controls">
              <label>縮放<input id="cropZoom" type="range" min="1" max="3" step="0.01" value="1"></label>
              <label>左右<input id="cropX" type="range" min="-100" max="100" step="1" value="0"></label>
              <label>上下<input id="cropY" type="range" min="-100" max="100" step="1" value="0"></label>
            </div>
            <div class="crop-actions">
              <button class="secondary-button" id="applyCropButton" type="button">套用裁切</button>
              <button class="secondary-button" id="cancelCropButton" type="button">取消裁切</button>
            </div>
          </div>
          <div class="button-row">
            <button class="secondary-button" id="recognizeCardButton" type="button">AI 辨識</button>
            <button class="secondary-button" id="saveCardButton" type="button">儲存名片</button>
          </div>
          <div class="form-grid" style="margin-top: 14px;">
            <div class="field"><label for="cardName">姓名</label><input id="cardName" autocomplete="name"></div>
            <div class="field"><label for="cardTitle">職稱</label><input id="cardTitle"></div>
            <div class="field"><label for="cardCompany">公司</label><input id="cardCompany" autocomplete="organization"></div>
            <div class="field"><label for="cardPhone">電話</label><input id="cardPhone" autocomplete="tel"></div>
            <div class="field"><label for="cardEmail">Email</label><input id="cardEmail" autocomplete="email"></div>
            <div class="field"><label for="cardWebsite">網站</label><input id="cardWebsite" autocomplete="url"></div>
            <div class="field"><label for="cardAddress">地址</label><input id="cardAddress"></div>
            <div class="field"><label for="cardIntro">介紹</label><textarea id="cardIntro"></textarea></div>
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
              <label for="cardLayout">分享版型</label>
              <select id="cardLayout">
                <option value="standard">標準</option>
                <option value="free">自由</option>
                <option value="square">正方</option>
              </select>
            </div>
            <div class="field">
              <label>底部按鈕設定</label>
              <div class="button-editor" id="cardButtonEditor"></div>
              <button class="secondary-button" id="addCardButton" type="button" style="margin-top: 10px;">+ 新增按鈕</button>
            </div>
          </div>
          <div class="url-grid">
            <label>標準<input id="publicCardUrlStandard" type="text" readonly></label>
            <label>自由<input id="publicCardUrlFree" type="text" readonly></label>
            <label>正方<input id="publicCardUrlSquare" type="text" readonly></label>
            <button class="secondary-button" id="shareCardButton" type="button">分享名片</button>
          </div>
          <div class="card-preview" id="cardPreview">
            <img id="cardPreviewImage" alt="">
            <div class="card-preview-body">
              <div class="card-preview-title" id="cardPreviewTitle"></div>
              <div class="card-preview-meta" id="cardPreviewMeta"></div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </main>
  <script>
    const config = ${JSON.stringify({ storeCode, referralCode, liffId })};
    const statusEl = document.getElementById("status");
    const loginButton = document.getElementById("loginButton");
    const memberEl = document.getElementById("member");
    const cardSdkEl = document.getElementById("cardSdk");
    let currentIdToken = "";
    let currentSessionToken = "";
    let currentMember = null;
    let currentCard = null;
    let activeCardLayout = "standard";
    let selectedCardImages = {};
    let cropState = null;
    let cardButtons = [];

    function setStatus(text) {
      statusEl.textContent = text;
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
          setStatus("請使用 LINE Login 登入。");
          return;
        }
        await submitIdToken();
      } catch (error) {
        setStatus(error.message || "LIFF 初始化失敗");
      }
    }

    async function submitIdToken() {
      const idToken = liff.getIDToken();
      if (!idToken) {
        setStatus("無法取得 LINE idToken，請重新登入。");
        return;
      }
      currentIdToken = idToken;
      setStatus("正在建立會員身份...");
      const response = await fetch("/api/auth/line-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeCode: config.storeCode,
          referralCode: config.referralCode || undefined,
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
      document.getElementById("memberNo").textContent = result.member.memberNo;
      document.getElementById("myReferralCode").textContent = result.member.referralCode;
      document.getElementById("attribution").textContent = result.attribution.result || result.attribution.status;
      const referralLink = new URL(location.href);
      referralLink.searchParams.set("storeCode", config.storeCode);
      referralLink.searchParams.set("ref", result.member.referralCode);
      document.getElementById("referralLink").value = referralLink.toString();
      renderDownlines(result.downlines || []);
      currentMember = result.member;
      memberEl.classList.add("visible");
      cardSdkEl.classList.add("visible");
      await loadMyCard();
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
      const aliases = { poster: "standard", classic: "free", links: "square" };
      const layout = String(value || "standard").toLowerCase();
      return aliases[layout] || (["standard", "free", "square"].includes(layout) ? layout : "standard");
    }

    function cropSpecForLayout(layout) {
      return normalizeLayoutName(layout) === "square"
        ? { width: 800, height: 800, className: "square" }
        : { width: 800, height: 533, className: "" };
    }

    function updateCropPreview() {
      if (!cropState) return;
      const img = document.getElementById("cropImage");
      const stage = document.getElementById("cropStage");
      const spec = cropSpecForLayout(activeCardLayout);
      stage.classList.toggle("square", spec.className === "square");
      const box = stage.getBoundingClientRect();
      const coverScale = Math.max(box.width / cropState.width, box.height / cropState.height);
      const zoom = Number(document.getElementById("cropZoom").value || 1);
      const scale = coverScale * zoom;
      const x = Number(document.getElementById("cropX").value || 0);
      const y = Number(document.getElementById("cropY").value || 0);
      img.style.width = Math.round(cropState.width * scale) + "px";
      img.style.height = Math.round(cropState.height * scale) + "px";
      img.style.transform = "translate(calc(-50% + " + x + "px), calc(-50% + " + y + "px))";
    }

    async function openCropper(file) {
      const src = await readFileAsDataUrl(file);
      const probe = new Image();
      await new Promise((resolve, reject) => {
        probe.onload = resolve;
        probe.onerror = reject;
        probe.src = src;
      });
      cropState = { src, width: probe.naturalWidth || probe.width, height: probe.naturalHeight || probe.height };
      document.getElementById("cropImage").src = src;
      document.getElementById("cropZoom").value = "1";
      document.getElementById("cropX").value = "0";
      document.getElementById("cropY").value = "0";
      document.getElementById("cardCropper").classList.add("visible");
      updateCropPreview();
      setStatus("請先裁切版型圖片，再儲存名片。");
    }

    async function applyCrop() {
      if (!cropState) return;
      const spec = cropSpecForLayout(activeCardLayout);
      const stage = document.getElementById("cropStage").getBoundingClientRect();
      const coverScale = Math.max(stage.width / cropState.width, stage.height / cropState.height);
      const zoom = Number(document.getElementById("cropZoom").value || 1);
      const scale = coverScale * zoom;
      const offsetX = Number(document.getElementById("cropX").value || 0);
      const offsetY = Number(document.getElementById("cropY").value || 0);
      const visibleW = stage.width / scale;
      const visibleH = stage.height / scale;
      const centerX = cropState.width / 2 - offsetX / scale;
      const centerY = cropState.height / 2 - offsetY / scale;
      let sx = centerX - visibleW / 2;
      let sy = centerY - visibleH / 2;
      sx = Math.max(0, Math.min(cropState.width - visibleW, sx));
      sy = Math.max(0, Math.min(cropState.height - visibleH, sy));

      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = cropState.src;
      });
      const canvas = document.createElement("canvas");
      canvas.width = spec.width;
      canvas.height = spec.height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, sx, sy, visibleW, visibleH, 0, 0, canvas.width, canvas.height);
      selectedCardImages[activeCardLayout] = canvas.toDataURL("image/jpeg", 0.88);
      document.getElementById("cardCropper").classList.remove("visible");
      cropState = null;
      renderCardPreview({ ...getEffectiveLayoutCard(currentCard, activeCardLayout), ...getCardFormData(), imageUrl: selectedCardImages[activeCardLayout] });
      setStatus("裁切完成，請儲存名片。");
    }

    function cancelCrop() {
      cropState = null;
      document.getElementById("cardCropper").classList.remove("visible");
      document.getElementById("cardImageFile").value = "";
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
        shareLabel: document.getElementById("cardShareLabel").value.trim(),
        shareColor: document.getElementById("cardShareColor").value,
        layout: document.getElementById("cardLayout").value,
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
        shareLabel: card.shareLabel || "分享",
        shareColor: card.shareColor || "#ef4444",
        buttons: Array.isArray(card.buttons) ? card.buttons : [],
        imageUrl: card.imageUrl || "",
        imageKey: card.imageKey || "",
      };
    }

    function getEffectiveLayoutCard(card, layout) {
      layout = normalizeLayoutName(layout);
      const base = baseCardFields(card);
      const override = card && card.layouts && card.layouts[layout] ? card.layouts[layout] : {};
      return { ...base, ...override, layout, publicUrls: card?.publicUrls || {}, publicUrl: card?.publicUrls?.[layout] || card?.publicUrl || "" };
    }

    function saveCurrentLayoutDraft() {
      if (!currentCard) return;
      const layout = normalizeLayoutName(activeCardLayout);
      currentCard.layouts = { ...(currentCard.layouts || {}) };
      currentCard.layouts[layout] = {
        ...(currentCard.layouts[layout] || {}),
        ...getCardFormData(),
        layout,
      };
      if (selectedCardImages[layout]) currentCard.layouts[layout].imageUrl = selectedCardImages[layout];
    }

    function fillCardForm(card, layout) {
      card = card || {};
      activeCardLayout = normalizeLayoutName(layout || card.layout || activeCardLayout || "standard");
      const view = getEffectiveLayoutCard(card, activeCardLayout);
      document.getElementById("cardName").value = view.name || "";
      document.getElementById("cardTitle").value = view.title || "";
      document.getElementById("cardCompany").value = view.company || "";
      document.getElementById("cardPhone").value = view.phone || "";
      document.getElementById("cardEmail").value = view.email || "";
      document.getElementById("cardWebsite").value = view.website || "";
      document.getElementById("cardAddress").value = view.address || "";
      document.getElementById("cardIntro").value = view.intro || "";
      document.getElementById("cardShareLabel").value = view.shareLabel || "分享";
      document.getElementById("cardShareColor").value = view.shareColor || "#ef4444";
      document.getElementById("cardLayout").value = activeCardLayout;
      cardButtons = Array.isArray(view.buttons) && view.buttons.length ? view.buttons.slice(0, 6) : defaultCardButtons(view);
      renderCardButtonEditor();
      const urls = card.publicUrls || {};
      document.getElementById("publicCardUrlStandard").value = urls.standard || urls.poster || card.publicUrl || "";
      document.getElementById("publicCardUrlFree").value = urls.free || urls.classic || card.publicUrl || "";
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
      if (card && card.website) buttons.push({ label: "開啟網站", url: card.website, color: "#06c755" });
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
      const layout = document.getElementById("cardLayout").value || "standard";
      const urls = (card && card.publicUrls) || {};
      const aliases = { standard: "poster", free: "classic", square: "links" };
      return urls[layout] || urls[aliases[layout]] || card?.publicUrl || "";
    }

    async function loadMyCard() {
      if (!currentSessionToken) return;
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

    async function recognizeSelectedCard() {
      const file = document.getElementById("cardImageFile").files[0];
      const imageDataUrl = selectedCardImages[activeCardLayout];
      if (!imageDataUrl && !file) {
        setStatus("請先拍照或上傳名片圖片");
        return;
      }
      if (!imageDataUrl && file) {
        await openCropper(file);
        setStatus("請先套用裁切，再按 AI 辨識。");
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
      currentCard = currentCard || {};
      currentCard.layouts = { ...(currentCard.layouts || {}) };
      currentCard.layouts[activeCardLayout] = {
        ...getEffectiveLayoutCard(currentCard, activeCardLayout),
        ...(result.card || {}),
        imageUrl: selectedCardImages[activeCardLayout] || getEffectiveLayoutCard(currentCard, activeCardLayout).imageUrl,
      };
      fillCardForm(currentCard, activeCardLayout);
      setStatus("辨識完成，可以編輯後儲存");
    }

    async function saveBusinessCard() {
      if (!currentSessionToken) return;
      const pendingFile = document.getElementById("cardImageFile").files[0];
      if (pendingFile && !selectedCardImages[activeCardLayout]) {
        setStatus("請先套用裁切，再儲存名片。");
        return;
      }
      saveCurrentLayoutDraft();
      const layout = activeCardLayout;
      const card = { ...(currentCard || {}), ...getCardFormData(), layout };
      setStatus("正在儲存名片...");
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
        return;
      }
      currentCard = result.card;
      selectedCardImages = {};
      document.getElementById("cardImageFile").value = "";
      fillCardForm(currentCard, layout);
      setStatus("名片已儲存");
    }

    function flexText(value, fallback, limit = 120) {
      const text = String(value || fallback || " ").replace(/\\s+/g, " ").trim();
      return (text || " ").slice(0, limit);
    }

    function buildCardFlexMessage(card, url) {
      card = card || {};
      const name = flexText(card.name, "我的名片", 80);
      const meta = [card.company, card.title].filter(Boolean).join(" / ");
      const intro = flexText(card.intro || meta || url, "點擊查看完整名片", 180);
      const shareLabel = flexText(card.shareLabel, "分享", 16);
      const shareColor = card.shareColor || "#ef4444";
      const buttons = [
        { label: "查看名片", url, color: "#06C755" },
        ...getCardButtons(),
      ].slice(0, 4);
      const bubble = {
        type: "bubble",
        size: "mega",
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
              action: { type: "uri", uri: url },
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
      if (card.imageUrl && /^https:\\/\\//i.test(card.imageUrl)) {
        bubble.hero = {
          type: "image",
          url: card.imageUrl,
          size: "full",
          aspectRatio: "800:533",
          aspectMode: "cover",
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
      } catch (error) {}
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

    document.getElementById("copyReferralLink").addEventListener("click", async () => {
      const input = document.getElementById("referralLink");
      input.select();
      try {
        await navigator.clipboard.writeText(input.value);
        setStatus("推薦連結已複製");
      } catch (error) {
        document.execCommand("copy");
        setStatus("推薦連結已複製");
      }
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
    document.getElementById("saveCardButton").addEventListener("click", saveBusinessCard);
    document.getElementById("shareCardButton").addEventListener("click", shareBusinessCard);
    document.getElementById("cardImageFile").addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) await openCropper(file);
    });
    document.getElementById("cropZoom").addEventListener("input", updateCropPreview);
    document.getElementById("cropX").addEventListener("input", updateCropPreview);
    document.getElementById("cropY").addEventListener("input", updateCropPreview);
    document.getElementById("applyCropButton").addEventListener("click", applyCrop);
    document.getElementById("cancelCropButton").addEventListener("click", cancelCrop);
    document.getElementById("cardLayout").addEventListener("change", (event) => {
      saveCurrentLayoutDraft();
      activeCardLayout = normalizeLayoutName(event.target.value);
      cancelCrop();
      fillCardForm(currentCard || {}, activeCardLayout);
    });
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
  } else if (input.imageUrl) {
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
    shareLabel: standard.shareLabel || input.shareLabel || "分享",
    shareColor: standard.shareColor || input.shareColor || "#ef4444",
    layout: activeLayout,
    buttons: normalizeCardButtons(standard.buttons || input.buttons, standard),
    imageUrl: standard.imageUrl || "",
    imageKey: standard.imageKey || "",
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
  publicUrls.free = publicUrls.free || publicUrls.classic;
  publicUrls.square = publicUrls.square || publicUrls.links;
  const layouts = normalizeCardLayouts(card.layouts, card, origin);
  return {
    ...card,
    publicUrl: card.publicUrl || publicUrls[DEFAULT_CARD_LAYOUT],
    publicUrls,
    shareLabel: card.shareLabel || "分享",
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
  const card = await readBusinessCard(storage, index.tenantId, index.tenantMemberId, origin);
  return renderPublicCardShell(card, origin, normalizeCardLayout(layout), liffId);
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
  const shareLabel = card.shareLabel || "分享";
  const shareColor = safeCssColor(card.shareColor, "#ef4444");
  const buttons = normalizeCardButtons(card.buttons, card);
  const actionHtml = buttons.map((button) => `<a href="${escapeHtml(normalizeActionUrl(button.url))}" style="background:${escapeHtml(safeCssColor(button.color, "#06c755"))}">${escapeHtml(button.label)}</a>`).join("");
  const image = card.imageUrl ? `<img src="${escapeHtml(card.imageUrl)}" alt="">` : `<div class="visual-empty">${escapeHtml(String(title).slice(0, 1).toUpperCase())}</div>`;
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
    .card-shell { position:relative; background:white; border:1px solid #d8e0e8; border-radius:20px; overflow:hidden; box-shadow:0 18px 44px rgba(25,42,61,.12); }
    .share-head { min-height:52px; display:flex; justify-content:flex-end; align-items:center; padding:10px 12px; }
    .share-badge { appearance:none; border:0; display:inline-flex; flex:0 0 auto; width:auto; max-width:max-content; align-items:center; justify-content:center; min-height:32px; border-radius:999px; padding:6px 16px; color:white; font:inherit; font-weight:900; line-height:1.2; white-space:nowrap; text-decoration:none; background:${escapeHtml(shareColor)}; cursor:pointer; }
    .hero { background:#f8fbff; display:flex; align-items:center; justify-content:center; overflow:hidden; }
    .hero img { width:100%; height:100%; object-fit:cover; display:block; }
    .visual-empty { width:120px; height:120px; border-radius:8px; background:#06c755; color:white; display:flex; align-items:center; justify-content:center; font-size:44px; font-weight:900; }
    h1 { margin:0; letter-spacing:0; line-height:1.08; }
    .meta { color:#364756; line-height:1.45; }
    .intro { white-space:pre-line; line-height:1.65; color:#1f2a44; }
    .contacts { display:grid; gap:7px; color:#364756; font-size:15px; }
    .contacts a { color:#1f2933; text-decoration:none; word-break:break-word; }
    .actions { display:grid; gap:10px; }
    .actions a { display:block; text-decoration:none; text-align:center; padding:13px 16px; border-radius:8px; font-weight:900; color:white; }
    .layout-standard main { width:min(430px, calc(100% - 24px)); }
    .layout-standard .hero { aspect-ratio:800/533; }
    .layout-standard .hero img { object-fit:contain; background:#fff; }
    .layout-standard .body { padding:24px 26px 12px; text-align:center; }
    .layout-standard h1 { font-size:30px; margin-bottom:12px; }
    .layout-standard .intro { margin:14px 0 0; text-align:left; }
    .layout-standard .actions { padding:22px 26px 26px; }
    .layout-free main { width:min(860px, calc(100% - 28px)); }
    .layout-free .physical { display:grid; grid-template-columns:minmax(0,1fr) 38%; min-height:340px; }
    .layout-free .share-head { position:absolute; top:0; right:0; z-index:2; }
    .layout-free .info { padding:64px 34px 30px; display:flex; flex-direction:column; justify-content:space-between; border-left:8px solid #06c755; }
    .layout-free .brand { color:#607080; font-weight:800; }
    .layout-free h1 { font-size:40px; margin:8px 0; }
    .layout-free .meta { font-size:18px; }
    .layout-free .intro { margin-top:18px; color:#607080; }
    .layout-free .hero { min-height:340px; padding:18px; }
    .layout-free .hero img { object-fit:contain; border-radius:6px; box-shadow:0 10px 28px rgba(25,42,61,.10); }
    .layout-free .actions { grid-template-columns:repeat(2,minmax(0,1fr)); margin-top:16px; }
    .layout-square main { width:min(520px, calc(100% - 24px)); }
    .layout-square .card-shell { padding-bottom:22px; }
    .layout-square .square-frame { width:100%; aspect-ratio:1/1; display:grid; grid-template-rows:auto minmax(0,1fr) auto; }
    .layout-square .hero { min-height:0; }
    .layout-square .hero img { object-fit:cover; }
    .layout-square .profile { padding:18px 26px; text-align:center; }
    .layout-square h1 { font-size:28px; margin-bottom:8px; }
    .layout-square .intro { margin-top:10px; color:#607080; }
    .layout-square .actions { padding:0 26px; }
    @media (max-width: 680px) {
      .layout-free .physical { grid-template-columns:1fr; }
      .layout-free .hero { order:-1; min-height:220px; }
      .layout-free .info { padding:64px 24px 24px; }
      h1 { font-size:32px; }
      .layout-free .actions { grid-template-columns:1fr; }
    }
  </style>
</head>
<body class="${escapeHtml(bodyClass)}">
  <main>
    ${layout === "free" ? `
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
  <script>
    const shareConfig = ${JSON.stringify(sharePayload)};

    function publicFlexText(value, fallback, limit = 120) {
      const text = String(value || fallback || " ").replace(/\\s+/g, " ").trim();
      return (text || " ").slice(0, limit);
    }

    function buildPublicShareMessage() {
      const card = shareConfig.card || {};
      const name = publicFlexText(card.name, "我的名片", 80);
      const meta = publicFlexText(card.meta, "SDK 名片王", 100);
      const shareLabel = publicFlexText(card.shareLabel, "分享", 16);
      const shareColor = card.shareColor || "#ef4444";
      const buttons = [
        { label: "查看名片", url: shareConfig.url, color: "#06C755" },
        ...(Array.isArray(card.buttons) ? card.buttons : []),
      ].filter((button) => button && button.label && button.url).slice(0, 4);
      const bubble = {
        type: "bubble",
        size: "mega",
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
              action: { type: "uri", uri: shareConfig.url },
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
      if (card.imageUrl && /^https:\\/\\//i.test(card.imageUrl)) {
        bubble.hero = {
          type: "image",
          url: card.imageUrl,
          size: "full",
          aspectRatio: "800:533",
          aspectMode: "cover",
          action: { type: "uri", uri: shareConfig.url },
        };
      }
      return { type: "flex", altText: name + " 的名片", contents: bubble };
    }

    async function sharePublicCard() {
      try {
        if (shareConfig.liffId && window.liff) {
          await liff.init({ liffId: shareConfig.liffId });
          if (liff.isApiAvailable && liff.isApiAvailable("shareTargetPicker")) {
            await liff.shareTargetPicker([buildPublicShareMessage()]);
            return;
          }
        }
      } catch (error) {}
      location.href = "https://social-plugins.line.me/lineit/share?url=" + encodeURIComponent(shareConfig.url || location.href);
    }

    document.getElementById("publicShareButton")?.addEventListener("click", sharePublicCard);
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
    shareLabel: cleanText(source.shareLabel, 20) || "分享",
    shareColor: safeCssColor(source.shareColor, "#ef4444"),
    layout: normalizeCardLayout(source.layout),
    buttons: normalizeCardButtons(source.buttons, source),
    imageUrl: source.imageUrl && String(source.imageUrl).startsWith(origin) ? String(source.imageUrl) : "",
    imageKey: cleanText(source.imageKey, 500),
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
    shareLabel: cleanText(source.shareLabel, 20) || "分享",
    shareColor: safeCssColor(source.shareColor, "#ef4444"),
    buttons: normalizeCardButtons(source.buttons, source),
    imageUrl: cleanText(source.imageUrl, 500),
    imageKey: cleanText(source.imageKey, 500),
  };
}

function normalizeCardLayouts(layouts, fallback = {}, origin = "") {
  const normalized = {};
  const source = layouts && typeof layouts === "object" ? layouts : {};
  for (const layout of CARD_LAYOUTS) {
    const record = source[layout] || source[Object.entries(CARD_LAYOUT_ALIASES).find(([, target]) => target === layout)?.[0]] || null;
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
  const imageUrl = cleanText(source?.imageUrl, 500);
  return {
    ...base,
    layout: normalizeCardLayout(layout || source?.layout),
    imageUrl: imageUrl && (!origin || imageUrl.startsWith(origin) || imageUrl.startsWith("data:image/")) ? imageUrl : "",
    imageKey: cleanText(source?.imageKey, 500),
  };
}

function getLayoutCard(card, layout) {
  layout = normalizeCardLayout(layout);
  const base = layoutBaseFromCard(card);
  const override = card?.layouts?.[layout] || {};
  return {
    ...card,
    ...base,
    ...override,
    layout,
    publicUrl: card?.publicUrls?.[layout] || card?.publicUrl || "",
    publicUrls: card?.publicUrls || {},
    buttons: normalizeCardButtons(override.buttons || base.buttons, { ...base, ...override }),
  };
}

function parseCardRoute(pathname) {
  const parts = pathname.slice("/card/".length).split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  return {
    slug: cleanSlug(parts[0] || ""),
    layout: normalizeCardLayout(parts[1] || DEFAULT_CARD_LAYOUT),
  };
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
    free: `${origin}/card/${encoded}/free`,
    square: `${origin}/card/${encoded}/square`,
    poster: `${origin}/card/${encoded}/standard`,
    classic: `${origin}/card/${encoded}/free`,
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
  if (fallback.website) defaults.push({ label: "開啟網站", url: normalizeUrl(fallback.website), color: "#06c755" });
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
