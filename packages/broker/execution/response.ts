export async function parseFrelyResponse(response: Response): Promise<unknown> {
  let result: { output_text?: unknown; output?: unknown; status?: unknown };
  try { result = await response.json() as typeof result; } catch { throw new Error("PROVIDER_RESULT_INVALID"); }
  if (!result || typeof result !== "object" || ["failed", "incomplete", "in_progress", "queued"].includes(String(result.status))) throw new Error("PROVIDER_RESULT_INVALID");
  const hasText = typeof result.output_text === "string" && result.output_text.trim().length > 0;
  const hasOutput = Array.isArray(result.output) && result.output.some((item) => Array.isArray(item?.content) && item.content.some((part: { type?: string; text?: string }) => part?.type === "output_text" && typeof part.text === "string" && part.text.trim()));
  if (!hasText && !hasOutput) throw new Error("PROVIDER_RESULT_INVALID");
  return result;
}
