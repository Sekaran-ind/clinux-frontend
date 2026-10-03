// Address -> map point, for GeoPicker's "Find on map". OpenStreetMap's Nominatim by default (its
// usage policy allows light, user-triggered use like this one — one search per click, at most
// four requests, never autocomplete); a deployment with real traffic should point
// VITE_GEOCODE_URL at its own Nominatim-compatible geocoder, as with VITE_TILE_URL in tiles.js.
export const GEOCODE_URL = import.meta.env?.VITE_GEOCODE_URL || 'https://nominatim.openstreetmap.org/search';

// How close each kind of match is: the zoom to show it at, and what to tell the person.
const PRECISION = {
  address: { zoom: 17, note: 'Found the address. Check the pin and tap the exact spot if it is off.' },
  locality: { zoom: 15, note: 'Found the area, not the exact address. Tap the map to place the pin on the facility.' },
  pincode: { zoom: 14, note: 'Found the PIN code area only. Zoom in and tap the facility to place the pin.' },
};

/**
 * The searches to try, most precise first: the full address, the address without its PIN code
 * (a mistyped PIN otherwise sinks it), the town with its district and state, then the PIN code on
 * its own (India's postal codes are well covered by OSM). `parts` are the entered fields
 * ({ addressLine1, city, pincode }); `context` is fixed surroundings such as [district, state].
 * Repeated names (a city that is also its district) are sent once: Nominatim matches nothing
 * when a name appears twice, or when a sub-district name is added (checked live).
 */
export function geocodeQueries(parts = {}, context = []) {
  const { addressLine1, city, pincode } = parts;
  const pin = /^\d{6}$/.test(String(pincode || '').trim()) ? String(pincode).trim() : '';
  const join = (...xs) => {
    const seen = new Set();
    return xs.flat().map((x) => String(x || '').trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).join(', ');
  };
  const queries = [];
  const add = (precision, params) => {
    if (!queries.some((q) => JSON.stringify(q.params) === JSON.stringify(params))) queries.push({ precision, params });
  };
  if (addressLine1) {
    if (pin) add('address', { q: join(addressLine1, city, context, pin) });
    add('address', { q: join(addressLine1, city, context) });
  }
  if (city) add('locality', { q: join(city, context, pin) });
  if (pin) add('pincode', { postalcode: pin, country: 'India' });
  return queries;
}

/**
 * Finds the address. Resolves to { lat, lng, label, zoom, note } or null when nothing matched.
 * `fetchImpl` is injectable for tests.
 */
export async function geocode(parts, context, { fetchImpl = fetch, signal } = {}) {
  for (const { precision, params } of geocodeQueries(parts, context)) {
    const url = new URL(GEOCODE_URL);
    for (const [k, v] of Object.entries({ ...params, format: 'jsonv2', limit: '1', countrycodes: 'in', 'accept-language': 'en' })) url.searchParams.set(k, v);
    const res = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`The map search did not answer (${res.status}). Tap the map to place the pin instead.`);
    const [hit] = await res.json();
    const lat = Number(hit?.lat);
    const lng = Number(hit?.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, label: hit.display_name || '', ...PRECISION[precision] };
  }
  return null;
}
