import type { Application } from "@splinetool/runtime";
import { prepareSceneTitle } from "./scene-title";

const stage = document.querySelector<HTMLElement>("#top")!;
const first = stage.querySelector<HTMLElement>("[data-testid='first-screen']")!;
const second = stage.querySelector<HTMLElement>("#second-screen")!;
const clickMe = stage.querySelector<HTMLButtonElement>("[data-testid='click-me']")!;
const hint = stage.querySelector<HTMLElement>("[data-testid='scroll-hint']")!;

// The two native click targets in first-screen.splinecode share the same act-2 animation.
const ENTER_LABEL = "6e165d5a-6439-48a2-9cb6-f59606d95cb7";
const ENTER_ROBOT = "06c62216-cef7-46b6-bd80-75df8c04212f";
const SECOND_SCENE_GROUP = "a8e4a28a-f3cd-410e-9efa-98ab05e58d27";
const SECOND_SCENE_READY_STATE = "748e3077-f965-42dd-aabf-cb5fd37448e8";
const GESTURE_IDLE_MS = 240;
const SCENE_TRANSITION_MS = 2400;
const SCROLL_MS = 420;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let firstApp: Application | undefined;
let secondApp: Application | undefined;
let lastWheelAt = -Infinity;
let gestureUsed = false;
let sceneLockedUntil = 0;
let scrolling = false;

function markEngaged() {
  if (stage.dataset.state === "engaged") return;
  stage.dataset.state = "engaged";
  document.documentElement.dataset.landing = "engaged";
  clickMe.hidden = true;
  hint.textContent = "Scroll to the next scene";
  sceneLockedUntil = performance.now() + SCENE_TRANSITION_MS;
}

function enterScene() {
  if (first.dataset.sceneLoad !== "ready" || stage.dataset.state === "engaged") return;
  // Trigger Spline's authored transition; a DOM state change alone cannot switch the model.
  firstApp?.emitEvent("mouseDown", ENTER_LABEL);
}

clickMe.addEventListener("click", enterScene);

function screenTop(screen: HTMLElement) {
  return window.scrollY + screen.getBoundingClientRect().top;
}

function drawFrame(app: Application) {
  return new Promise<void>((resolve) => {
    const onRendered = () => {
      app.removeEventListener("rendered", onRendered);
      resolve();
    };
    app.addEventListener("rendered", onRendered);
    app.requestRender();
  });
}

