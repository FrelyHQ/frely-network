import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(ScrollTrigger, SplitText);

const duration = 0.35;
const stagger = 0.03;

export async function initShuffle(brand: HTMLElement) {
  await document.fonts.ready;

  // Keep the server-rendered text visible, including when reduced motion is requested.
  gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
    let split: SplitText | undefined;
    let timeline: gsap.core.Timeline | undefined;
    let visible = false;

    function create() {
      if (timeline) return;
      split = new SplitText(brand, {
        type: "chars",
        smartWrap: true,
        reduceWhiteSpace: false,
        aria: "auto",
      });

      const strips: HTMLElement[] = [];
      for (const char of split.chars as HTMLElement[]) {
        const width = char.getBoundingClientRect().width;
        if (!width) continue;
        const cell = document.createElement("span");
        cell.className = "shuffle-cell";
        Object.assign(cell.style, {
          display: "inline-block",
          overflow: "hidden",
          width: `${width}px`,
          verticalAlign: "bottom",
        });

        const strip = document.createElement("span");
        strip.className = "shuffle-strip";
        Object.assign(strip.style, {
          display: "inline-block",
          whiteSpace: "nowrap",
          willChange: "transform",
        });
        char.before(cell);
        cell.append(strip);
        char.style.width = `${width}px`;
        // shuffleTimes=1: two copies roll past the original from left to right.
        strip.append(char, char.cloneNode(true), char.cloneNode(true));
        strip.dataset.startX = String(-2 * width);
        strips.push(strip);
      }

      timeline = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 1 });
      const odd = strips.filter((_, index) => index % 2 === 1);
      const even = strips.filter((_, index) => index % 2 === 0);
      const evenStart = (duration + Math.max(0, odd.length - 1) * stagger) * 0.7;
      for (const [targets, start] of [[odd, 0], [even, evenStart]] as const) {
        timeline.fromTo(targets, {
          x: (_index: number, target: HTMLElement) => Number(target.dataset.startX),
        }, {
          x: 0,
          duration,
          stagger,
          ease: "power3.out",
          force3D: true,
        }, start);
      }
      if (visible) timeline.play();
    }

    // threshold=0.1, with the supplied component's default rootMargin of -100px.
    const trigger = ScrollTrigger.create({
      trigger: brand,
      start: "top 90%-=100px",
      once: true,
      onEnter: create,
    });

    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) timeline?.resume();
      else timeline?.pause();
    });
    visibility.observe(brand);

    function onHover() {
      // During the one-second loop gap, hovering starts the next shuffle immediately.
      if (visible && timeline && timeline.time() >= timeline.duration()) timeline.restart();
    }
    brand.addEventListener("mouseenter", onHover);

    return () => {
      visibility.disconnect();
      trigger.kill();
      timeline?.kill();
      brand.removeEventListener("mouseenter", onHover);
      split?.revert();
    };
  });
}
