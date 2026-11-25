# Admin Google Authentication, Custom-Claim Authorization, and Separate `/admin` Workspace

MyPlaydex introduces Admin authentication via Firebase Authentication (Google Sign-In only) on a standalone, zero-click `/login` page (`public/login.html`) that redirects to a dedicated `/admin` workspace (`public/admin.html`), authorized via a Firebase Auth custom claim (`admin: true`) enforced in `firestore.rules`, while keeping the public `/` discovery app untouched and free of Auth SDK overhead.

## Considered Options

- **In-place admin mode on `/` vs. separate `/admin` workspace**: Rejected in-place mode to keep `public/index.html` and `public/js/app.js` 100% public-only with zero Auth SDK loading or conditional UI branches.
- **Firestore `/admins` allowlist or hardcoded email in `firestore.rules` vs. Firebase Auth custom claim (`admin: true`)**: Rejected a `/admins` allowlist (extra Firestore read per write evaluation) and hardcoded email (commits personal PII to version control and requires rules deploys to manage access); selected a custom claim managed via a local `firebase-admin` CLI script.
- **`signInWithPopup` vs. auto-triggered `signInWithRedirect` with same-origin `authDomain`**: Rejected `signInWithPopup` because browsers block popups without an explicit button click; selected `signInWithRedirect` on `/login` using the Firebase Hosting domain (`myplaydex.web.app`) as `authDomain` so navigating to `/login` triggers Google Auth immediately with zero clicks and avoids third-party storage partitioning issues.

## Consequences

- `public/index.html`, `public/js/app.js`, and the strict default CSP header on `**` in `firebase.json` remain unchanged for public visitors; relaxed Firebase Auth CSP directives are scoped strictly to `/login` and `/admin`.
- `/login` and `/admin` carry `noindex, nofollow` and use `browserLocalPersistence`. Unauthenticated visits to `/admin` redirect to `/login`; authenticated Google accounts lacking `admin === true` are immediately signed out with a neutral access-denied state while `firestore.rules` enforces the real security boundary.
- `firestore.rules` grants Admins `read, create, update, delete` on `/activities`, `/organizers`, and `/venues` (keeping `id` and `created_at` immutable on update) and `read`-only access on `/regions`, while denying all other paths and non-admin writes.
- Granting or revoking Admin access requires running the local `firebase-admin` CLI script after the user's initial sign-in creates a Firebase Auth user record.
