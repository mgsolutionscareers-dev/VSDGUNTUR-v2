> **Status:** Phase 1 complete – Node + **Postgres** backend (`server/`).
> The SQLite data layer has been migrated to Supabase Postgres using the `pg` package.
> This document describes the further evolution to a full Next.js / Razorpay stack.

# Backend plan (phase 2)

**Stack:** Next.js 14 + TypeScript, PostgreSQL (Neon/Supabase), Prisma, Razorpay, Cloudinary, deploy on Vercel.

## Data model (Prisma)
User(role: ADMIN|CUSTOMER) · Address · Category · Product · ProductImage · ProductVariant(sku, weight, mrp, price, stock, lowStockLimit) ·
Combo · ComboItem(variantId, qty) · Cart/CartItem · Wishlist · Order · OrderItem · Payment · Coupon · Review · Banner · InventoryTransaction · Setting.
Order: orderNo `VSD-YYYY-000001`, status, paymentStatus, trackingNumber, totals, gst fields.

## Mapping from current backend
| Current (`server/index.js`) | Production |
|---|---|
| `doc` table (catalog JSONB blob) | normalised Postgres tables + `prisma/seed.ts` |
| `SELECT … FOR UPDATE` stock deduction | Prisma transactions with row locks (no overselling) |
| scrypt password, HTTP-only session cookie | hashed passwords, JWT or next-auth |
| image upload to `data/uploads/` | Cloudinary upload, store URL |
| `npm run export` CSV | server-side export (SheetJS) |

## Phases
1. Auth, schema, admin shell · 2. Catalogue, variants, inventory · 3. Storefront + cart · 4. Checkout, orders, Razorpay (webhook-verified) ·
5. Analytics, reports, exports, invoices · 6. CMS (banners, policies, settings), SEO · 7. Security review, tests, deploy.

## Security checklist
Zod validation on every API · never trust client prices (recompute server-side) · verify Razorpay signatures · admin routes protected in middleware and API · secrets only in env vars.
