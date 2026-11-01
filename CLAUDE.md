# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-user, local web app (Thai-language UI) for tracking supplier packing lists through work-order (WO) opening and QC results, with brand/BOM lookups against imported SAP master data. Two source files hold almost everything: `server.js` (Express API + all business logic) and `index.html` (the whole frontend: inline CSS + inline vanilla JS, no build step). The LINE QC integration lives in `line-qc-parser.js` (pure parser + decision rules) and `line-qc-service.js` (DB persistence, review actions, webhook app).

## Commands

- Install: `npm install`
- Run: `npm start` (or `node server.js`); serves on `http://127.0.0.1:8765`, override with `PORT=...`. Binds to localhost only.
- Health check: `curl http://127.0.0.1:8765/api/health`
- Inspect data: `sqlite3 data/pl-brand.sqlite`
- Tests: `npm test` (= `node --test "test/*.test.js"`; Node 24 rejects a bare directory). `test/line-qc-parser.test.js` is pure; `test/packing-list-delete.test.js` and `test/line-qc-integration.test.js` runs `server.js` from a temp folder with an empty DB and signed fake LINE events (never touches `data/`).
- LINE webhook: starts with the app on `127.0.0.1:8766` (`LINE_WEBHOOK_PORT`) when `LINE_CHANNEL_SECRET` is set; only `POST /line/webhook` (alias `/api/line/webhook`) and `GET /line/health`. A tunnel (ngrok) must point at 8766, never 8765.

There is no linter or build. Other than the LINE QC tests, verify changes by running the server and hitting the API or the UI.

## Required system tools (called via `execFileSync`)

- `sqlite3` CLI: the **only** database access path. There is no SQLite npm driver.
- `swift` (macOS, Vision + PDFKit): `ocr.swift <pdf> [pageIndex]` OCRs a page (Thai + English).
- `python3`: `read_master_xlsx.py <xlsx>` parses the master-data workbook with stdlib zip/XML and prints JSON.

## Architecture

**Database layer.** `sql()/query()/run()` in `server.js` shell out to `sqlite3 -json` per statement. Values are interpolated into SQL strings and must be escaped with `q(v)`. Never concatenate raw user input. The schema is created at startup with `CREATE TABLE IF NOT EXISTS`, and migrations are ad hoc (`PRAGMA table_info` check, then `ALTER TABLE`) near the top of `server.js`. Add new columns the same way. `audit()` writes to `audit_logs`. Call it for user-visible mutations.

**Packing list import** (`POST /api/packing-lists/import`). The uploaded PDF goes to `data/packing-lists/<uuid>.pdf`. `parsePdf` tries the pdf-parse text layer per page and falls back to Swift OCR when a page has little text or `parsePackingRows` finds fewer rows than OCR does. `parsePackingRows` is a heuristic line parser keyed on SAP numbers (6–10 digits) at specific token positions. Parsed rows go through a review modal in the UI before items are saved (`PUT /api/packing-lists/:invoice/items`).

**Master data and brands.** A workbook import (`/api/master-data/import-xlsx`) creates a `master_import_batches` row plus `sap_bom_data`, `production_model_data` and `master_brand_aliases` for that batch. `active_master_import` (a single row with id=1) points at the batch in use. `custom_master_overrides` (manual edits through `/api/brand-bom/update-item`) take precedence over batch data. Lookups go through in-memory caches (`brandCache`, `masterDescriptions`, `masterProductInfo`, `masterBomInfo`, `customOverridesCache`). **Reset the relevant cache to `null` after any write that affects them** (for example, `invalidateCustomOverrides()`). SAP numbers are normalized with `canonicalSap` (strips a trailing `-1`). Brand resolution (`resolveBomBrands`) walks the BOM and propagates brands across items that share an SAP PO.

**Brand display policy.** The UI shows brand *abbreviations only*. Full brand names are redacted (`redactKnownBrands`, `displayProductDescription`), and `invoiceSummary` strips file metadata. Items returned to the client go through `safeItems`/`safeItem`/`publicCandidate`. Keep that path in place for any new endpoint that returns items.

**QC.** `POST /api/qc/messages` takes free-text QC messages (LINE-style). `classify()` maps them to accept/reject using the phrases listed at `/api/qc/rules`, and `extractFields()` pulls out the invoice, SAP number and quantity. A near-identical `classify` also exists in `index.html` for client-side preview. Keep the two in sync. `packing_list_qc_tracking` plus `calculateSla`/`getSlaTrackingData` drive the SLA dashboard. `syncQcTracking()` runs at startup, and `runDailySlaCheck` runs hourly. `/api/line/webhook` on the main port is a legacy stub (left as is).

