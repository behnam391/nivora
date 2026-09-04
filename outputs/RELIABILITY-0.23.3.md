# Nivora 0.23.3 reliability changes

- Startup reuses an encrypted normalized subscription bundle; raw and Base64 bundles are accepted, HTML/error responses are rejected.
- Cached customer accounts can use a bounded, device-authenticated connection-readiness check without waiting for the full dashboard.
- Normal connections use one route at a time. Only an authenticated loopback SOCKS + certificate-verified HTTPS 204 response marks a route connected.
- Up to three distinct route signatures are tried. Background checks run every 30 seconds; three failures and a 60-second cooldown are required before replacing a route. This does not guarantee streaming or voice-call quality.
- Manual latency measurement traverses the actual active tunnel. Network-lab behavior and emergency-lease controls remain separate.
- Web and Android wallet purchases/renewals send durable retry keys. The server journals keys per authenticated actor and endpoint and replays completed responses.
- Wallet debit and purchase/renewal records are created in one SQLite transaction.
- Definite failures are excluded from approved sales and existing wallet refunds are retained. Unknown panel write outcomes remain under review: do not automatically retry or refund them before checking the panel.
- Interrupted keyed operations are visible in Admin > Direct sales > Purchases needing follow-up. Reconciliation remains a manual operational step; there is no automatic resolution of unknown panel outcomes.

## Verification and release boundary

The backend was deployed with code and database backups under `/opt/nivora/backups/reliability-before-EFcGgb` and passed health/static-asset checks. Android customer/partner release APKs use versionCode 49 and the existing signing key. Backend and Android automated tests were run. The first phone attempt hit a subscription-download timeout before the tunnel started; real network performance must not be reported as verified solely from automated tests. Do not broadcast a forced update before phone acceptance testing.

Older clients without retry headers retain legacy behavior. These protections require refreshed web assets or the new Android app. Third-party iOS V2Box routing is not controlled by Nivora's Android health policy.

Final phone check: version 0.23.3 (49) connected on the previously selected Turkey 3 subscription after the bundle-cache correction. This verifies the tunnel HTTPS health check, not Instagram playback or Telegram voice calls. All 146 backend tests passed. The new APK has not been broadcast or made a forced update.
