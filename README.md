# Nexada Meet

1. `cp .env.example .env` and fill in the keys (never commit .env).
2. `npm install && npm start`
3. Public join page: `/`, room: `/room`, host dashboard (password): `/host`.

## Google Calendar
1. console.cloud.google.com > new project > APIs & Services > Library > enable "Google Calendar API".
2. OAuth consent screen: External, add your Google email as a Test user.
3. Credentials > Create credentials > OAuth client ID > Web application.
   Authorized redirect URI: `APP_URL/auth/google/callback` (e.g. https://meet.nexada.co/auth/google/callback).
4. Put Client ID and Secret in `.env`, restart, open `/host` and click "Connect Google Calendar".
Events then appear in your calendar with the Daily link.

## Resend
Verify the domain nexada.co in Resend (add the DNS records) so meet@nexada.co can send.

## Free hosting (Render)
Free instances lose local files on restart. After connecting Google once, copy the refresh token shown
on the confirmation page into the `GOOGLE_REFRESH_TOKEN` env var and redeploy.
