/* ============================================================
   VINZX AI — BACKEND (Node.js + Express + @google/genai)
   ============================================================
   KONFIGURASI GEMINI API KEY
   ------------------------------------------------------------
   Isi API key Gemini Anda pada konstanta di bawah ini.
   Untuk deployment publik (Railway), gunakan environment
   variable GEMINI_API_KEY yang akan otomatis dipakai jika
   konstanta di bawah masih placeholder.
   ============================================================ */
const GEMINI_API_KEY = "AQ.Ab8RN6KINhdfuqnAM4LBqhRNEPQFfOAC3appPWzjwHcg-Lyc3w";
// ↑ GANTI dengan API key Gemini Anda, atau set env GEMINI_API_KEY.

/* Model default (ID resmi Google Gemini). */
const DEFAULT_MODEL = "gemini-2.0-flash";

/* Allowlist model yang benar-benar didukung. */
const ALLOWED_MODELS = [
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash (Cepat)" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];

/* ============================================================
   IMPORTS & APP
   ============================================================ */
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const PORT = process.env.PORT || 3000;

/* Ambil key dari env jika konstanta masih placeholder */
const API_KEY = (() => {
  if (GEMINI_API_KEY && GEMINI_API_KEY !== "ISI_API_KEY_GEMINI_DI_SINI") {
    return GEMINI_API_KEY;
  }
  return process.env.GEMINI_API_KEY || "";
})();

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

/* ============================================================
   MIDDLEWARE
   ============================================================ */
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "256kb" }));

/* Rate limiting */
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Terlalu banyak permintaan. Coba lagi nanti." },
});
app.use("/api/", limiter);

/* Timeout helper */
function withTimeout(promise, ms, label = "AI") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout ${label}`)), ms)),
  ]);
}

/* Validasi panjang teks */
function clampText(t, max) {
  if (typeof t !== "string") return "";
  return t.length > max ? t.slice(0, max) : t;
}

/* ============================================================
   PROMPT BUILDER
   ============================================================ */
function buildPrompt({ question, options, excerpt, url, title }) {
  const parts = [];
  parts.push(
    "Anda adalah asisten AI yang menjawab pertanyaan dari halaman web. " +
    "Berikan jawaban langsung, akurat, dan ringkas. Sertakan penjelasan singkat."
  );
  if (title) parts.push(`Judul halaman: ${title}`);
  if (url) parts.push(`URL: ${url}`);
  if (question) parts.push(`Pertanyaan: ${question}`);
  if (options?.length) parts.push(`Pilihan jawaban:\n${options.map((o) => `- ${o}`).join("\n")}`);
  if (!question && excerpt) parts.push(`Konteks halaman:\n${excerpt}`);
  parts.push(
    "\nBalas dalam format JSON: {\"answer\": \"...\", \"explanation\": \"...\"} " +
    "tanpa teks tambahan di luar JSON."
  );
  return parts.join("\n");
}

/* ============================================================
   GEMINI CALL
   ============================================================ */
async function callGemini(modelId, prompt) {
  if (!ai) throw new Error("Server belum dikonfigurasi dengan Gemini API key.");

  const response = await withTimeout(
    ai.models.generateContent({
      model: modelId,
      contents: prompt,
    }),
    40000,
    "Gemini"
  );

  const raw = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!raw) throw new Error("AI tidak mengembalikan jawaban.");

  /* Coba parse JSON */
  let parsed = null;
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    /* fallback: kembalikan teks mentah */
    parsed = { answer: raw.trim(), explanation: "" };
  }

  return {
    answer: String(parsed.answer || raw).slice(0, 4000),
    explanation: String(parsed.explanation || "").slice(0, 4000),
  };
}

/* ============================================================
   ENDPOINTS
   ============================================================ */

/* GET /api/status */
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    service: "Vinzx AI Backend",
    version: "1.0.0",
    aiConfigured: !!ai,
    defaultModel: DEFAULT_MODEL,
    timestamp: new Date().toISOString(),
  });
});

/* GET /api/models */
app.get("/api/models", (req, res) => {
  res.json({
    ok: true,
    defaultModel: DEFAULT_MODEL,
    models: ALLOWED_MODELS,
  });
});

/* POST /api/scan */
app.post("/api/scan", async (req, res) => {
  try {
    const { model, question, options, excerpt, url, title } = req.body || {};

    const chosenModel = model && ALLOWED_MODELS.some((m) => m.id === model)
      ? model
      : DEFAULT_MODEL;

    const payload = {
      question: clampText(question, 1500),
      options: Array.isArray(options) ? options.slice(0, 8).map((o) => clampText(o, 300)) : [],
      excerpt: clampText(excerpt, 4000),
      url: clampText(url, 500),
      title: clampText(title, 300),
    };

    if (!payload.question && !payload.excerpt) {
      return res.status(400).json({
        ok: false,
        error: "Tidak ada pertanyaan atau konteks yang dikirim.",
      });
    }

    const prompt = buildPrompt(payload);
    const result = await callGemini(chosenModel, prompt);

    res.json({
      ok: true,
      model: chosenModel,
      answer: result.answer,
      explanation: result.explanation,
    });
  } catch (err) {
    console.error("[scan] error:", err.message);
    const status = /timeout/i.test(err.message) ? 504 : 500;
    res.status(status).json({
      ok: false,
      error: err.message || "Terjadi kesalahan pada server.",
    });
  }
});

/* POST /api/ask */
app.post("/api/ask", async (req, res) => {
  try {
    const { model, question } = req.body || {};
    const chosenModel = model && ALLOWED_MODELS.some((m) => m.id === model)
      ? model
      : DEFAULT_MODEL;

    const q = clampText(question, 2000);
    if (!q) {
      return res.status(400).json({ ok: false, error: "Pertanyaan kosong." });
    }

    const prompt =
      "Jawab pertanyaan berikut secara langsung dan ringkas. " +
      "Sertakan penjelasan singkat.\n\n" +
      "Balas dalam format JSON: {\"answer\": \"...\", \"explanation\": \"...\"} " +
      "tanpa teks tambahan di luar JSON.\n\n" +
      `Pertanyaan: ${q}`;

    const result = await callGemini(chosenModel, prompt);

    res.json({
      ok: true,
      model: chosenModel,
      answer: result.answer,
      explanation: result.explanation,
    });
  } catch (err) {
    console.error("[ask] error:", err.message);
    const status = /timeout/i.test(err.message) ? 504 : 500;
    res.status(status).json({
      ok: false,
      error: err.message || "Terjadi kesalahan pada server.",
    });
  }
});

/* 404 fallback */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Endpoint tidak ditemukan." });
});

/* ============================================================
   START SERVER
   ============================================================ */
app.listen(PORT, () => {
  console.log(`Vinzx AI Backend listening on port ${PORT}`);
  console.log(`AI configured: ${ai ? "YES" : "NO (isi GEMINI_API_KEY)"}`);
});