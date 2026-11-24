$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    if (!sessionKey || !userId) {
        alert("請重新登入！");
        window.location.href = window.location.origin;
        return;
    }

    $("#navbar-container").load("../admin/navbar.html");

    const apiBase = EUCAN_API_BASE;
    const editModal = new bootstrap.Modal(document.getElementById("clockinEditModal"));
    let viewToken = 0;
    let directoryToken = 0;
    let periodToken = 0;
    let editSession = 0;
    let editingTarget = null;
    let savingEdit = false;
    let punchTarget = null;
    let punchAction = null;
    let punchBusy = false;

    async function fetchAvailableYears() {
        const url = `${apiBase}/api/clockin/years?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch clockin years", resp.status);
                return [];
            }
            const data = await resp.json();
            return Array.isArray(data?.years) ? data.years.map((year) => parseInt(year, 10)).filter((year) => !Number.isNaN(year)) : [];
        } catch (error) {
            console.error(error);
            return [];
        }
    }

    function populateYearOptions(years) {
        const select = $("#year");
        const uniqueYears = Array.from(new Set(years)).sort((a, b) => a - b);
        const nowYear = new Date().getFullYear();
        const fallbackYear = uniqueYears.includes(nowYear) ? nowYear : (uniqueYears[uniqueYears.length - 1] || nowYear);

        select.empty();
        uniqueYears.forEach((year) => {
            select.append($("<option>").val(String(year)).text(`${year}年`));
        });

        if (uniqueYears.length === 0) {
            select.append($("<option>").val(String(fallbackYear)).text(`${fallbackYear}年`));
        }

        select.val(String(fallbackYear));
    }

    function updateDayOptions() {
        const year = parseInt($("#year").val(), 10);
        const month = parseInt($("#month").val(), 10);
        const totalDays = new Date(year, month, 0).getDate();
        const currentDay = String($("#day").val() || new Date().getDate());
        let options = "";
        for (let day = 1; day <= totalDays; day++) {
            options += `<option value="${day}">${day}日</option>`;
        }
        $("#day").html(options);
        const maxDay = Math.min(parseInt(currentDay, 10), totalDays);
        $("#day").val(String(maxDay));
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function attr(value) {
        if (value == null) return "";
        return escapeHtml(value);
    }

    function displayValue(value) {
        if (value == null || String(value).trim() === "") return "無";
        return escapeHtml(value);
    }

    function missingTime(value) {
        return value == null || String(value).trim() === "";
    }

    function formatDate(year, month, day) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }

    function toTimeInput(value) {
        if (value == null) return "";
        const match = String(value).trim().match(/(?:^|\s)(\d{1,2}):(\d{2})(?::\d{2})?$/);
        if (!match) return "";
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour > 23 || minute > 59) return "";
        return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }

    function selectedEmployeeId() {
        return $("#employee").val() || "";
    }

    function downloadTitle(downloadable, masterReady) {
        if (downloadable === true) return "";
        return masterReady === true ? "總表沒有這位員工的紀錄" : "請先重新載入，產生該月總表";
    }

    function editButton(id, name, date, clockin, clockout, modified) {
        return `<button type="button" class="btn btn-sm btn-outline-primary record-edit-btn" data-id="${attr(id)}" data-name="${attr(name)}" data-date="${attr(date)}" data-clockin="${attr(clockin)}" data-clockout="${attr(clockout)}" data-modified="${modified === true ? "1" : ""}">補正</button>`;
    }

    function downloadButton(id, name, downloadable, masterReady) {
        const title = downloadTitle(downloadable, masterReady);
        const disabled = downloadable === true ? "" : " disabled";
        const titleAttr = title ? ` title="${attr(title)}"` : "";
        const button = `<button type="button" class="btn btn-sm btn-outline-secondary record-download-btn" data-id="${attr(id)}" data-name="${attr(name)}"${disabled}${titleAttr}>下載該月紀錄</button>`;
        if (!title) return button;
        return `<span class="record-download-wrap" title="${attr(title)}">${button}</span>`;
    }

    async function fetchDayView(year, month, day) {
        const url = `${apiBase}/api/clockin/view?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}&day=${day}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch clockin data", resp.status);
                return null;
            }
            return await resp.json();
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    async function fetchDirectory(year, month) {
        const url = `${apiBase}/api/clockin/directory?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch clockin directory", resp.status);
                return null;
            }
            const data = await resp.json();
            return Array.isArray(data?.employees) ? data.employees : [];
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    async function fetchEmployee(year, month, id) {
        const url = `${apiBase}/api/clockin/employee?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}&id=${encodeURIComponent(id)}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch employee clockin", resp.status);
                return null;
            }
            return await resp.json();
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    function renderDay(data, year, month, day) {
        if (!data || !Array.isArray(data.records)) {
            $("#calendarGrid").html('<div class="calendar-empty">無法取得打卡資料。</div>');
            return;
        }

        const targetDate = formatDate(year, month, day);
        const masterReady = data.masterReady === true;
        setMasterDownload(masterReady);
        const sortedRecords = data.records.slice().sort((a, b) => {
            const aId = String(a.id || "");
            const bId = String(b.id || "");
            return aId.localeCompare(bId, "zh-Hant", { numeric: true, sensitivity: "base" });
        });
        let html = `<div class="record-summary">${targetDate}</div><div class="record-grid">`;

        for (const record of sortedRecords) {
            const modified = Boolean(record.modified);
            const modifiedRows = modified
                ? `<div class="record-card-row"><span>修改原因</span><span>${displayValue(record.reason)}</span></div>
                    <div class="record-card-row"><span>修改的管理員</span><span>${displayValue(record.editorName)}</span></div>
                    <div class="record-card-row"><span>修改時間</span><span>${displayValue(record.editedAt)}</span></div>`
                : "";
            const displayName = `${escapeHtml(record.name == null ? "" : record.name)}${record.onLeave === true ? "*" : ""}`;
            const clockinRow = missingTime(record.clockin) ? "record-card-row record-card-row-missing" : "record-card-row";
            const clockoutRow = missingTime(record.clockout) ? "record-card-row record-card-row-missing" : "record-card-row";
            html += `
                <div class="record-card">
                    <div class="record-card-name">${displayName}</div>
                    <div class="${clockinRow}"><span>上班</span><span>${displayValue(record.clockin)}</span></div>
                    <div class="${clockoutRow}"><span>下班</span><span>${displayValue(record.clockout)}</span></div>
                    <div class="record-card-row"><span>修改紀錄</span><span>${modified ? "是" : "否"}</span></div>
                    ${modifiedRows}
                    ${record.makeup === true ? '<div class="record-card-row"><span>補登</span><span>是（已核准）</span></div>' : ""}
                    <div class="record-card-actions">
                        ${editButton(record.id, record.name, targetDate, record.clockin, record.clockout, record.modified)}
                        ${downloadButton(record.id, record.name, record.downloadable, masterReady)}
                    </div>
                </div>
            `;
        }

        html += "</div>";
        $("#calendarGrid").html(html);
    }

    function renderEmployee(data, year, month) {
        if (!data || !data.employee || !Array.isArray(data.days)) {
            $("#calendarGrid").html('<div class="calendar-empty">無法取得這位員工的打卡資料。</div>');
            return;
        }

        setMasterDownload(data.masterReady === true);
        const name = data.employee.name == null ? "" : String(data.employee.name);
        const id = data.employee.id == null ? "" : String(data.employee.id);
        const days = data.days.slice().sort((a, b) => Number(a.day) - Number(b.day));
        let rows = "";
        for (const day of days) {
            const date = /^\d{4}-\d{2}-\d{2}$/.test(String(day.date || ""))
                ? String(day.date)
                : formatDate(year, month, day.day);
            const modified = Boolean(day.modified);
            rows += `
                <tr>
                    <td>${escapeHtml(date)}</td>
                    <td>${displayValue(day.clockin)}</td>
                    <td>${displayValue(day.clockout)}${day.makeup === true ? ' <span class="badge bg-info text-dark">補登</span>' : ""}</td>
                    <td>${modified ? "是" : "否"}</td>
                    <td class="record-cell-reason">${modified ? displayValue(day.reason) : ""}</td>
                    <td>${modified ? displayValue(day.editorName) : ""}</td>
                    <td>${modified ? displayValue(day.editedAt) : ""}</td>
                    <td>${editButton(id, name, date, day.clockin, day.clockout, day.modified)}</td>
                </tr>
            `;
        }

        $("#calendarGrid").html(`
            <div class="record-summary">${escapeHtml(name)} ${year}-${String(month).padStart(2, "0")}</div>
            <div class="record-month-bar">
                ${downloadButton(id, name, data.downloadable, data.masterReady === true)}
            </div>
            <div class="record-table-wrap">
                <table class="table table-sm table-bordered record-month-table">
                    <thead>
                        <tr>
                            <th>日期</th>
                            <th>上班</th>
                            <th>下班</th>
                            <th>修改紀錄</th>
                            <th>修改原因</th>
                            <th>修改的管理員</th>
                            <th>修改時間</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `);
    }

    async function renderCurrent() {
        const token = ++viewToken;
        const employeeId = selectedEmployeeId();
        $("#day").prop("disabled", Boolean(employeeId));
        $("#calendarGrid").html('<div class="calendar-empty">載入中...</div>');
        const year = parseInt($("#year").val(), 10);
        const month = parseInt($("#month").val(), 10);

        if (employeeId) {
            const data = await fetchEmployee(year, month, employeeId);
            if (token !== viewToken) return;
            renderEmployee(data, year, month);
            return;
        }

        const day = parseInt($("#day").val(), 10);
        const data = await fetchDayView(year, month, day);
        if (token !== viewToken) return;
        renderDay(data, year, month, day);
    }

    function fillEmployeeSelect(employees, previous) {
        const select = $("#employee");
        select.empty();
        select.append($("<option>").val("").text("全部"));
        if (Array.isArray(employees)) {
            employees.forEach((employee) => {
                if (!employee || employee.id == null || String(employee.id) === "") return;
                const id = String(employee.id);
                const name = employee.name == null ? "" : String(employee.name);
                const label = employee.status === 1 ? name : `${name}（離職）`;
                select.append($("<option>").val(id).text(label));
            });
        }
        const hasPrevious = previous && select.find("option").toArray().some((option) => option.value === previous);
        select.val(hasPrevious ? previous : "");
    }

    async function loadDirectory() {
        const token = ++directoryToken;
        const previous = selectedEmployeeId();
        const year = parseInt($("#year").val(), 10);
        const month = parseInt($("#month").val(), 10);
        const employees = await fetchDirectory(year, month);
        if (token !== directoryToken) return;
        fillEmployeeSelect(employees, previous);
    }

    async function writeClockinArchive() {
        const year = parseInt($("#year").val(), 10);
        const month = parseInt($("#month").val(), 10);
        try {
            const resp = await fetch(`${apiBase}/clrecord`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    account: userId,
                    cookie: sessionKey,
                    year,
                    month,
                }),
            });
            return resp.status === 200;
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    async function reloadClockin() {
        const wrote = await writeClockinArchive();
        alert(wrote ? "備查檔已寫入" : "備查檔寫入失敗");
        await loadDirectory();
        await renderCurrent();
    }

    function setMasterDownload(masterReady) {
        const ready = masterReady === true;
        const button = $("#downloadMaster");
        button.prop("disabled", !ready);
        if (ready) {
            button.removeAttr("title");
        } else {
            button.attr("title", "請先重新載入，產生該月總表");
        }
    }

    function masterFileName(year, month) {
        return `${year}-${String(month).padStart(2, "0")}_打卡紀錄.pdf`;
    }

    async function downloadMaster() {
        const button = $("#downloadMaster");
        if (button.prop("disabled")) return;
        const year = $("#year").val();
        const month = $("#month").val();
        const url = `${apiBase}/api/clockin/master?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;
        button.prop("disabled", true);
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                await alertDownloadError(resp);
                return;
            }
            const blob = await resp.blob();
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = objectUrl;
            link.download = masterFileName(year, month);
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        } catch (error) {
            console.error(error);
            alert("下載失敗");
        } finally {
            button.prop("disabled", false);
        }
    }

    function personalFileName(year, month, name) {
        const safeName = String(name).replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim() || "員工";
        return `${year}-${String(month).padStart(2, "0")}_${safeName}_打卡紀錄.pdf`;
    }

    async function alertDownloadError(resp) {
        let message = "";
        try {
            const data = await resp.json();
            if (data && typeof data.message === "string") message = data.message;
        } catch (error) {
            message = "";
        }
        if (!message && (resp.status === 401 || resp.status === 403)) {
            alert("下載失敗");
            return;
        }
        alert(message || "下載失敗");
    }

    async function downloadPersonal(id, name) {
        const year = $("#year").val();
        const month = $("#month").val();
        const url = `${apiBase}/api/clockin/personal?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}&id=${encodeURIComponent(id)}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                await alertDownloadError(resp);
                return;
            }
            const blob = await resp.blob();
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = objectUrl;
            link.download = personalFileName(year, month, name);
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        } catch (error) {
            console.error(error);
            alert("下載失敗");
        }
    }

    function openEdit(target) {
        editSession += 1;
        editingTarget = {
            session: editSession,
            id: target.id,
            name: target.name,
            date: target.date,
        };
        $("#clockinEditTitle").text(`補正 ${target.name} ${target.date}`);
        $("#clockinEditClockin").val(toTimeInput(target.clockin));
        $("#clockinEditClockout").val(toTimeInput(target.clockout));
        $("#clockinEditReason").val("");
        punchTarget = { session: editSession, id: target.id, name: target.name, date: target.date, modified: target.modified === true };
        hidePunchForm();
        $("#punchNotice").toggleClass("d-none", !punchTarget.modified).text(punchTarget.modified
            ? "這天已有補正，打卡紀錄顯示的是補正後的時間；刪除下面的打卡不會改變顯示，除非把補正的時間清空。"
            : "");
        $("#punchList").html('<div class="calendar-empty">載入中...</div>');
        $("#punchAudit").empty();
        editModal.show();
        refreshPunches();
    }

    async function saveEdit() {
        if (savingEdit || !editingTarget) return;
        const session = editingTarget.session;
        const payload = {
            account: userId,
            cookie: sessionKey,
            id: editingTarget.id,
            date: editingTarget.date,
            clockin: toTimeInput($("#clockinEditClockin").val()) || null,
            clockout: toTimeInput($("#clockinEditClockout").val()) || null,
            reason: String($("#clockinEditReason").val() || ""),
        };
        savingEdit = true;
        $("#clockinEditSave").prop("disabled", true);
        try {
            const resp = await fetch(`${apiBase}/api/clockin/edit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(payload),
            });
            let data = {};
            try {
                data = await resp.json();
            } catch (error) {
                data = {};
            }
            const sameSession = Boolean(editingTarget && editingTarget.session === session);
            if (resp.ok && data.status === "saved") {
                if (sameSession) editModal.hide();
                await renderCurrent();
                return;
            }
            if (!sameSession) return;
            if (resp.ok && data.status === "unchanged") {
                alert(data.message || "時間沒有變更");
                return;
            }
            alert(data.message || "補正失敗");
        } catch (error) {
            console.error(error);
            if (editingTarget && editingTarget.session === session) alert("補正失敗");
        } finally {
            savingEdit = false;
            $("#clockinEditSave").prop("disabled", false);
        }
    }

    // ---- Single punches: delete (admins) and restore (root) ----

    async function fetchPunches(id, date) {
        const url = `${apiBase}/api/clockin/punches?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&id=${encodeURIComponent(id)}&date=${encodeURIComponent(date)}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch punches", resp.status);
                return null;
            }
            return await resp.json();
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    function hidePunchForm() {
        punchAction = null;
        $("#punchActionBox").addClass("d-none");
        $("#punchActionReason").val("");
    }

    const HALF_LABEL = { clockin: "上班", clockout: "下班", both: "整筆" };

    // One half (上班 or 下班) of a punch: its time plus a delete button, or,
    // for root, the deleted time with a restore button.
    function halfCell(punch, part, canRestore) {
        const live = punch[part];
        const removed = part === "clockin" ? punch.deletedClockin : punch.deletedClockout;
        const data = `data-num="${attr(punch.num)}" data-part="${part}" data-time="${attr(live || removed)}"`;
        if (punch.deleted === true) {
            return `<span class="text-muted">${displayValue(live)}</span>`;
        }
        if (live) {
            return `${displayValue(live)} <button type="button" class="btn btn-sm btn-outline-danger ms-1 punch-delete-btn" ${data}>刪除</button>`;
        }
        if (removed && canRestore) {
            return `<s class="text-muted">${displayValue(removed)}</s> <span class="badge bg-secondary">已刪除</span> <button type="button" class="btn btn-sm btn-outline-success ms-1 punch-restore-btn" ${data}>復原</button>`;
        }
        return displayValue(null);
    }

    function renderPunches(data) {
        if (!data || !Array.isArray(data.punches)) {
            $("#punchList").html('<div class="calendar-empty">無法取得打卡明細。</div>');
            $("#punchAudit").empty();
            return;
        }
        const canRestore = data.canRestore === true;
        if (data.punches.length === 0) {
            $("#punchList").html('<div class="calendar-empty">這天沒有打卡紀錄。</div>');
        } else {
            let rows = "";
            for (const punch of data.punches) {
                const deleted = punch.deleted === true;
                const status = deleted
                    ? `整筆已刪除<br><small>${displayValue(punch.deletedBy)}／${displayValue(punch.deletedAt)}<br>原因：${displayValue(punch.deleteReason)}</small>`
                    : (!punch.clockin && !punch.clockout
                        ? '<span class="text-muted">已無有效時間</span>'
                        : (punch.makeup === true ? "有效（補登）" : "有效"));
                const wholeRestore = deleted && canRestore
                    ? `<button type="button" class="btn btn-sm btn-outline-success punch-restore-btn" data-num="${attr(punch.num)}" data-part="both" data-time="">復原整筆</button>`
                    : "";
                rows += `
                    <tr class="${deleted ? "table-secondary" : ""}">
                        <td>${escapeHtml(punch.num)}</td>
                        <td>${halfCell(punch, "clockin", canRestore)}</td>
                        <td>${halfCell(punch, "clockout", canRestore)}</td>
                        <td>${status}${wholeRestore ? `<div class="mt-1">${wholeRestore}</div>` : ""}</td>
                    </tr>`;
            }
            $("#punchList").html(`
                <table class="table table-sm table-bordered align-middle">
                    <thead><tr><th>#</th><th>上班</th><th>下班</th><th>狀態</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>`);
        }

        const audit = Array.isArray(data.audit) ? data.audit : [];
        if (!canRestore || audit.length === 0) {
            $("#punchAudit").empty();
            return;
        }
        let items = "";
        for (const entry of audit) {
            const verb = entry.action === "restore" ? "復原" : "刪除";
            const half = entry.part === "clockin" || entry.part === "clockout"
                ? `的${HALF_LABEL[entry.part]}（${displayValue(entry.part === "clockin" ? entry.clockin : entry.clockout)}）`
                : "";
            items += `<li>${displayValue(entry.acted_at)} ${displayValue(entry.actor_name)}（${displayValue(entry.actor_id)}）${verb}第 ${escapeHtml(entry.punch_num)} 筆${half}，原因：${displayValue(entry.reason)}</li>`;
        }
        $("#punchAudit").html(`<div class="fw-bold mb-1">稽核紀錄</div><ul class="small mb-0">${items}</ul>`);
    }

    // Without a 補正 the day shows the earliest 上班 and the latest 下班 of
    // its live punches; keep the 補正 inputs in step after a delete / restore
    // so saving does not bring a deleted time back.
    function syncEditTimes(data) {
        if (!punchTarget || punchTarget.modified || !data || !Array.isArray(data.punches)) return;
        let clockin = null;
        let clockout = null;
        for (const punch of data.punches) {
            if (punch.deleted === true) continue;
            if (punch.clockin && (clockin === null || punch.clockin < clockin)) clockin = punch.clockin;
            if (punch.clockout && (clockout === null || punch.clockout > clockout)) clockout = punch.clockout;
        }
        $("#clockinEditClockin").val(toTimeInput(clockin || ""));
        $("#clockinEditClockout").val(toTimeInput(clockout || ""));
    }

    async function refreshPunches(syncTimes) {
        if (!punchTarget) return;
        const target = punchTarget;
        const data = await fetchPunches(target.id, target.date);
        if (punchTarget !== target) return;
        renderPunches(data);
        if (syncTimes) syncEditTimes(data);
    }

    function showPunchForm(kind, button) {
        const num = button.attr("data-num") || "";
        const part = button.attr("data-part") || "both";
        const time = button.attr("data-time") || "";
        punchAction = { kind, num, part };
        const verb = kind === "restore" ? "復原" : "刪除";
        const what = part === "both" ? "整筆打卡" : `${HALF_LABEL[part]}打卡（${time}）`;
        $("#punchActionTitle").text(`${verb}第 ${num} 筆的${what}`);
        $("#punchActionLabel").text(`${verb}原因（必填）`);
        $("#punchActionSubmit")
            .text(`確認${verb}`)
            .toggleClass("btn-danger", kind === "delete")
            .toggleClass("btn-success", kind === "restore");
        $("#punchActionReason").val("");
        $("#punchActionBox").removeClass("d-none");
        $("#punchActionReason").trigger("focus");
    }

    async function submitPunchAction() {
        if (punchBusy || !punchTarget || !punchAction) return;
        const reason = String($("#punchActionReason").val() || "").trim();
        const verb = punchAction.kind === "restore" ? "復原" : "刪除";
        const what = punchAction.part === "both" ? "打卡紀錄" : `${HALF_LABEL[punchAction.part]}打卡`;
        if (!reason) {
            alert(`請填寫${verb}原因`);
            return;
        }
        if (!window.confirm(`確定要${verb} ${punchTarget.name} ${punchTarget.date} 第 ${punchAction.num} 筆的${what}嗎？`)) return;
        const target = punchTarget;
        const action = punchAction;
        punchBusy = true;
        $("#punchActionSubmit").prop("disabled", true);
        try {
            const resp = await fetch(`${apiBase}/api/clockin/punch/${action.kind}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    account: userId,
                    cookie: sessionKey,
                    id: target.id,
                    date: target.date,
                    num: Number(action.num),
                    part: action.part,
                    reason,
                }),
            });
            let data = {};
            try {
                data = await resp.json();
            } catch (error) {
                data = {};
            }
            if (!resp.ok) {
                alert(data.message || (resp.status === 403 ? "沒有權限" : `${verb}失敗`));
                return;
            }
            hidePunchForm();
            await refreshPunches(true);
            await renderCurrent();
        } catch (error) {
            console.error(error);
            alert(`${verb}失敗`);
        } finally {
            punchBusy = false;
            $("#punchActionSubmit").prop("disabled", false);
        }
    }

    async function onPeriodChange() {
        const token = ++periodToken;
        updateDayOptions();
        await loadDirectory();
        if (token !== periodToken) return;
        await renderCurrent();
    }

    async function initializeClockin() {
        const years = await fetchAvailableYears();
        populateYearOptions(years);

        const currentMonth = String(new Date().getMonth() + 1);
        $("#month").val(currentMonth);
        if ($("#month").val() !== currentMonth) {
            $("#month").find(`option[value="${currentMonth}"]`).prop("selected", true);
        }

        updateDayOptions();
        const currentDay = String(new Date().getDate());
        $("#day").val(currentDay);

        await loadDirectory();
        await renderCurrent();
    }

    $("#upData").on("click", reloadClockin);
    $("#downloadMaster").on("click", downloadMaster);
    $("#month, #year").on("change", onPeriodChange);
    $("#day").on("change", () => {
        if (!selectedEmployeeId()) renderCurrent();
    });
    $("#employee").on("change", renderCurrent);
    $("#calendarGrid").on("click", ".record-edit-btn", function () {
        const button = $(this);
        openEdit({
            id: button.attr("data-id") || "",
            name: button.attr("data-name") || "",
            date: button.attr("data-date") || "",
            clockin: button.attr("data-clockin") || "",
            clockout: button.attr("data-clockout") || "",
            modified: button.attr("data-modified") === "1",
        });
    });
    $("#calendarGrid").on("click", ".record-download-btn", function () {
        if (this.disabled) return;
        downloadPersonal($(this).attr("data-id") || "", $(this).attr("data-name") || "");
    });
    $("#punchList").on("click", ".punch-delete-btn", function () {
        showPunchForm("delete", $(this));
    });
    $("#punchList").on("click", ".punch-restore-btn", function () {
        showPunchForm("restore", $(this));
    });
    $("#punchActionCancel").on("click", hidePunchForm);
    $("#punchActionSubmit").on("click", submitPunchAction);
    document.getElementById("clockinEditModal").addEventListener("hidden.bs.modal", () => {
        punchTarget = null;
        hidePunchForm();
    });
    $("#clockinEditForm").on("submit", (event) => {
        event.preventDefault();
        saveEdit();
    });
    initializeClockin();
});
