import type { z } from "zod";

// AI question generation for the standalone deploy.
//
// Two modes, chosen purely by environment:
//  1. External provider — when AI_API_KEY is set, call an OpenAI-compatible
//     chat-completions endpoint (AI_API_BASE_URL, default api.openai.com;
//     AI_MODEL, default gpt-4o-mini) and validate the JSON with the caller's
//     zod schema.
//  2. Local fallback — when no key is configured OR the provider call fails,
//     generate template-based draft questions from the teacher's own material
//     (cloze / comprehension / arithmetic-from-material). The feature never
//     dead-ends: the teacher always gets editable drafts.
//
// There are deliberately NO Muse-internal inference calls here.

interface ParsedRequest {
  count: number;
  type: "pilihan_ganda" | "isian" | "essay" | "angka";
  material: string;
}

function parsePrompt(prompt: string): ParsedRequest {
  const countMatch = prompt.match(/Buat\s+(\d+)\s+soal/i);
  const count = countMatch ? Math.max(1, Math.min(20, Number(countMatch[1]))) : 5;
  let type: ParsedRequest["type"] = "pilihan_ganda";
  if (/isian singkat/i.test(prompt)) type = "isian";
  else if (/berhitung/i.test(prompt)) type = "angka";
  else if (/essay/i.test(prompt)) type = "essay";
  const matIdx = prompt.indexOf("MATERI:");
  const material = (matIdx >= 0 ? prompt.slice(matIdx + "MATERI:".length) : prompt).trim();
  return { count, type, material };
}

const STOPWORDS = new Set(
  (
    "yang dan dari pada untuk dengan dalam adalah ialah merupakan sebagai " +
    "atau ini itu tidak juga akan dapat oleh karena sehingga agar saat ketika " +
    "antara menjadi memiliki dilakukan secara lebih sangat sudah telah ada " +
    "bagi para suatu sebuah tentang terhadap melalui proses hasil berikut " +
    "digunakan menggunakan terdiri disebut dikenal berfungsi bekerja terjadi"
  ).split(" "),
);

function sentencesOf(material: string): string[] {
  return material
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

function keywordsOf(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-zÀ-ÿ-]+/)) {
    const w = raw.trim();
    const low = w.toLowerCase();
    if (w.length >= 5 && !STOPWORDS.has(low) && !seen.has(low)) {
      seen.add(low);
      out.push(w);
    }
  }
  return out;
}

function cloze(sentence: string, keyword: string): string {
  const idx = sentence.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx < 0) return sentence;
  return sentence.slice(0, idx) + "_____" + sentence.slice(idx + keyword.length);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

interface DraftLike {
  prompt: string;
  options: string[];
  correctAnswer: string;
}

function localGenerate(req: ParsedRequest): DraftLike[] {
  const sentences = sentencesOf(req.material);
  const allKeywords = keywordsOf(req.material);
  const out: DraftLike[] = [];

  if (req.type === "angka") {
    const nums = (req.material.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) =>
      Number(n.replace(",", ".")),
    );
    for (let i = 0; i < req.count; i++) {
      const a = nums[i % Math.max(nums.length, 1)];
      const b = nums[(i + 1) % Math.max(nums.length, 1)];
      if (nums.length >= 2 && a !== undefined && b !== undefined) {
        const ops = [
          { sym: "+", val: a + b },
          { sym: "−", val: a - b },
          { sym: "×", val: a * b },
        ];
        const op = ops[i % ops.length]!;
        out.push({
          prompt: `Berdasarkan materi, berapakah hasil dari ${a} ${op.sym} ${b}?`,
          options: [],
          correctAnswer: String(op.val),
        });
      } else if (nums.length === 1 && a !== undefined) {
        out.push({
          prompt: `Berdasarkan materi, berapakah hasil dari ${a} × 2?`,
          options: [],
          correctAnswer: String(a * 2),
        });
      } else {
        const x = 6 + i * 3;
        const y = 7 + i;
        out.push({
          prompt: `Berapakah hasil dari ${x} × ${y}?`,
          options: [],
          correctAnswer: String(x * y),
        });
      }
    }
    return out;
  }

  const usable = sentences.length > 0 ? sentences : [req.material.slice(0, 220)];
  for (let i = 0; i < req.count; i++) {
    const sentence = usable[i % usable.length]!;
    const kws = keywordsOf(sentence);
    const keyword = kws[0] ?? allKeywords[i % Math.max(allKeywords.length, 1)] ?? "";
    if (req.type === "essay") {
      out.push({
        prompt: `Jelaskan dengan kata-katamu sendiri pernyataan berikut dari materi: "${sentence}"`,
        options: [],
        correctAnswer: sentence,
      });
    } else if (keyword) {
      const blanked = cloze(sentence, keyword);
      if (req.type === "pilihan_ganda") {
        const distractors = shuffle(allKeywords.filter((k) => k !== keyword)).slice(0, 3);
        while (distractors.length < 3) {
          distractors.push(
            ["Tidak disebutkan dalam materi", "Semua jawaban keliru", "Bukan salah satu di atas"][
              distractors.length
            ]!,
          );
        }
        out.push({
          prompt: `Lengkapi pernyataan berikut berdasarkan materi: ${blanked}`,
          options: shuffle([keyword, ...distractors]),
          correctAnswer: keyword,
        });
      } else {
        out.push({
          prompt: `Isilah titik-titik berikut berdasarkan materi: ${blanked}`,
          options: [],
          correctAnswer: keyword,
        });
      }
    } else {
      out.push({
        prompt: `Apa gagasan utama dari pernyataan berikut dalam materi: "${sentence}"?`,
        options: [],
        correctAnswer: sentence,
      });
    }
  }
  return out;
}

async function externalGenerate(
  prompt: string,
  opts: { schema: z.ZodTypeAny; timeout_secs?: number },
): Promise<unknown> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("AI_API_KEY not configured");
  const baseUrl = (process.env.AI_API_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.AI_MODEL ?? "gpt-4o-mini";
  const timeoutMs = (opts.timeout_secs ?? 60) * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              'You generate Indonesian school exam questions. Respond with JSON only: {"questions":[{"prompt":"...","options":["..."],"correctAnswer":"..."}]}. For non-multiple-choice questions use an empty options array.',
          },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`AI provider HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI provider returned no content");
    return JSON.parse(content) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drop-in replacement for the original ctx.inference.complete(prompt,
 * { schema, timeout_secs }). Validates the result with the caller's schema.
 */
export async function inferenceComplete(
  prompt: string,
  opts: { schema: z.ZodTypeAny; timeout_secs?: number },
): Promise<any> {
  if (process.env.AI_API_KEY) {
    try {
      const raw = await externalGenerate(prompt, opts);
      return opts.schema.parse(raw);
    } catch {
      // Provider unreachable/invalid output → fall through to the local
      // generator so the teacher is never stuck on an error screen.
    }
  }
  const drafts = localGenerate(parsePrompt(prompt));
  return opts.schema.parse({ questions: drafts });
}
