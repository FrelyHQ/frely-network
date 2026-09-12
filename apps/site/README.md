# Frely Network — landing (`apps/site`)

Static Astro showcase. Interaction:

1. **Splash** — full-viewport Spline ([public scene](https://my.spline.design/aidatamodelinteraction-yXFK4f6oAzDsrDztvyJ1dXk4/)); clicks reach the scene; a lower wheel-catch band detects downward scroll.
2. **Engaged** — after clicking inside Spline, act-2 stays native (FRELY NETWORK in the scene). Corner logo + scroll hint only.
3. **Details** — first meaningful downward wheel smooth-scrolls once to `#details` (project intro / screen 2).

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
