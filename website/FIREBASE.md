# Firebase Cloud Messaging (web + mobile)

There is no separate native iOS/Android app in this repo. **Mobile** means the guest gallery opened in a phone browser (or installed as a PWA). **Web** means desktop Chrome/Edge/Firefox. Both use the same FCM web SDK.

## What you get

| Who | How they opt in | When they get a push |
| --- | --- | --- |
| Guest | Gallery → **Enable photo alerts** | Booth finishes uploading that session (`?s=code`) |
| Operator | Admin → Settings → **Enable alerts on my phone** (opens gallery with `?operator=1`) | You can call `notifyOperator()` from the booth (optional hooks) |

iOS Safari only delivers web push after the site is **Add to Home Screen** (PWA). Android Chrome works from the browser tab once permission is granted.

## 1. Create a Firebase project

1. [Firebase Console](https://console.firebase.google.com/) → Add project  
2. Add a **Web** app → copy the config object  
3. **Build → Cloud Messaging → Web Push certificates** → generate a key pair (VAPID)  
4. **Build → Firestore** → create database (production or test mode; lock rules later)  
5. Project settings → **Service accounts** → Generate new private key (JSON)

## 2. Fill public web config

Edit `website/firebase-config.js`:

```js
root.NOSTALGIA_FIREBASE = {
  apiKey: "...",
  authDomain: "YOUR.firebaseapp.com",
  projectId: "YOUR",
  storageBucket: "YOUR.appspot.com",
  messagingSenderId: "...",
  appId: "...",
  vapidKey: "YOUR_WEB_PUSH_KEY_PAIR",
};
```

## 3. Vercel (gallery host) env + deps

In the Vercel project that deploys `website/`:

```
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...@....iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FCM_NOTIFY_SECRET=long-random-string
```

Install API deps once (Vercel will use `website/package.json`):

```bash
cd website && npm install
```

APIs:

- `POST /api/fcm-register` — gallery stores device tokens  
- `POST /api/fcm-notify` — booth (or you) send a push  

## 4. Booth `.env`

```
VITE_GALLERY_BASE_URL=https://your-gallery.vercel.app
VITE_FCM_NOTIFY_SECRET=same-as-FCM_NOTIFY_SECRET
# optional override:
# VITE_FCM_NOTIFY_URL=https://your-gallery.vercel.app/api/fcm-notify
```

Rebuild the desktop app after changing `VITE_*` vars.

## 5. PWA icons

Add `website/icon-192.png` and `website/icon-512.png` (manifest already references them). Until then, some install prompts may look incomplete; SVG logo is still used in the page.

## 6. Test

1. Deploy gallery with Firebase config + Vercel env  
2. Open `https://your-gallery/?s=TESTCODE` on Android Chrome → Enable photo alerts → Allow  
3. From booth (or curl):

```bash
curl -X POST https://your-gallery/api/fcm-notify \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SECRET" \
  -d '{"channel":"session","shortCode":"TESTCODE","title":"Nostalgia","body":"Test push","url":"https://your-gallery/?s=TESTCODE"}'
```

## Security notes

- Never put the service-account private key in the public Firebase web config.  
- Set `FCM_NOTIFY_SECRET` before production so random callers cannot spam pushes.  
- Tighten Firestore rules so only the Admin SDK (server) writes `fcmTokens`.
