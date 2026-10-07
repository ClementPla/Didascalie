# Very large images

Didascalie can annotate images much larger than a browser can decode in one piece,
including gigapixel microscopy, at full resolution.

## How it works

1. **A resolution pyramid.** Each level is half the size of the previous one, down
   to a level whose longest side is 4096 pixels. The view draws the smallest level
   that is still sharp at the current zoom. Zoomed out, you are looking at a small
   image.
2. **Native-resolution tiles on demand.** When you zoom in far enough that only a
   few tiles are visible, those tiles are fetched at full resolution and drawn
   over the pyramid.

You do not manage tiles or crops. Annotation coordinates are always in the image's
native pixels, so a mask drawn while zoomed in is stored at full resolution.

## What to expect

- Just after opening a large frame, the image can look soft until the tiles
  arrive.
- When zoomed out, only the pyramid is used. Fetching hundreds of tiles to draw
  each one a few pixels wide would be wasted work.
- Masks are run-length encoded, so a large and mostly empty mask takes little
  space.

## If it is slow

The same file performs differently on Windows, macOS and Linux, because each
platform uses a different web view. See
[Troubleshooting](../troubleshooting.md#a-large-image-is-slow-to-pan-or-zoom).
