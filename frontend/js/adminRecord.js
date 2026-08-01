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
        const sortedRecords = data.records.slice().sort((a, b) => {
            const aId = String(a.id || "");
            const bId = String(b.id || "");
            return aId.localeCompare(bId, "zh-Hant", { numeric: true, sensitivity: "base" });
        });
        let html = `<div class="record-summary">${targetDate}</div><div class="record-grid">`;

        for (const record of sortedRecords) {
            const clockIn = record.clockin ? escapeHtml(record.clockin) : "無";
            const clockOut = record.clockout ? escapeHtml(record.clockout) : "無";
            const statusText = record.hasRecord ? "" : '<div class="record-missing">這個人沒有打卡</div>';
            html += `
                <div class="record-card">
                    <div class="record-card-name">${escapeHtml(record.name)}</div>
                    <div class="record-card-row"><span>上班</span><span>${clockIn}</span></div>
                    <div class="record-card-row"><span>下班</span><span>${clockOut}</span></div>
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

    async function initializeClockin() {
        const years = await fetchAvailableYears();
        populateYearOptions(years);

        const nowMonth = new Date().getMonth() + 1;
        $("#month").val(String(nowMonth));

        updateDayOptions();
        const currentDay = String(new Date().getDate());
        $("#day").val(currentDay);

        updateClockin();
    }

    const now = new Date();

    $("#upData").on("click", updateClockin);
    $("#month, #year").on("change", () => {
        updateDayOptions();
        updateClockin();
    });
    $("#day").on("change", updateClockin);
    initializeClockin();
});
