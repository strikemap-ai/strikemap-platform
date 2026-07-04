# Strikemap Platform

Backend for Strikemap.ai's Orbit pipeline automation. Receives trigger webhooks from Clay, generates personalised outreach assets via the Claude API, stores everything in Supabase (Postgres), and notifies the AE by email via Resend.

This repository currently implements **Phase 1**: the webhook receiver, Claude integration, database writes, digest endpoint, digest email notification, and the admin overview endpoint. Phase 2 (AE dashboard, approve/reject, auth) and Phase 3 (LinkedIn/email/CRM execution) are not built yet.

## Tech stack

- Node.js 20+, ES modules
- Express 4
- PostgreSQL via Supabase (`@supabase/supabase-js`)
- Anthropic Claude API (`@anthropic-ai/sdk`), model `claude-sonnet-4-6`
- Resend for transactional email

## Prerequisites

- Node.js 20 or newer
- A `.env` file in the project root (see below) — this is never committed

## Environment variables

Create a `.env` file in the project root with the following keys. Values are not documented here — see your Anthropic, Supabase, and Resend account dashboards.

```
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
WEBHOOK_SECRET=
PORT=
NODE_ENV=
```

`SUPABASE_SERVICE_KEY` is the new-format Supabase secret key (`sb_secret_...`). It bypasses Row Level Security, which is enabled with no policies on all tables — all data access must go through this backend, never directly from a frontend with the publishable key.

`WEBHOOK_SECRET` is the single shared secret used to validate the Clay trigger webhook (`POST /api/trigger`).

## Database

All seven tables (`clients`, `system_prompts`, `competitors`, `accounts`, `assets`, `user_roles`, `outreach_log`) already exist in Supabase with RLS enabled. This project never runs `CREATE TABLE` statements — the schema is managed directly in Supabase.

## Install and run

```bash
npm install
npm start        # node src/index.js
# or, for auto-restart on file changes:
npm run dev
```

The server listens on `PORT` from `.env` (defaults to 3000 if unset).

## Endpoints (Phase 1)

### `GET /health`
Returns `200 { status: "ok" }`. Used as the Railway health check.

### `POST /api/trigger`
Receives a Clay trigger webhook. Validates `WEBHOOK_SECRET`, loads the client, saves the account, calls Claude to generate a full outreach package (account brief, cold call script, LinkedIn request/DM, 3-step email sequence), saves the assets with `sequence_status = 'pending_ae_review'`, and emails a digest notification to the client's AE via Resend.

Returns `400` if the client has no system prompt with `status = 'approved'`.

```bash
curl -X POST http://localhost:3000/api/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "token": "<WEBHOOK_SECRET from your .env>",
    "client_id": "a0000000-0000-0000-0000-000000000001",
    "company_name": "Luminai",
    "company_linkedin": "https://linkedin.com/company/luminai",
    "company_website": "https://luminai.com",
    "company_headcount": "51",
    "funding_stage": "Series B",
    "total_funding": "$60M",
    "trigger_type": "AE Job Posting",
    "trigger_score": 10,
    "primary_first_name": "Uriel",
    "primary_last_name": "Knorovich",
    "primary_email": "uriel@luminai.com",
    "primary_linkedin": "https://linkedin.com/in/urielknorovich",
    "primary_direct_dial": "",
    "primary_title": "CEO and Co-founder",
    "additional_contacts": [],
    "context": "Uriel posted about GTM difficulty. Series B $38M closed April 2026."
  }'
```

### `GET /api/digest/:clientId`
Returns all `pending_ae_review` assets for a client, sorted by `trigger_score` descending. This is the exact shape the Phase 2 React dashboard will consume.

```bash
curl http://localhost:3000/api/digest/a0000000-0000-0000-0000-000000000001
```

### `GET /api/admin/overview`
Admin-only. Returns all clients with pipeline counts, plus all pending system prompts and competitors awaiting approval across every client.

Requires an `Authorization: Bearer <token>` header. Phase 1 has no login flow yet (that's a Phase 2 deliverable), so the bearer token's JWT payload is decoded to read the `sub` claim as the user ID — the signature is **not** verified. That user ID is checked against the `user_roles` table for `role = 'admin'`. Real Supabase Auth session verification will replace this in Phase 2.

```bash
curl http://localhost:3000/api/admin/overview \
  -H "Authorization: Bearer <supabase-jwt>"
```

Returns `403 { "error": "Admin access required" }` if the token is missing, invalid, or the user isn't an admin.

Note: no `user_roles` row exists yet — that seed is deferred until a real Supabase Auth user exists (Phase 2).

## Project structure

```
src/
├── index.js                    # Express app entry point
├── db/
│   └── client.js               # Supabase client
├── routes/
│   ├── health.js                # GET /health
│   ├── trigger.js               # POST /api/trigger
│   ├── digest.js                 # GET /api/digest/:clientId
│   └── admin.js                  # GET /api/admin/overview
├── services/
│   ├── promptEngine.js          # Loads approved system prompt, calls Claude, saves assets
│   └── notificationService.js   # Sends digest emails via Resend
└── middleware/
    ├── validateWebhook.js        # Validates the Clay webhook secret
    └── requireAdmin.js           # Checks user_roles for role = 'admin'
```

## What's deferred to later phases

- React AE dashboard, Supabase Auth login (Phase 2)
- Approve/reject endpoints and any outreach execution (Phase 2 status-only, Phase 3 execution)
- Async job queue and rate limiting on `/api/trigger` (Phase 2 must-do, before a second client is onboarded)
- ConnectSafely, Instantly, and HubSpot integrations (Phase 3)
- Reply webhooks and the Zapier LinkedIn-reply-to-Instantly-pause bridge (Phase 3)
