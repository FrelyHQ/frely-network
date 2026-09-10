# @frely-network/site (Astro)

Static Frely Network landing page for ETHOnline (Web3 surface).

Replaces the Next.js experiment on `ui/site` with **Astro** per team preference. Visual narrative matches that branch: logo, hero, Discover → Verify → Pay → Execute, GitHub CTA.

Not the Web2 commercial site (`frely.cloud`).

## Pages

| Path | Role |
|---|---|
| `/` | Product introduction (not P0 payment proof) |
| `/evidence` | Issue #17 read-only evidence console shell (API-010). Stages stay `not_provided` until B publishes a projection. **Does not invent success.** |

## Run

```bash
cd apps/site
npm install
npm run dev
```

Open http://localhost:3010

## Preset

Design tokens follow merged shadcn preset **`b1aIuQ2WA`** (Gould `b1aIuQ2XC` + medium radius). See [PRESET.md](./PRESET.md).
