import fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createRequire } from "module";
import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// Loader
const require = createRequire(import.meta.url);
const dlmmMod = require("@meteora-ag/dlmm");
function resolveDLMM(mod: any) {
  const candidates = [mod?.DLMM, mod?.default?.DLMM, mod?.default, mod];
  for (const c of candidates) if (c && typeof c.create === "function") return c;
  const keys = Object.keys(mod || {});
  throw new Error(
    `Unable to locate DLMM export from @meteora-ag/dlmm. Available keys: [${keys.join(", ")}]`
  );
}
const DLMM = resolveDLMM(dlmmMod);

// Constants
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CBTC_MINT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const WBTC_MINT = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const JLP_MINT  = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const TRUMP_MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"

const SYMBOL_MAP: Record<string, string> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "So11111111111111111111111111111111111111112": "SOL",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC",
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij": "cbBTC",
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": "JLP",
  "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN": "TRUMP",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
  "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn": "PUMP",
};

// --- Pinned base per-leg fees (bps)
const PINNED_POOL_PER_LEG_BPS: Record<string, number> = {
  // SOL/USDC
  "HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR": 1.0,
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6": 4.0,
  "BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh": 20.0,
  "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y": 10.0,
  // SOL quoted tokens
  "HbjYfcWZBjCBYTJpZkLGxqArVmZVu3mQcRudb6Wg1sVh": 20.0,
  "J2Gsg3xTDjM8UZjKdEqzBeDwitHb2Ux6TSBX5RzsE42r": 20.0,
  "4kdxjt8pKEW4qV4ji4HANixwswDJw3Egn8L4x2BEWQqT": 3.01237, // wBTC/SOL
  // USDC quoted tokens
  "7ubS3GccjhQY99AYNKXjNJqnXjaokEdfdV915xnCb96r": 4.005,   // cbBTC/USDC
  "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2": 10.0,    // TRUMP/USDC
  "C8Gr6AUuq9hEdSYJzoEpNcdjpojPZwqG5MtQbeouNNwg": 15.0,    // JUP/SOL (binStep 80)
};

// Decimal overrides for known tokens
const DEC_OVERRIDE: Record<string, number> = {
  [USDC_MINT]: 6,
  [SOL_MINT]: 9,
  [CBTC_MINT]: 8,
  [WBTC_MINT]: 8,
  [JLP_MINT]: 6,
  [TRUMP_MINT]: 6,
  [JUP_MINT]: 6,
  [PUMP_MINT]: 6,
};

const BIN_ARRAY_SIZE = 64;
const MAX_EXTRA_BIN_ARRAYS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toBps = (x: number) => x * 1e4;
const fmtUSD = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;

// Price source: SOL/USD
async function fetchSolUsd(connection: Connection): Promise<number> {
  try {
    const SOL_USDC_POOL = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
    const dlmm = await DLMM.create(connection, SOL_USDC_POOL);
    const activeBin = await dlmm.getActiveBin();
    const mid = Number((activeBin as any).pricePerToken ?? (activeBin as any).price);
    if (!Number.isFinite(mid) || mid <= 0) throw new Error("Invalid mid from SOL/USDC pool");
    return mid;
  } catch {
    return 195.0;
  }
}

function parseSizes(sizesArg: string): number[] {
  if (sizesArg.includes(":")) {
    const [aRaw, bRaw, sRaw] = sizesArg.split(":");
    const a = Number(aRaw), b = Number(bRaw), s = Number(sRaw);
    if (![a, b, s].every(Number.isFinite) || s <= 0 || b < a) throw new Error("Bad --sizes A:B:S");
    const out: number[] = [];
    for (let v = a; v <= b; v += s) out.push(v);
    return out;
  }
  if (sizesArg.includes(",")) return sizesArg.split(",").map(x => Number(x.trim())).filter(n => Number.isFinite(n) && n > 0);
  const single = Number(sizesArg.trim());
  if (Number.isFinite(single) && single > 0) return [single];
  throw new Error(`Unsupported --sizes format: "${sizesArg}"`);
}

function toAtomicBN(amount: number, decimals: number): BN {
  const s = amount.toFixed(decimals);
  return new BN(s.replace(".", ""));
}
function asBN(x: any): BN {
  if (BN.isBN(x)) return x as BN;
  if (typeof x === "bigint") return new BN(x.toString());
  if (typeof x === "number") return new BN(Math.trunc(x));
  if (typeof x === "string") return new BN(x);
  throw new Error(`Cannot coerce to BN: ${typeof x}`);
}
function fromAtomicToNumber(x: any, decimals: number): number {
  const bn = asBN(x);
  const s = bn.toString();
  if (decimals === 0) {
    return Number(s);
  }
  const pad = s.padStart(decimals + 1, "0");
  const int = pad.slice(0, -decimals);
  const frac = pad.slice(-decimals);
  const composed = `${int}.${frac}`;
  return Number(composed);
}

