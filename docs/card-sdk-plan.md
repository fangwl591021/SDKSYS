# Card SDK V1

This feature intentionally uses the old `LINE-` card upload flow as behavior reference only.

## Do Not Import

- Do not copy the old `cards`, `mycard`, `ecard`, or `cropper` modules.
- Do not use R2, PHOTOMAN, ImgBB, or image fallback chains.
- Do not expose `OPENAI_API_KEY` to the browser.
- Do not use an action bus such as `fetchAPI(action, payload)`.
- Do not store raw LINE IDs or platform user IDs in public card pages.
- Do not store long base64 images inside business card JSON.

## Storage

Wasabi is the only storage for V1:

```text
business-cards/{tenant_id}/{tenant_member_id}.json
card-assets/{tenant_id}/{tenant_member_id}/{yyyy}/{mm}/{filename}.jpg
card-index/public-slugs/{slug}.json
```

## API

```text
POST /api/cards/me
POST /api/cards/recognize
POST /api/cards/upsert
GET  /card/{slug}
GET  /asset/card-assets/{tenant_id}/{tenant_member_id}/{yyyy}/{mm}/{filename}
```

All write APIs require a LINE `idToken` and tenant scope. Public card pages only read the published card JSON.

## Frontend Flow

```text
LINE Login
-> open card section
-> photo/upload image
-> browser compresses image
-> /api/cards/recognize calls OpenAI from Worker
-> user edits fields
-> /api/cards/upsert stores card JSON and optional image asset in Wasabi
-> public /card/{slug} link can be copied or shared
```

## OCR Schema

```json
{
  "name": "",
  "title": "",
  "company": "",
  "phone": "",
  "email": "",
  "website": "",
  "address": "",
  "intro": ""
}
```
