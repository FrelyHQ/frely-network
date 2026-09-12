# Frely Network — landing (`apps/site`)

Static Astro showcase. Interaction:

1. **Splash** — full-viewport Spline (iframe receives clicks; page chrome is `pointer-events: none` so the scene Click Me can play). Transparent logo only.
2. **Engaged** — after you click inside the Spline scene, the post-click animation stays visible; HTML overlays show **Frely Network** + agent placeholder (`—`).
3. **Details** — a clear downward wheel gesture smooth-scrolls to `#details` (project intro).

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
