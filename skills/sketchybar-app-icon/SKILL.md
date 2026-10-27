---
name: sketchybar-app-icon
description: Add a SketchyBar app icon (and optional AeroSpace floating rules) for a newly installed macOS app in ~/Documents/github/.dotfiles-macos. Use when the user says "add icon for <app>", a new app shows the default icon in the bar, or asks to float an app's popups in AeroSpace.
---

# Add SketchyBar icon for a new app

Repo: `~/Documents/github/.dotfiles-macos` (`~/.config/sketchybar` and aerospace config are symlinked here).

1. Identify the app:
   ```bash
   A="/Applications/<App>.app"
   defaults read "$A/Contents/Info" CFBundleName
   defaults read "$A/Contents/Info" CFBundleIdentifier
   aerospace list-windows --all --format '%{app-name}|%{app-bundle-id}|%{window-title}'
   ```
   The `icon_map.sh` case key must match the app name SketchyBar/AeroSpace reports (`%{app-name}`).

2. Find a glyph in the app font (no fontTools needed):
   ```bash
   strings -n 4 sketchybar/fonts/sketchybar-app-font.ttf | grep -io ':[a-z0-9_]*<keyword>[a-z0-9_]*:' | sort -u
   ```
   Also check `grep -n -i '<app>' sketchybar/plugins/icon_map.sh` — it may already be mapped.
   - Exact glyph exists → use it.
   - Not present → use the closest existing glyph (e.g. Writer → `:ia_writer:`) and tell the user it is a stand-in. A custom glyph requires rebuilding the font (see commit "Add Ardia icon to SketchyBar app font"); only do that if asked.

3. Add a case before the `*)` default in `sketchybar/plugins/icon_map.sh`:
   ```sh
   "<App Name>")
     icon_result=":<glyph>:"
     ;;
   ```

4. Verify and reload:
   ```bash
   ./sketchybar/plugins/icon_map.sh "<App Name>"   # prints the glyph
   sketchybar --reload
   ```

## Optional: AeroSpace float rules (browsers / apps with popups)

Edit `aerospace/aerospace.toml`, next to the other browser blocks (Zen/Arc/Dia/Phi). Pattern:
```toml
[[on-window-detected]]
if.app-id = '<bundle.id>'
if.window-title-regex-substring = '(?i)^$|settings|popup|chat|picture in picture'
run = 'layout floating'

[[on-window-detected]]
if.app-id = '<bundle.id>'
run = 'layout --root tiles'   # stops the force-tiling catch-all; keeps dialog heuristic
```
Inspect real window titles with `aerospace list-windows` to tune the regex. Then `aerospace reload-config`. Rules apply to newly opened windows only.

## Finish
Report what was mapped (and whether it's a stand-in). Commit/push only when asked:
`git add <files> && git commit -m "Add <App> icon to SketchyBar icon map" && git push`.
