# eucan_new_server

祐肯請假／打卡系統。`backend/` 是 Node.js + Express + SQLite（better-sqlite3）的 API，`frontend/` 是靜態頁面，`nginx/` 是反向代理設定。

## 啟動

```sh
make dev    # docker-compose-dev.yml
make prod   # docker-compose.yml
```

後端在容器內以 `node main.js` 啟動，資料庫檔是工作目錄下的 `./databases/loginDatabase.db`。

## 測試

```sh
cd backend
npm install
npm test     # 編譯到 .test-build/ 後跑 node --test
```

測試在暫存目錄建立假資料庫與假 SMTP，不會碰到真實資料或 `.env`。CI（`.github/workflows/backend-tests.yml`）在每個 PR 上以 Node 20 執行。

## 資料庫 migration

資料庫結構的變更寫在 `backend/src/plugins/migrations.ts`。每個步驟都會先檢查現有結構，只補上缺少的欄位、資料表或索引，所以可以重複執行；步驟只會「新增」，不會改動或刪除既有資料。

- **自動**：後端每次啟動（`sql` 物件建立時）都會執行一次，有實際變更時會寫進 log（`Database migrations applied: ...`）。一般部署只要照常重啟即可。
- **手動**：不想啟動伺服器、只想升級資料庫檔時：

  ```sh
  cd backend
  npx tsc                       # 先編譯（Docker 映像檔裡已經編好）
  npm run migrate               # 預設 ./databases/loginDatabase.db
  npm run migrate -- path/to.db # 指定其他檔案
  ```

  已是最新時會印出 `schema already up to date.`；檔案不存在時會直接結束，不會建立新檔。

建議在正式資料庫上執行前先備份 `loginDatabase.db`（連同 `-wal`、`-shm` 檔）。

### 目前的 migration

| 步驟 | 內容 |
| --- | --- |
| clockinrecord soft-delete columns | `clockinrecord` 新增 `deleted_at`、`deleted_by`、`delete_reason`（預設 NULL＝未刪除，舊資料全部維持有效） |
| clockin_punch_audit table | 新增打卡刪除／復原的稽核表 |
| clockinrecord (id, date) index | 新增一般索引（非 UNIQUE，舊資料若有重複也不會失敗） |

## 刪除誤打的打卡紀錄

管理員（主管）在「打卡紀錄」頁按「打卡明細」，可看到該員工當天的每一筆打卡，按「刪除」並填寫原因後確認。

- 一般員工不能刪除；管理員的打卡只有 root 能刪（與帳號刪除規則相同，見 `backend/src/plugins/account_rules.ts`）。
- 刪除是軟刪除：資料仍保留，標記刪除時間、刪除者與原因；每次刪除與復原都寫入 `clockin_punch_audit`。
- 已刪除的打卡不會出現在打卡畫面、員工自己的打卡查詢、月總表與個人 PDF，也不計入年份清單等統計。若該月總表已產生，刪除／復原後會自動重新產生。
- root 在明細裡看得到已刪除的紀錄與稽核紀錄，並可填寫原因後復原。

API：`GET /api/clockin/punches`、`POST /api/clockin/punch/delete`、`POST /api/clockin/punch/restore`，詳見 `backend/conf/API.md`。

## 正式站的 `.env`

`backend/.dockerignore` 排除了 `.env`、資料庫檔與資料目錄，映像檔裡不再包含設定與資料。正式站的 `docker-compose.yml` 改為把 `./backend/.env` 以唯讀方式掛到容器的 `/app/.env`，程式讀取方式（`dotenv`）不變。部署前請確認主機上的 `backend/.env` 存在。

## 測試站設定

測試站用 `docker-compose-test.yml`：不啟動 nginx（不會申請 Let's Encrypt 憑證），所有資料目錄都掛到 `./testenv/`（已列入 `.gitignore`），不寄信、不下載政府行事曆。

```sh
TEST_HOST=<測試主機名稱> docker compose -p eucan-test -f docker-compose-test.yml up -d --build
```

啟動前要先準備：

