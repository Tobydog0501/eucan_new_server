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

    async function fetchAvailableYears() {
        const url = `${apiBase}/api/calendar/years?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}`;
        try {
            const resp = await fetch(url, { method: 'GET', credentials: 'include' });
            if (!resp.ok) {
                console.warn('Failed to fetch calendar years', resp.status);
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
        const select = $('#year');
        const uniqueYears = Array.from(new Set(years)).sort((a, b) => a - b);
        const nowYear = new Date().getFullYear();
        const fallbackYear = uniqueYears.includes(nowYear) ? nowYear : (uniqueYears[uniqueYears.length - 1] || nowYear);

        select.empty();
        uniqueYears.forEach((year) => {
            select.append($('<option>').val(String(year)).text(`${year}年`));
        });

        if (uniqueYears.length === 0) {
            select.append($('<option>').val(String(fallbackYear)).text(`${fallbackYear}年`));
        }

        select.val(String(fallbackYear));
    }

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
                const eventsHtml = reminders.length
                    ? reminders.map(r => `<div class="cal-line">${escapeHtml(r)}</div>`).join('')
                    : '';
                html += `<td><div class="cal-day-label">Day ${c.day}</div>${eventsHtml}</td>`;
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

    async function initializeCalendar() {
        const years = await fetchAvailableYears();
        populateYearOptions(years);

        const nowMonth = new Date().getMonth() + 1;
        $("#month").val(String(nowMonth));

        await updateCalendar();
    }

    // 監聽 `#month` / `#year` 變更事件
    $("#month").change(updateCalendar);
    $("#year").change(updateCalendar);
    initializeCalendar();
});
