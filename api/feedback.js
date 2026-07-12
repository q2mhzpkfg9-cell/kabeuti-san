// Vercel Serverless Function:  POST /api/feedback
// 子どもの作文＋先生の意図(観点・見本・トーン・学年)を受け取り、Geminiで添削を返す。
// APIキーは Vercel の環境変数 GEMINI_API_KEY に入れる（コードには絶対書かない）。
// モデルは MODEL 環境変数で差し替え可（未設定なら gemini-2.5-flash / 無料枠対象）。

const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

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

// 小学校学習指導要領（国語「B書くこと」）の学年ごとの主なねらい。添削はこれをふまえる。
const CURRICULUM = {
  low:
    "・したことや見つけたことから、書くことをさがす。\n" +
    "・時間や順番（じゅんじょ）にそって、はじめ・なか・おわりを考える。\n" +
    "・「て・に・を・は」など言葉のつながり、主語と述語のつながりに気をつける。\n" +
    "・書いたら読み返して、まちがいを直す。",
  mid:
    "・だれに何を伝えるかを考えて、書くことを集めて整理する。\n" +
    "・段落（はじめ・中・終わり）の役わりを考えて組み立てる。\n" +
    "・主語と述語の対応、修飾語のかかり方、こそあど言葉・つなぎ言葉を正しく使う。\n" +
    "・読み返して、まちがいを正し、相手や目的に合うように整える。",
  high:
    "・目的や相手に応じて、事実と、感想・意見を区別して書く。\n" +
    "・文章全体の構成や展開（話の流れ）を考える。\n" +
    "・具体例や数字などを使って、考えが伝わるようにする。\n" +
    "・表現の効果を考えて推敲（すいこう）し、より伝わる文章に整える。",
};

function buildPrompt(p) {
  const name  = p.teacherName || "先生";
  const grade = GRADE_WORD[p.grade] || GRADE_WORD.mid;
  const tone  = TONE_WORD[[0,1,2].includes(p.tone) ? p.tone : 1];
  const aims  = (p.aims || []).filter(Boolean);
  const mihon = buildMihon(p.template);
  const curr = CURRICULUM[p.grade] || CURRICULUM.mid;

  return [
    `あなたは小学校の先生「${name}先生」のかわりに、子どもの作文を添削するAIです。`,
    `読み手: ${grade}`,
    `添削のトーン: ${tone}`,
    `この学年で大切にすること（小学校学習指導要領・国語「書くこと」より）。添削は必ずこれをふまえる:\n${curr}`,
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
    "- ready: この作文が、この学年の学習指導要領のねらいと先生の観点をおおむね満たし、先生に見せてよい段階なら true、まだ大きな直しが必要なら false。真偽値で返す。",
    "すべて日本語。読み手の学年に合わせた言葉で。アドバイスは上の学習指導要領のねらいに沿わせつつ、その学年の子が分かる言葉にかみくだく。事実は子どもの文章にあることだけを使い、作り話をしない。空いている欄があれば、そこを書くようにやさしくうながす。",
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
  // 診断用: GETすると、キーの有無とモデル名だけ返す（キー本体は出さない）
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
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    let text = parts.map((pt) => (pt && pt.text) || "").join("").trim();
    if (!text) { res.status(502).json({ error: "no content", detail: JSON.stringify(data).slice(0, 600) }); return; }
    // コードフェンスや前置き（思考など）を除き、最初の { から最後の } を取り出す
    const s = text.indexOf("{"), e2 = text.lastIndexOf("}");
    if (s >= 0 && e2 > s) text = text.slice(s, e2 + 1);
    let out;
    try { out = JSON.parse(text); }
    catch (pe) { res.status(502).json({ error: "parse", detail: text.slice(0, 600) }); return; }
    if (!out || !out.praise || !Array.isArray(out.advices)) {
      res.status(502).json({ error: "shape", detail: JSON.stringify(out).slice(0, 400) }); return;
    }
    out.name = p.teacherName || "先生";
    out.voice = p.teacherVoice || "";
    out.ready = !!out.ready;
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
