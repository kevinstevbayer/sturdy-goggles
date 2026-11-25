# 2027 Live Event Ops (Scoring, Timing & Dispatch)

Web PWA for 7 physical challenge stations, up to 30 teams of 3, and 10 volunteers (7 Station Hosts, 2 Hub Leads, 1 Floater).

## 1. Environment Setup

Create `.env.local` in the project root:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
```

## 2. Local Database & Edge Functions

```bash
pnpm install
npx supabase start
npx supabase db reset
npx supabase functions serve auth-session --no-verify-jwt
npx supabase functions serve finalize --no-verify-jwt
pnpm dev
```

Dev PINs from `supabase/seed.sql`:
- **Hub:** `999999`
- **Floater:** `888888`
- **Stations 1–7:** `100101` through `100707`

## 3. Running Tests

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
```

## 4. Production Deploy (Supabase + Vercel)

1. Push schema to hosted Supabase:
   ```bash
   supabase link --project-ref <PROJECT_REF>
   supabase db push
   supabase functions deploy auth-session --no-verify-jwt
   supabase functions deploy finalize --no-verify-jwt
   ```
2. Deploy Next.js app to Vercel with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Open **Hub → Roles**, regenerate all 9 credentials before event day, and print Team QR Cards from **Hub → Teams → Print cards**.

---

## One-Page Event-Day Checklist

- [ ] **Install PWA** on all 7 host phones, 1 floater phone, and Hub laptop/tablet (Add to Home Screen on iOS Safari / Android Chrome).
- [ ] **Grant Camera Permission** on every host phone and Hub device; test 1 QR scan + 1 manual team-number entry.
- [ ] **Power Banks & Cables** issued to every station host; screen brightness high for outdoor legibility.
- [ ] **2 Spare Charged Phones** at the Hub for fast swaps using **Hub → Roles → Takeover QR** (valid 2 min).
- [ ] **Station Number Signs** posted at Stations 1–7 showing ONLY station number and name (zero links, secrets, or PINs printed).
- [ ] **Roles Distributed Privately** at the volunteer briefing via Hub → Roles links/QRs/PINs.
- [ ] **Dry Run & Purge:** Run 1 practice attempt per station, then run **Hub → Export → Delete practice** with a reason.
- [ ] **Go Live:** Switch **Hub → Settings → Event state** to **LIVE** (locks out practice mode on all devices).
- [ ] **Closeout:** Confirm zero `Missing finish` alerts on Leaderboard, click **Hub → Export → Finalize snapshot**, and download the final CSV.
