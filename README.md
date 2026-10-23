# Dynamic Background

<img src="images/icon.png" alt="Dynamic Background icon" width="96" align="right">

## Why

When you work on a large codebase, you rarely remember *where* a piece of code is
by its line number. You remember it the way you remember places: by how it
*looks*. This extension gives every region of your code its own subtle color
cast, so you build a **subconscious sense of location**. Over time your brain
automatically associates the image on the screen with what that code does: a
section full of strings feels different from a block of dense logic or a
wall of comments, and you can tell where you are before you read anything.

The effect is deliberately faint. It isn't meant to be noticed consciously, only
recognized.

## What it does

Dynamic Background is a VS Code extension that tints the editor background with
the foreground color of the symbols (strings, keywords, variables, types...)
**present in the code currently visible on screen**. By default it uses the
symbol type that appears most in the visible area, so the dominant kind of code
on screen defines the tint. The
color is recalculated on every scroll, edit or file switch.

The base color is pure black for dark themes and pure white for light themes
(the theme's own editor background is ignored). With the default settings, the
tint is proportional to how much of the visible text is made of that symbol
(`scaleByDensity`), reaching at most `base × 80% + symbol_color × 20%`, always
fully opaque.

## How it works

1. Reads the active theme (`workbench.colorTheme`), including themes that use
   `include` and the user's `editor.tokenColorCustomizations`.
2. Tokenizes the visible lines with the same TextMate grammars installed in
   VS Code (via `vscode-textmate` + `vscode-oniguruma`). It caches the state of
   previous lines so scrolling stays fast.
3. Picks the tokens of the configured category (or, with `auto`, of the
   category with the most characters on screen) and averages their foreground
   colors, weighted by character count (e.g. plain strings and regexes with
   different colors contribute proportionally).
4. Blends that average into the base color (black for dark themes, white for
   light themes) using `intensity` as the weight, scaled by the symbol density
   on screen (`scaleByDensity`). The result is written to
   `workbench.colorCustomizations["[Theme Name]"]["editor.background"]` in the
   user settings. When no symbol of the category is visible, the background is
   the plain base color.

The original value is restored when the extension (or the feature) is disabled,
when the theme changes, or when VS Code closes. Other color customizations are
left untouched.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `dynamicBackground.enabled` | `true` | Turns the feature on or off. |
| `dynamicBackground.symbol` | `"auto"` | `auto` (most frequent on screen), `string`, `keyword`, `variable`, `type`, `function`, `number` or `comment`. |
| `dynamicBackground.intensity` | `0.2` | Maximum weight of the symbol color in the blend (0.2 = 80% of the black/white base). |
| `dynamicBackground.scaleByDensity` | `true` | Makes the intensity proportional to the amount of visible symbols. When off, a single visible symbol applies the full intensity. |
| `dynamicBackground.densitySaturation` | `0.25` | Fraction of the visible text taken by the symbol at which the maximum intensity is reached (e.g. `0.05` for numbers/strings, which tend to be sparse). |
| `dynamicBackground.debounceMs` | `100` | Delay after scrolling before recalculating. |
| `dynamicBackground.maxTokenizeLines` | `5000` | Above this, tokenization starts at the visible area (faster, less accurate). |

## Commands

- **Dynamic Background: Toggle**
- **Dynamic Background: Select Symbol Type**
- **Dynamic Background: Reload Theme and Grammars**

You can follow the calculations in the *Output → Dynamic Background* panel (use
*Developer: Set Log Level* → *Debug* to see every recalculation).

## Remote development (Dev Containers, SSH, WSL)

The extension runs on the local (UI) side, where your color theme is installed.
It still reads the remote files through the editor, so no installation inside
the container is required. If it was previously installed in a container,
uninstall it there and install it locally.

## Limitations

- VS Code has no API to change the editor color directly. The only way is to
  write `workbench.colorCustomizations` to the user's `settings.json`, so that
  file is rewritten (debounced, and only when the color changes). If you use
  Settings Sync, this key is synchronized too.
- An `editor.background` set in the **workspace** settings takes precedence and
  cancels the effect.
- With several windows open, the focused window sets the color (the setting is
  global).
- Classification relies on TextMate scopes. Semantic highlighting colors (provided
  by language servers) are not taken into account.

## Development

```sh
npm install
npm run compile      # or: npm run watch
```

Press `F5` in VS Code to open a development window with the extension.
To build the `.vsix` package: `npm run package`.

## License

Released under the [MIT License](LICENSE).
