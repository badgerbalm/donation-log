# Donation Log

Donation Log is a standalone website published from this repository at `https://badgerbalm.github.io/donation-log/`. It stores visits and medication dates through its own owner-authenticated Cloudflare API and encrypted database, separate from Daily Workout and Google Sheets.

Sign in with Google from Donation Log. The OAuth callback returns directly to this app; you do not need to open Daily Workout. The sign-in broker is shared infrastructure, while the app, browser session key, API, and health data remain separate.
