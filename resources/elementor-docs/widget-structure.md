# Elementor — Widget structure in `_elementor_data`

Every Elementor page stores its layout in the postmeta key `_elementor_data` as a
JSON-encoded array. Top-level entries are **sections** or **containers** (the new
flexbox-based container introduced in Elementor 3.6).

## Element types

```
{
  "id": "abc12345",            // 8-char hex id, unique within the page
  "elType": "section" | "container" | "column" | "widget",
  "settings": { ... },         // per-element controls (responsive variants suffixed _tablet / _mobile)
  "elements": [ ... ],         // nested elements (sections → columns → widgets)
  "isInner": false,            // true if nested section
  "widgetType": "heading"      // only present when elType === "widget"
}
```

## Common widget types

- `heading` — text heading
- `text-editor` — TinyMCE-style rich text
- `image` — image with caption + lightbox
- `button` — single CTA button
- `icon` — single icon
- `icon-box` — icon + heading + description
- `icon-list` — list with icons
- `divider`
- `spacer`
- `tabs` / `accordion` / `toggle`
- `image-gallery` / `image-carousel`
- `template` — embedded saved template
- `theme-post-title` / `theme-post-content` — theme-builder dynamic widgets

## Pro widgets

- `form` — Elementor Pro forms
- `posts` — dynamic posts grid
- `portfolio`
- `slides`
- `popup` (in popup templates)
- `nav-menu`
- `flip-box`
- `price-list` / `price-table`

## Settings — key fields

Common to most widgets:

- `_animation` — entrance animation
- `_css_classes` — extra CSS classes
- `_padding` / `_margin` — spacing (object: `top, right, bottom, left, unit, isLinked`)
- `_background_background` — "classic", "gradient", "video"
- `_background_color` / `_background_image`

Responsive variants are suffixed: `_padding_tablet`, `_padding_mobile`.

## Editing rules of thumb

1. **Always preserve `id`** — Elementor uses ids for CSS scoping. Changing them invalidates the generated CSS.
2. **Never edit `_elementor_data` without backing it up first** — corrupted JSON breaks the page.
3. **Flush CSS after edit** — Elementor caches per-page CSS at `wp-content/uploads/elementor/css/`. Regenerate via REST or by re-saving the page.
4. **Use `elementor_safe_edit` from this MCP** — it does all three (backup → edit → flush) atomically.
