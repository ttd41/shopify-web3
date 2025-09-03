const crypto = require("crypto");
const { ethers } = require("ethers");

function verifyShopifyHmac(req, secret) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(req.body, "utf8").digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

function centsToTokenUnits(cents, tokenDecimals) {
  // Assume 1 token unit == $1 with tokenDecimals decimals (USDC-like). Adjust if FX needed.
  const factor = BigInt(10) ** BigInt(tokenDecimals);
  return (BigInt(cents) * factor) / 100n;
}

function keccak256String(s) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function canonicalItemsHash(items) {
  // Canonicalize minimal fields: payee, amount
  const canon = items.map(x => ({ payee: x.payee.toLowerCase(), amount: String(x.amount) }));
  const s = JSON.stringify(canon);
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

module.exports = {
  verifyShopifyHmac,
  centsToTokenUnits,
  keccak256String,
  canonicalItemsHash
};
