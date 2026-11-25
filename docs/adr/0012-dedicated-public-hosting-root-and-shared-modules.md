# Dedicated `public/` Hosting Root and Shared Browser/Node Modules

We switched Firebase Hosting in `firebase.json` from `"public": "."` with a per-file `ignore` denylist to `"public": "public"` with a fail-closed layout: static root assets (`index.html`, SEO/icon/manifest files, `styles.css`), UI-only ESM scripts (`public/js/`), and pure browser+Node modules (`public/shared/discovery-engine.js`, `public/shared/perth-centroids.js`), while keeping all backend/crawler scripts in `src/`.

## Considered Options

- **Keep `"public": "."` and expand `hosting.ignore`**: Low initial diff, but fail-open—every new backend script in `src/` or local credential JSON at the repo root is publicly deployable unless manually ignored.
- **Stage a `dist/` bundle via a build script**: Avoids backend code importing from `public/`, but adds a mandatory build step before `serve:hosting` and `deploy:hosting`, breaking zero-build Vanilla ES2022 simplicity.

## Consequences

- New backend CLI scripts, crawlers, and local root files (such as service-account JSONs) can no longer be deployed to Firebase Hosting by accident.
- Backend modules in `src/` may import only from `public/shared/` (never `public/js/`), and modules in `public/shared/` must remain pure browser-safe JavaScript with zero `node:*` or `firebase-admin` imports.
