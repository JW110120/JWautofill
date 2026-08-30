---
name: uxp-themeable-dropdown
description: This skill should be used when building or restyling dropdown/select controls in a Photoshop UXP plugin, or when a dropdown's open-menu background cannot be changed via CSS. It documents the project's mandatory pattern of replacing native sp-picker/sp-menu (whose flyout background is unstyleable in UXP) with the custom React Select component that uses .mask-sync-select-* CSS and theme variables, plus the RGB-only color convention.
agent_created: true
---

# UXP Themeable Dropdown

## Purpose
In Photoshop UXP plugins, native Spectrum dropdowns (`<sp-picker>` + `<sp-menu>`/`<sp-menu-item>`) render their **open menu in a flyout whose background cannot be overridden by CSS** (shadow DOM / overlay). This breaks theme consistency. The project's mandated solution is a **custom React dropdown** (`src/components/Select.tsx`) that renders its own head + fixed popup, styled entirely by CSS variables.

## When to use
- Adding any new dropdown/select in the plugin UI.
- A dropdown's background/colors don't match the active theme.
- Replacing legacy `sp-picker`/`sp-menu` usages.

## Workflow
1. **Never use `sp-picker`/`sp-menu`.** Use `<Select>` from `src/components/Select.tsx`.
2. The component reads its look from theme tokens in `src/styles/theme.ts`:
   - `--dropdown-bg-color` (head + popup bg): darkest `rgb(32,32,32)` / dark `rgb(57,57,57)` / light `rgb(218,218,218)` / lightest `rgb(255,255,255)`
   - `--border-color`, `--text-color`, `--primary-color`, `--hover-bg`, `--disabled-color`
3. CSS classes live in `src/adjustments/adjustment.css` under `.mask-sync-select-*` and are globally available (main panel and adjustment panel share one document/bundle).
4. **Color convention (hard rule):** only `rgb()`/`rgba()` in code. No HEX. Convert any HEX literal before committing.

## Select API
- `value: string`
- `options?: SelectOption[]` (flat list) OR `groups?: SelectOption[][]` (renders a divider between each group)
- `onChange: (value: string) => void`
- `disabled?: boolean`
- `placeholder?`, `title?`, `className?`, `style?`
- `SelectOption = { value: string; label: string; disabled?: boolean; tag?: React.ReactNode }`
  - `tag` renders a right-aligned node (used by the brush dropdown for type icons).

## Examples
- Blend mode (grouped + disabled): `src/app.tsx` and `src/components/StrokeSetting.tsx` pass `groups={BLEND_MODE_OPTIONS}` and `disabled`.
- Brush dropdown: `src/hotkey/BrushSelect.tsx` is a thin wrapper mapping `{value, main, tag}` → `SelectOption` and delegating to `Select`.
- Gradient type / pattern zoom: `src/components/GradientPicker.tsx`, `src/components/PatternPicker.tsx`.

## Popup behavior notes
- Popup is `position: fixed` using `getBoundingClientRect()` so it escapes `overflow` clipping and aligns under the head; it repositions on scroll.
- Selected option gets `.sel` (background = `--primary-color`, white text). Group dividers use `.mask-sync-select-divider`. Option labels use `white-space: nowrap` + ellipsis so long names truncate cleanly.
