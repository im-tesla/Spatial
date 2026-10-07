type Rgb = [number, number, number];
export type Theme = Record<string, string>;

function hsl([red, green, blue]: Rgb): [number, number, number] {
  const r = red / 255; const g = green / 255; const b = blue / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const light = (max + min) / 2; const delta = max - min;
  if (delta === 0) return [0, 0, light];
  const saturation = delta / (1 - Math.abs(2 * light - 1));
  const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return [hue * 60, saturation, light];
}

function rgb(hue: number, saturation: number, light: number): Rgb {
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = light - chroma / 2;
  const components = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x]
    : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return components.map(value => Math.round((value + m) * 255)) as Rgb;
}

export function createTheme(color: Rgb): Theme {
  const [hue, saturation] = hsl(color);
  const neutral = saturation < .12;
  const tint = neutral ? 0 : Math.min(.45, saturation * .55);
  const accentSaturation = neutral ? 0 : Math.max(.35, Math.min(.75, saturation));
  const css = (s: number, l: number) => `rgb(${rgb(hue, s, l).join(" ")})`;
  const luminance = (color: Rgb) => color.map(channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const background = luminance(rgb(hue, tint, .21));
  const readable = (s: number, light: number) => {
    while (light < .94 && (luminance(rgb(hue, s, light)) + .05) / (background + .05) < 4.6) light += .01;
    return css(s, light);
  };
  return {
    "--base": css(tint * .6, .065), "--surface": css(tint * .65, .095),
    "--sidebar": css(tint * .5, .08), "--player": css(tint * .65, .115),
    "--panel": css(tint, .12), "--wash": css(tint, .19), "--raised": css(tint * .7, .15),
    "--active-bg": css(tint, .21), "--line": css(tint * .65, .23), "--strong-line": css(tint * .6, .3),
    "--accent": css(accentSaturation, .8), "--accent-hover": css(accentSaturation, .87),
    "--accent-ink": css(tint, .085), "--text": css(tint * .3, .94),
    "--secondary-text": readable(tint * .45, .79), "--muted": readable(tint * .4, .69),
    "--dim": readable(tint * .3, .63), "--lyric-past": readable(tint * .4, .63),
  };
}

export const defaultTheme = createTheme([150, 190, 110]);

// Quantized color groups keep small skin tones, text and highlights from
// overpowering the artwork's larger areas. Transparent pixels are ignored.
export function themeFromPixels(pixels: ArrayLike<number>): Theme {
  const groups = new Map<number, { count: number; red: number; green: number; blue: number }>();
  let total = 0; let saturationTotal = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const [, saturation, light] = hsl([r, g, b]);
    total++; saturationTotal += saturation;
    if (light < .08 || light > .92) continue;
    const key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
    const group = groups.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
    group.count++; group.red += r; group.green += g; group.blue += b;
    groups.set(key, group);
  }
  if (!total) return defaultTheme;
  if (saturationTotal / total < .08) return createTheme([128, 128, 128]);
  let best: Rgb | null = null; let bestScore = 0;
  for (const group of groups.values()) {
    const color: Rgb = [group.red / group.count, group.green / group.count, group.blue / group.count];
    const [, saturation] = hsl(color);
    const score = group.count * (1 + saturation * .6);
    if (score > bestScore) { best = color; bestScore = score; }
  }
  return best ? createTheme(best) : defaultTheme;
}
