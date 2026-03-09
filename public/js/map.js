// ── Mapbox token loaded from server ──────────────────────────────────────────
// Token is injected at runtime via GET /api/config so it never lives in source.
// All map initialisation is deferred until the token resolves.
async function loadMapboxToken() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`/api/config returned ${res.status}`);
  const { mapboxToken } = await res.json();
  if (!mapboxToken) throw new Error('mapboxToken missing in /api/config response');
  return mapboxToken;
}

// ── Escape HTML special characters in any data value inserted into HTML ───────
// Prevents XSS if city names or source names contain <, >, ", & characters.
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Color palette ─────────────────────────────────────────────────────────────
// green / yellow / red sentiment; multi-hue palette for source segments
const SENTIMENT_COLORS = {
  positive: '#62C370',
  neutral:  '#F5C842',
  negative: '#B63634',
};

const SOURCE_PALETTE = [
  '#60A5FA', // blue
  '#A78BFA', // violet
  '#34D399', // emerald
  '#FB923C', // orange
  '#F472B6', // pink
  '#FBBF24', // amber
  '#38BDF8', // sky
  '#4ADE80', // lime
];

// ── Bar geometry (geographic degrees) ────────────────────────────────────────
// At equator: 0.15° ≈ 17km width, 0.10° ≈ 11km depth.
// Bars are tiny in footprint but extrusion height (500km) makes dramatic spikes
// visible from globe orbit, growing into detailed bar charts as you zoom in.
const BAR_W   = 0.15;    // bar width in degrees
const BAR_D   = 0.10;    // bar depth in degrees
const BAR_GAP = 0.05;    // gap between adjacent columns
const MAX_H   = 500000;  // max extrusion height in metres (500km)

// Create a rectangular GeoJSON polygon footprint for one bar column
function barRect(lng, lat, dxOffset) {
  const x0 = lng + dxOffset - BAR_W / 2;
  const x1 = lng + dxOffset + BAR_W / 2;
  const y0 = lat - BAR_D / 2;
  const y1 = lat + BAR_D / 2;
  return {
    type: 'Polygon',
    coordinates: [[ [x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0] ]],
  };
}

// Build all GeoJSON Feature objects for one city:
//   columns 1-3  → sentiment bars (positive | neutral | negative)
//   column  4    → stacked source bar (one segment per source, stacked by base height)
function buildCityFeatures(city, heightScale) {
  const features = [];
  const step = BAR_W + BAR_GAP;

  // — Sentiment bars ——————————————————————————————————————————————————————————
  const sentimentDefs = [
    { key: 'positive', dx: -step },
    { key: 'neutral',  dx: 0     },
    { key: 'negative', dx: +step },
  ];

  for (const { key, dx } of sentimentDefs) {
    features.push({
      type: 'Feature',
      geometry: barRect(city.lng, city.lat, dx),
      properties: {
        city:        city.city,
        barType:     'sentiment',
        sentiment:   key,
        color:       SENTIMENT_COLORS[key],
        height:      Math.max(city[key] * heightScale, 5000),  // floor: 5km so bar is always visible
        base:        0,
        count:       city[key],
        total:       city.total,
        positive:    city.positive,
        neutral:     city.neutral,
        negative:    city.negative,
        sources:     JSON.stringify(city.sources || []),
        lastUpdated: city.last_updated || '',
      },
    });
  }

  // — Stacked source bar ——————————————————————————————————————————————————————
  // Each source = one fill-extrusion segment; base = cumulative height so far.
  const sources = city.sources || [];
  sources.reduce((baseH, src, i) => {
    const segH = Math.max(src.total * heightScale, 2000);
    features.push({
      type: 'Feature',
      geometry: barRect(city.lng, city.lat, 3 * step),
      properties: {
        city:           city.city,
        barType:        'source',
        sourceName:     src.source_name,
        sourceCategory: src.source_category,
        color:          SOURCE_PALETTE[i % SOURCE_PALETTE.length],
        height:         baseH + segH,
        base:           baseH,
        count:          src.total,
        total:          city.total,
        positive:       src.positive,
        neutral:        src.neutral,
        negative:       src.negative,
        allSources:     JSON.stringify(sources),
        lastUpdated:    city.last_updated || '',
      },
    });
    return baseH + segH;
  }, 0);

  return features;
}

