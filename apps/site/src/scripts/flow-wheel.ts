// OptionWheel's arc and exponential smoothing, adapted to Astro and two linked views.
// Source: https://reactbits.dev/r/OptionWheel-TS-TW.json. No sound is loaded or played.
const section = document.querySelector<HTMLElement>("#flow")!;
const track = section.querySelector<HTMLElement>(".flow-layout")!;
const navigation = section.querySelector<HTMLElement>(".flow-navigation")!;
const wheel = section.querySelector<HTMLElement>(".flow-index")!;
const viewport = section.querySelector<HTMLElement>(".flow-card-viewport")!;
const links = [...section.querySelectorAll<HTMLAnchorElement>("[data-flow-link]")];
const cards = [...section.querySelectorAll<HTMLElement>("[data-flow-stage]")];
const desktop = window.matchMedia("(min-width: 1024px) and (min-height: 640px)");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const last = cards.length - 1;
let enabled = false;
let position = 0;
let target = 0;
let start = 0;
let stride = 1;
let rowHeight = 52;
let cardPitch = 380;
let frame = 0;
let lastFrame = 0;
let snapTimer = 0;
let selected = -1;
let suppressClick = false;
let drag: { element: HTMLElement; id: number; y: number; position: number; pitch: number } | undefined;

const clamp = (value: number) => Math.max(0, Math.min(last, value));
const inTrack = () => window.scrollY >= start - 1 && window.scrollY <= start + stride * last + 1;

function select(index: number) {
  if (index === selected) return;
  selected = index;
  section.dataset.flowActive = cards[index].dataset.flowStage;
  links.forEach((link, i) => {
    if (i === index) link.setAttribute("aria-current", "step");
    else link.removeAttribute("aria-current");
    cards[i].dataset.active = String(i === index);
  });
}

function render(now: number) {
  frame = 0;
  // A busy loading frame can carry a timestamp earlier than the scheduling time.
  const dt = Math.max(0, Math.min((now - lastFrame) / 1000, 0.05));
  lastFrame = now;
  position += (target - position) * (1 - Math.exp(-dt / 0.2));
  const settled = Math.abs(target - position) < 0.001;
  if (settled) position = target;
  const angleStep = 6 * Math.PI / 180;
  const radius = rowHeight / angleStep;
  links.forEach((link, i) => {
    const distance = i - position;
    const amount = Math.abs(distance);
    const angle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, distance * angleStep));
    const x = -radius * (1 - Math.cos(angle));
    const y = radius * Math.sin(angle);
    link.style.transform = `translate(${x}px, calc(${y}px - 50%)) rotate(${angle * 180 / Math.PI}deg)`;
    link.style.opacity = String(Math.max(0.08, 1 - amount * 0.25));
    link.style.filter = `blur(${Math.min(amount * 2, 8)}px)`;
    // Cards share the exact wheel position but travel in a straight vertical line.
    cards[i].style.transform = `translateY(calc(${distance * cardPitch}px - 50%))`;
    cards[i].style.opacity = String(Math.max(0.06, 1 - amount * 0.45));
    cards[i].style.filter = `blur(${Math.min(amount * 2, 8)}px)`;
  });
  select(Math.round(position));
  if (!settled) frame = requestAnimationFrame(render);
}

function animateTo(value: number) {
  target = clamp(value);
  if (frame) return;
  lastFrame = performance.now();
  frame = requestAnimationFrame(render);
}

function goTo(value: number) {
  if (!enabled) return;
  target = clamp(value);
  window.scrollTo({ top: start + target * stride, behavior: "instant" });
  animateTo(target);
}

function queueSnap() {
  window.clearTimeout(snapTimer);
  snapTimer = window.setTimeout(() => {
    if (enabled && !drag && inTrack() && Math.abs(target - Math.round(target)) > 0.001) goTo(Math.round(target));
  }, 160);
}

function onScroll() {
  if (enabled) {
    const progress = (window.scrollY - start) / stride;
    // Browser scroll offsets are pixel-rounded; keep a settled option fully sharp.
    animateTo(Math.abs(progress - Math.round(progress)) * stride < 1 ? Math.round(progress) : progress);
    queueSnap();
  } else {
    let index = 0;
    cards.forEach((card, i) => { if (card.getBoundingClientRect().top <= innerHeight * 0.45) index = i; });
    select(index);
  }
}

