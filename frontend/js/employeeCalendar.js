$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    if (!sessionKey || !userId) {
        alert("請重新登入！");
        window.location.href = window.location.origin;
        return;
    }

    $("#navbar-container").load("../employee/navbar.html");

    const apiBase = `${window.location.protocol}//${window.location.hostname}:3000`;
    const weekLabels = ["日", "一", "二", "三", "四", "五", "六"];
    const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

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
            const resp = await fetch(url, { method: 'GET', credentials: 'include' });
            if (!resp.ok) {
                console.warn('Failed to fetch calendar', resp.status);
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
            $('#calendarGrid').html('<div class="calendar-empty">無法取得行事曆資料。</div>');
            return;
        }
        // Build simple table-like calendar (minimal styles) resembling spreadsheet
        let html = '<table class="calendar-table"><thead><tr>';
        for (let label of weekLabels) {
            html += `<th>${label}</th>`;
        }
        html += '</tr></thead><tbody>';

        for (let w of data.weeks) {
            html += '<tr>';
            for (let c of w) {
                if (c == null) {
                    html += '<td></td>';
                    continue;
                }
                const reminders = Array.isArray(c.reminders) ? c.reminders : [];
                if (reminders.length === 0) {
                    // No leave: render empty cell (no text)
                    html += '<td></td>';
                } else {
                    // Render Day label and each reminder on its own line
                    const eventsHtml = reminders.map(r => `<div class="cal-line">${escapeHtml(r)}</div>`).join('');
                    html += `<td><div class="cal-day-label">Day ${c.day}</div>${eventsHtml}</td>`;
                }
            }
            html += '</tr>';
        }

        html += '</tbody></table>';
        $('#calendarGrid').html(html);
    }

    async function updateCalendar() {
        const monthIndex = parseInt($("#month").val());
        const yearIndex = parseInt($("#year").val());
        $('#calendarGrid').html('<div class="calendar-empty">載入中...</div>');
        const data = await fetchCalendar(yearIndex, monthIndex);
        renderCalendar(data);
    }

    // 預設載入當月份
    const nowYear = new Date().getFullYear();
    const nowMonth = new Date().getMonth() + 1; // 取得當前月份 (1-12)
    $("#month").val(nowMonth + "月");
    $("#year").val(nowYear + "年");
    updateCalendar();

    // 監聽 `#month` / `#year` 變更事件
    $("#month").change(updateCalendar);
    $("#year").change(updateCalendar);
});
