# SDKSYS SaaS Architecture

## Identity Principle

One LINE user is not the same thing as one tenant or one member.

- `users` identifies the platform-level person.
- `tenants` identifies the shop, company, organization, or personal workspace.
- `tenant_members` identifies one user's membership inside one tenant.
- Affiliate attribution is attached to `tenant_members`, not directly to `users`.

## Roles

| Scope | Role | Purpose |
| --- | --- | --- |
| Platform | `super_admin` | Full system control across tenants, plans, lockouts, and global reporting. |
| Tenant | `owner` | Tenant owner and billing authority. |
| Tenant | `admin` | Manages members, campaigns, products, and affiliate settings. |
| Tenant | `staff` | Handles daily operations and customer service. |
| Tenant | `finance` | Views billing, settlements, commissions, and exports. |
| Tenant | `marketer` | Promotes with referral links and cards. |
| Tenant | `member` | General member or customer. |

## Plans

| Feature | Free | Pro | Enterprise |
| --- | --- | --- | --- |
| Tenant type | Personal or small shop | Shop/company | Company/org/custom |
| LINE Login | Yes | Yes | Yes |
| Referral code | Yes | Yes | Yes |
| Affiliate depth | 1 level | Multi-level | Custom |
| Release policy | Fixed 6 months | Fixed 6 months | Custom: 3/6/12/24 months or never |
| Roles | Basic | Full standard roles | Custom permissions |
| API/Webhook | Limited | Standard | Custom |
| Reports | Basic | Full | Custom/export/API |

## Member Number Rule

Public member numbers must not expose the platform UID.

```text
member_no = store_code + "-M" + HMAC_BASE36(tenant_id + ":" + user_id, MEMBER_NO_SECRET)
```

Example:

```text
A001-M8F29QX
B778-M3KP91A
```

The same LINE user receives different member numbers in different tenants.

## Affiliate Attribution Rule

1. First referral scan inside a tenant owns the member.
2. A tenant member can have only one active direct referrer at a time.
3. Later scans do not change attribution while the member is active.
4. If the member has no effective activity for the release period, attribution becomes releasable.
5. After release, the next referral scan can create a new attribution.
6. Reassignment affects future orders and commissions only.
7. All releases and reassignments must be recorded.

Effective activity includes tenant login, member center access, card/referral page access, form submission, order creation, payment, coupon usage, point changes, and event signup.

Receiving push messages or admin-only views does not count as member activity.

## Object Collections

Wasabi is used as the object database for the first system version.

```text
tenants/{tenant_id}.json
tenant-index/store-codes/{store_code}.json
users/{user_id}.json
tenant-members/{tenant_id}/{tenant_member_id}.json
referral-codes/{tenant_id}/{referral_code}.json
affiliate-assignments/{tenant_id}/{tenant_member_id}.json
affiliate-assignment-history/{tenant_id}/{tenant_member_id}/{event_id}.json
activity/{tenant_id}/{yyyy}/{mm}/{tenant_member_id}/{event_id}.json
audit/{tenant_id}/{yyyy}/{mm}/{event_id}.json
```

## First Login Flow

```text
LINE Login idToken
-> verify with LINE OAuth verify endpoint
-> resolve tenant by tenantId or storeCode
-> derive platform user_id from LINE sub
-> derive tenant_member_id from tenant_id + user_id
-> create member_no from store_code + tenant scoped HMAC
-> create member referralCode
-> record line_login activity
-> apply first-scan or release/reassign attribution rules
```

Raw `lineUserId` is stored only in the platform user object and is not returned to tenant-facing responses.

When transactional accounting becomes high volume, commission ledger and payments should be moved to D1 or another transactional database while keeping files and exports in Wasabi.