- `./testenv/databases/loginDatabase.db`：去識別化的資料庫（可參考 `backend/testlib/harness.js` 的 `SCHEMA` 與 `seed()` 建立假資料）。若從正式資料複製，必須先把所有 email 改成 `@example.invalid` 之類不存在的網域。
- `./testenv/api/office_calendar_<民國年>.json`：需要用到的年度行事曆。測試站關閉了下載，缺檔時相關請求會失敗而不會連外。

**不要**把 volume 指到 `./backend/*`，也不要在測試站的 checkout 裡放正式的 `.env`。

### 前端 API 位址

頁面不再寫死後端網址，而是呼叫「載入頁面的那台主機」的 3000 port（`frontend/js/cookieOperation.js` 的 `EUCAN_API_BASE`）。正式站頁面本來就從正式網域載入，所以位址和以前相同；測試站的頁面則一定打測試站自己的後端。

若後端不在同一台主機或不是 3000 port，build 時用 `API_BASE` 指定（格式 `http(s)://host[:port]`）。`frontend/Dockerfile_test` 另外會在 build 時檢查，只要還有任何頁面提到正式網域就 build 失敗。

### 環境變數

只列名稱與用途；值請依測試主機設定，不要沿用正式站的值。

| 名稱 | 種類 | 用途 |
| --- | --- | --- |
| `TEST_HOST` | compose 變數 | 測試主機名稱，用來組 `CORS_ORIGIN` |
| `TEST_API_BASE` | compose 變數（選填） | 傳給前端 build arg `API_BASE` |
| `API_BASE` | 前端 build arg（選填） | 固定前端呼叫的後端位址；未設定時用頁面所在主機的 3000 port |
| `PORT` | 後端 | 後端 listen 的 port |
| `CORS_ORIGIN` | 後端 | 允許的前端來源；未設定時為正式網域 |
| `MAIL_DISABLED` | 後端 | 設為 `1` 時完全不建立 SMTP 連線、不寄信（啟動時的 verify 也略過），只在 log 印出主旨 |
| `LEAVE_MANAGER_MAILS` | 後端 | 請假審核通知的收件人，逗號分隔，依員工的 mgroup（0 起算）選用；未設定時沿用程式內建名單 |
| `SMTP_SERVER`、`SMTP_PORT` | 後端 | SMTP 主機與 port；測試站指到不存在的本機位址，或只收不轉寄的郵件攔截器 |
| `USER_MAIL`、`USER_PWD` | 後端 | SMTP 帳密與寄件者；測試站填假值 |
| `SECRET` | 後端 | root 的 2FA 密鑰；測試站填假值 |
| `TOTP_VALIDATE_URL` | 後端 | root 2FA 的驗證端點（見下節） |
| `CALENDAR_DOWNLOAD_DISABLED` | 後端 | 設為 `1` 時不從 data.gov.tw 下載行事曆 |
| `CLOCKIN_PDF_FONT` | 後端（選填） | 打卡 PDF 的中文字型路徑 |

`docker-compose-test.yml` 已把上表後端各項設成安全的測試值。compose 的 `environment:` 會蓋過 `.env` 的同名值，所以每一項都要明確設定，不要留空。

### root 登入的 2FA

root 登入時，後端會把 root 的 2FA 密鑰和驗證碼送到 `TOTP_VALIDATE_URL`（預設是外部的驗證服務）。測試站**不可**外連，所以：

- 預設做法：`TOTP_VALIDATE_URL` 指到不存在的本機位址、`SECRET` 填假值。root 會登入失敗（403），其他帳號不受影響。測試請用一般的 admin 帳號，非 root 帳號不需要 2FA。
- 真的需要測 root：在同一個 compose 專案裡加一個只回應 `True` 的小服務（不開 `ports`，只在 compose 內部網路可見），把 `TOTP_VALIDATE_URL` 設成 `http://<服務名稱>:9999/`。服務內容例如：

  ```sh
  node -e "require('http').createServer((q,s)=>s.end('True')).listen(9999)"
  ```

  這個服務會接受任何驗證碼，只能用在測試站；`SECRET` 仍維持假值。
