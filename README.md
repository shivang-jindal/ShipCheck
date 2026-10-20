# ShipCheck

> **Shipment Tracking & Exception Management — Carrier-Agnostic**

[![CI](https://github.com/shivang-jindal/ShipCheck/actions/workflows/ci.yml/badge.svg)](https://github.com/shivang-jindal/ShipCheck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-4-lightgrey)](https://expressjs.com/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-brightgreen)](https://orm.drizzle.team/)

---

## Features

- **Carrier-Agnostic**: REST adapter + webhook ingest — no carrier lock-in
- **Tracking**: Manual entry + CSV import, public tracking pages
- **Exceptions**: Delay/delivery/loss detection with severity & SLAs
- **Webhooks**: HMAC-verified ingest from carriers
- **Imports**: CSV/JSON bulk import with deduplication
- **Public Pages**: Branded tracking pages for customers
- **Configurable**: Webhook signatures, notification channels, retention

---

## Quick Start

```bash
git clone https://github.com/shivang-jindal/ShipCheck.git
cd ShipCheck
npm install
npm run dev
```

Configure `.env` (copy `.env.example`):
```env
DATABASE_URL="postgresql://..."  # or omit for PGlite
ENCRYPTION_KEY="64-char-hex-key"
SESSION_SECRET="random-string"
EMAIL_PROVIDER="smtp|disabled|log"
```

---

## Architecture

```
ShipCheck/
├── client/          # React 18 + Vite 6 + Tailwind v4
├── server/          # Express 4 + Drizzle ORM + PGlite
├── shared/          # Shared types, Zod schemas, constants
└── scripts/         # Dev, migration, verification
```

**Stack**: React 18 · Vite 6 · TypeScript · Tailwind v4 · React Router · TanStack Query  
**Backend**: Express 4 · Zod · Drizzle ORM · PGlite (embedded PostgreSQL)  
**Auth**: Argon2id · opaque 256-bit tokens · HTTP-only cookies  
**Jobs**: DB-backed queue (`FOR UPDATE SKIP LOCKED`) · separate worker

---

## Configuration

All settings via environment variables (see `.env.example`):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | No | PostgreSQL URL (omit for PGlite) |
| `ENCRYPTION_KEY` | Yes | 64-char hex (32 bytes) |
| `SESSION_SECRET` | Yes | Random string |
| `EMAIL_PROVIDER` | Yes | `smtp` \| `disabled` \| `log` |

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev servers (client + server) |
| `npm run build` | Production build |
| `npm run verify` | Typecheck + Lint + Test + Build |
| `npm test` | Unit/integration tests (39 passing) |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:migrate` | Run migrations |

---

## Deployment

```bash
npm run build
# Deploy server/ + client/dist/ to your platform
```

Requires: Node 20+, PostgreSQL (or PGlite for embedded).

---

## License

MIT License - see [LICENSE](LICENSE)

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) • [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) • [SECURITY.md](SECURITY.md)