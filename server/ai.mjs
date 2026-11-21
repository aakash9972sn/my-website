/* Server-side Gemini for Blunder.
   Adapted to the request/response contract of the supplied working portfolio.
   No browser secrets. No dependency on a third-party AI app's URL/routes. */

const MODEL_DEFAULT = "gemini-3.1-flash-lite";
const API_URL = "https://generativelanguage.googleapis.com/v1beta/models/";

export class AIServiceError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = "AIServiceError";
    this.status = status;
  }
}

export function createAIService({ env = process.env, fetchImpl = fetch } = {}) {
  const key = typeof env.GEMINI_API_KEY === "string" ? env.GEMINI_API_KEY.trim() : "";
  const rawModel = typeof env.GEMINI_MODEL === "string" && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim() : MODEL_DEFAULT;
  const model = /^[a-z0-9][a-z0-9.-]{2,70}$/i.test(rawModel) ? rawModel : MODEL_DEFAULT;
  const limit = Math.max(1, Math.min(100, Number.parseInt(env.AI_DAILY_LIMIT || "30", 10) || 30));
  let day = new Date().toISOString().slice(0, 10);
  let calls = 0;

  function health() {
    return {
      ok: true, configured: Boolean(key), model,
      mode: "server-side-gemini", dailyLimit: limit
    };
  }

  function validate(body) {
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (question.length < 2 || question.length > 700)
      throw new AIServiceError("Enter a question between 2 and 700 characters.", 400);
    const history = Array.isArray(body.history) ? body.history.slice(-6)
      .filter(x => x && ["user","assistant"].includes(x.role) &&
        typeof x.content === "string" && x.content.trim())
      .map(x => ({ role: x.role === "assistant" ? "model" : "user",
        parts: [{ text: x.content.slice(0, 800) }] })) : [];
    const context = body.pageContext ?? body.context ?? {};
    const safeContext = typeof context === "string" ? context.slice(0, 2600) :
      (context && typeof context === "object" ? JSON.stringify(context).slice(0, 2600) : "");
    return {question, history, safeContext};
  }

  async function answer(body) {
    const {question, history, safeContext} = validate(body);
    if (!key) throw new AIServiceError(
      "Blunder Gemini is not configured on this Node server. Add GEMINI_API_KEY as a private environment variable.", 503
    );
    const now = new Date().toISOString().slice(0, 10);
    if (day !== now) { day = now; calls = 0; }
    if (calls >= limit) throw new AIServiceError(
      "Today's AI free-tier safety limit is reached. Shopping remains available.", 429
    );
    calls += 1;
    const contents = [
      ...history,
      { role: "user", parts: [{ text: question +
        (safeContext ? "\n\n[Public store catalogue/context]\n" + safeContext : "") }] }
    ];
    const bodyJSON = {
      systemInstruction: {
        parts: [{ text: "You are Blunder's helpful grocery shopping assistant. " +
          "Use the supplied public catalogue to compare products and plan baskets. " +
          "Do not invent prices, availability, delivery promises, discounts, or route times. " +
          "Explain unknowns clearly. Reply concisely in the customer's language. " +
          "Do not request or expose private addresses, payment information or passwords." }]
      },
      contents,
      generationConfig: { temperature: 0.35, maxOutputTokens: 900 }
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetchImpl(API_URL + encodeURIComponent(model) + ":generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(bodyJSON),
          signal: AbortSignal.timeout(28000)
        });
      } catch (error) {
        if (attempt === 0 && error?.name !== "AbortError" && error?.name !== "TimeoutError")
          continue;
        throw new AIServiceError(
          "The Gemini API could not be reached. Please retry later.", 503
        );
      }
      if (!response.ok) {
        if ([500, 502, 503, 504].includes(response.status) && attempt === 0) continue;
        if (response.status === 429) throw new AIServiceError(
          "Gemini's free usage quota is exhausted. Please try later.", 429
        );
        if (response.status === 400 || response.status === 404)
          throw new AIServiceError("The configured Gemini model is unavailable. Check GEMINI_MODEL on the server.", 503);
        if ([401, 403].includes(response.status))
          throw new AIServiceError("Gemini server key or project access is invalid. The site owner must check configuration.", 503);
        throw new AIServiceError("The Gemini provider returned an error. Please retry later.", 503);
      }
      let data;
      try { data = await response.json(); }
      catch { throw new AIServiceError("Gemini returned unreadable data.", 502); }
      const answer = (data?.candidates?.[0]?.content?.parts || [])
        .filter(part => typeof part?.text === "string").map(part => part.text).join("").trim();
      if (!answer) throw new AIServiceError(
        "Gemini returned no text. Please rephrase your question.", 502
      );
      return { answer: answer.slice(0, 8000) };
    }
    throw new AIServiceError("Gemini is temporarily unavailable.", 503);
  }
  return {health, answer};
}
