import { flavors, version, flavorEntries, FlavorName } from "@catppuccin/palette";



export function getDefaultColor(n: number) {

    n = n % 32

    let color = "#ffffff"
    flavorEntries.map(([_, flavor]) => {
        if (flavor.name === 'Latte') {

            flavor.colorEntries.map(([colorName, { hex, rgb, accent }], index) => {
                if (index === n) {
                    color = hex
                }
            })
        }
    })
    return color

}

export function from_hex_to_rgb(hex: string) {
    let r = parseInt(hex.slice(1, 3), 16)
    let g = parseInt(hex.slice(3, 5), 16)
    let b = parseInt(hex.slice(5, 7), 16)

    return [r, g, b]
}

/**
 * Build a 256-entry RGBA lookup table mapping a label's pixel values to display
 * colours. Index 0 stays transparent (background). For a semantic label every
 * value maps to `baseColor`; for an instance label (`shades` provided) value
 * `v` maps to `shades[v]`, falling back to `baseColor` when a shade is missing
 * or malformed. Returned as a flat `Uint8Array(256*4)`.
 */
export function buildLabelPalette(baseColor: string, shades: string[] | null): Uint8Array {
    const pal = new Uint8Array(256 * 4);
    const [br, bg, bb] = from_hex_to_rgb(baseColor);

    for (let v = 1; v < 256; v++) {
        let r = br, g = bg, b = bb;
        if (shades && shades.length > 0) {
            const hex = shades[v] ?? shades[v % shades.length];
            const [sr, sg, sb] = from_hex_to_rgb(hex ?? '');
            if (Number.isFinite(sr) && Number.isFinite(sg) && Number.isFinite(sb)) {
                r = sr; g = sg; b = sb;
            }
        }
        if (!Number.isFinite(r)) { r = 255; g = 255; b = 255; }
        pal[v * 4] = r;
        pal[v * 4 + 1] = g;
        pal[v * 4 + 2] = b;
        pal[v * 4 + 3] = 255;
    }
    return pal;
}

function componentToHex(c: number): string {
    var hex = c.toString(16);
    return hex.length == 1 ? "0" + hex : hex;
}

export function from_rgb_to_hex(r: number, g: number, b: number): string {
    return "#" + componentToHex(r) + componentToHex(g) + componentToHex(b);
}

/**
 * Deterministic per-instance shades derived from a base colour. Same hue as the
 * base, with lightness spread by a golden-ratio low-discrepancy sequence so
 * consecutive instance ids look distinct. Fully deterministic — an instance id
 * always maps to the same colour across sessions (no random shuffle), so painted
 * instances never change colour on reload. Index `v` is the shade for pixel
 * value `v` (index 0 is unused; 0 = background).
 */
export function generate_shades(hex: string, n: number): string[] {
    const [h, s] = rgbToHsl(...(from_hex_to_rgb(hex) as [number, number, number]));
    // Keep enough saturation that shades read as colour, not grey.
    const sat = Math.min(1, Math.max(0.45, s));
    const golden = 0.6180339887498949;
    const shades: string[] = [];
    for (let i = 0; i < n; i++) {
        const t = (i * golden) % 1; // well-spread in [0, 1)
        const light = 0.32 + 0.5 * t; // readable band: 0.32..0.82
        const [r, g, b] = hslToRgb(h, sat, light);
        shades.push(from_rgb_to_hex(r, g, b));
    }
    return shades;
}

/** RGB (0..255) → HSL (h in 0..360, s/l in 0..1). */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    const d = max - min;
    if (d !== 0) {
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            default: h = (r - g) / d + 4; break;
        }
        h *= 60;
    }
    return [h, s, l];
}

/** HSL (h in 0..360, s/l in 0..1) → RGB (0..255, rounded). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    h = ((h % 360) + 360) % 360 / 360;
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t: number): number => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [
        Math.round(hue(h + 1 / 3) * 255),
        Math.round(hue(h) * 255),
        Math.round(hue(h - 1 / 3) * 255),
    ];
}