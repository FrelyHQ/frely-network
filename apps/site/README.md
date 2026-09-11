# Frely Network — landing (`apps/site`)

Static Astro showcase for Frely Network (landing only). Visual language is inspired by the Spline community piece [AiData Model Interaction](https://app.spline.design/community/file/e41b79f5-7a6d-4123-814b-7d2e60ce7c44): dark immersive stage, interactive data-model hero, blue accent.

## Spline scene (optional)

Community files are not embeddable until you **Export → Code / Viewer** and get a `https://prod.spline.design/.../scene.splinecode` URL. Then:

```bash
# apps/site/.env
PUBLIC_SPLINE_SCENE=https://prod.spline.design/YOUR_ID/scene.splinecode
```

Without that env var, the page uses the built-in interactive canvas (mouse-reactive orbital network).

## Scripts

```bash
cd apps/site
npm install
npm run dev      # http://localhost:3010
npm run build
npm run preview
```

Outside the Bun workspaces on purpose (same pattern as `ui/site-astro`) so npm installs cleanly.
