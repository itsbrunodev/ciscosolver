import { USER_AGENTS } from "./constants";

export function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] || "";
}
