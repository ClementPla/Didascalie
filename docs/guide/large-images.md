# Very large images

Didascalie annotates images far larger than a browser can decode in one piece —
gigapixel microscopy included — at full resolution.

## How it works

Two mechanisms combine:

1. **A resolution pyramid.** Each level is half the size of the one below, down to a
   coarsest level whose longest side is 4096 pixels. The view draws the finest level
   that comfortably oversamples your viewport, so zoomed out you are looking at a
   small image.
2. **Native-resolution tiles on demand.** When you zoom in far enough that only a few
   tiles are visible, those tiles are fetched at full resolution and composited over
   the pyramid view for the region under inspection.

You never manage tiles or crops. Annotation coordinates are always in the image's
native pixel space, so a mask drawn while zoomed in is stored at full resolution.

## What to expect

- The first moments after opening a large frame can look soft while tiles arrive.
- Zoomed out past the point where tiles would help, the pyramid view is used alone —
  this is intentional, since fetching hundreds of tiles to draw them one pixel wide
  would be wasted work.
- Masks are run-length encoded, so a large mostly-empty mask costs little.

## If it is slow

Performance differs noticeably between platforms for the same file, because the
underlying web view differs. See
[Troubleshooting](../troubleshooting.md#a-large-image-is-slow-to-pan-or-zoom).
