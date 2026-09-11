# Frely Network — landing (`apps/site`)

Static Astro showcase. Interaction:

1. **Splash** — full-viewport Spline + corner brand. One visual **Click Me** (from the scene); the page uses an invisible hit layer so Reveal still works across the iframe.
2. **Reveal** (same page) — product copy focus; Spline fades out; How it works below

On narrow screens the iframe is skipped (poster only), so the page shows its own Click Me pill.

No return to splash. No evidence console on this branch.

## Spline

Default Public URL (iframe):

`https://my.spline.design/aidatamodelinteraction-yXFK4f6oAzDsrDztvyJ1dXk4/`

Optional `apps/site/.env`:

```bash
PUBLIC_SPLINE_PUBLIC=https://my.spline.design/your-scene/
PUBLIC_SPLINE_SCENE=https://prod.spline.design/YOUR_ID/scene.splinecode
```

Mobile uses the community poster fallback instead of the heavy iframe.

## Scripts

```bash
cd apps/site
npm install
npm run dev      # http://localhost:3010
npm run build
npm run preview
```
