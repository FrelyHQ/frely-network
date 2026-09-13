import { inView } from "motion";
import { animate } from "motion/mini";

const items = [...document.querySelectorAll<HTMLElement>("[data-architecture-item]")];
const cards = items.map((item) => item.querySelector<HTMLElement>("[data-architecture-card]")!);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let cleanups: Array<() => void> = [];

function highlight(active: HTMLElement) {
  cards.forEach((card) => { card.dataset.active = String(card === active); });
}

cards.forEach((card, index) => {
  card.addEventListener("pointerenter", () => highlight(card));
  card.addEventListener("focus", () => highlight(card));
  card.addEventListener("click", () => {
    highlight(card);
    card.focus({ preventScroll: true });
  });
  card.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = Math.max(0, Math.min(cards.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    cards[next]?.focus();
  });
});

function configureMotion() {
  cleanups.forEach((cleanup) => cleanup());
  cleanups = [];
  if (reducedMotion.matches) return;

  items.forEach((item, index) => {
    const card = cards[index]!;
    let animation: ReturnType<typeof animate> | undefined;
    card.style.opacity = "0";
    card.style.transform = "scale(0.7)";

    function play(visible: boolean) {
      animation?.stop();
      animation = animate(card, {
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0.7)",
      }, { duration: 0.2, delay: 0.1, ease: "easeOut" });
    }

    function revealFocusedCard() {
      animation?.stop();
      card.style.opacity = "1";
      card.style.transform = "scale(1)";
    }

    // Observe the stable wrapper so scaling cannot move the visibility threshold.
    const stopObserving = inView(item, () => {
      play(true);
      return () => play(false);
    }, { amount: 0.5 });

    card.addEventListener("focus", revealFocusedCard);
    if (document.activeElement === card) revealFocusedCard();
    cleanups.push(() => {
      stopObserving();
      animation?.stop();
      card.removeEventListener("focus", revealFocusedCard);
      card.style.removeProperty("opacity");
      card.style.removeProperty("transform");
    });
  });
}

configureMotion();
reducedMotion.addEventListener("change", configureMotion);
