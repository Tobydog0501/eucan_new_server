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
    const weekLabels = ["日", "一", "二", "三", "四", "五", "六"];

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    async function fetchCalendar(year, month) {
        const url = `${apiBase}/api/calendar/view?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch calendar", resp.status);
                return null;
            }
            return await resp.json();
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    function renderCalendar(data) {
        if (!data || !data.weeks) {
            $("#calendarGrid").html('<div class="calendar-empty">無法取得行事曆資料。</div>');
            return;
        }

        let html = '<table class="calendar-table"><thead><tr>';
        for (const label of weekLabels) {
            html += `<th>${label}</th>`;
        }
        html += "</tr></thead><tbody>";

        for (const week of data.weeks) {
            html += "<tr>";
            for (const cell of week) {
                if (cell == null) {
                    html += "<td></td>";
                    continue;
                }
                const reminders = Array.isArray(cell.reminders) ? cell.reminders : [];
                const eventsHtml = reminders.length
                    ? reminders.map(item => `<div class="cal-line">${escapeHtml(item)}</div>`).join("")
                    : '<div class="calendar-no-event">當日無排程</div>';
                html += `<td><div class="cal-day-label">${cell.day}日</div>${eventsHtml}</td>`;
            }
            html += "</tr>";
        }

        html += "</tbody></table>";
        $("#calendarGrid").html(html);
    }

    async function updateCalendar() {
        const monthIndex = parseInt($("#month").val(), 10);
        const yearIndex = parseInt($("#year").val(), 10);
        $("#calendarGrid").html('<div class="calendar-empty">載入中...</div>');
        const data = await fetchCalendar(yearIndex, monthIndex);
        renderCalendar(data);
    }

    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth() + 1;
    $("#year").val(String(nowYear));
    $("#month").val(String(nowMonth));

    $("#upData").on("click", updateCalendar);
    $("#month, #year").on("change", updateCalendar);
    updateCalendar();
});
