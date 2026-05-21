# Elementor docs corpus (MCP Resources)

This folder hosts Markdown extracts of the public Elementor developer documentation
(<https://developer.elementor.com/docs/>). Each file is exposed via the MCP server
as a `resources/list` + `resources/read` entry, so an LLM client can look up
Elementor hooks, filters, widget structure, and editor patterns without leaving
its context.

**Refresh**: `npm run docs:fetch` triggers `scripts/fetch-elementor-docs.ts` which
scrapes a curated set of pages, converts them to Markdown, and writes them here.

We intentionally ship a small curated set rather than the full docs — quality over
quantity for token efficiency.
