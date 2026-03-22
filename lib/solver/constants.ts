import path from "node:path";

export const INDEX_PATH = "data/vectors.msp";

// Local model directory (swap the comment below to use a remote HF model instead)
// export const EMBEDDING_MODEL = "Xenova/bge-m3";
export const EMBEDDING_MODEL = path.join(process.cwd(), "model");

// Ollama model for fallback and disambiguation.
// qwen2.5:7b at q4_K_M fits in ~4.1 GB VRAM and is substantially better at
// CCNA reasoning than 3b.
export const LLM_MODEL = "qwen2.5:7b-instruct-q4_K_M";

// How many candidates to retrieve from the vector index before re-ranking.
// Wider net → re-ranking has more to work with. Don't filter here; filter after.
export const DEFAULT_RETRIEVAL_LIMIT = 8;

// The initial ANN search threshold. Deliberately low (0.55) so borderline
// multilingual queries aren't discarded before re-ranking gets a shot.
// Re-ranking + the confidence gates below are the real accuracy filters.
export const DEFAULT_MIN_QUESTION_SIMILARITY = 0.55;

// Weight given to the question-only similarity score during re-ranking.
// export const RERANK_QUESTION_WEIGHT = 0.4;
export const RERANK_QUESTION_WEIGHT = 0.15;

// Minimum cosine similarity for answer-to-option mapping.
export const DEFAULT_MIN_PAIR_SIMILARITY = 0.5;

// Below this combined re-rank score, the vector hit is considered uncertain
// and the LLM is consulted as a cross-check / tiebreaker.
export const LLM_CONSULT_THRESHOLD = 0.78;

// Below this combined score, we skip the vector hit entirely and use LLM only.
export const LLM_ONLY_THRESHOLD = 0.65;

// When the top two answer options are within this margin in cosine similarity,
// trust the LLM to disambiguate rather than auto-picking the higher one.
export const ANSWER_AMBIGUITY_MARGIN = 0.04;
