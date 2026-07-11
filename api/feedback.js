// Vercel Serverless Function:  POST /api/feedback
// 子どもの作文＋先生の意図(観点・見本・トーン・学年)を受け取り、Geminiで添削を返す。
// APIキーは Vercel の環境変数 GEMINI_API_KEY に入れる（コードには絶対書かない）。
// モデルは MODEL 環境変数で差し替え可（未設定なら gemini-2.5-flash / 無料枠対象）。

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/* {穴} を分解（フロントの parseFrame と同じ） */
function parseFrame(frame) {
  const parts = [];
  const re = /\{([^}]+)\}/g;
  let last = 0, m;
  while ((m = re.exec(frame))) {
    if (m.index > last) parts.push({ type: "text", value: frame.slice(last, m.index) });
    parts.push({ type: "blank", key: m[1] });
    last = re.lastIndex;
  }
  if (last < frame.length) parts.push({ type: "text", value: frame.slice(last) });
  return parts;
}

/* 先生の見本(テンプレの例)をプレーンテキストに組み立て */
function buildMihon(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.map((b) => {
    const lab = b.label ? `【${b.label}】` : "";
    if (b.type === "read")  return lab + (b.text || "");
    if (b.type === "frame") {
      const line = parseFrame(b.frame || "")
        .map((p) => (p.type === "text" ? p.value : (b.example && b.example[p.key]) || `（${p.key}）`))
        .join("");
      return lab + line;
    }
    return lab + (b.example || "");
  }).filter((s) => s.replace(/【.*?】/g, "").trim()).join("\n");
}

const GRADE_WORD = {
  low:  "小学1・2年生。ひらがな中心で、みじかく、やさしい言葉で話しかける。",
  mid:  "小学3・4年生。やさしい言葉で、少していねいに。",
  high: "小学5・6年生。ていねいな言い回しでもよい。",
};
const TONE_WORD = [
  "とてもやさしく、できているところをたくさんほめる。直すところは1つだけ、そっと伝える。",
  "バランスよく。ほめたうえで、直すとよいところも具体的に伝える。",
  "しっかりと、直すところをはっきり伝える。ただし決して責めず、はげます。",
];

function buildPrompt(p) {
  const name  = p.teacherName || "先生";
  const grade = GRADE_WORD[p.grade] || GRADE_WORD.mid;
  const tone  = TONE_WORD[[0,1,2].includes(p.tone) ? p.tone : 1];
  const aims  = (p.aims || []).filter(Boolean);
  const mihon = buildMihon(p.template);

  return [
    `あなたは小学校の先生「${name}先生」のかわりに、子どもの作文を添削するAIです。`,
    `読み手: ${grade}`,
    `添削のトーン: ${tone}`,
    aims.length ? `先生が今回いちばん見てほしい観点（この順で1つずつ返す）:\n${aims.map((a,i)=>`${i+1}. ${a}`).join("\n")}` : `観点は特に指定なし。作文としての良さと、伝わりやすさを見る。`,
    mihon ? `先生の見本（お手本）:\n${mihon}` : "",
    p.source ? `子どもが読んだ元の文章:\n${p.source}` : "",
    `子どもが書いた文章:\n${p.studentText || ""}`,
    "",
    "つぎのルールでJSONを返してください。",
    "- praise: できているところを1つ、やさしくほめる短い文（子どもの名前は出さない）。",
    aims.length
      ? "- advices: 上の観点ごとに1つずつ。{aim: 観点名, msg: その観点でのアドバイス}。観点名は先生の言葉のまま。むずかしい直しを一度に言わず、見本と比べて具体的に。"
      : "- advices: 気づいた点を1〜2つ。{aim: 短い見出し, msg: アドバイス}。",
    "- next: つぎの一歩を1文で。",
    "すべて日本語。読み手の学年に合わせた言葉で。事実は子どもの文章にあることだけを使い、作り話をしない。空いている欄があれば、そこを書くようにやさしくうながす。",
  ].filter(Boolean).join("\n");
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    praise: { type: "string" },
    advices: {
      type: "array",
      items: {
        type: "object",
        properties: { aim: { type: "string" }, msg: { type: "string" } },
        required: ["aim", "msg"],
      },
    },
    next: { type: "string" },
  },
  required: ["praise", "advices", "next"],
};

module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  // 診断用: ブラウザで /api/feedback を開く(GET)と、キーの有無とモデル名だけ返す（キー本体は出さない）
  if (req.method === "GET") { res.status(200).json({ ok: true, keyPresent: !!key, model: MODEL }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  if (!key) { res.status(500).json({ error: "GEMINI_API_KEY is not set" }); return; }

  // body は Vercel が JSON パース済み。念のため文字列でも受ける。
  let p = req.body;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = {}; } }
  p = p || {};
  if (!p.studentText || !p.studentText.trim()) { res.status(400).json({ error: "empty studentText" }); return; }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const gBody = {
    contents: [{ role: "user", parts: [{ text: buildPrompt(p) }] }],
    generationConfig: {
      temperature: 0.6,
      responseMimeType: "application/json",
    },
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gBody),
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: "gemini " + r.status, detail: t.slice(0, 500) });
      return;
    }
    const data = await r.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) { res.status(502).json({ error: "no content", detail: JSON.stringify(data).slice(0, 500) }); return; }
    text = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const out = JSON.parse(text);
    out.name = p.teacherName || "先生";
    out.voice = p.teacherVoice || "";
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
