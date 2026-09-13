# Android 0.23.4 connection authorization hotfix

## Observed

- Local unauthenticated `/api/plans` probe: api.nivorali.com timed out at 12 seconds before TCP connected; b.nivorali.com returned HTTP 200 in 0.93 seconds. This is not a mobile-network test or proof of censorship.
- Dashboard failure could clear the pending VPN request while connection-ready authorization was still running, or display failure after that authorization succeeded.

## Changes

- Replay-safe API reads and device/connection checks can fail over between the two exact first-party HTTPS origins. Unknown installations do not receive these fallback hosts.
- A successful origin is shared with other API clients in the app process. Purchases and other writes are never automatically replayed. Authorization errors are not retried.
- Dashboard transport failure no longer cancels an in-flight connection check or reports authorization failure after a successful check.
- A changed subscription or unsuccessful readiness response terminates the pending request explicitly. Logout resets the fast-check state. Cached account data alone still cannot authorize VPN use.

## Delivery boundaries

Local builds only; no server deployment or public release broadcast performed. ADB reported no attached phone. Verify with Wi-Fi and mobile data before broad rollout. Both unavailable origins still produce an error; this does not fix an unreachable VPN server itself.

The larger requested bundle remains pending: unlimited traffic/duration, special subscription text, plan flags, expanded iOS QR access, Telegram navigation, and internal update-download progress. No completion claim is made for those items.
