import type { IconKey } from "./model.ts";

const P: Record<IconKey, string> = {
  bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  heart: '<path d="M12 20S5 15.6 5 10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  leaf: '<path d="M5 19c0-8 5-14 15-14 0 9-5 15-13 15"/><path d="M5 19c3-5 6-7 10-9"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M12 9v11M3 6h18v3H3zM12 6C10 3 6 4 7 6M12 6c2-3 6-2 5 0"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cart: '<path d="M3 4h2.5l2 11h10l2-8H7"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17"/>',
  sparkle: '<path d="M12 3c.8 4.5 2.5 6.2 7 7-4.5.8-6.2 2.5-7 7-.8-4.5-2.5-6.2-7-7 4.5-.8 6.2-2.5 7-7zM19 16.5c.3 1.5.9 2.1 2.4 2.4-1.5.3-2.1.9-2.4 2.4-.3-1.5-.9-2.1-2.4-2.4 1.5-.3 2.1-.9 2.4-2.4z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  package: '<path d="m12 3 8 4v10l-8 4-8-4V7zM4 7l8 4 8-4M12 11v10"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c1 1.5 2 2 3.5 2s2.500-.5 3.500-2M9 9.5h.01M15 9.500h.01"/>',
};

export const iconSvg = (k: IconKey) =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[k]}</svg>`;
