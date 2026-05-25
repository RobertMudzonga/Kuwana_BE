# Sosa Connect — Backend API

Production-ready, dockerised RESTful backend for the **Sosa Connect** platform — a Zimbabwean marketplace and emergency services application.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework | Express.js + TypeScript |
| Database | PostgreSQL 16 + PostGIS |
| ORM / Migrations | Prisma |
| Auth | JWT (access + refresh tokens) |
| Payments | Stripe (+ Paynow stub) |
| File Storage | MinIO (S3-compatible) |
| Logging | Winston + Morgan |
| Validation | Zod |
| Containerisation | Docker + docker-compose |
| Testing | Jest + Supertest |

---

## Quick Start

### Prerequisites
- Docker + Docker Compose
- Node.js 20+ (for local dev)

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env — set JWT secrets, Stripe key, etc.
```

Minimum required for dev:
```
JWT_ACCESS_SECRET=at-least-32-random-characters-here
JWT_REFRESH_SECRET=another-32-random-chars-different
STRIPE_SECRET_KEY=sk_test_...   # optional — skip for non-payment testing
```

### 2. Start with Docker Compose

```bash
# Production-like stack (API + Postgres + MinIO)
docker-compose up --build

# Development stack (includes Adminer DB UI on port 8080)
docker-compose --profile dev up --build
```

The API will be available at **http://localhost:3000**.

### 3. Seed the database

```bash
docker-compose exec api sh -c "node -e \"require('./dist/main')\""
# Or from your host (requires DATABASE_URL pointing to running Postgres):
npm run db:seed
```

---

## Local Development (without Docker)

```bash
npm install
npm run db:generate       # generate Prisma client
npm run db:migrate:dev    # run migrations
npm run db:seed           # seed sample data
npm run dev               # start dev server with hot-reload
```

---

## API Reference

Interactive docs available at: **http://localhost:3000/api/v1/docs**

### Base URL
```
http://localhost:3000/api/v1
```

### Authentication
All protected routes require:
```
Authorization: Bearer <access_token>
```

Refresh tokens are stored in an `httpOnly` cookie (`sosa_refresh_token`) **and** returned in the response body for mobile clients.

### Endpoints Overview

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | Public | Register user or provider |
| `POST` | `/auth/login` | Public | Login |
| `POST` | `/auth/refresh` | Public | Rotate refresh token |
| `POST` | `/auth/logout` | Auth | Revoke refresh token |
| `GET` | `/users/me` | Auth | Own profile |
| `PUT` | `/users/me` | Auth | Update profile + location |
| `GET` | `/providers/nearby` | Public | Geospatial provider search |
| `POST` | `/providers/onboard` | Auth | Provider self-onboarding |
| `GET` | `/providers/me` | Provider | Own provider record |
| `GET` | `/providers/:id` | Public | Provider profile + services |
| `GET` | `/services` | Public | Browse service listings |
| `POST` | `/services` | Provider | Create service listing |
| `PUT` | `/services/:id` | Provider | Update own listing |
| `DELETE` | `/services/:id` | Provider | Deactivate listing |
| `POST` | `/orders` | Auth | Place an order |
| `GET` | `/orders` | Auth | List own orders |
| `PATCH` | `/orders/:id/status` | Auth | Update order status |
| `POST` | `/payments/initiate` | Auth | Initiate payment (Stripe) |
| `POST` | `/payments/webhook` | Public | Stripe/Paynow webhook |
| `GET` | `/payments` | Auth | Transaction history |
| `GET` | `/emergency` | Public | Emergency contacts |
| `GET` | `/admin/dashboard` | Admin | Dashboard stats |
| `GET` | `/admin/users` | Admin | Manage users |
| `PATCH` | `/admin/users/:id/status` | Admin | Suspend/activate user |
| `GET` | `/admin/providers` | Admin | Manage providers |
| `PATCH` | `/admin/providers/:id/approval` | Admin | Approve/reject provider |
| `GET` | `/admin/audit-logs` | Admin | Audit trail |
| `GET` | `/admin/payments` | Admin | All transactions |

---

## Seed Credentials

After running `npm run db:seed`:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@sosaconnect.zw` | `Admin@Sosa2024!` |
| Provider | `emmanuel.k@example.zw` | `Provider@1234!` |
| User | `amara.moyo@example.zw` | `User@1234!` |

---

## Payment Gateways

The system uses a **gateway abstraction layer** (`IPaymentGateway`). Switch gateways via env:

```env
ACTIVE_PAYMENT_GATEWAY=stripe   # or: paynow
```

| Gateway | Status | Notes |
|---|---|---|
| **Stripe** | ✅ Full | Requires `STRIPE_SECRET_KEY` |
| **Paynow** | 🟡 Stub | Ready for integration — see `paynow.gateway.ts` |

### Stripe Webhook (local testing)
```bash
stripe listen --forward-to http://localhost:3000/api/v1/payments/webhook
```

---

## Architecture

```
src/
├── config/          # Env validation (Zod), constants
├── lib/             # Prisma client, logger, response helpers, geo utils
├── middleware/       # Auth (JWT), RBAC, error handler, validation, audit log
├── modules/
│   ├── auth/        # Register, login, refresh, logout
│   ├── users/       # Profile management
│   ├── providers/   # Onboarding, geospatial search, approval
│   ├── services/    # Service listings (products/services for sale)
│   ├── orders/      # Order lifecycle
│   ├── payments/    # Gateway abstraction + Stripe + Paynow stub
│   ├── emergency/   # Emergency contacts (ZW)
│   └── admin/       # Dashboard, audit logs, moderation
├── app.ts           # Express factory
└── main.ts          # Bootstrap, graceful shutdown
```

Each module: `schema.ts` → `repository.ts` → `service.ts` → `controller.ts` → `routes.ts`

---

## Running Tests

```bash
npm test
npm run test:coverage
```

Tests require a running PostgreSQL instance (uses `DATABASE_URL` from `.env`).

---

## Docker Architecture

```yaml
services:
  api:       # Node.js 20-alpine (multi-stage build, non-root user)
  postgres:  # postgis/postgis:16-3.4-alpine
  minio:     # Object storage (S3-compatible)
  adminer:   # DB UI — only with --profile dev
```

### Services & Ports

| Service | Port | URL |
|---|---|---|
| API | 3000 | http://localhost:3000 |
| PostgreSQL | 5432 | — |
| MinIO API | 9000 | — |
| MinIO Console | 9001 | http://localhost:9001 |
| Adminer (dev) | 8080 | http://localhost:8080 |
| Swagger Docs | 3000 | http://localhost:3000/api/v1/docs |

---

## Security Highlights

- JWT access tokens (15 min) + rotating refresh tokens (7 days, revokable)
- `httpOnly` cookie for refresh token storage
- Helmet.js security headers
- Rate limiting: 100 req/15min global, 10 req/15min on auth routes
- Zod input validation on all request bodies and queries
- No card data stored — Stripe handles PCI compliance
- Audit log on all admin and state-changing actions
- Multi-stage Docker build — dev deps excluded from production image
- Non-root container user (`sosa:nodejs`)
- PostGIS geospatial indexing for `providers.geom` column

---

## Environment Variables

See `.env.example` for the full reference. Key variables:

```env
DATABASE_URL=postgresql://...
JWT_ACCESS_SECRET=<32+ chars>
JWT_REFRESH_SECRET=<32+ chars, different>
STRIPE_SECRET_KEY=sk_test_...
ACTIVE_PAYMENT_GATEWAY=stripe
```
