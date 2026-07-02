/**
 * Treasury / NAV reconciliation.
 *
 * Verifies recorded PnL against the wallet's real net asset value (NAV).
 *   NAV = liquid wallet holdings (SOL + dust tokens + USDC)
 *       + current value of open DLMM positions
 * Raw wallet SOL alone is misleading because capital rotates between the
 * wallet and open positions (deploy pulls SOL out; close returns it).
 *
 * All on-chain reads are READ-ONLY. State persisted in treasury.json.
 *
 * NOTE on units: with config.management.solMode = true, getMyPositions()
 * returns SOL-denominated values in `total_value_usd` / `pnl_usd`. The
 * always-USD counterparts are `total_value_true_usd` / `pnl_true_usd`, which
 * is what we use so NAV lines up with wallet.total_usd (real USD).
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getPerformanceSummary, getRealizedPnlSince } from "./lessons.js";
import { config } from "./config.js";

const TREASURY_FILE = repoPath("treasury.json");
const MAX_SNAPSHOTS = 500;
const WSOL_MINT = "So11111111111111111111111111111111111111111";

function load() {
  if (!fs.existsSync(TREASURY_FILE)) {
    return { baseline: null, initial_deposit_sol: null, snapshots: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(TREASURY_FILE, "utf8"));
    data.baseline ??= null;
    data.initial_deposit_sol ??= null;
    data.snapshots ??= [];
    return data;
  } catch {
    return { baseline: null, initial_deposit_sol: null, snapshots: [] };
  }
}

function save(data) {
  try {
    fs.writeFileSync(TREASURY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("treasury_error", `Failed to write treasury.json: ${err.message}`);
  }
}

const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
};

// ─── NAV Computation ───────────────────────────────────────────

/**
 * Compute current net asset value from wallet holdings + open positions.
 * USD-denominated (matches wallet.total_usd) with a derived SOL view.
 */
