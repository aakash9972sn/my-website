window.AAKASH_AI = {
  endpoint: "/api/ai/chat/stream",
  app: "shop",
  title: "Blunder AI · Gemini",
  intro:
    "Find everyday essentials, compare packs or plan a small basket using this shop’s catalogue.",
  suggestions: [
    "Suggest a basket under ₹50, including delivery",
    "Which products cost ₹10 or less?",
    "How does Cash on Delivery work?",
  ],
  privacy:
    "Your question and public catalogue are sent to Google Gemini when you ask. Your address, phone, email and private orders are not included.",
  context: () => window.BlunderAIContext?.() || null,
};
