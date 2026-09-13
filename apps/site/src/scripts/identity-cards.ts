import { inView, springValue, styleEffect } from "motion";
import { animate } from "motion/mini";

const steps = [...document.querySelectorAll<HTMLButtonElement>(".identity-step")];
const tilt = document.querySelector<HTMLElement>("[data-provider-tilt]");
const card = tilt?.querySelector<HTMLElement>(".provider-record");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const mousePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
let cleanups: Array<() => void> = [];

function configureMotion() {
  cleanups.forEach((cleanup) => cleanup());
  cleanups = [];
  if (reducedMotion.matches) return;

  steps.forEach((step) => {
    let animation: ReturnType<typeof animate> | undefined;
    step.style.opacity = "0";
    step.style.transform = "scale(0.7)";

    function play(visible: boolean) {
      animation?.stop();
      animation = animate(step, {
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1)" : "scale(0.7)",
      }, { duration: 0.2, delay: 0.1, ease: "easeOut" });
    }

    function revealFocusedStep() {
      animation?.stop();
      step.style.opacity = "1";
      step.style.transform = "scale(1)";
    }

    // Keep the observed row stable while its button scales in and out.
    const stopObserving = inView(step.parentElement!, () => {
      play(true);
      return () => play(false);
    }, { amount: 0.5 });

    step.addEventListener("focus", revealFocusedStep);
    if (document.activeElement === step) revealFocusedStep();
    cleanups.push(() => {
      stopObserving();
      animation?.stop();
      step.removeEventListener("focus", revealFocusedStep);
      step.style.removeProperty("opacity");
      step.style.removeProperty("transform");
    });
  });

  if (!tilt || !card || !mousePointer.matches) return;
  const spring = { damping: 30, stiffness: 100, mass: 2 };
  const rotateX = springValue<number>(0, spring);
  const rotateY = springValue<number>(0, spring);
  const scale = springValue<number>(1, spring);
  const stopRendering = styleEffect(card, { rotateX, rotateY, scale });

  function followPointer(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    // Measure the untransformed container, not the moving card.
    const bounds = tilt!.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, (event.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2)));
    const y = Math.max(-1, Math.min(1, (event.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2)));
    rotateX.set(-y * 12);
    rotateY.set(x * 12);
    scale.set(1.05);
  }

  function resetTilt() {
    rotateX.set(0);
    rotateY.set(0);
    scale.set(1);
  }

  tilt.addEventListener("pointerenter", followPointer);
  tilt.addEventListener("pointermove", followPointer);
  tilt.addEventListener("pointerleave", resetTilt);
  tilt.addEventListener("pointercancel", resetTilt);
  window.addEventListener("blur", resetTilt);
  window.addEventListener("scroll", resetTilt, { passive: true });
  cleanups.push(() => {
    tilt.removeEventListener("pointerenter", followPointer);
    tilt.removeEventListener("pointermove", followPointer);
    tilt.removeEventListener("pointerleave", resetTilt);
    tilt.removeEventListener("pointercancel", resetTilt);
    window.removeEventListener("blur", resetTilt);
    window.removeEventListener("scroll", resetTilt);
    stopRendering();
    [rotateX, rotateY, scale].forEach((value) => value.destroy());
    card.style.removeProperty("transform");
  });
}

configureMotion();
reducedMotion.addEventListener("change", configureMotion);
mousePointer.addEventListener("change", configureMotion);