// ── Tooltip HTML ──────────────────────────────────────────────────────────────
// Renders a rich, dark-themed card with inline sentiment mini-bars + source table.
// All dynamic values are HTML-escaped via esc() to prevent XSS.
function buildTooltip(p) {
  const t   = parseInt(p.total)    || 0;
  const pos = parseInt(p.positive) || 0;
  const neu = parseInt(p.neutral)  || 0;
  const neg = parseInt(p.negative) || 0;

  // Mini horizontal bar for one sentiment dimension
  const sentimentRow = (label, count, color) => {
    const pct = t > 0 ? Math.round(count / t * 100) : 0;
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <span style="width:56px;font-size:11px;color:${color};font-weight:600">${esc(label)}</span>
        <div style="flex:1;height:5px;background:#1e293b;border-radius:3px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${color};border-radius:3px"></div>
        </div>
        <span style="font-size:11px;color:#64748b;width:30px;text-align:right">${pct}%</span>
        <span style="font-size:11px;color:#475569;width:22px;text-align:right">${count}</span>
      </div>`;
  };

  // Highlighted badge showing which bar type is hovered
  let focusBadge = '';
  const sentiment = esc(p.sentiment || '');
  if (p.barType === 'sentiment' && sentiment) {
    const c = SENTIMENT_COLORS[p.sentiment] || '#888';
    focusBadge = `<div style="display:inline-block;background:${c}20;color:${c};font-size:10px;padding:2px 8px;border-radius:12px;margin-bottom:10px;border:1px solid ${c}40">
      ${sentiment.toUpperCase()} BAR · ${parseInt(p.count) || 0} posts
    </div>`;
  } else if (p.barType === 'source') {
    const c = esc(p.color || '#888');
    focusBadge = `<div style="display:inline-block;background:${c}20;color:${c};font-size:10px;padding:2px 8px;border-radius:12px;margin-bottom:10px;border:1px solid ${c}40">
      SOURCE: ${esc(p.sourceName)} · ${esc(p.sourceCategory)}
    </div>`;
  }

  // Source breakdown table — parsed from serialized JSON in properties
  let sourceTable = '';
  try {
    const sources = JSON.parse(p.sources || p.allSources || '[]');
    if (sources.length > 0) {
      const rows = sources.map((s, i) => `
        <tr>
          <td style="padding:3px 0">
            <span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${SOURCE_PALETTE[i % SOURCE_PALETTE.length]};margin-right:5px;vertical-align:middle"></span>
            <span style="color:#cbd5e1">${esc(s.source_name)}</span>
            <span style="color:#334155;font-size:9px;margin-left:4px">${esc(s.source_category)}</span>
          </td>
          <td style="color:#62C370;text-align:right;padding:3px 3px">${parseInt(s.positive) || 0}</td>
          <td style="color:#F5C842;text-align:right;padding:3px 3px">${parseInt(s.neutral)  || 0}</td>
          <td style="color:#B63634;text-align:right;padding:3px 3px">${parseInt(s.negative) || 0}</td>
          <td style="color:#475569;text-align:right;padding:3px 0">${parseInt(s.total)    || 0}</td>
        </tr>`).join('');

      sourceTable = `
        <div style="border-top:1px solid #1e293b;margin:10px 0 8px"></div>
        <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">SOURCE BREAKDOWN</div>
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead>
            <tr style="color:#334155;font-size:9px">
              <th style="text-align:left;padding-bottom:4px">Source</th>
              <th style="color:#62C370;text-align:right;padding-bottom:4px">+</th>
              <th style="color:#F5C842;text-align:right;padding-bottom:4px">○</th>
              <th style="color:#B63634;text-align:right;padding-bottom:4px">−</th>
              <th style="color:#475569;text-align:right;padding-bottom:4px">all</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    }
  } catch (_) { /* malformed JSON in properties — skip source table */ }

  return `
    <div style="background:#0f172a;color:#f8fafc;padding:16px;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui;min-width:260px;max-width:320px;border:1px solid #1e293b;box-shadow:0 8px 32px rgba(0,0,0,0.7)">
      <div style="font-size:15px;font-weight:700;margin-bottom:2px">${esc(p.city)}</div>
      <div style="font-size:11px;color:#475569;margin-bottom:10px">${t.toLocaleString()} posts analyzed</div>
      ${focusBadge}
      <div style="font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.8px;margin-bottom:7px">SENTIMENT</div>
      ${sentimentRow('Positive', pos, '#62C370')}
      ${sentimentRow('Neutral',  neu, '#F5C842')}
      ${sentimentRow('Negative', neg, '#B63634')}
      ${sourceTable}
    </div>`;
}

