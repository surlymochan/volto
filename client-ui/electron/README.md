# Electron shell

With Electron installed and available on your PATH, run from the repository root:

```sh
electron client-ui/electron/main.mjs
```

Use an Electron version whose Node runtime supports TypeScript type stripping,
which the relay and panel server require. The shell creates `hosts.json` in
Electron's user-data directory with an empty list. To configure initial hosts,
add entries such as `{ "alias": "my-ssh-alias" }` to that array. An optional
`label` may be supplied for display. Aliases must start with a letter, digit, or
underscore and contain only letters, digits, underscores, periods, and hyphens.

All bots are remote: hosts are SSH aliases, and local transport commands are not
accepted by the shell. Hosts added through the panel exist only for the current
relay session; edit `hosts.json` to configure hosts for future launches.
