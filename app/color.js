// sRGB hex <-> OKLCH, and an OKLCH gradient between two colors.

export function parseHex(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch([r, g, b]) {
  r = toLinear(r); g = toLinear(g); b = toLinear(b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}

// Returns linear sRGB (may be out of [0, 1]).
function oklchToLinear([L, C, H]) {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

// Out-of-gamut colors keep lightness and hue; chroma is reduced until they fit.
function oklchToHex([L, C, H]) {
  L = Math.min(1, Math.max(0, L));
  let rgb = oklchToLinear([L, C, H]);
  if (!inGamut(rgb)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear([L, mid, H]))) lo = mid; else hi = mid;
    }
    rgb = oklchToLinear([L, lo, H]);
  }
  return '#' + rgb
    .map((c) => Math.round(fromLinear(Math.min(1, Math.max(0, c))) * 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function oklchGradient(fromHex, toHex, count) {
  const a = parseHex(fromHex), b = parseHex(toHex);
  if (!a || !b || !(count >= 1)) return [];
  const p = rgbToOklch(a), q = rgbToOklch(b);
  // Greys have no meaningful hue: borrow the other end's so the hue doesn't swing.
  const ACHROMATIC = 0.002;
  if (p[1] < ACHROMATIC) p[2] = q[2];
  if (q[1] < ACHROMATIC) q[2] = p[2];
  let dh = q[2] - p[2];
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360; // shorter way around the hue wheel

  const n = Math.round(count);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    out.push(oklchToHex([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + dh * t]));
  }
  return out;
}