// ── Demo fallback data ────────────────────────────────────────────────────────
// Used when the API returns empty (DB not yet seeded). Showcases all visual elements.
const DEMO_DATA = [
  { city:'San Francisco', lat:37.7749,  lng:-122.4194, positive:142, neutral:89,  negative:47,  total:278, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',      source_category:'social',   positive:65, neutral:40, negative:20, total:125 },
      { source_name:'hacker_news', source_category:'tech',     positive:50, neutral:30, negative:15, total:95  },
      { source_name:'arxiv',       source_category:'academic', positive:27, neutral:19, negative:12, total:58  },
    ]},
  { city:'New York',      lat:40.7128,  lng:-74.0060,  positive:178, neutral:134, negative:88,  total:400, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',       source_category:'social',   positive:70, neutral:55, negative:35, total:160 },
      { source_name:'nytimes_tech', source_category:'news',     positive:50, neutral:45, negative:30, total:125 },
      { source_name:'hacker_news',  source_category:'tech',     positive:38, neutral:24, negative:15, total:77  },
      { source_name:'arxiv',        source_category:'academic', positive:20, neutral:10, negative:8,  total:38  },
    ]},
  { city:'London',        lat:51.5074,  lng:-0.1278,   positive:88,  neutral:112, negative:67,  total:267, dominant:'neutral',  last_updated:new Date().toISOString(),
    sources:[
      { source_name:'guardian_tech', source_category:'news',   positive:30, neutral:55, negative:32, total:117 },
      { source_name:'reddit',        source_category:'social', positive:38, neutral:40, negative:22, total:100 },
      { source_name:'bbc_tech',      source_category:'news',   positive:20, neutral:17, negative:13, total:50  },
    ]},
  { city:'Berlin',        lat:52.5200,  lng:13.4050,   positive:55,  neutral:78,  negative:102, total:235, dominant:'negative', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',        source_category:'social',   positive:20, neutral:35, negative:45, total:100 },
      { source_name:'eu_commission', source_category:'policy',   positive:10, neutral:30, negative:42, total:82  },
      { source_name:'arxiv',         source_category:'academic', positive:25, neutral:13, negative:15, total:53  },
    ]},
  { city:'Tokyo',         lat:35.6762,  lng:139.6503,  positive:195, neutral:67,  negative:30,  total:292, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',  source_category:'social',   positive:80, neutral:30, negative:15, total:125 },
      { source_name:'twitter', source_category:'social',   positive:75, neutral:25, negative:8,  total:108 },
      { source_name:'arxiv',   source_category:'academic', positive:40, neutral:12, negative:7,  total:59  },
    ]},
  { city:'Beijing',       lat:39.9042,  lng:116.4074,  positive:210, neutral:80,  negative:40,  total:330, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'weibo',  source_category:'social',   positive:90, neutral:35, negative:20, total:145 },
      { source_name:'arxiv',  source_category:'academic', positive:75, neutral:25, negative:10, total:110 },
      { source_name:'xinhua', source_category:'news',     positive:45, neutral:20, negative:10, total:75  },
    ]},
  { city:'Singapore',     lat:1.3521,   lng:103.8198,  positive:120, neutral:55,  negative:25,  total:200, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',        source_category:'social',   positive:60, neutral:25, negative:10, total:95  },
      { source_name:'arxiv',         source_category:'academic', positive:40, neutral:20, negative:10, total:70  },
      { source_name:'straits_times', source_category:'news',     positive:20, neutral:10, negative:5,  total:35  },
    ]},
  { city:'Seoul',         lat:37.5665,  lng:126.9780,  positive:155, neutral:60,  negative:25,  total:240, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',      source_category:'social',   positive:70, neutral:28, negative:12, total:110 },
      { source_name:'korea_times', source_category:'news',     positive:55, neutral:20, negative:8,  total:83  },
      { source_name:'arxiv',       source_category:'academic', positive:30, neutral:12, negative:5,  total:47  },
    ]},
  { city:'São Paulo',     lat:-23.5505, lng:-46.6333,  positive:65,  neutral:88,  negative:47,  total:200, dominant:'neutral',  last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit', source_category:'social',   positive:35, neutral:40, negative:20, total:95 },
      { source_name:'folha',  source_category:'news',     positive:20, neutral:35, negative:20, total:75 },
      { source_name:'arxiv',  source_category:'academic', positive:10, neutral:13, negative:7,  total:30 },
    ]},
  { city:'Bangalore',     lat:12.9716,  lng:77.5946,   positive:145, neutral:55,  negative:20,  total:220, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',         source_category:'social',   positive:70, neutral:28, negative:10, total:108 },
      { source_name:'times_of_india', source_category:'news',     positive:45, neutral:17, negative:6,  total:68  },
      { source_name:'arxiv',          source_category:'academic', positive:30, neutral:10, negative:4,  total:44  },
    ]},
  { city:'Sydney',        lat:-33.8688, lng:151.2093,  positive:98,  neutral:67,  negative:35,  total:200, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',   source_category:'social',   positive:55, neutral:35, negative:15, total:105 },
      { source_name:'abc_tech', source_category:'news',     positive:30, neutral:22, negative:13, total:65  },
      { source_name:'arxiv',    source_category:'academic', positive:13, neutral:10, negative:7,  total:30  },
    ]},
  { city:'Toronto',       lat:43.6532,  lng:-79.3832,  positive:88,  neutral:72,  negative:40,  total:200, dominant:'positive', last_updated:new Date().toISOString(),
    sources:[
      { source_name:'reddit',   source_category:'social',   positive:45, neutral:35, negative:20, total:100 },
      { source_name:'cbc_tech', source_category:'news',     positive:30, neutral:25, negative:15, total:70  },
      { source_name:'arxiv',    source_category:'academic', positive:13, neutral:12, negative:5,  total:30  },
    ]},
];

