import { StoreError } from "./commerce.mjs";
export function razorpayGateway(env = process.env) {
  const keyId = env.RAZORPAY_KEY_ID,
    secret = env.RAZORPAY_KEY_SECRET,
    webhookSecret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!keyId || !secret || !webhookSecret) return null;
  async function request(path, body) {
    const response = await fetch(`https://api.razorpay.com/v1/${path}`, {
      method: body ? "POST" : "GET",
      signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok)
      throw new StoreError(
        "The payment service is temporarily unavailable.",
        502,
      );
    return response.json();
  }
  return {
    keyId,
    secret,
    webhookSecret,
    createOrder: (body) => request("orders", body),
    getPayment: (id) => request(`payments/${encodeURIComponent(id)}`),
    getPayments: async (id) =>
      (await request(`orders/${encodeURIComponent(id)}/payments`)).items || [],
  };
}
