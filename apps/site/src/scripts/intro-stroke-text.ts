import { gsap } from "gsap";

// StrokeText's staggered SVG outline and fill wipe, adapted to the existing Astro heading.
// Source: https://reactbits.dev/r/StrokeText-TS-TW.json.
const title = document.querySelector<HTMLElement>(".details-title")!;
const lines = [...title.querySelectorAll<HTMLElement>("[data-stroke-line]")];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const svgNamespace = "http://www.w3.org/2000/svg";
let timeline: gsap.core.Timeline | undefined;
let visible = false;
let fontsReady = false;
let layoutKey = "";

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>) {
  const element = document.createElementNS(svgNamespace, tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
  return element;
}

function clear() {
  timeline?.kill();
  timeline = undefined;
  lines.forEach((line) => {
    delete line.dataset.strokeReady;
    line.querySelector("[data-stroke-svg]")?.remove();
  });
}

function build() {
  if (!fontsReady) return;
  const styles = lines.map((line) => getComputedStyle(line));
  const key = lines.map((line, i) => `${line.offsetWidth}:${line.offsetHeight}:${styles[i].fontSize}:${styles[i].color}`).join("|");
  if (key === layoutKey && !reducedMotion.matches) return;
  layoutKey = key;
  const previousProgress = timeline?.progress() ?? 0;
  clear();
  if (reducedMotion.matches) { layoutKey = ""; return; }

  timeline = gsap.timeline({ paused: true });
  lines.forEach((line, index) => {
    const fallback = line.querySelector<HTMLElement>("[data-stroke-fallback]")!;
    const node = fallback.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const style = styles[index];
    const fontSize = parseFloat(style.fontSize);
    const bounds = line.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const svg = svgElement("svg", {
      "data-stroke-svg": "", "aria-hidden": "true", focusable: "false",
      viewBox: `0 0 ${bounds.width} ${bounds.height}`,
    });
    const id = `intro-stroke-wipe-${index}`;
    const definitions = svgElement("defs", {});
    const clip = svgElement("clipPath", { id, clipPathUnits: "userSpaceOnUse" });
    const wipe = svgElement("rect", { width: "0" });
    clip.append(wipe);
    definitions.append(clip);
    const strokes = svgElement("text", {
      fill: "none", stroke: styles[1 - index].color,
      "stroke-width": String(Math.max(0.75, Math.min(1.4, fontSize * 0.014))),
      "stroke-linejoin": "round", "stroke-linecap": "round",
    });
    const fills = svgElement("text", { fill: style.color, stroke: "none", "clip-path": `url(#${id})` });
    [strokes, fills].forEach((text) => {
      text.style.fontFamily = style.fontFamily;
      text.style.fontSize = style.fontSize;
      text.style.fontWeight = style.fontWeight;
      text.style.letterSpacing = style.letterSpacing;
      text.setAttribute("dominant-baseline", "text-before-edge");
    });

    // Follow the real HTML glyph positions, including mobile word wrapping.
    const range = document.createRange();
    let offset = 0;
    Array.from(node.textContent ?? "").forEach((character) => {
      range.setStart(node, offset);
      offset += character.length;
      range.setEnd(node, offset);
      const rect = range.getBoundingClientRect();
      const stroke = svgElement("tspan", {
        x: String(rect.left - bounds.left), y: String(rect.top - bounds.top), "data-stroke-char": "",
      });
      stroke.textContent = character;
      const fill = stroke.cloneNode(true) as SVGTSpanElement;
      fill.removeAttribute("data-stroke-char");
      fill.setAttribute("data-fill-char", "");
      strokes.append(stroke);
      fills.append(fill);
    });
    svg.append(definitions, strokes, fills);
    line.append(svg);
    const textBox = strokes.getBBox();
    const pad = 2;
    wipe.setAttribute("x", String(textBox.x - pad));
    wipe.setAttribute("y", String(textBox.y - pad));
    wipe.setAttribute("height", String(textBox.height + pad * 2));
    const dash = Math.max(fontSize * 7, 200);
    const characters = [...strokes.children];
    gsap.set(characters, { strokeDasharray: dash, strokeDashoffset: dash });
    timeline!.to(characters, { strokeDashoffset: 0, duration: 1.6, ease: "power2.out", stagger: 0.05 }, 0);
    timeline!.to(wipe, { attr: { width: textBox.width + pad * 2 }, duration: 0.8, ease: "power2.inOut" }, 1.8);
    line.dataset.strokeReady = "";
  });
  if (visible) {
    if (previousProgress === 1) timeline.progress(1).pause();
    else timeline.progress(previousProgress).play();
  }
}

// Observe the unchanged HTML heading, so drawing the SVG cannot retrigger visibility.
const visibility = new IntersectionObserver(([entry]) => {
  if (!entry.isIntersecting) {
    visible = false;
    timeline?.pause(0);
  } else if (entry.intersectionRatio >= 0.15 && !visible) {
    visible = true;
    timeline?.play(0);
  }
}, { rootMargin: "-64px 0px 0px", threshold: [0, 0.15] });
visibility.observe(title);
const resize = new ResizeObserver(build);
resize.observe(title);
reducedMotion.addEventListener("change", build);
void document.fonts.ready.then(() => { fontsReady = true; build(); });
