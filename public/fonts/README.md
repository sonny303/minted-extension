# Bundled fonts

`figtree-latin.woff2` and `figtree-latin-ext.woff2` are the Figtree variable
font (weight axis 300–900), split into the latin and latin-ext subsets.
Figtree is designed by Erik Kennedy and distributed through Google Fonts
under the SIL Open Font License 1.1
(<https://fonts.google.com/specimen/Figtree/license>).

The files are bundled inside the extension and declared via `@font-face` in
`src/sidepanel/sidepanel.css` so the panel never makes an external font
request (extension CSP + no network dependency).

Figtree is a stand-in approved by the design doc ("closest Google Font to the
app's grotesque"). If a licensed brand font arrives, drop its woff2 files in
here and update the `@font-face` blocks — nothing else references the files.
