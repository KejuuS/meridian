import fs from "fs";
import { log } from "./logger.js";
import { reconcile } from "./treasury.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");
const LESSONS_FILE = repoPath("lessons.json");

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity — SOL-denominated. Only records tagged denom:"SOL" count;
  //    older USD-denominated records are excluded (they fade as new SOL records accumulate).
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const solPerf24h = perfLast24h.filter(p => p.denom === "SOL");   // pnl_usd holds SOL here
  const totalPnlSol24h = solPerf24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesSol24h = solPerf24h.reduce((sum, p) => sum + (p.fees_earned_sol || 0), 0);
  const winRate24h = solPerf24h.length > 0
    ? Math.round((solPerf24h.filter(p => p.pnl_usd > 0).length / solPerf24h.length) * 100)
    : null;
  const solAll = (lessonsData.performance || []).filter(p => p.denom === "SOL");
  const allTimePnlSol = solAll.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const allTimeWinSol = solAll.length > 0
    ? Math.round((solAll.filter(p => p.pnl_usd > 0).length / solAll.length) * 100)
    : null;

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);

  // 4b. Treasury reconciliation — recorded PnL vs real wallet NAV.
  // Guarded: an on-chain hiccup must not break the whole briefing.
  let recon = null;
  try { recon = await reconcile(); }
  catch (err) { log("briefing_warn", `Reconcile failed: ${err.message}`); }

  const treasuryLines = recon ? [
    "",
    `<b>Treasury (SOL — recorded vs actual):</b>`,
    `🏦 NAV now: ${recon.current.nav_sol} SOL ($${recon.current.nav_usd})`,
    `   positions ${recon.current.positions_sol} SOL (${recon.current.open_count} open) · dust ${recon.current.dust_sol} SOL`,
    `📐 Baseline: ${recon.baseline?.nav_sol ?? "?"} SOL [${recon.baseline?.source ?? "?"}]`,
    `🔎 Expected ${recon.expected_nav_sol} SOL → drift ${recon.drift_sol} SOL${recon.drift_pct != null ? ` (${recon.drift_pct}%)` : ""}`,
    Math.abs(recon.drift_sol) > Math.max(0.01, Math.abs(recon.expected_nav_sol) * 0.1)
      ? "⚠️ Drift &gt;10% — cek gas/dust/state-sync, atau set initial deposit."
      : "✅ Drift wajar (gas + dust)."
  ] : [];

  // 5. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance (SOL, 24h):</b>`,
    `💰 Net PnL: ${totalPnlSol24h >= 0 ? "+" : ""}${totalPnlSol24h.toFixed(5)} SOL (${solPerf24h.length} closes)`,
    `💎 Fees: ${totalFeesSol24h.toFixed(5)} SOL`,
    winRate24h != null ? `📈 Win Rate: ${winRate24h}%` : "📈 Win Rate: N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    solAll.length > 0
      ? `📊 All-time (SOL): ${allTimePnlSol >= 0 ? "+" : ""}${allTimePnlSol.toFixed(5)} SOL (${allTimeWinSol}% win, ${solAll.length} closes)`
      : "",
    ...treasuryLines,
    "────────────────"
  ];

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
