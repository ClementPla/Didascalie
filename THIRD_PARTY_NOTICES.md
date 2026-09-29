# Third-party notices

Didascalie itself is BSD-3-Clause (see [`LICENSE`](LICENSE)). It bundles the
third-party assets below into its installers, which carry their own terms.

Dependency licences are declared in `package.json` / `Cargo.toml` and the
respective lockfiles; this file covers the binary assets that are redistributed
verbatim inside the application, where the licence asks for attribution.

## Material Symbols (icon font)

- Package: [`@material-symbols/font-400`](https://www.npmjs.com/package/@material-symbols/font-400)
- Upstream: [google/material-design-icons](https://github.com/google/material-design-icons)
- Copyright: Google LLC
- Licence: Apache License 2.0 — <https://www.apache.org/licenses/LICENSE-2.0>

Only the *Outlined* style is bundled (`material-symbols-outlined.woff2`). The
font file is served from inside the application; Didascalie does **not** load it
from Google Fonts or any other remote host, so the application keeps working
offline and makes no network request for it.

## PrimeIcons (icon font)

- Package: [`primeicons`](https://www.npmjs.com/package/primeicons)
- Copyright: PrimeTek
- Licence: MIT

## PrimeNG / PrimeNG Themes

- Packages: [`primeng`](https://www.npmjs.com/package/primeng), `@primeng/themes`
- Copyright: PrimeTek
- Licence: MIT (PrimeNG Community version)

## Catppuccin palette

- Package: [`@catppuccin/palette`](https://www.npmjs.com/package/@catppuccin/palette)
- Licence: MIT

## Machine-learning model weights

Encoder weights (DINOv3 and others) are **not** bundled. They are downloaded on
request, from the source named in the model picker, and carry their own licence
terms — which you should check before using them in your own work.
