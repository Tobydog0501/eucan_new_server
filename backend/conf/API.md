## API Documentation

---

### 1. Check Server Status

**Endpoint:**
![GET](https://img.shields.io/badge/GET-0052CC?style=flat-square&logo=appveyor&logoColor=white) `/session`

**Description:**  
Check if the server is online.

**Request:**
```http
GET /session
```

**Response:**
- **200 OK**: Server is online.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 2. Login

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/login`

**Description:**  
Login to the system.

**Request Body:**
```json
{
  "account": "string",   // User account.
  "pwd": "string",       // User password.
  "twoFA": "string"      // Optional two-factor authentication (only for root account).
}
```

**Response:**
- **200 OK**: Successful login.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission or invalid credentials.

---

### 3. Register a New User

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/register`

**Description:**  
Register a new user.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string",    // Session cookie.
  "user": "string",      // New user's ID.
  "pwd": "string",       // New user's password.
  "mail": "string",      // New user's email.
  "name": "string",      // New user's name.
  "date": "YYYY-MM-DD",  // Join date (optional).
  "type": "string",      // Account type (optional, defaults to "employee").
  "mgroup": "0 or 1",    // Manager group.
  "permit": true           // Permission to take a day off (optional).
}
```

**Response:**
- **200 OK**: User registered successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 4. Retrieve All Users

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/users`

**Description:**  
Retrieve a list of all users (admin-only).

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string"     // Session cookie.
}
```

**Response:**
- **200 OK**: Returns the list of users.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 5. Delete a User

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/delete`

**Description:**  
Delete a user account.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string",    // Session cookie.
  "user": "string"       // User ID to delete.
}
```

**Response:**
- **200 OK**: User deleted successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 6. Add a New Dayoff Request

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/request`

**Description:**  
Submit a new dayoff request.

**Request Body:**
```json
{
  "account": "string",        // User account.
  "cookie": "string",         // Session cookie.
  "type": "string",           // Dayoff type.
  "reason": "string",         // Reason for dayoff.
  "start": "YYYY-MM-DD HH:mm",// Start datetime.
  "end": "YYYY-MM-DD HH:mm"   // End datetime.
}
```

**Response:**
- **200 OK**: Dayoff request submitted successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 7. View Approved Dayoff Requests

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/approved`

**Description:**  
View all approved dayoff requests.

**Request Body:**
```json
{
  "account": "string",   // User account.
  "cookie": "string",    // Session cookie.
  "user":"string",       // The employee to lookup.(optional)
  "year":"string",       // The year to lookup.(optional)
  "limit":"integer"      // The limit of the amount to retrive.(optional)
}
```

**Response:**
- **200 OK**: Returns approved requests.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 8. View Employee Dayoff Records

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/dayoff`

**Description:**  
View an employee's dayoff record.

**Request Body:**
```json
{
  "account": "string",   // User account.
  "cookie": "string",    // Session cookie.
  "user": "string",      // Target user ID (optional).
  "year": "YYYY"         // Year to search for.
}
```

**Response:**
- **200 OK**: Returns dayoff records.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 9. Permit or Deny Dayoff Requests

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/permit`

**Description:**  
Approve or deny a dayoff request.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string",    // Session cookie.
  "num": "integer",      // Request ID.
  "permit": 1             // 1 to approve, 0 to deny.
}
```

**Response:**
- **200 OK**: Request updated successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 10. Query Pending Requests

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/query`

**Description:**  
Retrieve all unreviewed requests.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string"     // Session cookie.
}
```

**Response:**
- **200 OK**: Returns pending requests.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 11. Fetch Non-Working Days

