$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    if (!sessionKey || !userId) {
        alert("請重新登入！");
        window.location.href = window.location.origin;
        return;
    }

    $("#navbar-container").load("../admin/navbar.html");

    const apiBase = `${window.location.protocol}//${window.location.hostname}:3000`;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    async function fetchClockin(year, month) {
        const url = `${apiBase}/api/clockin/view?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch clockin data", resp.status);
                return null;
            }
            return await resp.json();
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    function renderClockin(data) {
        if (!data || !Array.isArray(data.days)) {
            $("#calendarGrid").html('<div class="calendar-empty">無法取得打卡資料。</div>');
            return;
        }

        let html = '<table class="calendar-table"><thead><tr><th>日期</th><th>打卡明細</th></tr></thead><tbody>';

        for (const day of data.days) {
            const records = Array.isArray(day.records) ? day.records : [];
            const recordsHtml = records.length
                ? records.map(record => {
                    const clockIn = record.clockin ? escapeHtml(record.clockin) : "未打卡";
                    const clockOut = record.clockout ? escapeHtml(record.clockout) : "未打卡";
                    return `<div class="cal-line">${escapeHtml(record.name)} (${escapeHtml(record.id)})｜上班 ${clockIn}｜下班 ${clockOut}</div>`;
                }).join("")
                : '<div class="calendar-no-event">當日無打卡資料</div>';
            html += `<tr><td><div class="cal-day-label">${day.day}日</div></td><td>${recordsHtml}</td></tr>`;
        }

        html += "</tbody></table>";
        $("#calendarGrid").html(html);
    }

    async function updateClockin() {
        const monthIndex = parseInt($("#month").val(), 10);
        const yearIndex = parseInt($("#year").val(), 10);
        $("#calendarGrid").html('<div class="calendar-empty">載入中...</div>');
        const data = await fetchClockin(yearIndex, monthIndex);
        renderClockin(data);
    }

    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth() + 1;
    $("#year").val(String(nowYear));
    $("#month").val(String(nowMonth));

    $("#upData").on("click", updateClockin);
    $("#month, #year").on("change", updateClockin);
    updateClockin();
});
