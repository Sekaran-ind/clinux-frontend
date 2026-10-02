import { describe, expect, it } from 'vitest';
import { geocode, geocodeQueries } from './geocode.js';

const parts = { addressLine1: '12 MG Road', city: 'Pune', pincode: '411001' };
const context = ['Pune', 'Maharashtra'];

describe('geocodeQueries', () => {
  it('tries the full address, without its PIN, then the town, then the PIN code — each name once', () => {
    expect(geocodeQueries(parts, context)).toEqual([
      { precision: 'address', params: { q: '12 MG Road, Pune, Maharashtra, 411001' } },
      { precision: 'address', params: { q: '12 MG Road, Pune, Maharashtra' } },
      { precision: 'locality', params: { q: 'Pune, Maharashtra, 411001' } },
      { precision: 'pincode', params: { postalcode: '411001', country: 'India' } },
    ]);
  });
  it('skips what was not entered, and a PIN that is not six digits', () => {
    expect(geocodeQueries({ pincode: '4110' }, context)).toEqual([]);
    expect(geocodeQueries({ pincode: '411001' }, [])).toEqual([{ precision: 'pincode', params: { postalcode: '411001', country: 'India' } }]);
  });
});

function fakeFetch(answers) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(new URL(url));
    const body = answers.shift() ?? [];
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, urls };
}

describe('geocode', () => {
  it('returns the first match, zoomed by how precise it was', async () => {
    const { fetchImpl, urls } = fakeFetch([[], [], [{ lat: '18.52', lon: '73.85', display_name: 'Pune' }]]);
    const hit = await geocode(parts, context, { fetchImpl });
    expect(hit).toMatchObject({ lat: 18.52, lng: 73.85, label: 'Pune', zoom: 15 });
    expect(hit.note).toMatch(/area/);
    expect(urls).toHaveLength(3);
    expect(urls[0].searchParams.get('countrycodes')).toBe('in');
    expect(urls[0].searchParams.get('format')).toBe('jsonv2');
  });
  it('returns null when nothing matched', async () => {
    const { fetchImpl, urls } = fakeFetch([]);
    expect(await geocode(parts, context, { fetchImpl })).toBeNull();
    expect(urls).toHaveLength(4);
  });
  it('explains a failed search', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429 });
    await expect(geocode(parts, context, { fetchImpl })).rejects.toThrow(/429/);
  });
});
