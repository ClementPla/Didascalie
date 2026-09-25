/**
 * Limits shared between the projection renderer and its view.
 *
 * Kept in its own module so the view can import it statically while the
 * renderer — which pulls in three.js — is loaded on demand. Importing it from
 * `projection-renderer.ts` would drag the whole WebGL stack into the initial
 * bundle for the sake of one number.
 */

/** Label channels the projection shader can composite at once. */
export const MAX_PROJECTED_LABELS = 8;
