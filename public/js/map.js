mapboxgl.accessToken = 'pk.eyJ1IjoiamVubmlmZXItbWNraW5uZXkiLCJhIjoiY21mcHppYzlqMG5wcDJsb2VienBmbWExNyJ9.BVmgHfDxHPAiIWQwAyhyhA';
const SEABORN_COLORS = { negative:'#B63634', neutral:'#2E3B4E', positive:'#62C370'};

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11',
  projection: 'globe',   // globe render pipeline — swipe spins, pinch zooms
  center: [10, 20],      // balanced globe view: Europe/Africa axis
  zoom: 1.5,             // global view; sentiment dots visible on globe surface
  hash: true,
});

// Touch gestures — built into Mapbox GL JS; explicitly enabled for clarity
map.dragRotate.enable();       // click+drag rotates globe (bearing)
map.dragPan.enable();          // click+drag pans globe (moves center)
map.scrollZoom.enable();       // vertical two-finger scroll = zoom
map.doubleClickZoom.enable();  // double-tap to zoom in on mobile
map.touchZoomRotate.enable();  // pinch open = zoom in, two-finger twist = rotate

// ── MacBook trackpad swipe-to-spin ──────────────────────────────────────────
// On macOS, finger slides without clicking fire WheelEvents, not pointer events.
// Mapbox routes ALL wheel events to scrollZoom (zoom only — no spin).
// This handler intercepts predominantly-horizontal wheel deltas and converts
// them to longitude movement (globe spin), leaving vertical scroll for zoom.
map.on('load', () => {
  const canvas = map.getCanvas();
  canvas.addEventListener('wheel', (e) => {
    const isHorizontalSwipe = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (!isHorizontalSwipe) return;   // vertical scroll → Mapbox zoom as normal

    e.preventDefault();               // stop Mapbox from also treating this as zoom
    e.stopPropagation();

    // Sensitivity scales with zoom: globe view needs large moves, street view small
    const sensitivity = Math.max(0.02, 0.4 / Math.pow(2, map.getZoom() - 1));
    const center = map.getCenter();
    map.setCenter([center.lng + e.deltaX * sensitivity, center.lat]);
  }, { passive: false });
});

map.on('style.load', async () => {
  // Atmosphere effect — only renders in globe projection
  map.setFog({
    'color':           'rgb(220, 230, 242)',  // lower atmosphere haze
    'high-color':      'rgb(90, 140, 220)',   // upper atmosphere blue
    'horizon-blend':   0.03,                  // soft blend at horizon
    'space-color':     'rgb(8, 12, 30)',      // deep space / night sky
    'star-intensity':  0.5,                   // subtle stars when zoomed out
  });

  try {
    // Get city data
    const res = await fetch('/api/posts/aggregated-by-location');
    const cities = await res.json();

    // Add sentiment markers FIRST
    const sentimentMarkers = cities.map(city => {
      const max = Math.max(city.positive, city.neutral, city.negative);
      let dominant = 'neutral', color = SEABORN_COLORS.neutral;
      if (max === city.positive) { dominant = 'positive'; color = SEABORN_COLORS.positive; }
      if (max === city.negative) { dominant = 'negative'; color = SEABORN_COLORS.negative; }
      return { 
        type: 'Feature', 
        geometry: { type: 'Point', coordinates: [city.lng, city.lat] }, 
        properties: { city: city.city, dominant, color, positive: city.positive, neutral: city.neutral, negative: city.negative, total: city.total } 
      };
    });
    map.addSource('sentiment-markers', { type: 'geojson', data: { type: 'FeatureCollection', features: sentimentMarkers } });
    map.addLayer({ 
      id: 'sentiment-indicators', 
      type: 'circle', 
      source: 'sentiment-markers', 
      paint: { 
        'circle-radius': 16, 
        'circle-color': ['get','color'], 
        'circle-opacity': 0.9, 
        'circle-stroke-color': '#fff', 
        'circle-stroke-width': 2 
      } 
    });

    // OFFICIAL MAPBOX 3D BUILDINGS CODE (exact copy from docs)
    const layers = map.getStyle().layers;
    const labelLayerId = layers.find(
      (layer) => layer.type === 'symbol' && layer.layout['text-field']
    ).id;

    map.addLayer({
      'id': 'add-3d-buildings',
      'source': 'composite',
      'source-layer': 'building',
      'filter': ['==', 'extrude', 'true'],
      'type': 'fill-extrusion',
      'minzoom': 15,
      'paint': {
        'fill-extrusion-color': '#aaa',
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['zoom'],
          15, 0,
          15.05, ['get', 'height']
        ],
        'fill-extrusion-base': [
          'interpolate',
          ['linear'],
          ['zoom'],
          15, 0,
          15.05, ['get', 'min_height']
        ],
        'fill-extrusion-opacity': 0.6
      }
    }, labelLayerId);

    console.log('✅ 3D buildings loaded - official Mapbox code');

    // Tooltips
    const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
    map.on('mouseenter', 'sentiment-indicators', e => {
      map.getCanvas().style.cursor = 'pointer';
      const p = e.features[0].properties;
      const t = p.total;
      popup.setLngLat(e.lngLat).setHTML(`
        <div style="background:#0f172a;color:#f8fafc;padding:12px;border-radius:6px;font-family:system-ui;border:1px solid #334155;">
          <h3 style="margin:0 0 8px;color:#fff">${p.city}</h3>
          <div style="color:${p.color};font-weight:bold;margin-bottom:6px">${p.dominant.toUpperCase()}</div>
          <div style="font-size:12px">
            <div>+ ${Math.round(p.positive/t*100)}%</div>
            <div>○ ${Math.round(p.neutral/t*100)}%</div>
            <div>− ${Math.round(p.negative/t*100)}%</div>
          </div>
        </div>
      `).addTo(map);
    });
    map.on('mouseleave', 'sentiment-indicators', () => { 
      map.getCanvas().style.cursor = ''; 
      popup.remove(); 
    });

  } catch (e) {
    console.error('❌ Error:', e);
  }
});
