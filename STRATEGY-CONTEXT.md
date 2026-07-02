# MERIDIAN — Autonomous DLMM LP Agent (Ringkasan untuk perencanaan strategi)

> Dibuat untuk dibawa ke sesi Claude Chat terpisah guna merencanakan implementasi strategi
> KOL DLMM (dari tweet) ke dalam agent ini. Berisi arsitektur, mekanik trading, sistem
> pembelajaran, dan batasan keras yang perlu dipertimbangkan sebelum mengusulkan perubahan.
> Snapshot per 2026-07-02.

## 1. Apa ini

Node.js/ESM service yang **sepenuhnya otonom** — tanpa manusia di loop — melakukan screening,
deploy, dan manajemen posisi likuiditas di **Meteora DLMM** (Solana) memakai LLM (via
OpenRouter, model saat ini `deepseek/deepseek-v4-flash`) untuk keputusan yang butuh judgment,
dan **aturan JS deterministik** untuk semua exit/safety-critical logic. Berjalan sebagai daemon
(`node index.js`) dengan cron + poller real-time, plus REPL/Telegram untuk ops.

## 2. Arsitektur inti

- **Tiga role agent**: `SCREENER` (cari & deploy pool), `MANAGER` (kelola/tutup posisi
  terbuka), `GENERAL` (chat/ops ad-hoc). Masing-masing dapat subset tool berbeda dan system
  prompt berbeda.
- **Hybrid deterministic + LLM**: management cycle **95% aturan JS murni** (5 exit rule
  hard-coded, lihat §4) — LLM cuma dipanggil kalau ada aksi non-STAY yang perlu eksekusi, TIDAK
  untuk re-evaluasi. Screening cycle: hard filter (JS) → enrich data → LLM memilih 1 kandidat
  terbaik dari daftar yang sudah lolos semua filter.
- **Cadence**: screening tiap 3 menit, management tiap 5 menit, **fast PnL poller tiap 3
  detik** berjalan independen dari cron — inilah yang benar-benar mengeksekusi exit real-time.
- **Confirmation-tick system**: sinyal exit (stop-loss, take-profit, OOR, trailing) harus
  konsisten N tick berturut sebelum benar-benar dieksekusi, supaya 1 tick noise tidak memicu
  close prematur. Stop-loss/OOR/trailing = 2 tick (~6 detik); take-profit = 4 tick (~12 detik,
  sengaja lebih lambat — lihat §4).
- **Sizing per posisi sangat kecil saat ini**: `deployAmountSol=0.12`, `maxPositions=2` — ini
  masih skala testing, bukan produksi besar.

## 3. Mekanik deploy DLMM (constraint keras — WAJIB diperhatikan untuk strategi baru)

- **Single-sided SOL only** — semua deploy `amount_x=0`, murni `amount_y` (SOL). Tidak ada
  dual-sided deposit saat ini. Strategi KOL yang mengasumsikan dual-sided (mis. deposit
  token+SOL sekaligus) **butuh perubahan kode baru**, bukan sekadar config.
- **Bin range**: `bins_below` dihitung linear dari volatility pool (`minBinsBelow=35` s.d.
  `maxBinsBelow=40`, default 69 kalau tidak dihitung), floor keras 35 bin
  (`MIN_SAFE_BINS_BELOW`). Range selalu di **bawah** harga aktif (karena single-sided SOL) —
  `bins_above=0`.
- **Shape strategi (BARU, dinamis)**: sebelumnya selalu `spot`. Baru saja diubah jadi
  **otomatis memilih spot vs bid_ask berdasarkan volatility pool**:
  - volatility ≥ **3.5** → **bid_ask** (likuiditas terkonsentrasi di edge — fee turnover
    tinggi dekat harga, cocok pool volatil)
  - volatility < 3.5 → **spot** (cakupan merata, cocok ranging)
  - `curve` **masih dinonaktifkan** (belum diuji untuk single-sided SOL; ada larangan
    eksplisit di prompt LLM "Never use curve")
  - Override eksplisit (user/LLM) selalu menang atas pilihan otomatis.
  - Data awal (n=7 bid_ask vs n=23 spot): bid_ask win-rate 71% vs spot 65%, arah sesuai
    hipotesis tapi sampel masih kecil.
- **Bin step dibatasi 80–125** — mengecualikan pool stable-pair bin-step rendah.

## 4. Aturan exit (deterministik, urutan prioritas)

