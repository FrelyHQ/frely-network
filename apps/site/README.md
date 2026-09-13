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
npm run pitch:build   # static Slidev → public/pitch/
npm run dev           # http://localhost:3040 — landing (Spline). Pitch via /pitch/index.html
npm run pitch:dev     # live-edit Slidev only: http://localhost:3041/pitch/
npm run shots:pitch   # Playwright screenshots → tmp-shots/
npm run build
npm run preview
```

Pitch source: `pitch/slides.md`. Header **Pitch** / hero **View pitch** open the deck.
**Port 3040 is the landing page**, not Slidev.
