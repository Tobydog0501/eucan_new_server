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
            $('#calendarGrid').html('<p>無法取得行事曆資料。</p>');
            return;
        }
        let html = '<table class="table table-bordered"><thead><tr>';
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        for (let d of days) html += `<th>${d}</th>`;
        html += '</tr></thead><tbody>';
        for (let w of data.weeks) {
            html += '<tr>';
            for (let c of w) {
                if (c == null) {
                    html += '<td></td>';
                } else {
                    let cell = `<div><strong>${c.day}</strong>`;
                    if (c.reminders && c.reminders.length > 0) {
                        cell += '<ul>';
                        for (let r of c.reminders) cell += `<li>${r}</li>`;
                        cell += '</ul>';
                    }
                    cell += '</div>';
                    html += `<td style="vertical-align:top">${cell}</td>`;
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
        $('#calendarGrid').html('<p>載入中...</p>');
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

    // 匯出按鈕
    $(document).on('click', '#exportBtn', function () {
        const monthIndex = parseInt($("#month").val());
        const yearIndex = parseInt($("#year").val());
        const url = `${apiBase}/api/calendar/export?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${yearIndex}&month=${monthIndex}`;
        window.open(url, '_blank');
    });
});
