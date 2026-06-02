# scripts/

## geocode.js — Permanent fix for bad coordinates

Why this exists: the browser-side live geocoder hits Nominatim with no `User-Agent` header (policy violation; throttled) and saves every low-quality result into Firebase, where wrong coords persist forever and propagate to every device. The fix is to geocode offline, once, with proper headers and quality filtering, and bake the results into the app.

### Run it

Requires Node 18+ (uses built-in `fetch`). No npm install needed.

```powershell
cd D:\OPHANIM\Andsons-Ops
node scripts\geocode.js
```

Run time: ~15-25 minutes (1.1 second delay between Nominatim requests to respect their fair-use policy). You can leave it running unattended. It caches progress to `scripts/output/.geocode-cache.json` and is safe to re-run if interrupted.

### Output

- `scripts/output/verified-coords.js` — drop-in JS file exporting `window.VERIFIED_COORDS = { "LOT 1|0": {lat, lng, source}, ... }`. Include it via `<script src="scripts/output/verified-coords.js"></script>` near the top of `<head>` in `index.html`.
- `scripts/output/UNRESOLVED.csv` — sites where Nominatim returned nothing within the quality filter. Review these manually and use the in-app "PASTE GOOGLE MAPS URL" feature to fix them one by one.
- `scripts/output/.geocode-cache.json` — progress cache so re-runs are fast. Add to `.gitignore`.

### How quality filtering works

For each site:
1. Address is normalized (`Brgy.` → `Barangay`, removes `#`, fixes known typos like "Aurotra" → "Aurora").
2. Nominatim is queried with `countrycodes=ph`, the PH bounding box (4.5°-21.5° N, 116°-127° E), and `bounded=1`.
3. Results are filtered: must be inside PH bbox, and if a province centroid is known for the site's claimed division, must be within 80 km of it.
4. The highest-importance surviving result wins.
5. If no result survives filtering, falls back to the province centroid (still useful — drivers know which town to head to, just not the exact spot).
6. If no province centroid is known either, the site is written to UNRESOLVED.csv.

### After it finishes

1. Inspect `UNRESOLVED.csv`. For each row, open the site in the app (search by district name) and use "PASTE GOOGLE MAPS URL".
2. Add this line to `index.html` (just after the Firebase scripts):

   ```html
   <script src="scripts/output/verified-coords.js"></script>
   ```

3. In `index.html`, find the function `_applyGeocacheToSites` (around line 1428). Right after the `Object.keys(_geocache).forEach(...)` loop, add:

   ```javascript
   // Verified coords (from scripts/geocode.js) override the Firebase geocache
   if (window.VERIFIED_COORDS) {
     Object.keys(window.VERIFIED_COORDS).forEach(function(key){
       var ss = getSS(key);
       var v = window.VERIFIED_COORDS[key];
       ss.lat = v.lat;
       ss.lng = v.lng;
     });
   }
   ```

4. **Clear the bad Firebase geocache** so the system doesn't re-load wrong coords. In Firebase Console → Realtime Database, find the `geocache/` node and click the X to delete it. The verified coords will then be applied on next page load. (Or, more aggressive: delete `state/sites/*/lat` and `state/sites/*/lng` keys too, so previously-saved bad coords on the live state are also wiped.)
5. Commit and push.

### Future improvements

- Add HOTOSM PH Education Facilities matching as a pre-step (better hit rate for actual schools).
- Add a Google Maps Geocoding fallback for sites Nominatim can't find (requires a key; trade-offs in EVALUATION.md section 4).
- Add reverse-geocoding to validate each result lands inside the claimed barangay/municipality polygon.
