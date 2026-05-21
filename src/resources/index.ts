import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, "../resources/elementor-docs");

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

export async function listResources(): Promise<Resource[]> {
  if (!existsSync(DOCS_DIR)) return [];
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
  return files.map((f) => ({
    uri: `elementor-docs://${f}`,
    name: basename(f, ".md"),
    description: `Elementor documentation snippet (scraped from developer.elementor.com)`,
    mimeType: "text/markdown",
  }));
}

export async function readResource(uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  if (!uri.startsWith("elementor-docs://")) {
    throw new Error(`Unknown resource URI: ${uri}`);
  }
  const filename = uri.replace("elementor-docs://", "");
  const path = join(DOCS_DIR, filename);
  if (!existsSync(path)) throw new Error(`Resource not found: ${filename}`);
  return {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text: readFileSync(path, "utf8"),
      },
    ],
  };
}
