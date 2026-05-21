/**
 * Fetch and convert a curated set of Elementor developer docs to local Markdown
 * for MCP `resources/list` exposure.
 *
 * This is intentionally small (handful of high-signal pages) — we're not
 * trying to mirror the entire site. Quality > quantity for token budget.
 *
 * Run: `npm run docs:fetch`
 */
const SOURCES: Array<{ slug: string; url: string; title: string }> = [
  // Hand-curated set. Expand cautiously — every entry adds tokens to the LLM context window.
  { slug: "introduction", url: "https://developer.elementor.com/docs/getting-started/", title: "Getting started" },
  { slug: "widgets-overview", url: "https://developer.elementor.com/docs/widgets/", title: "Widgets overview" },
  { slug: "hooks", url: "https://developer.elementor.com/docs/hooks/", title: "Hooks reference" },
];

async function main() {
  console.error(`Fetching ${SOURCES.length} doc pages...`);
  // Skeleton — actual scraping/Markdown conversion would use a fetch + html-to-md pipeline.
  // We ship a hand-written corpus in resources/elementor-docs/ by default; this script
  // is the future-proofing path for automated refresh.
  console.error("This script is a placeholder. The curated docs in resources/elementor-docs/");
  console.error("are hand-written for v0.1.0. Automated fetching is on the roadmap.");
}

main();
