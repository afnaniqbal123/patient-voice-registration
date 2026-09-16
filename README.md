# Patient Registration Voice AI Agent

A phone-callable AI agent that conversationally registers new patients,
persists their demographic data, and exposes it through a REST API and a
small read-only dashboard. Built for the CareCloud take-home assessment.

**Repository:** https://github.com/afnaniqbal123/patient-voice-registration
**Phone number:** _fill in after running `scripts/setup-vapi.sh` — see [Vapi setup](#9-provision-the-voice-agent-vapi)_
**API base URL:** _fill in after deploying — see [Deployment](#8-deploy-free-render--mongodb-atlas)_
**Dashboard:** `<API base URL>/dashboard/`

---

## 1. Architecture

```
                    ┌─────────────────────┐
   PSTN call  ─────▶│   Vapi (telephony,  │
                    │   STT/TTS, Gemini    │
                    │   LLM orchestration)  │
                    └──────────┬───────────┘
                               │  HTTPS webhook (function calls +
                               │  end-of-call report), shared-secret auth
                               ▼
                    ┌─────────────────────────────────────────┐
                    │   NestJS API  (Render)                    │
                    │                                           │
                    │   VapiController  ──▶  VapiService        │
                    │        (tool-call adapter)     │          │
                    │                                 ▼          │
                    │   PatientsController ──▶ PatientsService   │
                    │        (public REST API)                  │
                    │                                 │          │
                    │   CallLogsController            │          │
                    │        (transcript read API)     │          │
                    │                                 ▼          │
                    └─────────────────────────── MongoDB ────────┘
                               ▲
                               │  fetch()
                    ┌──────────┴───────────┐
                    │  /dashboard (static)   │
                    │  vanilla HTML/JS view  │
                    └────────────────────────┘
```

**Why this shape:** the voice agent and the REST API are two different
*callers* of the same `PatientsService` — never two different sources of
truth. `VapiService` re-validates every field through the exact same
`CreatePatientDto`/`UpdatePatientDto` class-validator pipeline the public
API uses, so the LLM is never trusted to have already sanitized anything
(per the spec's "do not rely solely on the voice agent for validation").

### Separation of concerns

| Layer | Responsibility | Where |
|---|---|---|
| Telephony + STT/TTS + LLM orchestration | Vapi (hosted) | Vapi dashboard/API, not in this repo |
| Conversation design | The system prompt | [`prompts/system-prompt.md`](prompts/system-prompt.md) |
| Tool-call adapter | Translates Vapi's function-call JSON into service calls | [`src/vapi/`](src/vapi) |
| Data validation + business rules | class-validator DTOs, service layer | [`src/patients/`](src/patients) |
| Persistence | Mongoose schema/DB | [`src/patients/patient.schema.ts`](src/patients/patient.schema.ts) |
| Public REST API | HTTP surface for the spec's 5 endpoints | [`src/patients/patients.controller.ts`](src/patients/patients.controller.ts) |
| Observability | stdout logs + call transcript storage | [`src/call-logs/`](src/call-logs), Nest `Logger` calls throughout |
| Dashboard | Read-only patient list UI | [`dashboard/index.html`](dashboard/index.html), served at `/dashboard` |

## 2. Tech stack & why

| Choice | Reasoning |
|---|---|
| **NestJS + TypeScript** | Requested stack; DI + decorators give a clean module boundary between the REST API and the Vapi webhook adapter without extra ceremony, and `class-validator` DTOs double as the API's server-side validation layer. |
| **MongoDB (Mongoose)** | Requested stack; the patient record is a single flat document with a few optional fields — no joins needed, so a document model avoids migration ceremony while still enforcing schema/types via Mongoose. |
| **Vapi** | Provides telephony + STT/TTS + LLM orchestration + **free US phone numbers issued directly from their API/dashboard** — no separate Twilio account, no need to already own a US number. This was the deciding factor since the candidate does not have a US phone number. Also has first-class function-calling with a documented webhook contract. |
| **Google Gemini (`gemini-flash-latest`) as the LLM** | Candidate had a Gemini API key on hand. Wired via Vapi's `custom-llm` provider against Google's OpenAI-compatible endpoint rather than Vapi's native Google integration — see [section 9](#9-provision-the-voice-agent-vapi) for why. Flash tier keeps per-turn latency low, which matters more than raw reasoning depth for a slot-filling conversation. |
| **Render (app) + MongoDB Atlas (DB)** | Both have a real, permanent free tier requiring no credit card — Railway's trial expired mid-build. GitHub-integration deploys on Render, and Atlas's M0 tier is free forever. The trade-off (Render free tier's 15-min idle sleep) is mitigated with a free uptime pinger; see [Deployment](#8-deploy-free-render--mongodb-atlas). |

## 3. Data model

See [`src/patients/patient.schema.ts`](src/patients/patient.schema.ts) and
[`src/patients/dto/create-patient.dto.ts`](src/patients/dto/create-patient.dto.ts)
for the enforced schema/validators. Highlights:

- `patient_id` — server-generated UUID (`uuid`), not the Mongo `_id`, so the
  public API never leaks internal DB ids.
- `phone_number` / `emergency_contact_phone` — normalized to bare 10 digits
  on write (a `class-transformer` `@Transform` strips formatting before
  `@Matches(/^\d{10}$/)` runs), so "(202) 555-0100", "202-555-0100" and
  "2025550100" all validate and store identically — important since the
  voice agent will pass whatever the caller said.
- `date_of_birth` — stored as the spec's `MM/DD/YYYY` string (not a `Date`)
  to avoid timezone-shift bugs when a date-only value round-trips through
  JSON; a custom validator (`IsValidDateOfBirth`) rejects both
  calendar-invalid dates (`02/30/2020`) and future dates.
  See [`src/patients/validators/date-of-birth.validator.ts`](src/patients/validators/date-of-birth.validator.ts).
- `state` — validated against a hardcoded list of real USPS abbreviations
  ([`src/common/us-states.ts`](src/common/us-states.ts)), not just "2
  letters."
- `deleted_at` — soft delete; `DELETE /patients/:id` sets this instead of
  removing the document, and every read path filters `deleted_at: null`.
- Every response is wrapped `{ "data": ..., "error": null }` (or
  `{ "data": null, "error": {...} }`) by
  [`ResponseEnvelopeInterceptor`](src/common/response-envelope.interceptor.ts),
  scoped to the public REST controllers only — **not** the Vapi webhook,
  which must return Vapi's own `{ "results": [...] }` shape verbatim (this
  was caught during manual testing; an early version wrapped that response
  too and would have silently broken every tool call in production).

## 4. REST API

Base path: none (all routes are top-level). All bodies/responses are JSON.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/patients?last_name=&date_of_birth=&phone_number=` | Filters are ANDed; `last_name` is case-insensitive exact match. |
| `GET` | `/patients/:id` | `:id` is the `patient_id` UUID, not the Mongo `_id`. 404 if missing/soft-deleted. |
| `POST` | `/patients` | 201 on success, 422 with field-level messages on validation failure. |
| `PUT` | `/patients/:id` | Partial update — only send fields you want to change. |
| `DELETE` | `/patients/:id` | Soft delete (`deleted_at` set). Returns the updated record. |
| `GET` | `/health` | Liveness check. |
| `GET` | `/call-logs?patient_id=` | Bonus: recent call transcripts/summaries, optionally filtered by patient. |
| `POST` | `/vapi/webhook` | Internal — Vapi's tool-call + end-of-call-report webhook. Requires `x-vapi-secret` header matching `VAPI_SERVER_SECRET`. Not part of the public API surface. |

Example:

```bash
curl -X POST "$API_BASE_URL/patients" \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Jane", "last_name": "Doe",
    "date_of_birth": "05/14/1990", "sex": "Female",
    "phone_number": "202-555-0101",
    "address_line_1": "123 Main St", "city": "Springfield",
    "state": "IL", "zip_code": "62704"
  }'
```

## 5. Voice agent design

The full, commented system prompt lives in
[`prompts/system-prompt.md`](prompts/system-prompt.md) along with the
design rationale for each conversational decision (why fields are grouped
the way they are, why duplicate-detection happens right after the phone
number, why confirmation is a hard gate before saving, how corrections and
"start over" are handled, etc.) — read that file for the conversational
design writeup rather than duplicating it here.

The agent has four tools, all implemented in
[`src/vapi/vapi.service.ts`](src/vapi/vapi.service.ts) and dispatched
through [`src/vapi/vapi.controller.ts`](src/vapi/vapi.controller.ts):

1. `lookup_patient_by_phone` — duplicate detection.
2. `create_patient` — final save, only after verbal confirmation.
3. `update_patient` — partial update for a returning caller.
4. `propose_appointment` — bonus: mock next-business-day slot, no real
   scheduling backend.

## 6. Local development

```bash
npm install
cp .env.example .env          # then fill in MONGODB_URI at minimum

# requires a local MongoDB (brew services start mongodb-community, or
# docker run -p 27017:27017 mongo), or point MONGODB_URI at Atlas/Railway
npm run start:dev

npm run seed                  # inserts 2 demo patients (Jane Doe, Carlos Rivera)
npm test                      # unit tests
npm run test:e2e              # e2e tests against an in-memory MongoDB — no setup needed
```

Dashboard: http://localhost:3000/dashboard/

## 7. Environment variables

See [`.env.example`](.env.example) for the full list with comments. Summary:

| Variable | Required by | Purpose |
|---|---|---|
| `PORT` | app | HTTP port (Render sets this automatically). |
| `MONGODB_URI` | app | Mongo connection string. |
| `VAPI_SERVER_SECRET` | app + `scripts/setup-vapi.sh` | Shared secret validated on every `/vapi/webhook` call via the `x-vapi-secret` header. **Must match** between the deployed app and the Vapi assistant config. |
| `VAPI_API_KEY` | `scripts/setup-vapi.sh` only | Your Vapi private API key. Never sent to the app itself. |
| `GEMINI_API_KEY` | `scripts/setup-vapi.sh` only | Your Google AI Studio Gemini key. Never sent to the app itself — only used to create the `custom-llm` credential on Vapi (see section 9). |
| `PUBLIC_API_BASE_URL` | `scripts/setup-vapi.sh` only | Your deployed Render URL — becomes the tool-call webhook target. |

No API keys are hardcoded anywhere in the source; secrets only ever come
from environment variables.

## 8. Deploy (free): Render + MongoDB Atlas

Railway's free trial expired and reactivating it costs money, so this repo
deploys on a combo that's genuinely free with no credit card: **Render**
(free web service) for the app, **MongoDB Atlas M0** (free forever) for the
database. `railway.json` is still in the repo in case you'd rather pay for
Railway's $5/mo Hobby plan instead — same build/start commands apply there.

**Trade-off to know about:** Render's free tier spins a service down after
15 minutes with no inbound traffic, and the next request pays a ~30-60s
cold-start. Step 5 below sets up a free uptime pinger so the service never
actually goes to sleep before/during review.

### 8.1 Database — MongoDB Atlas (free, permanent)

1. Sign up at https://www.mongodb.com/cloud/atlas/register (no card
   required).
2. Create a free **M0** cluster (any region close to you).
3. **Database Access** → add a user with a password (save it).
4. **Network Access** → **Add IP Address** → **Allow Access From Anywhere**
   (`0.0.0.0/0`) — Render's free tier has no static IP, so this is required
   unless you're on a paid Render plan with a fixed egress IP.
5. **Database → Connect → Drivers** → copy the connection string, looks
   like `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/patient_registration?retryWrites=true&w=majority`.
   This full string is your `MONGODB_URI`.

### 8.2 App — Render

1. Go to https://dashboard.render.com → **New** → **Web Service** → connect
   your GitHub account → select `patient-voice-registration`.
2. Render reads [`render.yaml`](render.yaml) automatically (Blueprint) —
   confirm plan **Free**, build command `npm run build`, start command
   `npm run start:prod`. If it doesn't pick up the blueprint automatically,
   set those two commands manually and set the health check path to
   `/health`.
3. Under **Environment**, add:
   - `MONGODB_URI` → the Atlas connection string from step 8.1.
   - `VAPI_SERVER_SECRET` → any long random string, e.g. `openssl rand -hex 32`.
4. Deploy. Your **API base URL** is the `https://<name>.onrender.com` URL
   Render shows you.
5. **Keep it warm (free):** sign up at https://uptimerobot.com (or
   https://cron-job.org) and add a monitor that `GET`s
   `https://<name>.onrender.com/health` every 5-10 minutes. This is what
   keeps the phone agent responsive on an unpredictable incoming call
   instead of eating a cold-start on the first tool call of a demo call.
6. (Optional, once) seed demo data from your machine:
   `MONGODB_URI="<same Atlas string>" npm run seed`.

## 9. Provision the voice agent (Vapi)

Vapi's phone numbers and assistant config are fully scriptable via their
REST API — **no dashboard configuration needed at all.**

> **Why not Vapi's native "Google" model provider?** As of Sep 2026, Google
> routes newly-created Gemini API keys away from `gemini-2.5-flash`, but
> Vapi's dashboard "Add Google Credential" dialog validates any key with a
> hardcoded test call against exactly that model — so saving a fresh Gemini
> key there fails with `Couldn't Validate Google Credential`, unrelated to
> whether your key actually works. `scripts/setup-vapi.sh` routes around
> this entirely by wiring the assistant as a `custom-llm` pointed straight
> at [Google's OpenAI-compatible Gemini endpoint](https://ai.google.dev/gemini-api/docs/openai),
> using the `gemini-flash-latest` alias (Google hot-swaps this to their
> current recommended flash model, so it won't need revisiting the next
> time a dated model id gets deprecated). If you hit that dashboard error
> yourself, you can safely cancel out of it — this repo doesn't need it.

1. Sign up at https://dashboard.vapi.ai (free).
2. **Settings → API Keys** → copy your **Private Key** → this is
   `VAPI_API_KEY`.
3. From this repo, run:
   ```bash
   export VAPI_API_KEY=...
   export GEMINI_API_KEY=...              # your Google AI Studio Gemini key
   export PUBLIC_API_BASE_URL=https://<your-app>.onrender.com
   export VAPI_SERVER_SECRET=...   # the exact same value you set in Render's Environment tab
   ./scripts/setup-vapi.sh
   ```
   This creates a `custom-llm` credential from your Gemini key, the 4
   tools, the assistant (system prompt pulled straight from
   `prompts/system-prompt.md`, so the two never drift), and a free US phone
   number, then prints the number. It can take a couple of minutes to go
   live.
5. Call the printed number. That's your **phone number to call**.

If you ever edit `prompts/system-prompt.md`, re-run the script (it creates
fresh tools/assistant) or use the `PATCH` command it prints at the end to
update the existing assistant in place.

## 10. Security & observability

- No secrets in source; everything sensitive comes from env vars
  (`.env` is gitignored, `.env.example` has no real values).
- All patient input is validated server-side regardless of caller (voice
  agent or direct API client) — the LLM's own soft validation in the
  prompt is a UX nicety, not the security boundary.
- The Vapi webhook is gated by a shared secret header; a 401 short-circuits
  before any DB access.
- `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` strips/
  rejects unexpected fields on the public API (basic injection/pollution
  hardening).
- Every patient create/update/delete and every completed call (with
  summary + transcript) is logged via Nest's `Logger` to stdout — visible
  in Render's log viewer — satisfying the observability requirement.
  Full transcripts are additionally persisted to the `call_logs` collection
  (bonus) and readable via `GET /call-logs`.

## 11. Known limitations & trade-offs

- **No automatic retry/backoff on the Vapi→API webhook.** If the app is
  mid-deploy (or asleep past the uptime pinger's reach) when a call lands,
  that one tool call fails; the prompt tells
  the agent to apologize and retry once in-call, but there's no queue/DLQ.
  Acceptable for a 3-hour assessment; a production version would add a
  durable outbox.
- **Duplicate detection is phone-number-only,** not fuzzy name+DOB
  matching. A returning caller from a different number won't be recognized.
- **No HIPAA controls** — explicitly out of scope per the assessment FAQ;
  do not put real patient data in this system.
- **Vapi's free trial phone number is US-only and capped at 10 per
  account** — fine for this assessment, not a real allocation strategy.
- **Single Mongo instance, no replica set** (Atlas M0 is a 3-node replica
  set under the hood, but there's no sharding/read scaling story here) —
  acceptable for a take-home.
- **Render's free tier sleeps after 15 min idle** (~30-60s cold start on
  the next request). Mitigated with a free external uptime pinger (see
  deployment section) so it should stay warm through review, but a burst
  of calls after a long idle period could still see one slow first call.
- **Dashboard has no auth.** It's a read-only view behind an obscure path,
  fine for a reviewer demo, not for anything with real PHI.
- **Candidate had no US phone number to test with directly** — resolved by
  using Vapi, which issues its own number; verification was done by
  calling the provisioned number from a different phone.

## 12. Next steps (if given more time)

- Fuzzy duplicate matching on name + DOB in addition to phone number.
- Real appointment scheduling backend instead of the mocked slot.
- Automated conversational testing (scripted multi-turn transcripts against
  the Vapi test-call API) instead of only REST-layer e2e tests.
- Rate limiting on the public API.
- Structured JSON logging (pino) instead of Nest's default logger, for
  easier querying in a real log aggregator.

## 13. Project structure

```
src/
  app.module.ts
  main.ts
  common/            # response envelope, exception filter, US states list
  patients/           # schema, DTOs, service, controller (the public REST API)
  vapi/               # webhook controller + tool-call adapter service
  call-logs/          # transcript storage + read endpoint
  health/
  seed/               # seed script (2 demo patients)
dashboard/            # static HTML/JS patient list UI, served at /dashboard
prompts/
  system-prompt.md     # the voice agent's system prompt + design rationale
scripts/
  setup-vapi.sh        # provisions Vapi tools + assistant + phone number
test/
  patients.e2e-spec.ts # e2e tests against an in-memory MongoDB
```
