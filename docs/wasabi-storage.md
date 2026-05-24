# Wasabi Storage

## Source

Storage follows the provided "外站直接串接 Wasabi 空間讀寫 API 文件".

Wasabi is S3-compatible object storage. Secrets must stay in Worker Secrets and must not be committed to Git.

## Runtime Configuration

```text
WASABI_BUCKET=tonyuse
WASABI_REGION=us-west-1
WASABI_ENDPOINT=https://s3.us-west-1.wasabisys.com
WASABI_BASE_PREFIX=tonyuse/sdksys
```

Secrets:

```text
WASABI_ACCESS_KEY_ID
WASABI_SECRET_ACCESS_KEY
MEMBER_NO_SECRET
SYSTEM_API_KEY
LINE_LOGIN_CHANNEL_ID
```

## Key Layout

All SDKSYS data is stored under:

```text
tonyuse/sdksys/
```

Suggested keys:

```text
tonyuse/sdksys/tenants/{tenant_id}.json
tonyuse/sdksys/users/{user_id}.json
tonyuse/sdksys/tenant-members/{tenant_id}/{tenant_member_id}.json
tonyuse/sdksys/referral-codes/{tenant_id}/{referral_code}.json
tonyuse/sdksys/affiliate-assignments/{tenant_id}/{tenant_member_id}.json
tonyuse/sdksys/activity/{tenant_id}/{yyyy}/{mm}/{tenant_member_id}/{event_id}.json
tonyuse/sdksys/files/shops/{shop_id}/{category}/{yyyy}/{mm}/{filename}
tonyuse/sdksys/audit/{tenant_id}/{yyyy}/{mm}/{event_id}.json
```

## Safety Rules

- Never expose `line_user_id`, `user_id`, Wasabi keys, or raw object write APIs to tenant users.
- Public member identity should use `member_no`, not platform UID.
- Tenant reads and writes must always include tenant scope.
- Referral code lookup must use `tenant_id + referral_code`.
- Private files should use short-lived signed access rather than public bucket access.
- Existing commission records must not be recalculated when a member is reassigned.

## Worker Storage API

Initial internal endpoints:

```text
GET  /health
GET  /api/system/storage
POST /api/member-number/preview
POST /api/admin/tenants/upsert
POST /api/auth/line-login
POST /api/storage/head
POST /api/storage/get-json
POST /api/storage/put-json
POST /api/storage/list
```

`/api/auth/line-login` is public and verifies the LINE `idToken`.

The admin and raw storage endpoints require:

```text
x-sdksys-api-key: YOUR_SYSTEM_API_KEY
```
