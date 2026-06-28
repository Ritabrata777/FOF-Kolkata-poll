# Firebase Setup

1. Create a Firebase project.
2. Run Firebase login:

```bash
npm run firebase:login
```

3. Auto-fill `.env.local` from your Firebase project:

```bash
npm run firebase:env
```

The helper can pick an existing Firebase Web app, create one if the project has none, and find/create a Realtime Database instance.

If your Google account has many Firebase projects, set the project first in PowerShell:

```powershell
$env:FIREBASE_PROJECT_ID="your-project-id"; npm run firebase:env
```

4. Run the app:

```bash
npm run dev
```

Manual fallback: copy `.env.example` to `.env.local`, then paste your Firebase Web app config from Firebase Console.

For deployment:

```bash
npm run build
firebase deploy
```

The QR code is generated from the hosted URL, so after Firebase Hosting deployment it points to:

```text
https://your-site.web.app/audience/<eventId>
```

Current database rules are open for demo/testing. Add Firebase Auth and admin-only writes before using this for a public production event.
