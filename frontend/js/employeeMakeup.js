// 補打卡申請（員工端）：列出自己應打卡卻沒有打卡（也沒有請假）的時段，
// 每張卡片按「申請補打卡」填寫實際上班／下班時間與未打卡原因；日期、上班／下班由卡片決定。
// 下方列出自己申請的審核狀態。
$(function () {
    const API = EUCAN_API_BASE;
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    $("#navbar-container").load("../employee/navbar.html");

    if (!sessionKey) {
        alert("請重新登入");
        window.location = window.location.origin;
        return;
    }
    loginCheck(userId, sessionKey);

    const STATE_CLASS = { pending: "text-secondary", approved: "text-success", rejected: "text-danger" };
    const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
    const modal = new bootstrap.Modal(document.getElementById("applyModal"));
    let current = null; // the card being applied for

    function dateLabel(date) {
        const [y, m, d] = date.split("-").map(Number);
        return `${date}（${WEEKDAYS[new Date(y, m - 1, d).getDay()]}）`;
    }

    function renderMissing(cards) {
        const box = $("#missing").empty();
        if (!cards.length) {
            box.append($("<p>").addClass("eu-card text-muted mb-0").text("近一個月沒有需要補打卡的紀錄。"));
            return;
        }
        cards.forEach((card) => {
            const button = $("<button>").attr("type", "button").addClass("btn btn-primary btn-sm").text("申請補打卡")
                .on("click", () => openApply(card));
            box.append($("<div>").addClass("eu-card eu-punch-card").attr("data-date", card.date).attr("data-kind", card.kind).append(
                $("<div>").addClass("eu-punch-date").text(dateLabel(card.date)),
                $("<div>").addClass("eu-punch-kind").append(
                    $("<span>").addClass("eu-punch-badge").text(`未打${card.kindLabel}卡`),
                    $("<span>").addClass("text-muted").text(`應打卡 ${card.time}`)
                ),
                button
            ));
        });
    }

    function renderMine(requests) {
        const body = $("#mine").empty();
        if (!requests.length) {
            body.append($("<tr>").append($("<td>").attr("colspan", 8).addClass("text-center text-muted").text("尚無申請")));
            return;
        }
        requests.forEach((r) => {
            body.append($("<tr>").append(
                $("<td>").text(r.date),
                $("<td>").text(r.kindLabel),
                $("<td>").text(r.clockin || "—"),
                $("<td>").text(r.clockout || "—"),
                $("<td>").text(r.reason),
                $("<td>").text((r.appliedAt || "").slice(0, 10)),
                $("<td>").addClass(STATE_CLASS[r.state] || "").text(r.stateLabel),
                $("<td>").text(r.reviewNote || "")
            ));
        });
    }

    function load() {
        return $.ajax({
            url: `${API}/api/makeup/mine`,
            type: "GET",
            dataType: "json",
            data: { account: userId, cookie: sessionKey },
        }).done((res) => {
            renderMissing(res.missing || []);
            renderMine(res.requests);
        }).fail((xhr) => {
            const closed = xhr.status === 403 && xhr.responseJSON && xhr.responseJSON.message;
            if (closed) {
                // 功能管理裡「補打卡申請」還沒開放
                $("#missing").empty().append($("<p>").addClass("text-muted mb-0").text(xhr.responseJSON.message));
                return;
            }
            $("#missing").empty().append($("<p>").addClass("text-danger mb-0").text("無法取得未打卡紀錄，請稍後再試。"));
            alert("無法取得補打卡資料，請稍後再試！");
        });
    }
    load();

    function openApply(card) {
        current = card;
        $("#applyDate").text(dateLabel(card.date));
        $("#applyKind").text(`${card.kindLabel}未打卡`);
        $("#actualTimeLabel").text(`實際${card.kindLabel}時間`);
        $("#actualTime").val("");
        const other = card.kind === "in" ? card.clockout && `當日下班 ${card.clockout}` : card.clockin && `當日上班 ${card.clockin}`;
        $("#actualTimeHint").text(`應打卡 ${card.time}${other ? `；${other}` : ""}`);
        $("#reason").val("");
        $("#formError").text("");
        modal.show();
    }
    document.getElementById("applyModal").addEventListener("shown.bs.modal", () => $("#actualTime").trigger("focus"));

    $("#applyForm").on("submit", function (event) {
        event.preventDefault();
        if (!current) return;
        $("#formError").text("");
        const time = ($("#actualTime").val() || "").slice(0, 5);
        if (!time) return $("#formError").text(`請填寫實際${current.kindLabel}時間`);
        const reason = $("#reason").val().trim();
        if (!reason) return $("#formError").text("請填寫未打卡原因");

        const btn = $("#submitBtn").prop("disabled", true);
        $.ajax({
            url: `${API}/api/makeup/apply`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ account: userId, cookie: sessionKey, date: current.date, kind: current.kind, time, reason }),
        }).done(() => {
            modal.hide();
            alert("已送出補打卡申請，請等候主管審核");
            load();
        }).fail((xhr) => {
            const message = xhr.responseJSON && xhr.responseJSON.message;
            $("#formError").text(message || "送出失敗，請稍後再試");
            if (xhr.status === 409) load();
        }).always(() => {
            btn.prop("disabled", false);
        });
    });
});
