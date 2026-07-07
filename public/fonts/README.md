# Bundled fonts

`instrument-sans-latin-400/500/600/700-normal.woff2` are the four static weights
of **Instrument Sans**, the same font the Minted Panel app self-hosts
(`mintedpanel/public/fonts/`). Bundling the identical files keeps the extension's
type in lockstep with the app.

Instrument Sans is distributed through Google Fonts under the SIL Open Font
License 1.1 (<https://fonts.google.com/specimen/Instrument+Sans>).

The files are bundled inside the extension and declared via `@font-face` in
`src/sidepanel/sidepanel.css` so the panel never makes an external font request
(extension CSP + no network dependency).

The app also uses **Geist Mono** for monospaced numerals; it is intentionally
not bundled here (the side panel uses mono only for digit-only NPI/ID readouts,
where the system monospace fallback is indistinguishable). The `--mp-mono` stack
in `sidepanel.css` names `"Geist Mono"` first so it upgrades automatically if
the file is ever added.

If a licensed brand font arrives, drop its woff2 files in here and update the
`@font-face` blocks — nothing else references the files.
