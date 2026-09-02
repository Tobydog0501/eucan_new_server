$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    if (!sessionKey || !userId) {
        alert("請重新登入！");
        window.location = window.location.origin;
        return;
    }

    loginCheck(userId, sessionKey);
    $("#navbar-container").load("../admin/navbar.html");

    const apiBase = `${window.location.protocol}//${window.location.hostname}:3000`;
    let employees = [];
    let selected = new Set();

    fillTyphoonDefaults();
    loadEmployees();

    $("#type").on("change", function () {
        if ($(this).val() === "停班停課") {
            fillTyphoonDefaults();
        }
    });
    $("#search").on("input", renderTable);
    $("#selectVisible").on("click", selectVisible);
    $("#clearSelect").on("click", clearSelect);
    $("#table").on("change", ".employee-check", function () {
        const id = String($(this).val());
        if ($(this).is(":checked")) {
            selected.add(id);
        } else {
            selected.delete(id);
        }
        updateSelectedCount();
    });
    $("#batchForm").on("submit", submitBatch);

    function fillTyphoonDefaults() {
        const today = toDateInput(new Date());
        $("#start_day").val(today);
        $("#end_day").val(today);
        $("#start_time").val("08:30");
        $("#end_time").val("17:30");
        if (!$("#reason").val()) {
            $("#reason").val("停班停課");
        }
    }

    function toDateInput(date) {
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${date.getFullYear()}-${month}-${day}`;
    }

    function normalizeTime(value) {
        if (!value) return "";
        const parts = String(value).split(":");
        const hour = parts[0].padStart(2, "0");
        const minute = (parts[1] || "00").padStart(2, "0");
        return `${hour}:${minute}`;
    }

    function validClock(time) {
        if (!time || !time.includes(":")) return false;
        const [hour, minute] = time.split(":").map(Number);
        if (hour < 8 || hour > 17) return false;
        if (hour === 8 && minute === 0) return false;
        return minute === 0 || minute === 30;
    }

    function loadEmployees() {
        $.ajax({
            url: `${apiBase}/users`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                account: userId,
                cookie: sessionKey,
            }),
        }).then((res) => {
            employees = (res.data || []).filter((item) =>
                item.id !== "monitor" &&
                item.type === "employee" &&
                Number(item.status) === 1
            ).sort((a, b) => String(a.id).localeCompare(String(b.id), "zh-Hant", { numeric: true }));
            renderTable();
        }).catch(() => {
            alert("讀取員工名單失敗");
        });
    }

    function renderTable() {
        const keyword = String($("#search").val() || "").trim().toLowerCase();
        const filtered = employees.filter((item) => {
            if (!keyword) return true;
            const name = String(item.name || "").toLowerCase();
            const id = String(item.id || "").toLowerCase();
            return name.includes(keyword) || id.includes(keyword);
        });

        const rows = filtered.map((item) => {
            const checked = selected.has(item.id) ? "checked" : "";
            const displayName = item.name && String(item.name).trim() ? item.name : "（未填姓名）";
            return `<tr>
                <td><input class="form-check-input employee-check" type="checkbox" value="${escapeAttr(item.id)}" ${checked}></td>
                <td>${escapeHtml(item.id)}</td>
                <td>${escapeHtml(displayName)}</td>
            </tr>`;
        }).join("");

        $("#table").html(rows || `<tr><td colspan="3" class="text-center text-muted">沒有符合的在職員工</td></tr>`);
        updateSelectedCount();
    }

    function visibleIds() {
        const ids = [];
        $(".employee-check").each(function () {
            ids.push(String($(this).val()));
        });
        return ids;
    }

    function selectVisible() {
        visibleIds().forEach((id) => selected.add(id));
        renderTable();
    }

    function clearSelect() {
        selected = new Set();
        renderTable();
    }

    function updateSelectedCount() {
        $("#selectedCount").text(`已選 ${selected.size} 人`);
    }

    function submitBatch(event) {
        event.preventDefault();
        const users = Array.from(selected);
        const leaveType = $("#type").val();
        const reason = String($("#reason").val() || "").trim();
        const startTime = normalizeTime($("#start_time").val());
        const endTime = normalizeTime($("#end_time").val());
        const startDay = $("#start_day").val();
        const endDay = $("#end_day").val();

        if (users.length === 0) {
            alert("請先勾選員工");
            return;
        }
        if (!reason) {
            alert("請輸入事由");
            return;
        }
        if (!startDay || !endDay) {
            alert("請選擇起迄日期");
            return;
        }
        if (!validClock(startTime) || !validClock(endTime)) {
            alert("時間需在 08:30 到 17:30，且為整點或半點");
            return;
        }

        const $submit = $("#submit").prop("disabled", true);
        $.ajax({
            url: `${apiBase}/batchrequest`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                account: userId,
                cookie: sessionKey,
                users,
                type: leaveType,
                reason,
                start: `${startDay} ${startTime}`,
                end: `${endDay} ${endTime}`,
            }),
        }).then((res) => {
            renderResult(res);
        }).fail((xhr) => {
            if (xhr && xhr.status === 403) {
                alert("沒有權限，或時間格式不被接受");
                return;
            }
            alert("批次請假失敗");
        }).always(() => {
            $submit.prop("disabled", false);
        });
    }

    function renderResult(res) {
        const ok = res && Array.isArray(res.success) ? res.success : [];
        const failed = res && Array.isArray(res.failed) ? res.failed : [];
        let html = `<p>成功 ${ok.length} 人，失敗 ${failed.length} 人。</p>`;
        if (ok.length) {
            html += `<h3 class="h5">成功</h3><ul>${ok.map((item) =>
                `<li>${escapeHtml(item.id)} ${escapeHtml(item.name)}</li>`
            ).join("")}</ul>`;
        }
        if (failed.length) {
            html += `<h3 class="h5">失敗</h3><ul>${failed.map((item) =>
                `<li>${escapeHtml(item.id)} ${escapeHtml(item.name || "")}：${escapeHtml(item.reason)}</li>`
            ).join("")}</ul>`;
        }
        $("#resultBody").html(html);
        $("#result").prop("hidden", false);
        alert(`已送出。成功 ${ok.length} 人，失敗 ${failed.length} 人。`);
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function escapeAttr(text) {
        return escapeHtml(text);
    }
});
