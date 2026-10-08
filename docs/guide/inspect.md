# Inspecting sequences

The inspector plays a sequence back like a video, with its masks drawn on top.
Use it to check labels over a whole sequence. A mask that flickers, drifts or
disappears for a few frames is easy to miss frame by frame and easy to see at
15 fps.

The inspector is read-only.

## Opening it

- From the **gallery**: the video button on a sequence.
- From the **editor**: the **Inspect sequence** button, which opens the sequence
  you are working on.
- From the left toolbar: the video icon.

<video src="../../assets/screenshots/inspect.mp4" poster="../../assets/screenshots/inspect_poster.jpg"
       autoplay loop muted playsinline controls preload="metadata" style="width: 100%"
       aria-label="The inspector playing a sequence back with its masks outlined."></video>

## Playback

| Action | Keys |
| --- | --- |
| Play / pause | ++space++ |
| Next / previous frame | ++arrow-up++ / ++arrow-down++ |
| Next / previous sequence | ++arrow-right++ / ++arrow-left++ |
| First / last frame | ++home++ / ++end++ |
| Show only edges | ++ctrl+e++ |

The speed goes from 1 to 60 fps, and **Loop** restarts the sequence at the end.

Playback never skips frames. If frames cannot be loaded fast enough for the
chosen speed, playback slows down and the actual rate is shown next to the speed
selector.

Wheel zooms and dragging pans. Double-click a pane to fit the image again.
Frames are loaded as previews of at most 2048 px. To see a large image at native
resolution, open the frame in the editor.

## Looking at the labels

- The **opacity** slider fades the masks to compare them with the image
  underneath.
- **Show only edges** draws outlines in place of filled regions. Use it when
  several labels overlap or when the fill hides the structure.
- Click a **label chip** to hide or show that label.

Only masks are drawn. Vector shapes and keypoints are not shown.

<!-- SCREENSHOT: the same frame with filled masks and with "Show only edges", side by side. -->
<!-- SCREENSHOT: close-up of the player bar: timeline, speed, loop, opacity, edges toggle and label chips. -->

## Fixing what you find

Pause on the faulty frame and click the pencil in the pane header. The editor
opens on that frame.

## Comparing sequences side by side

Up to six sequences can play together, to compare acquisitions of the same
subject or two annotators' work.

- In the gallery, select several sequences and click **Inspect side by side**.
- In the inspector, add one with **Compare with…**.

Panes play in step, by frame index. A shorter sequence holds its last frame
while the longer ones continue.

Click a pane to focus it: next and previous sequence then act on that pane only.
The link button makes every pane zoom and pan together.

<!-- SCREENSHOT: three sequences side by side, one pane focused. -->
<!-- SCREENSHOT: gallery with several sequences selected and the "Inspect side by side" button. -->
