# Electron packaging

Packaging requires macOS, Node 24 or later, npm, and the Electron shell entry
point at `client-ui/electron/main.js`. The shell must be present before running
the packaging script. Run from the repository root:

```sh
scripts/electron-build.sh --dir
scripts/electron-build.sh --dmg
```

The first command produces an unpacked arm64 app; the second produces an arm64
DMG. Output is written to `dist/`. The script installs Electron and
Electron Builder in a temporary directory outside the repository and removes it
when finished. The application identifier is a placeholder that must be
changed before distribution under a real identifier.

By default the app is unsigned and intended for internal use. On first open,
right-click the app, choose **Open**, and confirm the Gatekeeper prompt. This
is a one-time action on the Mac where the app is opened.

To sign, make a suitable Apple signing identity available in the macOS
keychain and set `VOLTO_MAC_IDENTITY` in the environment to its identity name.
To also notarize, set `VOLTO_NOTARIZE=1` and supply `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` in the environment. Set
these values in your shell or a secure environment provider; do not put them in
repository files. Notarization requires a signing identity and Apple account
credentials. Leave `VOLTO_MAC_IDENTITY` unset for an unsigned build, and leave
`VOLTO_NOTARIZE` unset or set to `0` to skip notarization.
