# Sales Targets Mobile (Expo)

## Quick Start
```bash
npm i -g eas-cli
npm install
npx expo start
```

## Build APK / IPA
```bash
# APK for sideloading
npx eas build -p android --profile preview

# Android App Bundle for Play Store
npx eas build -p android --profile production

# IPA for TestFlight/App Store (Apple Dev account required)
npx eas build -p ios --profile production
```

## Daily Email (6:00pm local)
In the app, open **Settings → Daily Email Settings** and set **Webhook URL** to your serverless email endpoint.

Payload the app sends:
```json
{ "to": "john.yatman@raywhite.com", "subject": "Daily KPI – 2025-08", "text": "...", "csv": "Name,Connects,...", "month": "2025-08" }
```

### Example Cloudflare Worker (send-email-worker.js)
```js
export default {
  async fetch(req, env) {
    if (req.method !== 'POST') return new Response('Only POST', { status: 405 });
    const { to, subject, text, csv } = await req.json();
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_KEY}` },
      body: JSON.stringify({
        from: 'reports@yourdomain.com',
        to: [to],
        subject,
        text,
        attachments: csv ? [{ filename: 'kpi.csv', content: btoa(csv) }] : undefined
      })
    });
    if (!r.ok) return new Response('Provider failed', { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }
}
```

## One-command builds
```bash
npm run build:apk   # outputs .apk
npm run build:aab   # outputs .aab (Play Store)
npm run build:ipa   # outputs .ipa (TestFlight/App Store)
```
