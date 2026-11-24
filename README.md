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
| clockinrecord half-delete columns | `clockinrecord` 新增 `deleted_clockin`、`deleted_clockout`（單獨刪除的上班／下班時間）；`clockin_punch_audit` 新增 `part`（NULL＝整筆） |

步驟依上表順序執行（1–3 為打卡軟刪除，4–7 為未打卡通知與補登）；之後新增的步驟請接在最後。

## 刪除誤打的打卡紀錄

管理員（主管）在「打卡紀錄」頁按「補正」，下方「打卡明細」列出該員工當天的每一筆打卡。上班、下班各有自己的「刪除」按鈕，可以分開刪除，填寫原因後確認。

- 刪掉一筆的上班或下班後，員工之後再打卡不會補進被刪的那一格；上下班都被刪掉的那筆就不再出現。
- 這天若已有補正，打卡紀錄顯示的是補正時間，刪除明細不會改變顯示（視窗裡會提示）。

- 一般員工不能刪除；管理員的打卡只有 root 能刪（與帳號刪除規則相同，見 `backend/src/plugins/account_rules.ts`）。
- 刪除是軟刪除：資料仍保留，標記刪除時間、刪除者與原因；每次刪除與復原都寫入 `clockin_punch_audit`。
- 已刪除的打卡不會出現在打卡畫面、員工自己的打卡查詢、月總表與個人 PDF，也不計入年份清單等統計。若該月總表已產生，刪除／復原後會自動重新產生。
- root 在明細裡看得到已刪除的上班／下班時間與稽核紀錄，並可填寫原因後分別復原。

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

前端容器用 `frontend/nginx.test.conf`（`docker-compose-test.yml` 掛載）：除了靜態頁面，也把 `/api/*`、根層級的 POST 路由和 `/healthz` 反代到後端，所以測試站可以只用一個網域（`API_BASE` 設成該網域即可），後端 3000 port 不必對外。上傳上限和正式站一樣是 2G。後端新增根層級路由時，要一併加進這個檔案，`backend/test/nginx_test_conf.test.js` 會檢查。

### 環境變數

只列名稱與用途；值請依測試主機設定，不要沿用正式站的值。

| 名稱 | 種類 | 用途 |
| --- | --- | --- |
| `TEST_HOST` | compose 變數 | 測試主機名稱，用來組 `CORS_ORIGIN` |
| `TEST_API_BASE` | compose 變數（選填） | 傳給前端 build arg `API_BASE` |
| `API_BASE` | 前端 build arg（選填） | 固定前端呼叫的後端位址；未設定時用頁面所在主機的 3000 port |
| `PORT` | 後端 | 後端 listen 的 port |
| `CORS_ORIGIN` | 後端 | 允許的前端來源；未設定時為正式網域 |
| `MAIL_DISABLED` | 後端 | 設為 `1` 時完全不建立 SMTP 連線、不寄信（啟動時的 verify 也略過），只在 log 印出主旨；未打卡通知也不寄，改寫入 outbox（見「未打卡通知信」） |
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

## 功能管理（新功能的上線排定）

用途：開發人員先把新功能做完並部署到正式機，功能在上線前保持隱藏；主管在「系統 → 功能管理」（`frontend/admin/features.html`）決定什麼時候上線，部署日不必等於上線日。所有管理員帳號都能使用。

- **每個功能一張卡片**，狀態為：開發中（不能排定）、未上線、已排定（顯示上線時間與倒數）、已上線。
- **主管的操作**：排定上線／改上線時間（必須是未來的時間）、立即上線、取消排定、下架。時間一到自動上線，不需要重啟。
- **發布紀錄**用句子記錄每次操作，例如「上線時間從 2026-12-01 00:00 改為 2026-12-03 08:00」，並記下操作人（`feature_audit`）。
- 新功能第一次部署啟動時，系統依程式裡的初始設定寫入一筆，操作人記為「系統初始設定」。

| 功能 | 代碼 | 未上線時 | 初始設定 |
| --- | --- | --- | --- |
| 補打卡申請／補登審核 | `makeup` | 員工與主管導覽列的入口隱藏，`/api/makeup/mine`、`/api/makeup/apply` 回 403 | 2026-12-01 00:00 上線 |
| 未打卡通知信 | `missed_punch_notice` | 每晚的檢查直接跳過，不寄信 | 2026-12-01 00:00 上線 |

**開發人員新增功能的步驟**

1. 在 `backend/src/plugins/features.ts` 的 `FEATURES` 加一筆：`key`、`name`、`description`、`ready: false`、`initialLaunchAt: null`。這時管理頁會顯示「開發中」，不能排定。
2. 程式裡用 `isFeatureOn(sqlPlugin, '代碼')` 判斷是否上線；前端導覽列項目加上 `class="d-none" data-feature="代碼"`，上線後才顯示。
3. 開發完成後把 `ready` 改成 `true` 並部署，通知主管到功能管理排定上線時間。

`FEATURE_OVERRIDES`（例如 `makeup=on,missed_punch_notice=off`）會強制蓋過管理頁的設定，給自動測試或緊急關閉用，正式機平常不要設；被強制時卡片上會顯示提醒。

## 公告

管理員在「系統 → 公告管理」（`frontend/admin/announcements.html`）新增、編輯、刪除公告。

