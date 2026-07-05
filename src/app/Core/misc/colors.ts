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

export function generate_shades(hex: string, n: number) {
    let [r, g, b] = from_hex_to_rgb(hex)
    let shades = []
    for (let i = 0; i < n; i++) {
        let rnew = Math.floor(r * (1 - i / n))
        let gnew = Math.floor( g * (1 - i / n))
        let bnew = Math.floor( b * (1 - i / n))
        let shade = from_rgb_to_hex(rnew, gnew, bnew)
        shades.push(shade)
    }

    // Shuffle the shades 

    for (let i = shades.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shades[i], shades[j]] = [shades[j], shades[i]];
    }

    return shades
}