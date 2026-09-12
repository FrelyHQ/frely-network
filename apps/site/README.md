# Frely Network — landing (`apps/site`)

Static Astro showcase. Interaction:

1. **Splash** — full-viewport Spline ([public scene](https://my.spline.design/aidatamodelinteraction-yXFK4f6oAzDsrDztvyJ1dXk4/)); page chrome is `pointer-events: none` so the scene Click Me can play. Blue transparent logo in the corner.
2. **Engaged** — after clicking inside the Spline scene, act-2 stays native (title lives in Spline). Page only shows a light scroll hint.
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

Brand mark: `public/logo.png` (blue transparent).

## Scripts

```bash
cd apps/site
npm install
npm run dev      # http://localhost:3010
npm run build
npm run preview
```
