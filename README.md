# Pressed Floral Scorecards

Next.js app for managing Pressed Floral scorecard goals, actuals, Rippling employee imports, and submitted bonus scorecards.

## Local Setup

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Production mode requires:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SCORECARDS_DATA_MODE=supabase`

For local fixture-mode testing without Supabase credentials:

```sh
NEXT_PUBLIC_SCORECARDS_DATA_MODE=fixture npm run dev
```

## Supabase

The deployment database is the `scorecards-app` Supabase project. Apply migrations with the Supabase CLI after logging in:

```sh
npx supabase link --project-ref mwwqeakjxmpticvbpinc
npx supabase db push
```

The deploy-readiness migration:

- Allows `admin`, `manager`, and `user` profile roles.
- Adds a unique employee/month constraint for scorecards.
- Restricts table reads/writes to authenticated users through RLS.
- Cleans known bad period data only when guard checks pass.

## Verification

Run these before deploying:

```sh
npm test
npm run build
npm run test:parity
npx supabase db advisors --linked
```

For Vercel, set the production env vars above and use the default Next.js build command:

```sh
npm run build
```
