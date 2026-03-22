import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
  throw new Error("GOOGLE_API_KEY is required");
}

export const ai = new GoogleGenAI({ apiKey });

export const MODEL_ID = "gemini-3.1-flash-lite-preview";

class Semaphore {
  private tasks: (() => void)[] = [];
  private running = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => this.tasks.push(resolve));
  }

  release(): void {
    this.running--;
    const next = this.tasks.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

const geminiRateLimiter = new Semaphore(35);

export async function generateContentWithRetry(
  params: Parameters<typeof ai.models.generateContent>[0],
  maxRetries = 5,
) {
  await geminiRateLimiter.acquire();

  try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await ai.models.generateContent(params);
      } catch (error: any) {
        const status = error?.status || error?.response?.status;
        const message = error?.message?.toLowerCase() || "";

        const isRetryable =
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          message.includes("429") ||
          message.includes("503") ||
          message.includes("quota") ||
          message.includes("overloaded") ||
          message.includes("deadline exceeded");

        if (isRetryable && attempt < maxRetries - 1) {
          const delayMs = 2 ** (attempt + 1) * 1000 + Math.random() * 1000;

          const errorType = status ? `Status ${status}` : "Transient Error";
          console.warn(
            `[Gemini] ${errorType} detected. Retrying in ${Math.round(delayMs)}ms... (Attempt ${attempt + 1}/${maxRetries})`,
          );

          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          throw error;
        }
      }
    }

    throw new Error("Max retries reached for Gemini API");
  } finally {
    geminiRateLimiter.release();
  }
}
