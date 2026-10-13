# VSD – Venkata Sai Dry Fruits

Online store + admin panel + backend for **Venkata Sai Dry Fruits** (wholesale & retail, Patnam Bazar, Guntur).

Customers browse, choose a weight, check out and the order opens in WhatsApp with address and details.
The owner manages everything from `/#/admin`. Orders, stock, banners, settings and photos are stored on the **server** (not in the browser).

## Run it (needs Node.js 22.5 or newer and a Postgres database)
Copy `.env.example` to `.env`, set `DATABASE_URL` and your admin password, then:
```bash
npm install
npm start
# open http://localhost:3000        admin: http://localhost:3000/#/admin
npm test                           # 18 API checks against a clean Postgres schema
npm run export                     # orders/products as CSV for Excel
npm run migrate                    # one-time: copy existing SQLite data to Postgres
```
Or set the password in the terminal:
```
Mac/Linux:   ADMIN_PASSWORD="my-password" npm start
PowerShell:  $env:ADMIN_PASSWORD="my-password"; npm start
cmd.exe:     set "ADMIN_PASSWORD=my-password"&& npm start      <- quotes + no space before && (otherwise a hidden space ends up in the password)
```
The server prints one line on start, e.g. `Admin sign-in -> username "admin", password loaded from ADMIN_PASSWORD (11 characters)`.
If the character count is not what you typed, the shell changed it (characters like `& ! ^ %` are risky in a terminal) – use the `.env` file instead.
Without any password setting the server uses `admin123` and says so – **never go live like that.** The username is not case-sensitive.

## Environment variables
| Name | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string (required) | – |
| `ADMIN_PASSWORD` | admin password (spaces at the ends are ignored) | `admin123` (dev only) |
| `ADMIN_USER` | admin username | `admin` |
| `PORT` | port | `3000` |
| `DATA_DIR` | where uploaded photos are kept | `./data` |
| `NODE_ENV=production` | marks the login cookie `Secure` (use behind HTTPS) | – |
| `TRUST_PROXY=1` | read the client IP from `X-Forwarded-For` (behind a proxy, for rate limits) | – |
| `TEST_DATABASE_URL` | separate Postgres DB for `npm test` (falls back to `DATABASE_URL`) | – |

## Structure
```
index.html, css/, js/, assets/   the website (plain HTML/CSS/JS, no build step)
server/index.js                  API + static file server (requires `pg` package)
server/seed.json                 starting catalogue, loaded into an empty database (sample data!)
server/test.js                   API tests (runs against Postgres)
server/migrate-sqlite-to-pg.js   one-time migration from the old SQLite database
data/                            uploads/ folder for product photos (git-ignored – BACK THIS UP)
docs/CLIENT_SETUP_GUIDE.md       hosting, backups, troubleshooting (give this to the client)
deploy/                          Linux service, nginx and settings templates
docs/BACKEND_PLAN.md             further evolution notes
```

## What the server guarantees
- Prices, shipping and totals are **recalculated on the server**; the browser cannot change them.
- Stock is reduced inside one Postgres transaction per order with `SELECT … FOR UPDATE` on the catalog row → **no overselling**; combos reduce their component stock; cancelling restores it.
- Admin API needs a login session (HTTP-only cookie, 8 h); login is rate-limited; admin password is compared with scrypt hashing.
- Customers see only *In stock / Only a few left / Out of stock*; the public API caps stock numbers at 50.
- Customer text is stripped of `< > " ' \`` characters; uploads are checked (JPG/PNG/WebP only).

## Hosting
Needs a host that runs Node and has access to a **Postgres database** (Supabase, Neon, Railway Postgres, Render Postgres, or any managed Postgres).
Set `DATABASE_URL`, `ADMIN_PASSWORD`, `NODE_ENV=production` and put it behind HTTPS.
No persistent disk is required for the database — only for the `uploads/` photo folder (or use Cloudinary).

## Known limits (be honest with the client)
- One server instance (in-memory admin sessions; restarting logs the admin out).
- One admin account (from environment variables). No customer accounts: customers find orders by order number + phone.
- Orders are confirmed over WhatsApp; there is **no online payment** yet (Razorpay is the next step).
- Catalogue edits are saved as one document (last save wins if two admins edit at once).
- `server/seed.json` holds **placeholder** prices and stock – replace them in Admin before launch.
- Back up Postgres regularly (Supabase and Render do this automatically).

## Admin
Dashboard & analytics · Orders (status, payment, India Post tracking, invoice, Excel export) · Products & combos · Inventory with log · Theme (4 colours) · Banners · Settings (shipping, WhatsApp number, scrolling text).

## Business details
GSTIN 37BRLPK9740E1ZG · D.No. 23-6-15, Opp. Axis Bank, Patnam Bazar, Guntur 522003, A.P. · 88853 55666

## Branding files
`assets/images/logo.webp` (header, footer, admin) · `assets/images/watermark.webp` (faint watermark on every page – strength is the `opacity` in `css/styles.css`, `body::before`) · `assets/images/favicon.png` (browser tab). Replace the files (keep the names) to rebrand. Use PNG/WebP with a transparent background.
