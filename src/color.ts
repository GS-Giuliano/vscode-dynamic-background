export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Converte "#rgb", "#rgba", "#rrggbb" ou "#rrggbbaa" em RGBA (canais 0-255, alfa 0-1). */
export function parseColor(value: string | undefined): RGBA | undefined {
  if (!value) {
    return undefined;
  }
  let hex = value.trim().replace(/^#/, '');
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
    return undefined;
  }
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

/** Formata como "#rrggbb" (cor sempre opaca). */
export function toHex(color: RGBA): string {
  const channel = (v: number) =>
    Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Interpolação linear: t = 0 retorna `from`, t = 1 retorna `to`. */
export function mix(from: RGBA, to: RGBA, t: number): RGBA {
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
    a: 1,
  };
}

/** Compõe uma cor possivelmente translúcida sobre um fundo opaco. */
export function composite(fg: RGBA, bg: RGBA): RGBA {
  return fg.a >= 1 ? fg : mix(bg, { ...fg, a: 1 }, fg.a);
}
