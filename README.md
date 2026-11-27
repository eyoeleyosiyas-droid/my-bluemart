# BlueMart

An online marketplace built with Flask and PostgreSQL. Sellers list products, buyers search and
pay through Stripe Checkout, and every order is tracked from payment to delivery.

## Features

- Accounts with e-mail verification, Google sign-in, password reset by e-mail code, login lockout
- Product listings with a description and several photos; the same product can be sold by more than one seller
- Search, category and price filters, sorting and pagination, all done by the server
- A page for every product (`/product/<id>`) with a link preview, plus `sitemap.xml` and `robots.txt`
- Cart, stock reservation while paying, Stripe Checkout, refunds for late or failed payments
- Order tracking, shipments, buyer/seller messages, seller ratings and reviews
- Disputes, automatic confirmation of delivered orders, and an admin page (disputes, listing reports, seller verification)

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in the values, then load them into your shell
export FLASK_ENV=development
python app.py
```

The tables are created on start-up. `GET /healthz` returns 200 when the database is reachable.

## Deploy

`Procfile` runs `gunicorn app:app`. Set the variables from `.env.example` in your host's dashboard.
Two settings matter in production:

- `TRUST_PROXY=1` when you are behind a proxy (Render, nginx, ...). Without it every visitor looks like the same IP and the rate limits block everyone together.
- `RATELIMIT_STORAGE_URI=redis://...` so all workers share one set of rate-limit counters. Without it each worker counts on its own.

The app logs a warning at start-up when either is missing.

Add the Stripe webhook `https://your-domain/api/stripe/webhook` (events `checkout.session.completed`
and `checkout.session.expired`) and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.

## Admin

Put the usernames of your admins in `ADMIN_USERNAMES` (comma separated). They get an **Admin** tab:

- **Disputes**: *Refund buyer* refunds the whole order through Stripe and cancels the held payouts.
  *Release to seller* treats the order as received and releases the payouts.
  Stripe takes one payment per order, so on an order with several sellers a refund returns the full amount.
- **Reports**: buyers can report a listing. Dismiss the report or hide the listing (the seller is told).
- **Sellers**: grant or remove the *Verified* badge. It is only ever given by an admin.

## Money and payouts

- Prices are stored as `NUMERIC(10,2)` and handled as `Decimal`. The allowed range is `MIN_PRICE`..`MAX_PRICE`.
- `CURRENCY` is a Stripe currency code (default `usd`). Check that Stripe supports your currency and your country before going live.
- Payouts are a **ledger**: the app records what each seller is owed and when it is released, but it does not transfer money to sellers. Pay sellers from that ledger, or add Stripe Connect or a local payout provider.
- If a buyer never confirms delivery, the order is confirmed automatically `AUTO_CONFIRM_DAYS` days after the last shipment was delivered (set `0` to turn this off).

## Database changes

`init_db()` runs when the app starts, under a database lock so several workers can start together.
It keeps the original `CREATE TABLE IF NOT EXISTS` statements as a baseline. Anything new goes into
the `MIGRATIONS` list in `app.py` as a new `("000N_name", [sql, ...])` entry. Each entry runs once and is
recorded in the `schema_migrations` table.

## Project layout

```
app.py              the Flask app: routes, database, payments, e-mail
templates/          index.html (the single-page shop), legal.html (policies)
static/             app.js, style.css, theme.js, legal.js, images
Procfile            gunicorn command
.env.example        every setting the app reads
```

All JavaScript lives in `static/`, so the Content-Security-Policy does not allow inline scripts.
