require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { ethers } = require("ethers");
const { NonceManager } = require("@ethersproject/experimental");
const db = require("./db");
const { verifyShopifyHmac, centsToTokenUnits, keccak256String, canonicalItemsHash } = require("./utils");

const PORT = process.env.PORT || 3000;
const DEV_MODE = process.env.DEV_MODE === "1";
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "devsecret";
const TOKEN_DECIMALS = parseInt(process.env.TOKEN_DECIMALS || "6", 10);
const FEES_BPS = parseInt(process.env.FEES_BPS || "0", 10); // fee to deduct before split
const SPLIT_PAYEES = (process.env.SPLIT_PAYEES || "").split(",").map(s => s.trim()).filter(Boolean);
const SPLIT_SHARES = (process.env.SPLIT_SHARES_BPS || "").split(",").map(s => parseInt(s.trim(), 10));
if (SPLIT_PAYEES.length !== SPLIT_SHARES.length) {
  console.error("SPLIT_PAYEES length must equal SPLIT_SHARES_BPS length");
  process.exit(1);
}
const SHARES_SUM = SPLIT_SHARES.reduce((a, b) => a + b, 0);
if (SHARES_SUM !== 10000) {
  console.warn("Warning: SPLIT_SHARES_BPS do not sum to 10000 (100%). Current:", SHARES_SUM);
}

const deployments = safeReadJSON("./deployments.local.json"); // written by deploy.js
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const EXECUTOR_PK = process.env.EXECUTOR_PRIVATE_KEY || "";
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || (deployments && deployments.token);
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || (deployments && deployments.payout);
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = EXECUTOR_PK ? new ethers.Wallet(EXECUTOR_PK, provider) : null;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];
const Payout_ABI = [
  "function submitBatch(bytes32 batchId,uint256 total,(address payee,uint256 amount)[] items,bytes32 batchHash)",
  "function balances(address) view returns (uint256)"
];
const token = TOKEN_ADDRESS ? new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, wallet || provider) : null;
const payout = CONTRACT_ADDRESS ? new ethers.Contract(CONTRACT_ADDRESS, Payout_ABI, wallet || provider) : null;

function safeReadJSON(p) {
  try { return require(p); } catch { return null; }
}

const app = express();

// Raw body only for webhook verification
app.post("/webhooks/orders-paid", express.raw({ type: "application/json" }), (req, res) => {
  if (!DEV_MODE && !verifyShopifyHmac(req, SHOPIFY_WEBHOOK_SECRET)) {
    return res.status(401).send("Invalid HMAC");
  }
  const payload = JSON.parse(req.body.toString());
  // Simplified: use total_price in currency cents; deduct fees bps
  const currency = payload.currency || "USD";
  const total = Math.round(parseFloat(payload.total_price) * 100); // cents
  const net = Math.floor(total * (10000 - FEES_BPS) / 10000);

  const id = String(payload.id || payload.admin_graphql_api_id || `${Date.now()}`);
  try {
    db.prepare("INSERT OR IGNORE INTO payments (id, amount_cents, currency, status, raw_json) VALUES (?, ?, ?, 'READY', ?)")
      .run(id, net, currency, JSON.stringify(payload));
    return res.sendStatus(200);
  } catch (e) {
    console.error("Insert payment error:", e);
    return res.status(500).send("DB error");
  }
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));

