import { Database } from "bun:sqlite";
import fs from "node:fs";
import { pipeline } from "@huggingface/transformers";
import { type AnyOrama, create, insertMultiple } from "@orama/orama";
import { persistToFile } from "@orama/plugin-data-persistence/server";

interface MatchingPair {
  term: string;
  definition: string;
}

interface Question {
  id: string;
  question: string;
  type: string;
  options: string[];
  correctAnswer: string[];
  matchingPairs: MatchingPair[];
  explanation?: string;
  imageUrl?: string | null;
  sourceUrl?: string;
  confidence?: number;
}

const DB_PATH = "data/questions.db";
const INDEX_PATH = "data/vectors.msp";

const CHECKPOINT_INTERVAL = 2000;
const BATCH_SIZE = 4;

function buildIndexText(q: Question): string {
  const safeQuestion = q.question || "";

  if (q.type === "matching") {
    const terms = (q.matchingPairs ?? []).map((p) => p.term).join(" ");
    const defs = (q.matchingPairs ?? []).map((p) => p.definition).join(" ");
    return `${safeQuestion} ${terms} ${defs}`.trim();
  }

  const allOptions = (q.options ?? []).join(" ");
  return `${safeQuestion} ${allOptions}`.trim();
}

async function ingest() {
  console.log("Starting vector ingestion...");

  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  const sqlite = new Database(DB_PATH, { readonly: true });

  const db = await create({
    schema: {
      id: "string",
      text: "string",
      embedding: "vector[1024]",
      data: "string",
    },
  });
  const orama = db as unknown as AnyOrama;

  console.log("Loading BGE-M3 model...");
  const extractor = await pipeline("feature-extraction", "Xenova/bge-m3");

  const { count: total } = sqlite
    .prepare("SELECT COUNT(*) as count FROM questions")
    .get() as { count: number };

  const query = sqlite.prepare("SELECT * FROM questions");
  const rowIterator = query.iterate() as IterableIterator<{
    id: number;
    data: string;
  }>;

  let processed = 0;
  const startTime = performance.now();

  console.log(`Total items to process: ${total}`);

  let batch: Array<{ id: number; data: string }> = [];

  const processBatch = async (rows: typeof batch) => {
    const parsed = rows.map((r) => {
      const q = JSON.parse(r.data) as Question;

      delete q.explanation;
      delete q.imageUrl;
      delete q.sourceUrl;
      delete q.confidence;

      return { question: q, raw: JSON.stringify(q) };
    });

    const texts = parsed.map(({ question: q }) => buildIndexText(q));

    const outputs = await extractor(texts, { pooling: "cls", normalize: true });

    const dims = 1024;
    const flat = outputs.data as Float32Array;

    const docs = parsed.map(({ question: q, raw }, i) => ({
      id: q.id,
      text: buildIndexText(q),
      embedding: Array.from(flat.subarray(i * dims, (i + 1) * dims)),
      data: raw,
    }));

    await insertMultiple(orama, docs);

    processed += rows.length;

    const elapsedMs = performance.now() - startTime;
    const msPerItem = elapsedMs / processed;
    const remainingMs = (total - processed) * msPerItem;
    const etaMinutes = Math.floor(remainingMs / 60000);
    const etaSeconds = Math.floor((remainingMs % 60000) / 1000);
    const memoryMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);

    process.stdout.write(
      `\r[${processed}/${total}] | ETA: ${etaMinutes}m ${etaSeconds}s | RAM: ${memoryMB}MB    `,
    );

    if (
      Math.floor(processed / CHECKPOINT_INTERVAL) >
      Math.floor((processed - rows.length) / CHECKPOINT_INTERVAL)
    ) {
      console.log(`\nCheckpoint: Saving index at ${processed} items...`);
      await persistToFile(orama, "binary", INDEX_PATH);
    }
  };

  for (const row of rowIterator) {
    batch.push(row);

    if (batch.length >= BATCH_SIZE) {
      try {
        await processBatch(batch);
      } catch (e) {
        console.error("\nFailed to process batch:", e);
      }
      batch = [];
    }
  }

  if (batch.length > 0) {
    try {
      await processBatch(batch);
    } catch (e) {
      console.error("\nFailed to process final batch:", e);
    }
  }

  console.log(`\nFinalizing: Saving complete index to ${INDEX_PATH}...`);
  await persistToFile(orama, "binary", INDEX_PATH);

  const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`\nDone! Processed ${total} questions in ${totalTime}s.`);

  sqlite.close();
}

ingest().catch(console.error);
