// Map tiles. OpenStreetMap's standard tiles by default; their usage policy allows light use and
// requires attribution. A production deployment with real traffic should point VITE_TILE_URL at
// a tile provider (or its own tile server) instead.
export const TILE_URL = import.meta.env.VITE_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = import.meta.env.VITE_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// India, for maps with nothing on them yet.
export const DEFAULT_VIEW = { center: [22.5, 79], zoom: 4 };
