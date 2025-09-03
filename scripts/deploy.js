const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer, oracleFallback] = await hre.ethers.getSigners();
  const oracleEnv = process.env.ORACLE_ADDRESS;
  const oracleAddr = oracleEnv && oracleEnv.length > 0 ? oracleEnv : oracleFallback.address;

  console.log("Deployer:", deployer.address);
  console.log("Oracle  :", oracleAddr);

  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  console.log("MockUSDC:", await usdc.getAddress());

  // Mint some tokens to deployer and to oracle
  const oneMillion = 1_000_000n * 10n ** 6n;
  await (await usdc.mint(deployer.address, oneMillion)).wait();
  await (await usdc.mint(oracleAddr, oneMillion)).wait();

  const ShopifyRoyaltyPayout = await hre.ethers.getContractFactory("ShopifyRoyaltyPayout");
  const payout = await ShopifyRoyaltyPayout.deploy(await usdc.getAddress(), deployer.address, oracleAddr);
  await payout.waitForDeployment();
  console.log("Payout  :", await payout.getAddress());

  const out = {
    network: hre.network.name,
    token: await usdc.getAddress(),
    payout: await payout.getAddress(),
    admin: deployer.address,
    oracle: oracleAddr
  };

  const outPath = path.join(__dirname, "..", "app", "deployments.local.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Saved:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