function getAmountOut(q: any): any {
  return (
    q?.amountOut ?? q?.outAmount ?? q?.amountOutBn ?? q?.amountOutLamports ??
    q?.outAmountLamports ?? q?.outputAmount ?? q?.yAmount ?? q?.xAmount ?? undefined
  );
}
function getAmountIn(q: any): any {
  return (
    q?.amountIn ?? q?.inAmount ?? q?.amountInBn ?? q?.amountInLamports ??
    q?.inputAmount ?? q?.yAmount ?? q?.xAmount ?? undefined
  );
}
function getFeeAmount(q: any): any {
  const f = q?.fee ?? q?.fees ?? {};
  return (
    f?.totalFeeAmount ?? f?.swapFee ?? f?.binFee ?? f?.totalFee ?? f?.feeAmount ?? f?.amount ??
    q?.totalFeeAmount ?? q?.feeAmount ?? undefined
  );
}

//  Main
(async () => {
  const argv = await yargs(hideBin(process.argv))
    .options({
      rpc:         { type: "string", default: "https://api.mainnet-beta.solana.com" },
      pool:        { type: "string", demandOption: true, desc: "DLMM pool address" },
      quoteMint:   { type: "string", demandOption: true, desc: "Quote mint (USDC or SOL)" },
      sizes:       { type: "string", default: "10,25,50,100,250,500,1000,2500,5000,10000", desc: "USD notionals: list '10,25,50,...' or range 'a:b:s'. If --range is provided, it overrides --sizes." },
      range:       { type: "string", desc: "Alternative to --sizes, colon format 'a:b:s' (start:end:step). Overrides --sizes if provided." },
      coverage:    { type: "number", default: 24, desc: "BinArray coverage (# arrays)" },
      dynamicFeePct: { type: "number", default: 0, desc: "Dynamic fee per-leg percentage" },
      csv:         { type: "string", desc: "Output CSV filename (optional)" },
    })
    .strict()
    .parse();

  const rpc = String(argv.rpc);
  const connection = new Connection(rpc, "confirmed");
  const poolPk = new PublicKey(String(argv.pool));
  const quoteMintArg = String(argv.quoteMint);
  // If --range is provided, it overrides --sizes.
  const sizesUSD = argv.range ? parseSizes(String(argv.range)) : parseSizes(String(argv.sizes));
  const coverage = Number(argv.coverage);
  const dynamicFeePct = Number(argv.dynamicFeePct) || 0;

  const dlmm = await DLMM.create(connection, poolPk);
  const programId = (dlmm.program?.programId?.toBase58?.() ?? "DLMM_PROGRAM");
  const tokenX: PublicKey = dlmm.lbPair.tokenX ?? dlmm.lbPair.tokenXMint ?? dlmm.lbPair.tokenMintX;
  const tokenY: PublicKey = dlmm.lbPair.tokenY ?? dlmm.lbPair.tokenYMint ?? dlmm.lbPair.tokenMintY;

  const decX = DEC_OVERRIDE[tokenX.toBase58()] ?? Number(dlmm.lbPair.tokenXDecimals ?? 9);
  const decY = DEC_OVERRIDE[tokenY.toBase58()] ?? Number(dlmm.lbPair.tokenYDecimals ?? 9);

  const quoteMintPk = new PublicKey(quoteMintArg);
  const isQuoteX = tokenX.equals(quoteMintPk);
  const baseMint = isQuoteX ? tokenY : tokenX;
  const baseDecs = isQuoteX ? decY : decX;
  const quoteDecs = isQuoteX ? decX : decY;

  const activeBin = await dlmm.getActiveBin();
  const rawMid = Number((activeBin as any).pricePerToken ?? (activeBin as any).price ?? 0);
  // Adjust for decimal difference between base and quote tokens
  const decimalAdjustment = Math.pow(10, baseDecs - quoteDecs);
  const adjustedMid = rawMid * decimalAdjustment;

  let solUsd = 0;
  let refPriceUSDperQuote: number;
  let midUSDperBase: number;
  if (quoteMintPk.toBase58() === USDC_MINT) {
    refPriceUSDperQuote = 1.0;
    midUSDperBase = adjustedMid;
  } else if (quoteMintPk.toBase58() === SOL_MINT) {
    solUsd = await fetchSolUsd(connection);
    refPriceUSDperQuote = solUsd;
    midUSDperBase = solUsd * adjustedMid;
  } else {
    refPriceUSDperQuote = 1.0;
    midUSDperBase = adjustedMid;
  }

  const arraysToFetch = Math.max(2, coverage);
  const buySwapForY  = isQuoteX ? true  : false;
  const sellSwapForY = isQuoteX ? false : true;
  let buyBinArrays  = await dlmm.getBinArrayForSwap(buySwapForY, arraysToFetch);
  let sellBinArrays = await dlmm.getBinArrayForSwap(sellSwapForY, arraysToFetch);
  const binStep = Number(dlmm.lbPair.binStep ?? dlmm.lbPair.tickSpacing ?? 0);

  const basePerLegBps = PINNED_POOL_PER_LEG_BPS[poolPk.toBase58()] ?? 0;
  const dynPerLegBps = dynamicFeePct * 100;
  const fee_bps_total = 2 * (basePerLegBps + dynPerLegBps);

  let csvStream: fs.WriteStream | undefined = undefined;
  if (argv.csv !== undefined) {
    const csvPath = String(argv.csv);
    const needHeader =
      !fs.existsSync(csvPath) || (fs.statSync(csvPath).size === 0);
    csvStream = fs.createWriteStream(csvPath, { flags: "a" });
    if (needHeader) {
      csvStream.write(
        "ts_utc,dex,pool,program_id,tick_spacing,fee_ppm,fee_bps,protocol_fee_ppm," +
        "liquidity_u128,sqrt_price_x64,tick_current," +
        "mintA,decA,symbolA,mintB,decB,symbolB," +
        "base_mint,base_decimals,base_symbol," +
        "quote_mint,quote_decimals,quote_symbol," +
        "usd_per_quote,mid_usd_per_base,usd_notional," +
        "buy_px_usd_per_base,sell_px_usd_per_base," +
        "roundtrip_bps,fee_bps_total,impact_bps_total," +
        "buy_out_base,sell_in_base,buy_fee_quote,sell_fee_base\n"
      );
    }
  }

  // Output
  console.log("Pool Summary");
  console.log("------------");
  console.log(`Pool:                 ${poolPk.toBase58()}`);
  console.log(`Program:              ${programId}`);
  console.log(`tokenX:               ${tokenX.toBase58()} (dec=${decX})`);
  console.log(`tokenY:               ${tokenY.toBase58()} (dec=${decY})`);
  console.log(`quoteMint:            ${quoteMintPk.toBase58()} (dec=${quoteDecs})`);
  console.log(`baseMint:             ${baseMint.toBase58()} (dec=${baseDecs})`);
  console.log(`binStep:              ${binStep}`);
  console.log(`mid USD/BASE:         ${midUSDperBase.toFixed(2)}  (rawMid=${rawMid.toPrecision(6)}, adjusted=${adjustedMid.toPrecision(6)})`);
  console.log("");

  console.log("Roundtrip results (USD-sized):");
  console.log("  Notional      Mid(USD/BASE)   BuyPx       SellPx      RT bps   Fee bps   Impact bps");

  for (const usd of sizesUSD) {
    const quoteIn = usd / refPriceUSDperQuote;
    try {
      const buyQ = await dlmm.swapQuote(toAtomicBN(quoteIn, quoteDecs), buySwapForY, new BN(50), buyBinArrays, false, MAX_EXTRA_BIN_ARRAYS);
      const buyOutRaw = getAmountOut(buyQ);
      const buyOutBase = fromAtomicToNumber(buyOutRaw, baseDecs);
      const buyPxUSDperBase = usd / buyOutBase;

      const sellQ = await dlmm.swapQuoteExactOut(toAtomicBN(quoteIn, quoteDecs), sellSwapForY, new BN(50), sellBinArrays, MAX_EXTRA_BIN_ARRAYS);
      const sellInRaw = getAmountIn(sellQ);
      const sellInBase = fromAtomicToNumber(sellInRaw, baseDecs);
      const sellPxUSDperBase = usd / sellInBase;

      const impact_bps = toBps((buyPxUSDperBase - sellPxUSDperBase) / midUSDperBase);
      const rt_bps = impact_bps + fee_bps_total;

      console.log(
        `RT ${fmtUSD(usd).padStart(8)}  mid=${midUSDperBase.toFixed(2)}  ` +
        `buy=${buyPxUSDperBase.toFixed(2)}  sell=${sellPxUSDperBase.toFixed(2)}  ` +
        `rt=${rt_bps.toFixed(4)}bps  fee=${fee_bps_total.toFixed(4)}bps  impact=${impact_bps.toFixed(4)}bps`
      );

      if (csvStream) {
        const ts_utc = new Date().toISOString();
        const dex = "meteora";
        const pool = poolPk.toBase58();
        const program_id = programId;
        const tick_spacing = binStep;
        // Canonical schema: compute all fields.
        const mintA = dlmm.lbPair?.tokenX?.toBase58?.() ?? "";
        const decA = dlmm.lbPair?.tokenXDecimals ?? "";
        const mintB = dlmm.lbPair?.tokenY?.toBase58?.() ?? "";
        const decB = dlmm.lbPair?.tokenYDecimals ?? "";
        // Symbols via map:
        const symbolA = SYMBOL_MAP[mintA] ?? "";
        const symbolB = SYMBOL_MAP[mintB] ?? "";
        const base_mint = baseMint.toBase58();
        const base_decimals = baseDecs;
        const base_symbol = SYMBOL_MAP[base_mint] ?? "";
        const quote_mint = quoteMintPk.toBase58();
        const quote_decimals = quoteDecs;
        const quote_symbol = SYMBOL_MAP[quote_mint] ?? "";
        const fee_ppm = ((basePerLegBps + dynPerLegBps) * 10000).toFixed(0);
        const protocol_fee_ppm = (dlmm.lbPair?.protocolFeeBps ?? 0) * 10000;
        const liquidity_u128 = dlmm.lbPair?.liquidity?.toString?.() ?? "";
        const sqrt_price_x64 = dlmm.lbPair?.sqrtPriceX64?.toString?.() ?? "";
        const tick_current = dlmm.lbPair?.activeId ?? activeBin?.activeId ?? "";
        const fee_bps = fee_bps_total;
        const usd_per_quote = refPriceUSDperQuote;
        const mid_usd_per_base = midUSDperBase;
        const usd_notional = usd;
        const buy_px_usd_per_base = buyPxUSDperBase;
        const sell_px_usd_per_base = sellPxUSDperBase;
        const roundtrip_bps = rt_bps;
        const fee_bps_total_csv = fee_bps_total;
        const impact_bps_total = impact_bps;
        const buy_out_base = buyOutBase;
        const sell_in_base = sellInBase;
        const buy_fee_quote = getFeeAmount(buyQ) ?? "";
        const sell_fee_base = getFeeAmount(sellQ) ?? "";
        // All fields in canonical schema order:
        const line = [
          ts_utc,
          dex,
          pool,
          program_id,
          tick_spacing,
          fee_ppm,
          fee_bps,
          protocol_fee_ppm,
          liquidity_u128,
          sqrt_price_x64,
          tick_current !== undefined && tick_current !== null ? tick_current.toString() : "",
          mintA,
          decA !== undefined && decA !== null ? decA.toString() : "",
          symbolA,
          mintB,
          decB !== undefined && decB !== null ? decB.toString() : "",
          symbolB,
          base_mint,
          base_decimals !== undefined && base_decimals !== null ? base_decimals.toString() : "",
          base_symbol,
          quote_mint,
          quote_decimals !== undefined && quote_decimals !== null ? quote_decimals.toString() : "",
          quote_symbol,
          usd_per_quote !== undefined && usd_per_quote !== null ? usd_per_quote.toString() : "",
          mid_usd_per_base !== undefined && mid_usd_per_base !== null ? mid_usd_per_base.toString() : "",
          usd_notional !== undefined && usd_notional !== null ? usd_notional.toString() : "",
          buy_px_usd_per_base !== undefined && buy_px_usd_per_base !== null ? buy_px_usd_per_base.toString() : "",
          sell_px_usd_per_base !== undefined && sell_px_usd_per_base !== null ? sell_px_usd_per_base.toString() : "",
          roundtrip_bps !== undefined && roundtrip_bps !== null ? roundtrip_bps.toString() : "",
          fee_bps_total_csv !== undefined && fee_bps_total_csv !== null ? fee_bps_total_csv.toString() : "",
          impact_bps_total !== undefined && impact_bps_total !== null ? impact_bps_total.toString() : "",
          buy_out_base !== undefined && buy_out_base !== null ? buy_out_base.toString() : "",
          sell_in_base !== undefined && sell_in_base !== null ? sell_in_base.toString() : "",
          buy_fee_quote !== undefined && buy_fee_quote !== null ? buy_fee_quote.toString() : "",
          sell_fee_base !== undefined && sell_fee_base !== null ? sell_fee_base.toString() : ""
        ].join(",") + "\n";
        csvStream.write(line);
      }
      await sleep(120);
    } catch (e: any) {
      console.error(`[ERROR size=${usd}] ${e?.message || String(e)}`);
      await sleep(120);
    }
  }
  if (csvStream) {
    csvStream.end();
  }
})();
