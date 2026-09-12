// Explanatory interactions only: these diagrams do not initiate network or payment calls.
const identitySteps = document.querySelectorAll<HTMLButtonElement>("[data-identity-step]");
const record = document.querySelector<HTMLElement>("#provider-record");

identitySteps.forEach((button) => {
  button.addEventListener("click", () => {
    identitySteps.forEach((step) => step.setAttribute("aria-pressed", String(step === button)));
    if (record) record.dataset.identityActive = button.dataset.identityStep;
  });
});

// Content stays visible without JavaScript and under reduced-motion preferences.
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
const revealElements = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
const revealSections = [...document.querySelectorAll<HTMLElement>(".story-section")];
const revealObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const visible = entry.isIntersecting && entry.intersectionRatio > 0;
    entry.target.querySelectorAll<HTMLElement>("[data-reveal]").forEach((element) => {
      element.classList.toggle("reveal-pending", !visible);
    });
  }
}, { rootMargin: "-64px 0px 0px 0px", threshold: [0, 0.001] });

function configureReveals() {
  revealObserver.disconnect();
  revealElements.forEach((element) => element.classList.remove("reveal-pending"));
  if (motion.matches) return;

  // Observe each stable section so the text's own movement cannot retrigger visibility.
  revealSections.forEach((section) => {
    const bounds = section.getBoundingClientRect();
    const hidden = bounds.top >= window.innerHeight || bounds.bottom <= 64;
    section.querySelectorAll<HTMLElement>("[data-reveal]").forEach((element) => {
      element.classList.toggle("reveal-pending", hidden);
    });
    revealObserver.observe(section);
  });
}

configureReveals();
motion.addEventListener("change", configureReveals);
