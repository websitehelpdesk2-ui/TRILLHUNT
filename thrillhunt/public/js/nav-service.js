/**
 * NavigationService (§66–§73)
 *
 * THRILLHUNT does not build turn-by-turn navigation. It hands a destination to
 * the user's own map app using each platform's documented URL scheme, then gets
 * out of the way. The user's current position is never sent to us or embedded
 * in the link — the map app asks the OS for it.
 */
export const platform = (() => {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  return { isIOS, isAndroid, isMobile: isIOS || isAndroid, isMac: /Macintosh/.test(ua) };
})();

function destQuery(d) {
  if (d.lat != null && d.lng != null) return `${d.lat},${d.lng}`;
  return d.address || d.name;
}

export const NavigationService = {
  /** Apple Maps — maps.apple.com works as a universal link on iOS/macOS. */
  appleMapsUrl(d) {
    const p = new URLSearchParams();
    if (d.lat != null && d.lng != null) { p.set('ll', `${d.lat},${d.lng}`); p.set('q', d.name); }
    else p.set('q', d.address || d.name);
    p.set('dirflg', 'd');
    return `https://maps.apple.com/?${p.toString()}`;
  },

  /** Google Maps universal URL — resolves to the app when installed. */
  googleMapsUrl(d) {
    const p = new URLSearchParams({ api: '1', destination: destQuery(d) });
    if (d.place_id) p.set('destination_place_id', d.place_id);
    return `https://www.google.com/maps/dir/?${p.toString()}`;
  },

  /** geo: intent — lets Android offer every installed navigation app. */
  geoUrl(d) {
    if (d.lat != null && d.lng != null) return `geo:${d.lat},${d.lng}?q=${encodeURIComponent(`${d.lat},${d.lng}(${d.name})`)}`;
    return `geo:0,0?q=${encodeURIComponent(d.address || d.name)}`;
  },

  /** Options to present, ordered by what the platform prefers. */
  optionsFor(d) {
    const apple = { key: 'apple', label: '🗺️  Apple Maps', url: this.appleMapsUrl(d) };
    const google = { key: 'google', label: '📍  Google Maps', url: this.googleMapsUrl(d) };
    const other = { key: 'other', label: '🧭  Other navigation app', url: this.geoUrl(d) };
    if (platform.isIOS || platform.isMac) return [apple, google];
    if (platform.isAndroid) return [google, other];
    return [google, apple];   // web: Google Maps default per §66
  },

  open(url) {
    // We cannot reliably detect whether an app is installed, so we never assume:
    // the universal/web URL degrades to the browser on its own.
    const w = window.open(url, '_blank', 'noopener');
    if (!w) { window.location.href = url; return false; }
    return true;
  },

  openDefaultNavigation(d) {
    const opt = this.optionsFor(d)[0];
    return this.open(opt.url);
  },

  addressText(d) {
    if (d.address) return d.address;
    if (d.lat != null) return `${d.lat}, ${d.lng}`;
    return d.name;
  },
};
