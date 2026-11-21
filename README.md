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
