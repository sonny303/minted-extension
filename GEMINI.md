# GEMINI.md — Minted Panel Workbench Guidelines

Binding rules for Gemini / Antigravity agents working on `minted-extension`.

- **Rules & Invariants**: See [`AGENTS.md`](AGENTS.md)
- **Current Architecture & Specifications**: See [`CLAUDE.md`](CLAUDE.md)
- **Chrome Web Store Release Procedure**: See [`.claude/skills/publish-update-to-chrome-store/SKILL.md`](.claude/skills/publish-update-to-chrome-store/SKILL.md)

### Verification Commands

```bash
npm run typecheck
npm test
npx vitest run scripts/release/contract.test.mjs
```
