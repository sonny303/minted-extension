`CopyButton` is the compact copy chip for IDs (NPI, CAQH, license #) — click copies the value and the chip confirms with a green "✓ Copied" for ~1.2s.

```jsx
<CopyButton value="1000000004" />
<CopyButton value="10000001" onCopy={(v) => track("copy_caqh", v)} />
```

Sits at the end of a key/value ID row next to a mono value. 26px tall. The confirmed state is automatic — don't build your own.