**Endpoint:**
![GET](https://img.shields.io/badge/GET-0052CC?style=flat-square&logo=appveyor&logoColor=white) `/api/{YEAR}`

**Description:**  
Retrieve non-working and working days for the specified year.

**Request Body:**
```json
{
  "account": "string",   // User account.
  "cookie": "string"     // Session cookie.
}
```

**Response:**
- **200 OK**: Returns non-working day data.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 12. Modify User Data

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/modify`

**Description:**  
Modify an existing user’s data.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string",    // Session cookie.
  "user": "string",      // User ID to modify.
  "year": "string",      // Year of modification.
  "data": "object"       // Data to update.
}
```

**Response:**
- **200 OK**: User data updated successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 13. List Clock-in Punches of One Day

**Endpoint:**
![GET](https://img.shields.io/badge/GET-0052CC?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/punches`

**Description:**  
Every punch of one employee on one day (admins only). Soft-deleted punches and the audit trail are only returned to root.

**Query:** `account`, `cookie`, `id` (employee id), `date` (`YYYY-MM-DD`)

**Response:**
- **200 OK**: `{ "id", "date", "canRestore": boolean, "punches": [{ "num", "clockin", "clockout", "deleted", "deletedAt", "deletedBy", "deleteReason", "deletedClockin", "deletedClockout" }]` (`deletedClockin` / `deletedClockout`: the time of a deleted half, root only; a punch with no half left is listed for root only), "audit": [...] }`
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 14. Delete / Restore a Clock-in Punch

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/punch/delete`
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/punch/restore`

**Description:**  
Soft-delete one punch (admins; punches of admin or built-in accounts: root only), or restore a deleted one (root only). The row is kept and marked with `deleted_at`, `deleted_by` and `delete_reason`; every delete and restore is written to `clockin_punch_audit`. Deleted punches are left out of every clock-in view, the month sheet and the PDF exports; an already generated month sheet is regenerated.

With `part` set to `clockin` or `clockout` only that half is deleted or restored: its time moves to `deleted_clockin` / `deleted_clockout`, an employee's later punch never refills it, and the audit row records the half in `part`. A punch with no half left drops out of every view.

**Request Body:**
```json
{
  "account": "string",
  "cookie": "string",
  "id": "string",      // Employee id.
  "date": "string",    // YYYY-MM-DD
  "num": 1,            // Punch number from /api/clockin/punches.
  "part": "clockin",   // Optional: "clockin" (上班) or "clockout" (下班) only; omitted or "both" = the whole punch.
  "reason": "string"   // Required, at most 200 characters.
}
```

**Response:**
- **200 OK**: `{ "status": "deleted" | "restored", "part": "both" | "clockin" | "clockout", "masterRefreshed": boolean }`
- **400 Bad Request**: Invalid input data or missing reason.
- **403 Forbidden**: No permission.
- **404 Not Found**: No such (live / deleted) punch.
- **409 Conflict**: Duplicate legacy rows share this punch number, or (restore of a half) the half has a time again.


---

### 15. Make-up Punch Requests (補打卡申請) — employee side

**Endpoints:**
![GET](https://img.shields.io/badge/GET-0052CC?style=flat-square&logo=appveyor&logoColor=white) `/api/makeup/mine`
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/api/makeup/apply`

**Description:**  
`mine` returns the caller's own requests and missing punches only (no parameter selects anybody else). `missing` lists one card per missing half (clock-in or clock-out) on each working day of the last 31 days up to yesterday (Taipei), newest first, using the same detection as the missed-punch notice; pending leave excuses too, and halves with a pending or approved request are left out. `apply` files a pending request for one of those cards; it never creates a punch. Date and half must match a current card (otherwise 409). `time` is the actual time of that half on the card's date, as `HH:MM` (no date, no seconds); it must be earlier than the day's recorded clock-out (for `in`) or later than the recorded clock-in (for `out`), and when that other half is missing too, earlier than 17:30 (`in`) or later than 08:30 (`out`). That time is stored and is what an approval puts on the punch; `clockin` / `clockout` fields in the body are ignored. Name and department come from the account.

**`apply` body:**
```json
{
  "account": "string",
  "cookie": "string",
  "date": "YYYY-MM-DD",   // The card's date (before today, Taipei).
  "kind": "in" | "out",   // The card's half.
  "time": "HH:MM",        // Required: the actual clock-in / clock-out time on that date.
  "reason": "string"      // Required, at most 200 characters.
}
```

**Response:**
- `mine` **200 OK**: `{ "applicant": { "name", "department" }, "today", "missing": [{ "date", "kind": "in" | "out", "kindLabel": "上班" | "下班", "time": "08:30" | "17:30", "clockin", "clockout" }], "requests": [{ "requestId", "name", "department", "date", "kind", "kindLabel", "clockin", "clockout", "reason", "appliedAt", "state", "stateLabel", "reviewerName", "reviewedAt", "reviewNote" }] }`
- `apply` **201 Created**: `{ "status": "pending", "request": {...} }`
- **400 Bad Request**: `{ "message" }` saying which field is wrong, or that the time does not fit the day's other half.
- **403 Forbidden**: Not logged in.
- **409 Conflict**: A pending or approved request already covers the same half of that day, or that date and half is not a missing punch.

---

### 16. Review Make-up Punch Requests — admin side

**Endpoints:**
![GET](https://img.shields.io/badge/GET-0052CC?style=flat-square&logo=appveyor&logoColor=white) `/api/makeup/requests?state=pending|approved|rejected|all`
![GET](https://img.shields.io/badge/GET-0052CC?style=flat-square&logo=appveyor&logoColor=white) `/api/makeup/audit?requestId=N`
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/api/makeup/review`

**Description:**  
Admins only. Who may decide follows the punch-deletion rule (`canReviewMakeup` in `account_rules.ts`): requests of admin or built-in accounts only by root, and nobody decides their own. The list carries `account` and `canReview` per row. Approving inserts one punch into `clockinrecord` with `makeup_request_id` set (shown as `makeup: true` in the clock-in views and punch list) and refreshes an already generated month sheet; rejecting inserts nothing. Every submit / approve / reject is written to `makeup_audit`.

**`review` body:**
```json
{
  "account": "string",
  "cookie": "string",
  "requestId": 1,
  "decision": "approve" | "reject",
  "note": "string"       // Required to reject, optional to approve; at most 200 characters.
}
```

**Response:**
- **200 OK**: `{ "status": "approved" | "rejected", "request": {...}, "masterRefreshed": boolean }`
- **400 Bad Request**: Invalid input data or missing rejection reason.
- **403 Forbidden**: No permission.
- **404 Not Found**: No such request.
- **409 Conflict**: Already approved or rejected.
