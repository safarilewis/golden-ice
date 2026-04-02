# GoldenIce Backend

This service sits between the Expo app and Supabase for application data and loyalty mutations.

Supabase still owns:
- authentication
- storage buckets
- database tables and RPCs

This backend owns:
- app bootstrap payloads
- account setup/profile creation
- profile updates
- points-award orchestration
- receipt verification and fraud-side hooks

## Why this exists

The mobile app was making too many direct table requests. This backend turns those into a smaller set of app-focused endpoints so we can deploy on Railway or Render and keep the client thinner.

## Runtime

- Node.js 18+
- no runtime dependencies

## Environment variables

Set these in Railway, Render, or your local shell:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
PORT=8787
HOST=0.0.0.0
ALLOWED_ORIGINS=*
```

`ALLOWED_ORIGINS` can be a comma-separated list.

## Scripts

```bash
npm run dev
npm start
```

## Endpoints

- `GET /health`
- `GET /profile`
- `POST /account/setup`
- `GET /app/bootstrap?scope=chooser|customer|staff|owner`
- `PATCH /profiles/me`
- `POST /receipt/verify`
- `POST /points/award`
- `POST /fraud/evaluate`
- `POST /digest/nightly`

All authenticated endpoints expect:

```http
Authorization: Bearer <supabase_access_token>
```

## Deploying to Railway or Render

### Railway

1. Create a new service from the `backend` directory.
2. Set the environment variables above.
3. Use:
   - Build command: `npm install`
   - Start command: `npm start`

### Render

1. Create a new Web Service pointed at the `backend` directory.
2. Set:
   - Build command: `npm install`
   - Start command: `npm start`
3. Add the environment variables above.

## App configuration

In the Expo app, add:

```bash
EXPO_PUBLIC_BACKEND_URL=https://your-backend-domain.com
```

The app will keep using Supabase directly for auth and receipt storage uploads, but database reads and writes now go through this backend service.
