require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");

const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "devsecret";
const url = process.env.MOCK_WEBHOOK_URL || "http://127.0.0.1:3000/webhooks/orders-paid";

// Minimal Shopify-ish payload for orders/paid
const payload = {
  id: Math.floor(Math.random() * 1e12),
  currency: "USD",
  total_price: (Math.random() * 10 + 1).toFixed(2) // $1.00 - $11.00
};

const body = JSON.stringify(payload);
const hmac = crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");

axios.post(url, body, {
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-Sha256": hmac
  }
}).then(r => {
  console.log("Mock webhook sent:", payload);
}).catch(e => {
  console.error("Mock webhook error:", e.response?.status, e.response?.data || e.message);
});
