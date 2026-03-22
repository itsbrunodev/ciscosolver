export interface SolveRequest {
  question: string;
  options?: string[];
  terms?: string[];
  definitions?: string[];
  overrides: {
    minQuestionSimilarity?: number;
    minAnswerSimilarity?: number;
    candidateCount?: number;
    bypassCache?: boolean;
  };
}

export interface SolveResult {
  answers?: string[];
  matchingPairs?: Array<{ term: string; definition: string }>;
  confidence: number;
  source: "db" | "llm" | "db+llm" | "not_found" | "cache";
  explanation?: string;
}
