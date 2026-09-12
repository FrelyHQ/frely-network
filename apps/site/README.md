# Frely Network — landing (`apps/site`)

Static Astro showcase. Interaction:

1. **Splash** — full-viewport Spline + transparent logo. Scene receives the click so its post-click animation can play.
2. **Engaged** — same Spline frame stays visible; HTML overlays show **Frely Network** + supported-agent placeholder (`—`).
3. **Details** — first downward wheel on the first screen smooth-scrolls to the project intro (`#details`) and unlocks the rest of the page (How it works).

On narrow screens the iframe is skipped; ambient + page Click Me remain.

## Spline

Default Public URL (iframe):

`https://my.spline.design/aidatamodelinteraction-yXFK4f6oAzDsrDztvyJ1dXk4/`

Optional `apps/site/.env`:

```bash
PUBLIC_SPLINE_PUBLIC=https://my.spline.design/your-scene/
PUBLIC_SPLINE_SCENE=https://prod.spline.design/YOUR_ID/scene.splinecode
```

Brand mark: `public/logo.png` (transparent). Agent count is a placeholder until product data exists.

## Scripts

```bash
cd apps/site
npm install
npm run dev      # http://localhost:3010
npm run build
npm run preview
```
