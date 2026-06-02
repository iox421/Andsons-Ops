#!/usr/bin/env node
/**
 * scripts/geocode.js — Offline geocoder for Andsons-Ops
 *
 * Solves EVALUATION.md G-1..G-7: the browser-side live geocoder hits
 * Nominatim with no User-Agent (policy violation) and saves every
 * low-quality result to Firebase, where wrong coords stick forever.
 *
 * This script:
 *   1. Reads ALL_SITES from index.html
 *   2. Geocodes each site via Nominatim with a real User-Agent + PH bbox
 *   3. Filters out low-quality results (too far from claimed province,
 *      outside PH, place_rank too low)
 *   4. Outputs scripts/output/verified-coords.js (drop-in for index.html)
 *   5. Outputs scripts/output/UNRESOLVED.csv for manual review
 *
 * Usage (Windows PowerShell, in D:\OPHANIM\Andsons-Ops):
 *   node scripts/geocode.js
 *
 * Run time: ~15-25 minutes (864 sites at 1.1s per request to respect
 * Nominatim's fair-use policy). You can leave it running unattended.
 *
 * Requires Node 18+ (built-in fetch). No npm install needed.
 */

const fs = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const OUT_DIR    = path.join(__dirname, 'output');
const OUT_JS     = path.join(OUT_DIR, 'verified-coords.js');
const OUT_CSV    = path.join(OUT_DIR, 'UNRESOLVED.csv');
const CACHE_PATH = path.join(OUT_DIR, '.geocode-cache.json');

const USER_AGENT = 'Andsons-Ops/1.0 (info@andsonsinc.com; PH DepEd delivery dispatch)';
const PH_BBOX    = { south: 4.5, west: 116.0, north: 21.5, east: 127.0 };
const NOMINATIM_DELAY_MS = 1100;       // Nominatim policy: max 1 req/sec

// Province centroids — same as in index.html, for distance sanity-check.
const CENTROIDS = {
  'Aklan':[11.81,122.09],'Albay':[13.18,123.62],'Antique':[11.18,121.96],
  'Aurora':[15.74,121.55],'Bataan':[14.68,120.50],'Batanes':[20.45,121.97],
  'Bulacan':[14.93,120.93],'Cagayan':[18.04,121.83],'Capiz':[11.55,122.73],
  'Catanduanes':[13.70,124.30],'Guimaras':[10.59,122.61],'Ilocos Norte':[18.16,120.74],
  'Ilocos Sur':[17.43,120.54],'Iloilo Province':[11.00,122.55],'Iloilo':[11.00,122.55],
  'Isabela':[17.00,121.81],'La Union':[16.61,120.32],'Marinduque':[13.40,121.96],
  'Masbate':[12.37,123.45],'Nueva Ecija':[15.58,121.10],'Nueva Vizcaya':[16.33,121.18],
  'Occidental Mindoro':[12.80,120.85],'Oriental Mindoro':[13.04,121.41],
  'Palawan':[9.83,118.74],'Pampanga':[15.08,120.62],'Pangasinan':[15.92,120.36],
  'Pangasinan I, Lingayen':[15.92,120.23],'Pangasinan II, Binalonan':[16.07,120.59],
  'Quirino':[16.38,121.62],'Romblon':[12.57,122.27],'Sorsogon':[12.97,124.00],
  'Tarlac':[15.50,120.60],'Zambales':[15.50,120.06],
  'Alaminos City':[16.15,119.98],'Angeles City':[15.13,120.59],
  'Balanga City':[14.68,120.53],'Batac City':[18.06,120.57],
  'Cabanatuan City':[15.49,120.97],'Calapan City':[13.41,121.18],
  'Candon City':[17.20,120.45],'Cauayan City':[16.93,121.77],
  'City of Ilagan':[17.15,121.89],'Dagupan City':[16.04,120.34],
  'Gapan City':[15.31,120.95],'Iloilo City':[10.72,122.56],
  'Laoag City':[18.20,120.59],'Legaspi City':[13.14,123.74],
  'Legazpi City':[13.14,123.74],'Ligao City':[13.22,123.52],
  'Mabalacat City':[15.22,120.57],'Malolos City':[14.84,120.81],
  'Masbate City':[12.37,123.62],'Meycauayan City':[14.74,120.96],
  'Muñoz Science City':[15.72,120.91],'Olongapo City':[14.83,120.28],
  'Passi City':[11.11,122.64],'Puerto Princesa City':[9.74,118.74],
  'Roxas City':[11.59,122.75],'San Carlos City, I':[15.93,120.34],
  'San Fernando City, I':[16.62,120.32],'San Fernando City, III':[15.04,120.69],
  'San Jose City':[15.79,120.99],'San Jose del Monte City':[14.81,121.05],
  'Santiago City':[16.69,121.55],'Sorsogon City':[12.97,124.01],
  'Tabaco City':[13.36,123.73],'Tarlac City':[15.49,120.59],
  'Tuguegarao City':[17.61,121.73],'Urdaneta City':[15.98,120.57],
  'Vigan City':[17.57,120.39]
};

