# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems.

Report them privately through GitHub: on this repository, open **Security → Report a vulnerability**
(GitHub's private vulnerability reporting). Include what you found, how to reproduce it, and which
version you tested.

We aim to:

- reply within **3 days**;
- confirm and assess the problem within **7 days**;
- release a fix as soon as possible, usually within **30 days** for serious issues, and credit you in the
  release notes if you'd like.

Please give us a reasonable time to release a fix before sharing details publicly.

## Supported versions

Only the **latest release** gets security fixes. Self-hosted servers should update when a new release
is published (Admin panel → Updates shows when one is out).

## Running a server safely

- **Serve it over HTTPS** behind a reverse proxy and set `SECURE_COOKIES=true`.
- **Set `PUBLIC_URL`** to the address people use, so links in emails always point to your server.
- **Turn on email** (SMTP) so sign-up codes and invitation confirmations work. With
  `REQUIRE_EMAIL_VERIFICATION=true`, new accounts must confirm their address before using it.
- **Close sign-ups** in the admin panel if only invited people should join.
- **Keep the admin panel private**: it listens on its own port, bound to this machine by default.
- **Shared or hosted servers:** set `ALLOW_PRIVATE_URLS=false` so webhooks and AI addresses can't reach
  the local network.
- **The optional updater** controls Docker on the machine. Only start it (`--profile updater`) if you
  want automatic updates; it installs tagged releases only.
- **Back up** the `db` and `data` volumes regularly, and test restoring them.

## Known limits

- **Android keeps the sign-in token in the app's private settings file.** Only the app can read it, but
  it isn't in a hardware-backed keystore yet. (On Windows and macOS it's in the OS keychain.)
- **No independent security audit has been done.** The checks so far are our own reviews and an outside
  code review; treat Atrium accordingly for very sensitive data.
- **Meetings connect people directly to each other** (each person to every other), so they suit small
  groups. Large calls need a media server, which Atrium doesn't include.
