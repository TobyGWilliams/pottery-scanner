# Pot Wall Scanner

Scan a wheel-thrown, open pot (bowl, mug, cylinder) with an Android phone's browser and see
where the walls are thick and thin. Everything runs on the phone; there is no server side.

## How it works

1. **WebXR AR session** (Chrome on Android, ARCore) with `hit-test`, `depth-sensing`
   (CPU depth, raw where offered), `anchors` and `dom-overlay`.
2. You mark the pot centre on the table. Each depth frame is unprojected into 3D points
   in a frame anchored to the table (`js/depth.js`).
3. `js/analysis.js` then:
   - re-estimates the table height from depth points around the pot;
   - fits the rotation axis as the common centre of concentric rings;
   - labels each point inside/outside from where its camera ray crosses the rim plane
     (a ray can only reach the inside through the opening), which is immune to depth noise;
   - collapses all points into one (radius, height) half-section using symmetry and takes
     medians, so thousands of noisy samples average into each profile point;
   - measures thickness from the inner profile to the outer profile, or to the table under the base.
4. `js/results.js` draws the cross-section heat map, a thickness chart and a 3D cutaway.

## Running it on your phone

WebXR needs a secure origin. Two options:

- **USB (no hosting):** `npm start` on this machine, plug the phone in with USB debugging on,
  open `chrome://inspect/#devices` in desktop Chrome, add port forwarding `8080 -> localhost:8080`,
  then open `http://localhost:8080` in Chrome on the phone (localhost counts as secure).
- **Host it:** upload this folder to any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages).
  There is no build step.

The phone needs Google Play Services for AR and a device on the ARCore Depth API list.

## Scanning tips

- Matte, leather-hard or bisque surfaces scan best. Wet, shiny clay and glossy glaze scan badly.
- Put newspaper or a patterned cloth under the pot and use good light; tracking needs texture.
- Stay 30-40 cm away and move slowly. Do one lap low around the outside, then look down into
  the pot from all sides. Watch the blue (outside) and orange (inside) dots fill in.
- Keep the 22 cm circle around the pot clear of other objects.

## Accuracy, honestly

Phone depth is good to a few millimetres per point at best, and can carry a constant bias.
Averaging round the pot removes the random part, so the *pattern* (heavy base, thin belly)
is more trustworthy than the absolute millimetres. If you know the rim thickness, enter it on
the results page to anchor the scale. The lowest ~1 cm of the outside is extrapolated, and a
foot ring or hollowed base is read as solid.

## Development

- Run `npm run stamp` before each commit. It writes a build number and time to
  `js/version.js`, shown at the bottom of the homepage.
- `npm test` runs the analysis against a ray-cast synthetic pot with depth noise.
- Open `/?demo` in any browser to see the results page with that synthetic scan.
- The AR capture path (`js/scanner.js`) can only be exercised on a real device.

## Vendored three.js

`vendor/three.module.min.js` is three r169 with one local patch: its XR frame loop only
asks for GPU depth when a GPU depth binding exists. Unpatched, it throws on every frame of
a CPU-depth AR session on Android, which freezes the camera feed. Re-apply (or use a release
that includes the upstream fix) if you upgrade three.