// ── Map initialization (deferred until token is available) ────────────────────
let map;

async function initMap() {
  try {
    mapboxgl.accessToken = await loadMapboxToken();
  } catch (err) {
    console.error('[map] Failed to load Mapbox token:', err.message);
    document.getElementById('map').textContent = 'Map unavailable — token not configured.';
    return;
  }

  map = new mapboxgl.Map({
    container:  'map',
    style:      'mapbox://styles/mapbox/dark-v11',  // dark base makes colored spikes pop
    projection: 'globe',
    center:     [10, 20],  // balanced globe view: Europe/Africa axis
    zoom:       1.5,
    pitch:      0,         // flat globe overview; 3D bars revealed as user zooms in
    hash:       true,
  });

// ── Gesture configuration ────────────────────────────────────────────────────
// dragRotate disabled: in globe projection it intercepts left-click+drag for
// bearing-only rotation, preventing true 2D pan.
// dragPan disabled: replaced by custom handler below for true lat/lng panning.
map.dragRotate.disable();
map.dragPan.disable();
map.scrollZoom.enable();
map.doubleClickZoom.enable();
map.touchZoomRotate.enable();

// ── Custom left-click drag: pan globe in any direction ───────────────────────
// Formula: pixelsPerDegree = (256 × 2^zoom) / 360
const GLOBE_PAN_MAX_ZOOM = 4;

map.on('load', () => {
  const canvas = map.getCanvas();

  let isDragging = false, dragLastX = 0, dragLastY = 0;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragLastX;
    const dy = e.clientY - dragLastY;
    dragLastX = e.clientX;
    dragLastY = e.clientY;
    const pixelsPerDegree = (256 * Math.pow(2, map.getZoom())) / 360;
    const center = map.getCenter();
    map.setCenter([
      center.lng - dx / pixelsPerDegree,
      Math.max(-85, Math.min(85, center.lat - dy / pixelsPerDegree)),
    ]);
  });

  const stopDrag = () => { isDragging = false; canvas.style.cursor = ''; };
  canvas.addEventListener('mouseup', stopDrag);
  window.addEventListener('mouseup', stopDrag);

  // ── Trackpad swipe-to-pan ─────────────────────────────────────────────────
  canvas.addEventListener('wheel', (e) => {
    if (map.getZoom() > GLOBE_PAN_MAX_ZOOM) return;
    if (e.ctrlKey) return;
    if (e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
    const hasMeaningfulX = Math.abs(e.deltaX) > 1;
    if (!hasMeaningfulX && Math.abs(e.deltaY) > 30) return;

    e.preventDefault();
    e.stopPropagation();

    const sensitivity = Math.max(0.02, 0.4 / Math.pow(2, map.getZoom() - 1));
    const center = map.getCenter();
    map.setCenter([
      center.lng + e.deltaX * sensitivity,
      Math.max(-85, Math.min(85, center.lat - e.deltaY * sensitivity)),
    ]);
  }, { passive: false });
});