Dievaluasi tiap tick poller (3 detik) DAN tiap management cycle:

1. **Stop loss**: `pnl_pct <= stopLossPct` (saat ini **−19.89%** — cukup longgar, dan ini
   nilai yang **berubah sendiri** di luar sepengetahuan operator, lihat §9).
2. **Take profit**: `pnl_pct >= takeProfitPct` (saat ini **1%**, baru dinaikkan dari 0.5% +
   confirm 4 tick — 0.5% dengan confirm 2 tick dulu sering fire di noise lalu settlement-nya
   malah rugi karena swing harga saat tx berjalan ~7 detik).
3. **Pumped far above range**: active bin jauh di atas upper bin (`outOfRangeBinsToClose=10`
   bin toleransi).
4. **Out of range wait**: keluar range & bertahan ≥ `outOfRangeWaitMinutes` (10 menit).
5. **Low yield**: `fee_per_tvl_24h < minFeePerTvl24h` (20%) setelah `minAgeBeforeYieldCheck`
   (60 menit).

**Trailing take-profit** (mekanisme terpisah, jalan paralel dengan rule #2): begitu pnl ≥
`trailingTriggerPct` (1.5%) → "armed", lalu close kalau turun `trailingDropPct` (1%) dari
puncak. Siapa yang confirm duluan (hard-TP sustained 4 tick vs trailing drop) yang menang. Ini
family exit **paling profitable** secara historis.

Semua posisi diklaim fee otomatis sebelum close; base token otomatis di-swap balik ke SOL
setelah close (kecuali dust <$0.10).

## 5. Kriteria screening/entry

**Hard filter (sebelum LLM lihat kandidat)**: `minTvl` 10K–`maxTvl` 150K, `minVolume` 1000,
`minOrganic` 60 (auto-evolving), `minHolders` 500, `minMcap` 150K–`maxMcap` 10M,
`minTokenFeesSol` 30 (fee historis token, anti-bundled/scam — hard rule tanpa pengecualian),
`maxBotHoldersPct` 30%, `maxTop10Pct` 60%, bin step 80–125, cooldown pool/token, PVP symbol
conflict detection (simbol sama di banyak mint = red flag), dev/deployer blocklist, token
blacklist.

**Judgment LLM (setelah lolos filter)**: kualitas narrative (event nyata vs hype generik),
smart wallet presence (bisa override narrative lemah), pool memory (riwayat deploy sebelumnya
di pool yang sama), signal weights Darwinian (lihat §6).

**Sizing**: `computeDeployAmount = clamp((walletSOL - gasReserve) × positionSizePct,
[deployAmountSol, maxDeployAmount])` — saat ini efektif selalu 0.12 SOL karena floor=ceiling.

## 6. Sistem pembelajaran (auto-adaptif)

- **Lessons** (`lessons.json`): tiap close menghasilkan lesson PREFER/AVOID/WORKED/FAILED yang
  diinjeksi ke prompt LLM berikutnya. Threshold "good/bad" **baru direkalibrasi** ke skala
  posisi kecil saat ini (good ≥2%, bad <−0.5%) — kalau ukuran posisi berubah signifikan,
  threshold ini perlu disesuaikan lagi.
- **Signal weights (Darwinian)**: tiap 5 close, sinyal screening (fee/TVL ratio, mcap, volume,
  organic score, holder count, volatility, smart-wallet presence, narrative quality)
  di-boost/decay berdasar korelasi dengan winner/loser. Saat ini fee/TVL & mcap paling
  prediktif; holder count & volume mentah kurang prediktif.
- **Pool memory + cooldown**: per-pool riwayat deploy, win-rate, adjusted win-rate (exclude OOR
  pumps). Cooldown otomatis: low-yield → 4 jam; 3× OOR berturut → 12 jam (pool+token); repeat
  fee-generating deploy (≥6× berturut) → 3 jam (baru dilonggarkan dari 3×/12 jam).
- **evolveThresholds**: tiap 5 close otomatis menaikkan/menurunkan `minFeeActiveTvlRatio` dan
  `minOrganic` berdasar data winner/loser.
- **HiveMind**: opsional, berbagi lesson lintas-agent lewat API eksternal (agentmeridian.xyz).

## 7. Akuntansi — PENTING

Sistem ini **`solMode: true`** — tujuannya menumbuhkan **jumlah SOL**, bukan nilai USD. Baru
saja diperbaiki: sebelumnya PnL dicatat dalam USD, yang **menyesatkan** karena kenaikan harga
SOL bisa membuat posisi terlihat "profit" padahal jumlah SOL-nya justru berkurang (IL
memakannya). Sekarang semua pencatatan performance & rekonsiliasi treasury **SOL-primary**.
Kalau strategi KOL yang mau diimplementasikan berorientasi USD/dual-token, ini perlu
dipertimbangkan — agent ini murni permainan akumulasi SOL.

## 8. Strategi LP tersimpan (`strategy-library.js`) — beda dari "shape" DLMM

Ada 5 strategi bernama yang bisa diaktifkan (`set_active_strategy`), ini pola perilaku LP
tingkat tinggi, bukan shape spot/bid_ask:

- `custom_ratio_spot`, `single_sided_reseed`, `fee_compounding`, `multi_layer`,
  `partial_harvest`.

Ini tempat natural untuk menambahkan strategi baru dari KOL — tambahkan entri baru di sini
kalau idenya berupa *pola perilaku* (kapan reseed, kapan compound, dst), bukan sekadar shape
bin.

## 9. Batasan & hal yang perlu diwaspadai

- **Config bisa berubah sendiri** — ada 2 jalur self-tuning: (a) `evolveThresholds` otomatis
  (minFeeActiveTvlRatio, minOrganic), (b) LLM/operator memanggil `update_config` (tercatat
  sebagai lesson `[SELF-TUNED]`). Tapi beberapa perubahan (mis. `stopLossPct` sekarang
  −19.89%, `managementIntervalMin` jadi 5) **tidak** tercatat via jalur itu — kemungkinan dari
  Telegram `/settings` menu atau sumber lain yang tak meninggalkan jejak lesson. **Selalu cek
  `user-config.json` real-time, jangan asumsikan nilai statis.**
- **Skala sangat kecil**: 0.12 SOL/posisi, maks 2 posisi simultan (~0.24 SOL modal kerja).
  Strategi yang butuh modal besar atau banyak posisi paralel perlu penyesuaian
  `maxPositions`/`deployAmountSol`/`gasReserve` dulu.
- **Tidak ada leverage/perp** — murni spot DLMM providing.
- **Siklus sangat cepat & agresif** (screening 3 menit, poller 3 detik) — strategi KOL yang
  berbasis timeframe lebih panjang (swing berhari-hari) mungkin butuh penyesuaian cadence atau
  bahkan modul terpisah.
- **Auto-swap fee/base token kembali ke SOL** setelah tiap close — tidak ada "hold token"
  opsi default kecuali diinstruksikan eksplisit.
- **Trade-off historis**: audit performa terakhir menunjukkan mayoritas rugi kecil berasal dari
  churn "out of range" (~50% aktivitas, nyaris impas) dan satu-dua stop-loss besar bisa
  menghapus banyak gain kecil.

## 10. Titik masuk kode untuk strategi baru (peta file)

| Mau ubah apa | File |
|---|---|
| Kriteria screening/entry (filter, scoring) | `tools/screening.js` |
| Shape DLMM & pemilihan strategi entry | `tools/dlmm.js` (`deployPosition`), `config.js` (`chooseEntryStrategy`) |
| Aturan exit/close | `index.js` (`getDeterministicCloseRule`), `state.js` (`updatePnlAndCheckExits`) |
| Semua parameter tunable | `config.js` + `tools/executor.js` (`CONFIG_MAP`) |
| Pola perilaku LP bernama (strategi tingkat tinggi) | `strategy-library.js` |
| Instruksi/prioritas untuk LLM | `prompt.js` |
| Tambah tool baru untuk LLM | `tools/definitions.js` + `tools/executor.js` + `agent.js` |

---

**Cara pakai dokumen ini**: kalau mau feed tweet strategi KOL ke Claude Chat lain, tempel
dokumen ini sebagai konteks awal, lalu tempel tweet-nya. Claude Chat bisa memetakan tiap ide
KOL ke salah satu titik masuk di §10, dan menilai apakah itu masalah *config* (tinggal ubah
angka), *shape DLMM baru* (butuh kode di `tools/dlmm.js`), atau *pola perilaku LP baru* (masuk
`strategy-library.js`) — sekaligus mengecek konsistensinya terhadap batasan keras di §9
(single-sided SOL, no leverage, skala kecil, SOL-primary accounting).
