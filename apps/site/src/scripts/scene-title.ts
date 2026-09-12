import type { Application } from "@splinetool/runtime";
import { initShuffle } from "./brand-shuffle";

// Native title and its animated parent in the checked-in first-screen.splinecode.
const TITLE_ID = "1b4cbc9a-468e-44a5-9806-6653438e25d4";
const PART_TWO_ID = "a8e4a28a-f3cd-410e-9efa-98ab05e58d27";

export async function prepareSceneTitle(app: Application, stage: HTMLElement) {
  const label = stage.querySelector<HTMLElement>("[data-testid='scene-brand']");
  const nativeTitle = app.findObjectById(TITLE_ID);
  const partTwo = app.findObjectById(PART_TWO_ID);
  if (!label || !nativeTitle || !partTwo) return;

  // This is the same font embedded in the model. Keep the native text until it is ready.
  await document.fonts.load('32px "Frely Scene"');

  function reveal() {
    // Wait for Spline's own scene-2 entrance to finish, rather than guessing a delay.
    if (stage.dataset.state !== "engaged" || Math.abs(partTwo!.position.y) > 0.001) return;
    app.removeEventListener("rendered", reveal);
    nativeTitle!.hide();
    label!.hidden = false;
    void initShuffle(label!);
  }

  app.addEventListener("rendered", reveal);
  reveal();
}
