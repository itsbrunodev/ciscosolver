export function cos_sim(A: number[], B: number[]): number {
  let dot = 0;
  const len = Math.min(A.length, B.length);
  for (let i = 0; i < len; i++) dot += (A[i] ?? 0) * (B[i] ?? 0);
  return dot;
}

export function cleanOptionText(text: string): string {
  if (!text) return "";
  return text
    .trim()
    .replace(/^[A-Za-z][.)]\s*|^-\s*|^\s*\d+[.)]\s*/, "")
    .trim();
}

export function buildQueryText(
  question: string,
  options?: string[],
  terms?: string[],
  definitions?: string[],
): string {
  const q = question.trim();

  if (Array.isArray(terms) && terms.length > 0) {
    const termsStr = terms.join(" ");
    const defsStr = (definitions ?? []).join(" ");
    return `${q} ${termsStr} ${defsStr}`.trim();
  }

  const cleanedOptions = (options ?? []).map(cleanOptionText).join(" ");
  return `${q} ${cleanedOptions}`.trim();
}
