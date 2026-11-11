# Live Doodle · Inkbox

A local live-doodle app with traceable image references and editable layers, using the selected Inkbox artwork.

## Use online

**[Open Live Doodle](https://hurrygoooodjob.github.io/live-doodle/)**

A retro hand-drawn canvas for animated doodles, image tracing and layered exports. Drawing and imported images are processed in your browser. No account, package install or API key is required.

## Run locally

Run `python3 -m http.server 8771 --bind 127.0.0.1` in this repository and visit http://127.0.0.1:8771/ .

## Trace an image

Click **Image** in the top bar and choose a local PNG, JPEG or WebP. The reference is added as a separate locked layer at 35% opacity. Open **Layers** to adjust opacity, fit, scale or position. Draw on a layer above the reference. Image layers stay separate from editable doodle strokes.

The layer panel remains available while drawing. You can create, name, hide, lock, reorder, duplicate and delete layers. Deleting a layer and merging downward can be undone. **Merge down** combines the selected layer with the next layer below and preserves their animation and composited opacity. A merged layer retains its internal groups; it is not a frozen screenshot.

## Export

The Export dialog lists layers individually. Select the layers to include; the doodles preset excludes standalone image references. You can include a reference image explicitly. The transparent PNG option removes the paper background, independently of the layer choices. GIF exports the selected layers as a three-second loop. Video remains experimental.

**Save** writes a JSON project including layers, images and strokes. **Open** reads it back. Earlier version-1 projects are migrated to separate image/doodle layers when explicitly opened. v05 uses an independent browser draft key and does not overwrite earlier drafts. A v05 layered project requires v05 or later to preserve its layers.

## Drawing

Choose a pen, color, Size and Edge, then draw. New strokes keep a solid core and irregular edges. Live controls animation; Play starts or pauses the loop. The initial sample is paused to match the selected artwork. The small top-left icon opens additional drawing tools. Erase removes an entire stroke.

The original three example drawings are independent transparent artwork objects, with Pen/Boil/Wiggle effects. Newly drawn strokes support all six pens. Shortcuts: B draw, V select, E erase, Space play/pause, Delete remove stroke, Ctrl/Cmd Z undo, Ctrl/Cmd Shift Z redo, Ctrl/Cmd S save.

## Assets and maintenance

`assets/inkbox-original.png` is the user-selected generated artwork. Main labels, pens, halftone and irregular frame reuse that original graphic; interactive controls are real. Kalam Bold is embedded for changing numbers and secondary controls, under the included `assets/OFL.txt` license. Font source: https://github.com/google/fonts/tree/main/ofl/kalam .

`src/layers.js` implements layer operations and compositing support; `src/engine.js` draws strokes; `src/exports.js` validates and exports projects; `src/app.js` connects the controls; `src/skin.js` maintains artwork states and narrow-screen crops.

Run `python3 scripts/build.py --check`, then `python3 scripts/build.py --output-dir dist` to create a self-contained offline HTML and a versioned source package in `dist/`. Open the generated HTML directly in a browser. All runtime assets are embedded. Existing different output is not overwritten; choose a new `--version` when needed.

GitHub Pages serves the repository root from the `main` branch. `.nojekyll` keeps the static files unchanged. No build service or external CDN is needed. Runtime paths are relative so the app works under `/live-doodle/`.

## Boundaries

This is a browser-based demo, with no cloud image upload, collaborative editing or native Live Photo. Browser drafts are specific to the website origin and browser; use Save/Open to move projects between the offline and hosted versions. Layer nesting, image size and document complexity are bounded. Merged groups retain their internal visibility and opacity. Real stylus/touch performance and experimental video quality require further device testing.

## Credits and rights

Kalam Bold is distributed under the SIL Open Font License in `assets/OFL.txt`. No additional open-source license is granted for the application code or artwork in this repository.