**LINE QC.** Separate from the legacy parser above (do not merge them). `.env` is loaded into a private object (`lineEnv`), not `process.env`, so its `PORT` never moves the main app; keys: `LINE_CHANNEL_SECRET`, `LINE_QC_GROUP_ID`, optional `LINE_WEBHOOK_PORT` (`LINE_CHANNEL_ACCESS_TOKEN` is unused: the bot never replies). The webhook verifies the HMAC-SHA256 signature on the raw body, accepts only the configured group, and stores each text message in `line_qc_messages` (unique `line_message_id` = duplicate/redelivery protection). `parseQcMessage` removes mentions only via LINE metadata (index/length read as UTF-16, else code points, only if every mentionee fits one unit; `@name` text without metadata is never removed), and the LOT result comes only from the last non-empty line, which must exactly match an approved summary (ACCEPT LOT / ACC.LOT / ACC. LOT / ผลผ่าน / `<x> / ผลผ่าน`, or `<reason> จึงขอทำการ Reject`), optionally followed by exactly one polite word from a fixed list (ค่ะ คะ ครับ นะคะ นะครับ); anything else is UNKNOWN. `decideQcAction` auto-applies (writes `qc_results` in one transaction, `source_message_id='line:<id>'`) only when there is exactly one invoice and one SAP, both found, and no ACCEPT/REJECT is current; a same result becomes CONFIRMED_EXISTING (no write); everything else is NEEDS_REVIEW. Existing results are never replaced automatically; `POST /api/line-qc/messages/:id/resolve` replaces only with `confirm_replace:true`, keeping the old row (`is_current=0`) and auditing. Never store LINE user IDs, group IDs, or reply tokens. Non-QC chatter is stored as IGNORED with no text. Review UI: the LINE QC page (`#lineqc`) in `index.html`.

**WO/archive.** The UI imports SAP "List of Production Orders" Excel (`/api/sap/import-xlsx`). Columns are matched by header name, and the header row is found automatically. Rows are upserted into `sap_production_orders` (key: Production Order ID; rows are never deleted; `row_hash` detects unchanged rows; `raw_json` keeps every column). The large upsert goes through `runScript` (sqlite3 via stdin, since argv is size-limited). The export has no Invoice column, so `autoLinkWorkOrders` writes `work_orders` only when, for a canonical SAP No., exactly one item is waiting for a WO and exactly one active (not Finished/Closed/Canceled), unused order exists. Everything else is returned as `ambiguous`, and existing links are never overwritten. The legacy `/api/sap/import-csv` (Invoice + SAP + WO) still exists but the UI no longer uses it. `refreshArchive` marks a packing list `ARCHIVED` once every item has a WO.

**Deleting a packing list** (`DELETE /api/packing-lists/:invoice`, body `{confirm_invoice}` that must equal the invoice no.; preview counts via `GET /api/packing-lists/:invoice/usage`; UI: "จัดการ Packing List" panel on the archive page). Any list can be deleted, permanently. The server first writes `data/pl-brand-before-delete-<invoice>-<UTC yyyymmddHHMMSS>.sqlite` with `.backup` (no backup, no delete), then one transaction removes `work_orders`, `qc_results`, `items`, `packing_list_qc_tracking` rows and the `packing_lists` row, and audits `DELETE`. LINE QC messages are never deleted: `lineQc.detachPackingListSql` unlinks them and sends APPLIED/CONFIRMED_EXISTING/RESOLVED ones back to NEEDS_REVIEW (reason `PACKING_LIST_DELETED`). The PDF is removed last, only if its real path is inside `data/packing-lists/` and no other list uses it. When adding a table that references `packing_lists` or `items`, add it to this delete.

**Frontend.** `index.html` is a single page with `.page` sections that `go(id)` switches between. All calls go through `api(url, opts)`, which throws on a non-OK response using the server's `{error}` message. Server error messages are in Thai. Follow that convention.

## Data and outputs

- `data/pl-brand.sqlite` (WAL mode) is the live database and is committed to git. The dated `pl-brand-before-*.sqlite` files are manual backups made before risky migrations or imports. Make a similar backup before any bulk data change (use `sqlite3 data/pl-brand.sqlite ".backup 'data/...'"`, because a plain file copy can miss WAL content). Because the DB is in git, LINE QC message text (brand-redacted) and mention display names stored in `line_qc_messages` will be committed with it.
- `data/tmp/` holds multer upload staging. `outputs/` holds design previews and templates, and nothing in the app references it.

## Code style

`server.js` is written in a dense style: many endpoints are one-liners, there are few comments, and statements are separated by `;` and `,`. Match it when editing nearby code rather than reformatting.
## การบันทึกความคืบหน้า
- ก่อนเริ่มงาน ให้อ่าน PROGRESS.md เพื่อดูว่าทำอะไรไปแล้ว
- ทุกครั้งที่ทำงานเสร็จหนึ่งชิ้น ให้อัปเดต PROGRESS.md โดย:
  - ย้ายงานที่เสร็จไปไว้หัวข้อ "เสร็จแล้ว" พร้อมวันที่
  - จดการตัดสินใจสำคัญ เช่น ทำไมเลือกวิธีนี้
  - จดปัญหาที่ยังค้างหรือบั๊กที่รู้แล้วแต่ยังไม่แก้
- ถ้ามีการเปลี่ยนโครงสร้างโปรเจกต์ คำสั่ง build/test หรือไลบรารีที่ใช้ ให้อัปเดต CLAUDE.md ด้วย