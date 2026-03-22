export type QuestionType = "single-choice" | "multiple-choice" | "matching";

export interface MatchingPair {
  term: string;
  definition: string;
}

export interface Question {
  id: string;
  question: string;
  type: QuestionType;
  options: string[];
  correctAnswer: string[];
  matchingPairs: MatchingPair[];
  explanation?: string;
  imageUrl: string | null;
  sourceUrl: string;
  confidence: number;
}
