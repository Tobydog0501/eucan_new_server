// 補登申請（員工端）：填寫未打卡補登申請，並查看自己申請的審核狀態。
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

    // 依類別只要求對應的時間欄位。
    function syncKind() {
        const kind = $("#kind").val();
        const needIn = kind === "in" || kind === "both";
        const needOut = kind === "out" || kind === "both";
        $("#clockin").prop("disabled", !needIn).prop("required", needIn);
        $("#clockout").prop("disabled", !needOut).prop("required", needOut);
        $("#clockinStar").toggle(needIn);
        $("#clockoutStar").toggle(needOut);
        if (!needIn) $("#clockin").val("");
        if (!needOut) $("#clockout").val("");
    }
    $("#kind").on("change", syncKind);
    syncKind();

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
            $("#applicant").val(res.applicant.name);
            $("#department").val(res.applicant.department);
            $("#appliedOn").val(res.today);
            $("#date").attr("max", res.today);
            renderMine(res.requests);
        }).fail(() => {
            alert("無法取得補登資料，請稍後再試！");
        });
    }
    load();

    $("#makeupForm").on("submit", function (event) {
        event.preventDefault();
        $("#formError").text("");
        const kind = $("#kind").val();
        const form = {
            account: userId,
            cookie: sessionKey,
            date: $("#date").val(),
            kind,
            clockin: $("#clockin").prop("disabled") ? null : ($("#clockin").val() || null),
            clockout: $("#clockout").prop("disabled") ? null : ($("#clockout").val() || null),
            reason: $("#reason").val().trim(),
        };
        if (!form.date) return $("#formError").text("請選擇未打卡日期");
        if ((kind === "in" || kind === "both") && !form.clockin) return $("#formError").text("請填寫實際上班時間");
        if ((kind === "out" || kind === "both") && !form.clockout) return $("#formError").text("請填寫實際下班時間");
        if (form.clockin && form.clockout && form.clockin >= form.clockout) return $("#formError").text("實際下班時間必須晚於上班時間");
        if (!form.reason) return $("#formError").text("請填寫未打卡原因");

        const btn = $("#submitBtn").prop("disabled", true);
        $.ajax({
            url: `${API}/api/makeup/apply`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(form),
        }).done(() => {
            alert("已送出補登申請，請等候主管審核");
            $("#reason").val("");
            $("#clockin, #clockout").val("");
            load();
        }).fail((xhr) => {
            const message = xhr.responseJSON && xhr.responseJSON.message;
            $("#formError").text(message || "送出失敗，請稍後再試");
        }).always(() => {
            btn.prop("disabled", false);
        });
    });
});
