window.AAKASH_AI = {
  endpoint: "https://aakash-test-ai.aakashinfinity72.workers.dev",
  app: "shop",
  title: "Blunder shopping helper",
  intro:
    "Find everyday essentials, compare packs or plan a small basket using this shop’s catalogue.",
  suggestions: [
    "Suggest a basket under ₹50, including delivery",
    "Which products cost ₹10 or less?",
    "How does Cash on Delivery work?",
  ],
  privacy:
    "Your question and public catalogue are sent to Cloudflare AI when you ask. Your address, phone, email and private orders are not included.",
  context: () => window.BlunderAIContext?.() || null,
};
