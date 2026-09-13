export {};
const prompt = document.querySelector<HTMLTextAreaElement>("#network-install-prompt");
const button = document.querySelector<HTMLButtonElement>("[data-copy-prompt]");
const status = document.querySelector<HTMLElement>("[data-copy-status]");
button?.addEventListener("click", async () => {
  if (!prompt || !status) return;
  try {
    await navigator.clipboard.writeText(prompt.value.trim());
    status.textContent = "Copied. Paste the prompt into your agent.";
    button.textContent = "Copied";
  } catch {
    prompt.focus();
    prompt.select();
    status.textContent = "The prompt is selected. Use your device's copy command.";
  }
});