// ── Style load: add data layers ───────────────────────────────────────────────
map.on('style.load', async () => {
  // Atmosphere effect (dark theme variant — deep space with subtle blue upper atmosphere)
  map.setFog({
    'color':          'rgb(15, 22, 40)',
    'high-color':     'rgb(40, 80, 160)',
    'horizon-blend':  0.03,
    'space-color':    'rgb(5, 8, 20)',
    'star-intensity': 0.65,
  });

  // Fetch live city data; fall back to demo data if DB is empty or unreachable
  let cities = [];
  try {
    const res = await fetch('/api/posts/aggregated-by-location');
    const data = await res.json();
    cities = data.filter(c => c.lat != null && c.lng != null);
  } catch (_) { /* network error — use demo */ }
  if (cities.length === 0) cities = DEMO_DATA;

  // Scale all bar heights so the tallest sentiment count reaches MAX_H (500km)
  const maxCount = Math.max(...cities.flatMap(c => [c.positive, c.neutral, c.negative]), 1);
  const heightScale = MAX_H / maxCount;

  // ── Circle layer: globe overview (zoom 0–4, fades as 3D bars emerge) ──────
  // Colored by dominant sentiment; disappears as bars fade in at zoom 2–3.
  const circleFeatures = cities.map(city => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [city.lng, city.lat] },
    properties: {
      city:     city.city,
      color:    SENTIMENT_COLORS[city.dominant] || SENTIMENT_COLORS.neutral,
      total:    city.total,
      positive: city.positive,
      neutral:  city.neutral,
      negative: city.negative,
      sources:  JSON.stringify(city.sources || []),
      barType:  'circle',
    },
  }));

  map.addSource('city-circles', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: circleFeatures },
  });

  map.addLayer({
    id:      'city-circle-dots',
    type:    'circle',
    source:  'city-circles',
    maxzoom: 5,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 8, 2, 12, 3, 10, 4, 6],
      'circle-color':  ['get', 'color'],
      // Fade out circles as 3D bars emerge (zoom 2 → 4)
      'circle-opacity':        ['interpolate', ['linear'], ['zoom'], 2, 0.9, 4, 0],
      'circle-stroke-color':   'rgba(255,255,255,0.55)',
      'circle-stroke-width':   1.5,
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 4, 0],
    },
  });

  // ── 3D bar layers ─────────────────────────────────────────────────────────
  const allFeatures = cities.flatMap(c => buildCityFeatures(c, heightScale));

  map.addSource('city-bars', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: allFeatures },
  });

  // Sentiment bars: three columns per city (positive | neutral | negative)
  map.addLayer({
    id:      'sentiment-bars',
    type:    'fill-extrusion',
    source:  'city-bars',
    filter:  ['==', ['get', 'barType'], 'sentiment'],
    minzoom: 2,
    paint: {
      'fill-extrusion-color':   ['get', 'color'],
      'fill-extrusion-height':  ['get', 'height'],
      'fill-extrusion-base':    0,
      // Fade in as circles fade out (zoom 2 → 3)
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0, 3, 0.88],
    },
  });

  // Source stacked bar: one additional column per city, segmented by source
  // Each segment uses base+height to stack on top of the previous source's segment
  map.addLayer({
    id:      'source-bars',
    type:    'fill-extrusion',
    source:  'city-bars',
    filter:  ['==', ['get', 'barType'], 'source'],
    minzoom: 2,
    paint: {
      'fill-extrusion-color':   ['get', 'color'],
      'fill-extrusion-height':  ['get', 'height'],
      'fill-extrusion-base':    ['get', 'base'],
      'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 2, 0, 3, 0.88],
    },
  });

  // ── 3D buildings at street level (official Mapbox pattern, zoom 15+) ──────
  const layers = map.getStyle().layers;
  const labelLayerId = layers.find(l => l.type === 'symbol' && l.layout['text-field'])?.id;
  if (labelLayerId) {
    map.addLayer({
      id:             'add-3d-buildings',
      source:         'composite',
      'source-layer': 'building',
      filter:         ['==', 'extrude', 'true'],
      type:           'fill-extrusion',
      minzoom:        15,
      paint: {
        'fill-extrusion-color':   '#aaa',
        'fill-extrusion-height':  ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['get', 'height']],
        'fill-extrusion-base':    ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['get', 'min_height']],
        'fill-extrusion-opacity': 0.6,
      },
    }, labelLayerId);
  }

  // ── Legend overlay (positioned bottom-left inside map container) ──────────
  const legend = document.createElement('div');
  legend.style.cssText = [
    'position:absolute', 'bottom:36px', 'left:16px',
    'background:rgba(10,17,32,0.93)', 'padding:13px 15px',
    'border-radius:9px', 'font-family:-apple-system,BlinkMacSystemFont,system-ui',
    'font-size:11px', 'border:1px solid #1e293b', 'pointer-events:none',
    'box-shadow:0 4px 20px rgba(0,0,0,0.5)', 'min-width:140px',
  ].join(';');

  const sentimentItems = [
    ['#62C370', 'Positive'],
    ['#F5C842', 'Neutral'],
    ['#B63634', 'Negative'],
  ];

  // Build legend DOM content using textContent for data values (no XSS risk)
  const legendFragment = document.createDocumentFragment();

  const sentLabel = document.createElement('div');
  sentLabel.style.cssText = 'color:#475569;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px';
  sentLabel.textContent = 'SENTIMENT BARS';
  legendFragment.appendChild(sentLabel);

  for (const [color, label] of sentimentItems) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:5px';
    const swatch = document.createElement('div');
    swatch.style.cssText = `width:10px;height:18px;background:${color};border-radius:2px;flex-shrink:0`;
    const text = document.createElement('span');
    text.style.color = '#cbd5e1';
    text.textContent = label;
    row.appendChild(swatch);
    row.appendChild(text);
    legendFragment.appendChild(row);
  }

  const divider1 = document.createElement('div');
  divider1.style.cssText = 'border-top:1px solid #1e293b;margin:9px 0 7px';
  legendFragment.appendChild(divider1);

  const srcLabel = document.createElement('div');
  srcLabel.style.cssText = 'color:#475569;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px';
  srcLabel.textContent = 'SOURCE STACK';
  legendFragment.appendChild(srcLabel);

  SOURCE_PALETTE.slice(0, 4).forEach((color, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:5px';
    const swatch = document.createElement('div');
    swatch.style.cssText = `width:10px;height:10px;background:${color};border-radius:2px;flex-shrink:0`;
    const text = document.createElement('span');
    text.style.color = '#94a3b8';
    text.textContent = `Source ${i + 1}`;
    row.appendChild(swatch);
    row.appendChild(text);
    legendFragment.appendChild(row);
  });

  const divider2 = document.createElement('div');
  divider2.style.cssText = 'border-top:1px solid #1e293b;margin:9px 0 6px';
  legendFragment.appendChild(divider2);

  const hint = document.createElement('div');
  hint.style.color = '#334155';
  hint.style.fontSize = '9px';
  hint.textContent = 'Zoom in to see bars';
  legendFragment.appendChild(hint);

  legend.appendChild(legendFragment);
  document.getElementById('map').appendChild(legend);

  // ── Tooltips ──────────────────────────────────────────────────────────────
  const popup = new mapboxgl.Popup({
    closeButton:  false,
    closeOnClick: false,
    maxWidth:     '340px',
  });

  // Attach hover handlers to all interactive layers
  for (const layerId of ['sentiment-bars', 'source-bars', 'city-circle-dots']) {
    map.on('mouseenter', layerId, (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const p = e.features[0].properties;
      popup.setLngLat(e.lngLat).setHTML(buildTooltip(p)).addTo(map);
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
      popup.remove();
    });
  }

  console.log(`✅ 3D sentiment bars loaded — ${cities.length} cities, ${allFeatures.length} bar features`);
  });
}

// Bootstrap — token fetch runs before any Mapbox GL initialisation
initMap();
