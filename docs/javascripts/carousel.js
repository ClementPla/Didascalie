// Screenshot carousel (home page): previous/next buttons and one dot per slide
// over a scroll-snapping row of figures. Styles in stylesheets/carousel.css.

function setUpCarousel(carousel) {
  if (carousel.dataset.ready) return;
  carousel.dataset.ready = "true";

  const track = carousel.querySelector(".carousel__track");
  const dots = document.createElement("div");
  dots.className = "carousel__dots";

  const slides = () => Array.from(track.children);
  const current = () =>
    Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
  const show = (index) => {
    const count = slides().length;
    track.scrollTo({ left: ((index + count) % count) * track.clientWidth });
  };

  // Rebuilt whenever a slide is dropped, so the dots always match the slides.
  const render = () => {
    const count = slides().length;
    carousel.hidden = count === 0;
    carousel
      .querySelectorAll(".carousel__button")
      .forEach((button) => (button.hidden = count < 2));
    dots.replaceChildren(
      ...slides().map((slide, index) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.setAttribute("aria-label", `Show screenshot ${index + 1} of ${count}`);
        dot.addEventListener("click", () => show(index));
        return dot;
      }),
    );
    dots.hidden = count < 2;
    mark();
  };
  const mark = () =>
    Array.from(dots.children).forEach((dot, index) =>
      dot.setAttribute("aria-current", String(index === current())),
    );

  for (const [name, label, step] of [
    ["previous", "Previous screenshot", -1],
    ["next", "Next screenshot", 1],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `carousel__button carousel__button--${name}`;
    button.setAttribute("aria-label", label);
    button.textContent = step < 0 ? "‹" : "›";
    button.addEventListener("click", () => show(current() + step));
    carousel.append(button);
  }
  carousel.append(dots);

  // A screenshot that does not exist (yet) takes its slide with it, so the
  // list in index.md can run ahead of the images actually captured.
  for (const image of track.querySelectorAll("img")) {
    const drop = () => {
      image.closest("figure").remove();
      render();
    };
    if (image.complete && image.naturalWidth === 0) drop();
    else image.addEventListener("error", drop);
  }

  track.addEventListener("scroll", mark, { passive: true });
  render();
}

// `document$` fires on every page shown, including the ones Material swaps in
// without a full reload (navigation.instant).
document$.subscribe(() =>
  document.querySelectorAll(".carousel").forEach(setUpCarousel),
);