// Pull latest unprocessed batch OR create one if none and there are READY payments
app.get("/payouts/latest", express.json(), (req, res) => {
  const row = db.prepare("SELECT * FROM batches WHERE status IN ('READY','PROCESSING') ORDER BY created_at LIMIT 1").get();
  if (row) {
    if (row.status === "READY") {
      db.prepare("UPDATE batches SET status='PROCESSING' WHERE batch_id=?").run(row.batch_id);
      row.status = "PROCESSING";
    }
    return res.json(rowToBatch(row));
  }

  const payRows = db.prepare("SELECT * FROM payments WHERE status='READY'").all();
  if (!payRows.length) return res.json({}); // nothing to process

  // aggregate all READY into a single batch, then mark them BATCHED
  const currency = payRows[0].currency;
  const cents = payRows.reduce((s, r) => s + r.amount_cents, 0);
  const totalToken = centsToTokenUnits(cents, TOKEN_DECIMALS);
  const items = SPLIT_PAYEES.map((p, i) => ({
    payee: p,
    amount: (totalToken * BigInt(SPLIT_SHARES[i])) / 10000n
  }));
  const totalCheck = items.reduce((s, it) => s + BigInt(it.amount), 0n);
  // Adjust dust to first payee
  const dust = totalToken - totalCheck;
  if (dust !== 0n && items.length > 0) items[0].amount = (BigInt(items[0].amount) + dust).toString();

  const batchIdStr = new Date().toISOString() + "#" + Math.random().toString(36).slice(2, 8);
  const batchId = batchIdStr;
  const batchHash = canonicalItemsHash(items);
  const itemsJson = JSON.stringify(items, (key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );

  db.prepare("INSERT INTO batches (batch_id, total_amount_token, currency, token_decimals, items_json, batch_hash, status) VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING')")
    .run(batchId, String(totalToken), currency, TOKEN_DECIMALS, itemsJson, batchHash);

  // mark payments as BATCHED
  const ids = payRows.map(r => r.id);
  const qMarks = ids.map(() => "?").join(",");
  db.prepare(`UPDATE payments SET status='BATCHED' WHERE id IN (${qMarks})`).run(...ids)

  const rowNew = db.prepare("SELECT * FROM batches WHERE batch_id=?").get(batchId);
  return res.json(rowToBatch(rowNew));
});

app.post("/payouts/mark-processed", express.json(), (req, res) => {
  const { batchId, txHash } = req.body || {};
  if (!batchId) return res.status(400).send("batchId required");
  db.prepare("UPDATE batches SET status='DONE', tx_hash=? WHERE batch_id=?").run(txHash || "", batchId);
  return res.json({ ok: true });
});

function rowToBatch(row) {
  return {
    batchId: row.batch_id,
    currency: row.currency,
    tokenDecimals: row.token_decimals,
    totalAmount: row.total_amount_token,
    items: JSON.parse(row.items_json),
    batchHash: row.batch_hash
  };
}

// ---------- Executor Loop ----------
async function executorTick() {
  try {
    if (!wallet || !token || !payout) return;
    const base = process.env.SERVICE_BASE_URL || `http://127.0.0.1:${PORT}`;
    const { data } = await axios.get(`${base}/payouts/latest`, { timeout: 5000 });
    if (!data || !data.batchId) return; // nothing to do

    const batchIdBytes32 = keccak256String(data.batchId);
    const total = BigInt(data.totalAmount);
    const items = data.items.map(x => ({ payee: x.payee, amount: BigInt(x.amount) }));
    const batchHash = data.batchHash;

    // 1) Ensure we (executor wallet) have enough token; in local dev we do (minted by deploy.js).
    const bal = await token.balanceOf(wallet.address);
    if (bal < total) {
      console.log("[executor] Insufficient token balance:", bal.toString(), "<", total.toString());
      return;
    }

    const currentNonce = await wallet.getNonce();

    // 2) Transfer tokens to contract
    const tx1 = await token.connect(wallet).transfer(CONTRACT_ADDRESS, total, {
      nonce: currentNonce
    });
    await tx1.wait();
    console.log("[executor] transferred", total.toString(), "tokens to payout");

    // 3) Submit batch
    const tx2 = await payout.connect(wallet).submitBatch(batchIdBytes32, total, items, batchHash, {
      nonce: currentNonce + 1
    });
    await tx2.wait();
    console.log("[executor] submitBatch ok:", tx2.hash);

    // 4) Mark processed
    await axios.post(`${base}/payouts/mark-processed`, { batchId: data.batchId, txHash: tx2.hash });
  } catch (e) {
    console.error("[executor] error:", e);
  }
}

setInterval(executorTick, parseInt(process.env.EXECUTOR_INTERVAL_MS || "15000", 10));

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  console.log(`DEV_MODE=${DEV_MODE}  RPC=${RPC_URL}`);
});
