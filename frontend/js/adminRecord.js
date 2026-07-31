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
    const fontSizes = [0.9, 1, 1.1, 1.2, 1.35];
    let fontSizeIndex = 1;

    function applyFontSize() {
        document.documentElement.style.setProperty("--record-font-scale", String(fontSizes[fontSizeIndex]));
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

    async function fetchClockin(year, month, day) {
        const url = `${apiBase}/api/clockin/day?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}&day=${day}`;
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
        if (!data || !Array.isArray(data.records)) {
            $("#calendarGrid").html('<div class="calendar-empty">無法取得打卡資料。</div>');
            return;
        }

        const targetDate = `${data.year}-${String(data.month).padStart(2, "0")}-${String(data.day).padStart(2, "0")}`;
        let html = `<div class="record-summary">${targetDate}</div><div class="record-grid">`;

        for (const record of data.records) {
            const clockIn = record.clockin ? escapeHtml(record.clockin) : "這個人沒有打卡";
            const clockOut = record.clockout ? escapeHtml(record.clockout) : "這個人沒有打卡";
            const statusText = record.hasRecord ? "" : '<div class="record-missing">這個人沒有打卡</div>';
            html += `
                <div class="record-card">
                    <div class="record-card-name">${escapeHtml(record.name)}</div>
                    <div class="record-card-row"><span>上班打卡</span><span>${clockIn}</span></div>
                    <div class="record-card-row"><span>下班打卡</span><span>${clockOut}</span></div>
                    ${statusText}
                </div>
            `;
        }

        html += "</div>";
        $("#calendarGrid").html(html);
    }

    async function updateClockin() {
        const monthIndex = parseInt($("#month").val(), 10);
        const yearIndex = parseInt($("#year").val(), 10);
        const dayIndex = parseInt($("#day").val(), 10);
        $("#calendarGrid").html('<div class="calendar-empty">載入中...</div>');
        const data = await fetchClockin(yearIndex, monthIndex, dayIndex);
        renderClockin(data);
    }

    const now = new Date();
    const nowYear = now.getFullYear();
    const nowMonth = now.getMonth() + 1;
    const nowDay = now.getDate();
    $("#year").val(String(nowYear));
    $("#month").val(String(nowMonth));
    updateDayOptions();
    $("#day").val(String(nowDay));

    applyFontSize();

    $("#fontDown").on("click", () => {
        if (fontSizeIndex > 0) {
            fontSizeIndex -= 1;
            applyFontSize();
        }
    });

    $("#fontReset").on("click", () => {
        fontSizeIndex = 1;
        applyFontSize();
    });

    $("#fontUp").on("click", () => {
        if (fontSizeIndex < fontSizes.length - 1) {
            fontSizeIndex += 1;
            applyFontSize();
        }
    });

    $("#upData").on("click", updateClockin);
    $("#month, #year").on("change", () => {
        updateDayOptions();
        updateClockin();
    });
    $("#day").on("change", updateClockin);
    updateClockin();
});