function configure() {
  const preserve = enabled && inTrack();
  const previous = Math.round(target);
  cancelAnimationFrame(frame);
  frame = 0;
  window.clearTimeout(snapTimer);
  enabled = desktop.matches && !reducedMotion.matches;
  section.toggleAttribute("data-flow-wheel", enabled);
  if (!enabled) {
    track.style.removeProperty("height");
    [...links, ...cards].forEach((element) => {
      ["transform", "opacity", "filter"].forEach((property) => element.style.removeProperty(property));
    });
    if (preserve) cards[previous].scrollIntoView({ behavior: "instant", block: "start" });
    onScroll();
    return;
  }
  const pinnedTop = parseFloat(getComputedStyle(navigation).top);
  const viewportHeight = viewport.offsetHeight;
  const cardHeight = Math.max(...cards.map((card) => card.offsetHeight));
  cardPitch = cardHeight + 60;
  rowHeight = parseFloat(getComputedStyle(links[0]).fontSize) * 1.65;
  stride = Math.max(280, Math.min(480, innerHeight * 0.45));
  track.style.height = `${viewportHeight + stride * last}px`;
  start = window.scrollY + track.getBoundingClientRect().top - pinnedTop;
  const wheelOffset = wheel.getBoundingClientRect().top - navigation.getBoundingClientRect().top;
  // Align the selected label and card without letting a tall card reach the header/footer.
  const center = Math.min(wheelOffset + wheel.offsetHeight / 2, viewportHeight - cardHeight / 2 - 12);
  wheel.style.setProperty("--flow-option-center", `${center - wheelOffset}px`);
  viewport.style.setProperty("--flow-card-center", `${center}px`);
  if (preserve) window.scrollTo({ top: start + previous * stride, behavior: "instant" });
  position = target = clamp((window.scrollY - start) / stride);
  lastFrame = performance.now();
  render(lastFrame);
}

links.forEach((link, index) => {
  link.addEventListener("click", (event) => {
    if (!enabled || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (suppressClick) { suppressClick = false; return; }
    history.replaceState(null, "", link.hash);
    goTo(index);
  });
  link.addEventListener("focus", () => { if (enabled && !drag) goTo(index); });
});

// Anchors keep native navigation in the fallback, but must not start browser link drags.
wheel.addEventListener("dragstart", (event) => { if (enabled) event.preventDefault(); });

navigation.addEventListener("keydown", (event) => {
  if (!enabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const index = event.key === "Home" ? 0 : event.key === "End" ? last
    : ["ArrowDown", "ArrowRight"].includes(event.key) ? Math.round(target) + 1
    : ["ArrowUp", "ArrowLeft"].includes(event.key) ? Math.round(target) - 1 : undefined;
  if (index === undefined) return;
  event.preventDefault();
  goTo(index);
  links[clamp(index)].focus({ preventScroll: true });
});

[wheel, viewport].forEach((element) => {
  element.addEventListener("wheel", (event) => {
    if (!enabled || !inTrack() || event.defaultPrevented || event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    // At either end, let the page continue to the previous/next section.
    if ((target <= 0 && event.deltaY < 0) || (target >= last && event.deltaY > 0)) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? innerHeight : 1);
    goTo(target + Math.max(-1, Math.min(1, delta / rowHeight)));
    queueSnap();
  }, { passive: false });
  element.addEventListener("pointerdown", (event) => {
    if (!enabled || event.pointerType !== "mouse" || event.button !== 0) return;
    suppressClick = false;
    drag = { element, id: event.pointerId, y: event.clientY, position: target, pitch: element === wheel ? rowHeight : cardPitch };
  });
  element.addEventListener("pointermove", (event) => {
    if (!drag || drag.element !== element || drag.id !== event.pointerId) return;
    const delta = event.clientY - drag.y;
    if (Math.abs(delta) <= 4 && !suppressClick) return;
    suppressClick = true;
    element.setPointerCapture(event.pointerId);
    element.dataset.dragging = "true";
    goTo(drag.position - delta / drag.pitch);
  });
  function endDrag() {
    if (!drag || drag.element !== element) return;
    const id = drag.id;
    drag = undefined;
    delete element.dataset.dragging;
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    if (suppressClick) goTo(Math.round(target));
  }
  element.addEventListener("pointerup", endDrag);
  element.addEventListener("pointercancel", endDrag);
  element.addEventListener("lostpointercapture", endDrag);
});

cards.forEach((card, index) => card.addEventListener("click", () => {
  if (suppressClick) { suppressClick = false; return; }
  if (enabled) goTo(index);
}));

function followHash() {
  const index = cards.findIndex((card) => `#${card.id}` === location.hash);
  if (enabled && index >= 0) goTo(index);
}

window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("resize", configure, { passive: true });
window.addEventListener("hashchange", followHash);
reducedMotion.addEventListener("change", configure);
configure();
void document.fonts.ready.then(() => { configure(); followHash(); });