async function scrollToScreen(screen: HTMLElement) {
  scrolling = true;
  const waitingAt = window.scrollY;
  if (screen === second && second.dataset.sceneLoad === "loading") {
    hint.textContent = "Loading the next scene…";
    // A first visit can reach this point before the second model has loaded and drawn.
    // Keep its placeholder offscreen, then perform the requested scroll once it is ready.
    await scenesReady;
    if (first.dataset.sceneLoad === "ready") hint.textContent = "Scroll to the next scene";
  }
  // A delayed canvas resize can invalidate its initial offscreen frame.
  // Refresh it before scrolling, rather than waiting for visibility to trigger drawing.
  if (screen === second && secondApp) await drawFrame(secondApp);
  if (window.scrollY !== waitingAt) {
    scrolling = false;
    return;
  }
  const startY = window.scrollY;
  const startAt = performance.now();
  const duration = reducedMotion.matches ? 0 : SCROLL_MS;

  function frame(now: number) {
    const progress = duration === 0 ? 1 : Math.min(1, (now - startAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    // Explicit instant steps avoid nesting this animation inside global CSS smooth scrolling.
    window.scrollTo({ top: startY + (screenTop(screen) - startY) * eased, behavior: "instant" });
    if (progress < 1) requestAnimationFrame(frame);
    else scrolling = false;
  }

  requestAnimationFrame(frame);
}

window.addEventListener("wheel", (event) => {
  if (event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;

  const now = performance.now();
  // Use input timestamps so a busy 3D render cannot turn queued inertia into a new gesture.
  if (event.timeStamp - lastWheelAt > GESTURE_IDLE_MS) gestureUsed = false;
  lastWheelAt = event.timeStamp;

  const y = window.scrollY;
  const secondTop = screenTop(second);
  const inFirst = y < secondTop - 2;
  const inSecond = y >= secondTop - 2 && y < secondTop + second.offsetHeight - 2;

  // Consume the rest of a wheel/touchpad gesture, including inertia after an animation ends.
  if (scrolling || (gestureUsed && (inFirst || inSecond))) {
    event.preventDefault();
    return;
  }

  if (inFirst && event.deltaY > 0) {
    event.preventDefault();
    gestureUsed = true;
    if (first.dataset.sceneLoad === "loading" || now < sceneLockedUntil) return;
    if (stage.dataset.state === "splash" && first.dataset.sceneLoad === "ready") enterScene();
    else scrollToScreen(second);
  } else if (event.deltaY < 0) {
    if (y > secondTop + 2) {
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      // Finish returning to screen two before a new gesture can enter screen one.
      if (y + event.deltaY * unit <= secondTop) {
        event.preventDefault();
        gestureUsed = true;
        scrollToScreen(second);
      }
    } else if (y > 2) {
      event.preventDefault();
      gestureUsed = true;
      scrollToScreen(first);
    }
  }
}, { passive: false, capture: true });

async function loadScenes() {
  const { Application } = await import("@splinetool/runtime");
  const apps = new Map<HTMLElement, Application>();
  const visibleScreens = new Set<Element>();
  const visibility = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const app = apps.get(entry.target as HTMLElement);
      // stop()/play() replays Spline Start events. Pause drawing, retaining each scene's state.
      if (entry.isIntersecting && entry.intersectionRatio > 0) {
        visibleScreens.add(entry.target);
        app?.requestRender();
      } else visibleScreens.delete(entry.target);
    }
  }, { threshold: [0, 0.001] });

  for (const [screen, scene] of [[first, "first-screen"], [second, "second-screen"]] as const) {
    const canvas = screen.querySelector<HTMLCanvasElement>("canvas")!;
    let app: Application | undefined;
    try {
      // Use the same synchronous renderer for both exports so a rendered event
      // represents a complete frame, without WebGPU's asynchronous shader warmup.
      app = new Application(canvas, { renderMode: "manual", renderer: "webgl" });
      await app.load(`/scenes/${scene}.splinecode`);
      if (screen === second) {
        const particles = app.findObjectById(SECOND_SCENE_GROUP);
        if (!particles) throw new Error("The second scene is missing its particle group.");
        // Apply the authored final state immediately, completing its Start transition.
        // Particle motion continues; the group no longer slides in from below the screen.
        particles.state = SECOND_SCENE_READY_STATE;
        // Manual mode leaves the old canvas pixels intact after a state change.
        // Draw the final background offscreen before allowing the canvas to appear.
        await drawFrame(app);
        secondApp = app;
      }
      app.addEventListener("rendered", () => {
        if (visibleScreens.has(screen)) app?.requestRender();
      });
      if (screen === first) {
        if (!app.getSplineEvents().mouseDown?.[ENTER_LABEL]) {
          throw new Error("The first scene is missing its native entry event.");
        }
        firstApp = app;
        void prepareSceneTitle(app, stage).catch((error) => {
          console.error("Could not prepare the scene title", error);
        });
        app.addEventListener("mouseDown", ({ target }) => {
          if (target.id === ENTER_LABEL || target.id === ENTER_ROBOT) markEngaged();
        });
        clickMe.disabled = false;
        hint.textContent = "Click the robot or scroll to begin";
      }
      apps.set(screen, app);
      screen.dataset.sceneLoad = "ready";
      visibility.observe(screen);
    } catch (error) {
      app?.dispose();
      screen.dataset.sceneLoad = "error";
      const message = screen.querySelector<HTMLElement>(".scroll-hint");
      if (message) message.textContent = "Scene unavailable. Scroll to continue.";
      console.error(`Could not load ${scene}`, error);
    }
  }
}

const scenesReady = loadScenes().catch((error) => {
  // A runtime download failure must not trap visitors at the top of the page.
  first.dataset.sceneLoad = "error";
  second.dataset.sceneLoad = "error";
  hint.textContent = "Scene unavailable. Scroll to continue.";
  console.error("Could not load Spline runtime", error);
});
