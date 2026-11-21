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
| makeup_request table | 新增補登申請表（待審／核准／駁回） |
| makeup_audit table | 新增補登申請的稽核表（送出、核准、駁回：誰、何時、原因） |
| clockinrecord makeup_request_id column | `clockinrecord` 新增 `makeup_request_id`（預設 NULL＝一般打卡；有值＝由該筆補登申請核准產生） |
| missed_punch_notice table | 新增未打卡通知的去重表（同一人同一天只寄一次） |

步驟依上表順序執行（1–3 為打卡軟刪除，4–7 為未打卡通知與補登）；之後新增的步驟請接在最後。

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

## 未打卡通知信

後端內建排程：每天 00:00（Asia/Taipei）以及每次啟動時，檢查「前一天」的出勤，員工上班或下班其中一次沒打卡就寄一封「祐肯企業上下班未打卡系統通知」，信末附補登申請頁連結。程式在 `backend/src/plugins/missed_punch.ts`。

- **誰會收到**：在職（status=1）、類型為 employee、當天已到職的員工。管理員帳號與 monitor 不檢查。
- **不寄的情況**：行事曆（`api/office_calendar_*.json`，與請假系統同一份，含國定假日與補班日）標示為休假的日子；已核准的假單涵蓋 08:30 就不要求上班卡、涵蓋 17:30 就不要求下班卡（全天假兩者都不要求）；當天已有待審的補登申請。行事曆讀不到時整天跳過、不寄，並寫 log。
- **怎麼算有打卡**：已軟刪除的打卡不算；管理員補正（clockin_edit）與核准的補登都算。
- **去重**：`missed_punch_notice` 每人每天一筆；已寄出（或已寫入 outbox）就不再寄。寄送失敗會標記 failed，下次執行時重試。
- **log**：只寫內部帳號 id、日期、類別與結果，不寫姓名、信箱或信件內容。

| 環境變數 | 預設 | 說明 |
| --- | --- | --- |
| `MISSED_PUNCH_MAIL_ENABLED` | 關 | 設為 `1`/`true` 才會真的透過 SMTP 寄出 |
| `MAIL_TEST_MODE` | 關 | 設為 `1` 時即使上面開啟也不寄，只寫 outbox（測試站請設） |
| `MAIL_OUTBOX_DIR` | `./logs/mail-outbox` | 不寄時信件寫到這裡：`{日期}_{帳號id}.txt`，內含收件者、主旨、內文與連結；目錄 0700、檔案 0600 |
| `APP_BASE_URL` | 未設 | 連結的網站網址，例如測試站 `https://test.example`；未設時連結為站內路徑 `/employee/makeup.html` |
| `MISSED_PUNCH_CHECK` | 開 | 設為 `0` 關閉整個排程 |
| `SMTP_SERVER`、`SMTP_PORT`、`USER_MAIL`、`USER_PWD` | — | 沿用既有寄信設定 |

測試站核對方式：保持寄信關閉（或設 `MAIL_TEST_MODE=1`），隔天（或重啟後）到 `logs/mail-outbox/` 查看檔案，核對主旨、內文、收件者與連結。

## 補登申請

- **員工**：導覽列「補登申請」（`frontend/employee/makeup.html`）。申請人、部門、申請日期自動帶入；依未打卡類別只要求對應的實際時間；原因必填。送出後為「待審」，下方列表可看自己每筆申請的狀態（待審／核准／駁回）與審核說明，看不到別人的申請。
- **主管／管理員**：「出勤 → 補登審核」（`frontend/admin/makeup.html`）核准或駁回（駁回需填原因），並可看每筆的稽核紀錄。權限與刪除打卡相同：管理員或內建帳號的申請只有 root 能審，任何人都不能審自己的申請。
- **核准**才會在 `clockinrecord` 新增一筆打卡（`makeup_request_id` 指回申請，畫面標示「補登」），並計入打卡畫面、月總表、個人 PDF 等統計與匯出；待審或駁回不產生任何打卡。若該月總表已產生，核准後會自動重產。
- 部門：帳號資料沒有部門欄位，目前以直屬主管組別（mgroup：JEFF／CAT，與員工資料管理頁相同）顯示。

API：`/api/makeup/*`，詳見 `backend/conf/API.md`。