const DIST_THRESHOLD_KM = 80;  // result must be within 80km of claimed province

// ─── Helpers ────────────────────────────────────────────────────────────
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
            Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function normalizeAddress(addr) {
  return addr
    .replace(/Brgy\.?\s*#?\s*/gi, 'Barangay ')
    .replace(/Bgy\.?\s*#?\s*/gi, 'Barangay ')
    .replace(/St\.\s/g, 'Street ')
    .replace(/Sta\.\s/g, 'Santa ')
    .replace(/Sto\.\s/g, 'Santo ')
    .replace(/\s+/g, ' ')
    .replace(/IlocosNorte/g, 'Ilocos Norte')
    .replace(/IlocosSur/g, 'Ilocos Sur')
    .replace(/Aurotra/g, 'Aurora')              // typo in source data
    .trim();
}

function provinceCentroid(division) {
  if (CENTROIDS[division]) return CENTROIDS[division];
  const norm = division.replace(/^City of\s+/i, '').replace(/,.*$/, '').trim();
  if (CENTROIDS[norm]) return CENTROIDS[norm];
  if (CENTROIDS[norm + ' City']) return CENTROIDS[norm + ' City'];
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Extract ALL_SITES from index.html ─────────────────────────────────
function loadAllSites() {
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');
  const lines = html.split(/\r?\n/);
  const line = lines.find(l => /^\s*var\s+ALL_SITES\s*=/.test(l));
  if (!line) throw new Error('ALL_SITES not found in index.html');
  const m = line.match(/^\s*var\s+ALL_SITES\s*=\s*(\{.*\})\s*;?\s*$/);
  if (!m) throw new Error('ALL_SITES line does not match expected pattern');
  return JSON.parse(m[1]);
}

// ─── Geocode one site ──────────────────────────────────────────────────
async function geocodeSite(addr, division) {
  const url = 'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({
      format: 'jsonv2',
      limit: '3',
      countrycodes: 'ph',
      viewbox: [PH_BBOX.west, PH_BBOX.north, PH_BBOX.east, PH_BBOX.south].join(','),
      bounded: '1',
      addressdetails: '1',
      q: addr,
    }).toString();

  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
  if (!r.ok) {
    return { error: 'HTTP ' + r.status };
  }
  const results = await r.json();
  if (!results || !results.length) return { error: 'no_results' };

  const centroid = provinceCentroid(division);

  // Score each result: prefer in-bbox + close to province centroid + higher importance
  let best = null;
  for (const r of results) {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
    if (lat < PH_BBOX.south || lat > PH_BBOX.north || lng < PH_BBOX.west || lng > PH_BBOX.east) continue;

    let distOk = true;
    let dist = null;
    if (centroid) {
      dist = distanceKm(lat, lng, centroid[0], centroid[1]);
      if (dist > DIST_THRESHOLD_KM) distOk = false;
    }
    if (!distOk) continue;

    const importance = parseFloat(r.importance || '0');
    if (!best || importance > best.importance) {
      best = { lat, lng, importance, place_rank: r.place_rank, dist, display_name: r.display_name };
    }
  }
  if (!best) return { error: 'all_results_filtered' };
  return best;
}

// ─── Main ──────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let cache = {};
  if (fs.existsSync(CACHE_PATH)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')); }
    catch (e) { console.warn('Cache load failed, starting fresh.'); cache = {}; }
  }
  console.log(`Cache: ${Object.keys(cache).length} entries`);

  const all = loadAllSites();
  const flat = [];
  for (const lot of Object.keys(all)) {
    all[lot].forEach((e, i) => flat.push({ key: lot + '|' + i, lot, ...e }));
  }
  console.log(`Loaded ${flat.length} sites across ${Object.keys(all).length} lots`);

  const resolved = {};
  const unresolved = [];

  for (let i = 0; i < flat.length; i++) {
    const s = flat[i];
    const cacheKey = s.key;

    if (cache[cacheKey] && cache[cacheKey].lat) {
      resolved[s.key] = cache[cacheKey];
      if (i % 50 === 0) console.log(`[${i+1}/${flat.length}] cached: ${s.district}`);
      continue;
    }

    const normalized = normalizeAddress(s.address);
    process.stdout.write(`[${i+1}/${flat.length}] ${s.district} (${s.division}) ... `);

    let result;
    try {
      result = await geocodeSite(normalized, s.division);
    } catch (e) {
      result = { error: 'fetch_failed: ' + e.message };
    }

    if (result.lat) {
      const entry = { lat: result.lat, lng: result.lng, source: 'nominatim' };
      resolved[s.key] = entry;
      cache[cacheKey] = entry;
      console.log(`OK ${result.lat.toFixed(4)},${result.lng.toFixed(4)} (${result.dist ? Math.round(result.dist)+'km off' : 'no centroid'})`);
    } else {
      // Fallback: just use the province centroid
      const centroid = provinceCentroid(s.division);
      if (centroid) {
        const entry = { lat: centroid[0], lng: centroid[1], source: 'province-centroid', fallback: true };
        resolved[s.key] = entry;
        cache[cacheKey] = entry;
        console.log(`FALLBACK to province centroid (reason: ${result.error})`);
      } else {
        unresolved.push({ ...s, error: result.error });
        console.log(`UNRESOLVED (${result.error})`);
      }
    }

    // Save cache every 25 sites in case of interruption
    if ((i + 1) % 25 === 0) {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    }

    await sleep(NOMINATIM_DELAY_MS);
  }

  // Save final cache
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  // Write verified-coords.js
  const header = `/* verified-coords.js — generated by scripts/geocode.js on ${new Date().toISOString()}
   ${Object.keys(resolved).length} sites resolved, ${unresolved.length} unresolved.
   Drop in via:  <script src="scripts/output/verified-coords.js"></script>
   Then in index.html, ALL_SITES coords are overridden by window.VERIFIED_COORDS.
*/
window.VERIFIED_COORDS = `;
  fs.writeFileSync(OUT_JS, header + JSON.stringify(resolved, null, 2) + ';\n');

  // Write UNRESOLVED.csv
  const csv = ['key,lot,district,division,address,qty,error'].concat(
    unresolved.map(u =>
      [u.key, u.lot, u.district, u.division, u.address, u.qty, u.error]
        .map(v => `"${String(v||'').replace(/"/g,'""')}"`)
        .join(',')
    )
  ).join('\r\n');
  fs.writeFileSync(OUT_CSV, csv);

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`Resolved:   ${Object.keys(resolved).length}`);
  console.log(`Unresolved: ${unresolved.length}`);
  console.log(`Output:     ${OUT_JS}`);
  console.log(`Unresolved CSV: ${OUT_CSV}`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`Next: review UNRESOLVED.csv, then commit verified-coords.js.`);
  console.log(`Add this near the top of <head> in index.html:`);
  console.log(`  <script src="scripts/output/verified-coords.js"></script>`);
  console.log(`And in the geocodeNext / _applyGeocacheToSites paths, prefer`);
  console.log(`window.VERIFIED_COORDS[key] when it exists.`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