- **欄位**：標題（100 字內）、內容（純文字 2000 字內，換行保留，不解讀 HTML）、對象（全體／員工／主管與管理員）、發布時間、下架時間（選填）、置頂。
- **排程**：發布時間在未來的公告為「排程中」，時間到才出現；過了下架時間自動消失。
- **顯示位置**：員工首頁「公告事項」最上方（對象：全體、員工）；主管登入後的「假單審核」頁上方（對象：全體、主管）。置頂在前，其餘新的在前；沒有公告時不顯示區塊。
- **刪除**為軟刪除（`deleted_at`），員工與主管都看不到。

## 未打卡通知信

後端內建排程：每天 **23:30**（Asia/Taipei）檢查「當天」的出勤，員工上班或下班其中一次沒打卡就在當晚寄一封「祐肯企業上下班未打卡系統通知」，信末附補打卡申請頁連結。每次啟動時也會補查前一天（以及已過 23:30 時的當天），伺服器剛好在 23:30 重啟也不會漏寄。是否寄送由功能管理的「未打卡通知信」決定（以該日 23:30 時是否已上線為準）。排程與名單判斷在 `backend/src/plugins/missed_punch.ts`；信件主旨、內文與寄送在 `backend/src/plugins/mailer.ts` 的 `mailer.sendMissedPunchNotice(信箱, 姓名, 日期, 連結)`，和請假通知等系統信件共用同一個 `send()`。

- **誰會收到**：在職（status=1）、類型為 employee、當天已到職的員工。管理員帳號與 monitor 不檢查。
- **不寄的情況**：行事曆（`api/office_calendar_*.json`，與請假系統同一份，含國定假日與補班日）標示為休假的日子；已核准的假單涵蓋 08:30 就不要求上班卡、涵蓋 17:30 就不要求下班卡（全天假兩者都不要求）；當天已有待審的補登申請。行事曆讀不到時整天跳過、不寄，並寫 log。
- **怎麼算有打卡**：已軟刪除的打卡不算；管理員補正（clockin_edit）與核准的補登都算。23:30 之後才打的下班卡不影響已寄出的通知。
- **去重**：`missed_punch_notice` 每人每天一筆；已寄出（或已寫入 outbox）就不再寄。寄送失敗會標記 failed，下次執行時重試。
- **log**：只寫內部帳號 id、日期、類別與結果，不寫姓名、信箱或信件內容。

| 環境變數 | 預設 | 說明 |
| --- | --- | --- |
| `MAIL_TEST_MODE` | 關 | 設為 `1` 時不寄，只寫 outbox（測試站請設） |
| `MAIL_DISABLED` | 關 | 全站不寄信開關（見「測試站設定」）；設為 `1` 時同樣不寄、只寫 outbox |
| `MAIL_OUTBOX_DIR` | `./logs/mail-outbox` | 不寄時信件寫到這裡：`{日期}_{帳號id}.txt`，內含收件者、主旨、內文與連結；目錄 0700、檔案 0600 |
| `APP_BASE_URL` | `https://eucan.ddns.net` | 信中連結的網站網址；測試站請設成自己的網址 |
| `MISSED_PUNCH_CHECK` | 開 | 設為 `0` 關閉整個排程（不論功能管理的設定） |
| `SMTP_SERVER`、`SMTP_PORT`、`USER_MAIL`、`USER_PWD` | — | 沿用既有寄信設定 |

測試站核對方式：設 `MAIL_TEST_MODE=1`（或 `MAIL_DISABLED=1`），當晚 23:30 後（或重啟後）到 `logs/mail-outbox/` 查看檔案，核對主旨、內文、收件者與連結。

## 補打卡申請

- **員工**：導覽列「補打卡申請」（`frontend/employee/makeup.html`）。頁面自動列出近 31 天（到昨天為止；每天 23:30 寄出通知後也包含當天）應打卡卻沒有打卡的時段，每個缺卡的上班或下班各一張卡片，顯示日期與缺上班或下班。判斷方式與未打卡通知信相同（行事曆工作日、在職員工、軟刪除的打卡不算、管理員補正與核准的補登算），另外**待審的假單也視為已請假**。已有待審或已核准申請的時段不再顯示；被駁回後卡片會再出現。
- 按卡片上的「申請補打卡」填寫實際上班或下班時間（必填，HH:MM）與未打卡原因；日期、上班／下班由卡片決定，伺服器會再確認該時段確實缺卡，並檢查時間合理：上班須早於當日已有的下班時間、下班須晚於當日已有的上班時間；當天另一半也沒打卡時，上班須早於 17:30、下班須晚於 08:30。核准後的補登打卡即為員工填寫的時間（審核頁顯示同一時間）。申請人、部門、申請日期由伺服器依登入帳號填入。送出後為「待審」，下方列表可看自己每筆申請的狀態（待審／核准／駁回）與審核說明，看不到別人的申請。
- **主管／管理員**：「出勤 → 補登審核」（`frontend/admin/makeup.html`）核准或駁回（駁回需填原因），並可看每筆的稽核紀錄。權限與刪除打卡相同：管理員或內建帳號的申請只有 root 能審，任何人都不能審自己的申請。
- **核准**才會在 `clockinrecord` 新增一筆打卡（`makeup_request_id` 指回申請，畫面標示「補登」），並計入打卡畫面、月總表、個人 PDF 等統計與匯出；待審或駁回不產生任何打卡。若該月總表已產生，核准後會自動重產。
- 部門：帳號資料沒有部門欄位，目前以直屬主管組別（mgroup：JEFF／CAT，與員工資料管理頁相同）顯示。

API：`/api/makeup/*`，詳見 `backend/conf/API.md`。
