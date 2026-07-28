# Bundled fonts

`geist-latin-400/500/600/700-normal.woff2` are the four static UI weights of
**Geist**, the Minted Panel Design System's UI font, and
`geist-mono-latin-400/500-normal.woff2` are the two mono weights the panel uses
for digit-only NPI/ID readouts. Both come from `@fontsource/geist` /
`@fontsource/geist-mono` — the same packages the app imports
(`mintedpanel/src/styles.css`) — so the extension's type stays in lockstep with
the app.

Geist is distributed under the SIL Open Font License 1.1
(<https://fonts.google.com/specimen/Geist>).

The files are bundled inside the extension and declared via `@font-face` in
`src/sidepanel/sidepanel.css` so the panel never makes an external font request
— MV3's CSP blocks the Google Fonts CDN, and self-hosting removes the network
dependency entirely.

Instrument Sans (the pre-conformance UI font) was removed when the panel was
brought onto the design system.
