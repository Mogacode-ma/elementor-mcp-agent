# Elementor — Common action hooks

This is a hand-curated reference of the most common action hooks exposed by
Elementor and Elementor Pro. Use these when extending Elementor from a custom
plugin or theme.

## Editor & frontend lifecycle

- `elementor/init` — fires once Elementor's main object is instantiated. Use it to register custom widgets, controls, or skins.
- `elementor/elements/categories_registered` — register a custom widget category before widgets register themselves.
- `elementor/widgets/widgets_registered` — register custom widgets.
- `elementor/editor/before_enqueue_scripts` — enqueue assets that should only run in the editor.
- `elementor/preview/enqueue_styles` — enqueue styles that should only run inside the editor preview iframe.
- `elementor/frontend/before_enqueue_scripts` — enqueue scripts on the live frontend (not the editor).

## Rendering

- `elementor/frontend/widget/before_render` / `after_render` — wrap any widget's output.
- `elementor/frontend/section/before_render` / `after_render` — same for sections.
- `elementor/frontend/the_content` — alters the HTML output of Elementor pages.

## CSS regeneration

- `elementor/core/files/clear_cache` — clear the Elementor CSS cache from PHP.
- `elementor_pro/core/files/clear_cache` — same for Pro assets.

## Common filters

- `elementor/widget/print_template` — modify the JS template a widget uses in the editor.
- `elementor/element/get_default_args` — change default control values for any widget.
- `elementor_pro/forms/render/item` — alter form fields before render.
