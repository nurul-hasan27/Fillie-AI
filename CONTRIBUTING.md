# Contributing

Thanks for helping! Small, focused pull requests are easiest to review.

1. Fork the repo and create a branch.
2. `npm install`, then `npm run watch` and load `dist/` in Chrome (see the README).
3. Make your change. Keep `src/core/` free of DOM and `chrome.*` calls so it stays testable.
4. Run `npm run typecheck && npm run test:unit` (and `npm run test:e2e` if you touched the page scanner or filler).
5. Open a pull request and say what changed and why.

## Ground rules

- Fillie must never submit a form for the user.
- Never log, render or export an API key.
- Page text is untrusted data. Do not let it become instructions.
- No runtime dependencies without a very good reason.

## Reporting bugs

Open an issue with the page type (not private data!), what you expected, and what happened.
Please never paste API keys or personal details.
