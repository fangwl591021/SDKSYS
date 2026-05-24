# SDKSYS

SDK 名片王 SaaS / affiliate platform.

## Current Runtime

- GitHub: `fangwl591021/SDKSYS`
- Worker: `https://sdksys.fangwl591021.workers.dev/`
- Storage: Wasabi S3-compatible object storage

## Local Commands

```powershell
node --check src/index.js
npx.cmd wrangler deploy --dry-run
npx.cmd wrangler deploy
```

## Required Worker Secrets

Do not commit Wasabi keys to Git.

```powershell
npx.cmd wrangler secret put WASABI_ACCESS_KEY_ID
npx.cmd wrangler secret put WASABI_SECRET_ACCESS_KEY
npx.cmd wrangler secret put MEMBER_NO_SECRET
npx.cmd wrangler secret put SYSTEM_API_KEY
npx.cmd wrangler secret put LINE_LOGIN_CHANNEL_ID
npx.cmd wrangler secret put LINE_LIFF_ID
npx.cmd wrangler secret put OPENAI_API_KEY
```

## Storage Environment

Configured in `wrangler.toml`:

- `WASABI_BUCKET`
- `WASABI_REGION`
- `WASABI_ENDPOINT`
- `WASABI_BASE_PREFIX`

See [docs/wasabi-storage.md](docs/wasabi-storage.md) for key layout.

## First Admin Call

Create or update a tenant before LINE Login:

```powershell
$apiKey = "YOUR_SYSTEM_API_KEY"

$body = @{
  tenantId = "demo-shop"
  storeCode = "DEMO"
  name = "Demo Shop"
  plan = "free"
} | ConvertTo-Json -Compress

$body | Set-Content -LiteralPath "tenant-upsert-payload.json" -Encoding UTF8

curl.exe -X POST "https://sdksys.fangwl591021.workers.dev/api/admin/tenants/upsert" `
  -H "content-type: application/json" `
  -H "x-sdksys-api-key: $apiKey" `
  --data-binary "@tenant-upsert-payload.json"
```

Then the front end can call:

```text
https://sdksys.fangwl591021.workers.dev/app?storeCode=DEMO
```

Or call the API directly:

```text
POST /api/auth/line-login
{
  "idToken": "LINE_ID_TOKEN",
  "storeCode": "DEMO",
  "referralCode": "OPTIONAL_REFERRAL_CODE"
}
```

## Card SDK V1

The first card flow is available inside:

```text
https://sdksys.fangwl591021.workers.dev/app?storeCode=DEMO
```

After LINE Login, the member can photo/upload a card image, run AI recognition, edit fields, save, and share a public card page. V1 uses Wasabi only; it does not use R2.

See [docs/card-sdk-plan.md](docs/card-sdk-plan.md).