export async function computeNav() {
  const [wallet, posRes] = await Promise.all([
    getWalletBalances(),
    getMyPositions({ force: true }),
  ]);

  const solPrice = Number(wallet?.sol_price) || 0;
  const walletUsd = Number(wallet?.total_usd) || 0;
  const walletSolUsd = Number(wallet?.sol_usd ?? (Number(wallet?.sol) || 0) * solPrice) || 0;

  const tokens = Array.isArray(wallet?.tokens) ? wallet.tokens : [];
  const dustUsd = tokens
    .filter((t) => t?.mint !== WSOL_MINT && String(t?.symbol || "").toUpperCase() !== "SOL")
    .reduce((s, t) => s + (Number(t?.usd) || 0), 0);

  const solMode = !!config.management?.solMode;
  const positions = Array.isArray(posRes?.positions) ? posRes.positions : [];
  // *_true_usd is ALWAYS USD. total_value_usd/pnl_usd hold SOL when solMode is on.
  const positionsUsd = positions.reduce(
    (s, p) => s + (Number(p?.total_value_true_usd ?? p?.total_value_usd) || 0), 0);
  const unrealizedUsd = positions.reduce(
    (s, p) => s + (Number(p?.pnl_true_usd ?? p?.pnl_usd) || 0), 0);
  const positionsSol = positions.reduce((s, p) => {
    const v = solMode ? Number(p?.total_value_usd)
      : (solPrice > 0 ? (Number(p?.total_value_true_usd) || 0) / solPrice : 0);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
  const unrealizedSol = positions.reduce((s, p) => {
    const v = solMode ? Number(p?.pnl_usd)
      : (solPrice > 0 ? (Number(p?.pnl_true_usd) || 0) / solPrice : 0);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);

  const dustSol = solPrice > 0 ? dustUsd / solPrice : 0;
  const navUsd = walletUsd + positionsUsd;
  const navSol = solPrice > 0 ? navUsd / solPrice : 0;

  return {
    ts: new Date().toISOString(),
    sol_price: round(solPrice, 4),
    wallet_usd: round(walletUsd),
    wallet_sol_usd: round(walletSolUsd),
    dust_usd: round(dustUsd),
    dust_sol: round(dustSol, 6),
    positions_usd: round(positionsUsd),
    positions_sol: round(positionsSol, 6),
    unrealized_pnl_usd: round(unrealizedUsd),
    unrealized_pnl_sol: round(unrealizedSol, 6),
    open_count: positions.length,
    nav_usd: round(navUsd),
    nav_sol: round(navSol, 4),
    wallet_error: wallet?.error || null,
    positions_error: posRes?.error || null,
  };
}

// ─── Baseline ──────────────────────────────────────────────────

/** Ensure a baseline exists; capture current NAV as baseline on first run. */
export async function ensureBaseline() {
  const data = load();
  if (data.baseline) return data.baseline;
  const nav = await computeNav();
  data.baseline = {
    nav_usd: nav.nav_usd,
    nav_sol: nav.nav_sol,
    sol_price: nav.sol_price,
    ts: nav.ts,
    source: "captured_now",
  };
  save(data);
  log("treasury", `Baseline captured: NAV $${nav.nav_usd} (${nav.nav_sol} SOL) @ ${nav.ts}`);
  return data.baseline;
}

/**
 * Set the true initial deposit (SOL) for full-history reconciliation.
 * Rebases the baseline to that deposit valued at the current SOL price.
 */
export async function setInitialDeposit(sol) {
  const amt = Number(sol);
  if (!Number.isFinite(amt) || amt < 0) {
    return { error: "initial deposit must be a non-negative number of SOL" };
  }
  const data = load();
  const nav = await computeNav();
  data.initial_deposit_sol = amt;
  data.baseline = {
    nav_usd: round(amt * nav.sol_price),
    nav_sol: round(amt, 4),
    sol_price: nav.sol_price,
    ts: new Date().toISOString(),
    source: "initial_deposit",
  };
  save(data);
  log("treasury", `Initial deposit set: ${amt} SOL → baseline NAV $${data.baseline.nav_usd}`);
  return { initial_deposit_sol: amt, baseline: data.baseline };
}

// ─── Snapshot ──────────────────────────────────────────────────

/** Append a NAV snapshot to the rolling history (equity curve at capital events). */
export async function recordNavSnapshot(navArg = null) {
  const nav = navArg || await computeNav();
  const data = load();
  const realized = getPerformanceSummary()?.total_pnl_usd ?? 0;
  data.snapshots.push({
    ts: nav.ts,
    nav_usd: nav.nav_usd,
    nav_sol: nav.nav_sol,
    wallet_usd: nav.wallet_usd,
    positions_usd: nav.positions_usd,
    dust_usd: nav.dust_usd,
    open_count: nav.open_count,
    cum_realized_pnl_usd: round(realized),
    sol_price: nav.sol_price,
  });
  if (data.snapshots.length > MAX_SNAPSHOTS) {
    data.snapshots = data.snapshots.slice(-MAX_SNAPSHOTS);
  }
  save(data);
  return nav;
}

// ─── Reconciliation ────────────────────────────────────────────

/**
 * Reconcile actual NAV against baseline + recorded PnL.
 * drift = current_nav − (baseline + realized + unrealized)
 *       ≈ gas + position rent + dust valuation + state-sync error.
 */
export async function reconcile() {
  const data = load();
  const nav = await computeNav();

  // Capture baseline lazily so the first-ever reconcile still works.
  let baseline = data.baseline;
  if (!baseline) baseline = await ensureBaseline();

  const perf = getPerformanceSummary();
  const solMode = !!config.management?.solMode;
  // Only realized PnL AFTER the baseline counts — historical PnL is already
  // reflected in a captured_now baseline (adding it would double-count).
  // In solMode, only sum SOL-denominated records so USD-era records (before this
  // build) don't get miscounted as SOL and blow up the drift.
  const since = getRealizedPnlSince(baseline?.ts || null, solMode ? { denom: "SOL" } : {});
  const realizedSince = since.realized_usd; // SOL when solMode

  // ── SOL-denominated reconciliation (primary — the currency we compound) ──
  const unrealizedSol = nav.unrealized_pnl_sol;
  const expectedNavSol = (baseline?.nav_sol || 0) + realizedSince + unrealizedSol;
  const driftSol = nav.nav_sol - expectedNavSol;
  const driftPct = expectedNavSol !== 0 ? (driftSol / Math.abs(expectedNavSol)) * 100 : null;

  // ── USD view (secondary — flattered by SOL price moves) ──
  const solPrice = nav.sol_price || 0;
  const unrealizedUsd = nav.unrealized_pnl_usd;
  const expectedNavUsd = (baseline?.nav_usd || 0) + realizedSince * solPrice + unrealizedUsd;
  const driftUsd = nav.nav_usd - expectedNavUsd;

  return {
    denom: "SOL",
    current: nav,
    baseline,
    initial_deposit_sol: data.initial_deposit_sol ?? null,
    // Primary (SOL)
    realized_pnl_sol: round(realizedSince, 6),        // since baseline — drives the drift
    unrealized_pnl_sol: round(unrealizedSol, 6),
    expected_nav_sol: round(expectedNavSol, 4),
    drift_sol: round(driftSol, 6),
    drift_pct: driftPct != null ? round(driftPct, 1) : null,
    closed_since_baseline: since.count,
    closed_positions: perf?.total_positions_closed ?? 0,
    // Secondary (USD)
    realized_pnl_all_time: round(perf?.total_pnl_usd ?? 0, 6), // mixed denom during go-forward transition
    unrealized_pnl_usd: round(unrealizedUsd),
    expected_nav_usd: round(expectedNavUsd),
    drift_usd: round(driftUsd),
    note: baseline?.source === "captured_now"
      ? "SOL-denominated. Baseline captured now → historical PnL predates it (realized-since ≈ 0); forward reconciliation starts here. Set --set-deposit <sol> for full-history accuracy."
      : "SOL-denominated. drift ≈ gas + position rent + dust + state-sync error — treat small drift as normal.",
  };
}

/** Multi-line human summary for CLI / briefing / Telegram. */
export function formatReconcile(r) {
  const b = r.baseline || {};
  const price = r.current.sol_price || 1;
  const walletSol = round(r.current.wallet_usd / price, 4);
  const lines = [
    `NAV now: ${r.current.nav_sol} SOL ($${r.current.nav_usd}) — wallet ~${walletSol} SOL + positions ${r.current.positions_sol} SOL (${r.current.open_count} open) · dust ${r.current.dust_sol} SOL`,
    `Baseline: ${b.nav_sol ?? "?"} SOL ($${b.nav_usd ?? "?"}) [${b.source || "?"}${b.ts ? " @ " + String(b.ts).slice(0, 16).replace("T", " ") : ""}]`,
    `Recorded (SOL): realized-since-baseline ${r.realized_pnl_sol} SOL (${r.closed_since_baseline} closed) + unrealized ${r.unrealized_pnl_sol} SOL`,
    `Expected NAV ${r.expected_nav_sol} SOL → drift ${r.drift_sol} SOL${r.drift_pct != null ? ` (${r.drift_pct}%)` : ""}`,
    `USD view (flattered by SOL price): NAV $${r.current.nav_usd} · drift $${r.drift_usd}`,
  ];
  if (r.initial_deposit_sol != null) lines.push(`Initial deposit: ${r.initial_deposit_sol} SOL`);
  if (r.current.wallet_error) lines.push(`⚠️ wallet: ${r.current.wallet_error}`);
  if (r.current.positions_error) lines.push(`⚠️ positions: ${r.current.positions_error}`);
  return lines.join("\n");
}
