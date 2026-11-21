// 補登審核（後台）：主管／管理員核准或駁回員工的補登申請。
// 核准後才會產生標記為「補登」的打卡紀錄；駁回需填原因。
$(function () {
    const API = "https://eucan.ddns.net:3000";
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    $("#navbar-container").load("../admin/navbar.html");

    if (!sessionKey) {
        alert("請重新登入");
        window.location = window.location.origin;
        return;
    }
    loginCheck(userId, sessionKey);

    const ACTION_LABELS = { submit: "送出申請", approve: "核准", reject: "駁回" };

    function render(requests) {
        const body = $("#requests").empty();
        if (!requests.length) {
            body.append($("<tr>").append($("<td>").attr("colspan", 10).addClass("text-center text-muted").text("沒有符合的補登申請")));
            return;
        }
        requests.forEach((r) => {
            const actions = $("<td>").addClass("text-nowrap");
            if (r.canReview) {
                actions.append(
                    $("<button>").addClass("btn btn-success btn-sm me-1").text("核准").on("click", () => decide(r, "approve")),
                    $("<button>").addClass("btn btn-danger btn-sm me-1").text("駁回").on("click", () => decide(r, "reject"))
                );
            } else if (r.state === "pending") {
                actions.append($("<span>").addClass("text-muted small me-1").text("需由 root 審核"));
            }
            actions.append($("<button>").addClass("btn btn-outline-secondary btn-sm").text("稽核").on("click", () => showAudit(r.requestId)));
            const state = r.state === "pending" ? r.stateLabel : `${r.stateLabel}（${r.reviewerName || ""}${r.reviewNote ? "：" + r.reviewNote : ""}）`;
            body.append($("<tr>").append(
                $("<td>").text(r.name),
                $("<td>").text(r.department),
                $("<td>").text(r.date),
                $("<td>").text(r.kindLabel),
                $("<td>").text(r.clockin || "—"),
                $("<td>").text(r.clockout || "—"),
                $("<td>").text(r.reason),
                $("<td>").text((r.appliedAt || "").slice(0, 10)),
                $("<td>").text(state),
                actions
            ));
        });
    }

    function load() {
        $.ajax({
            url: `${API}/api/makeup/requests`,
            type: "GET",
            dataType: "json",
            data: { account: userId, cookie: sessionKey, state: $("#state").val() },
        }).done((res) => render(res.requests))
            .fail(() => alert("無法取得補登申請，請稍後再試"));
    }

    function decide(r, decision) {
        let note = "";
        if (decision === "reject") {
            note = prompt(`駁回 ${r.name} ${r.date} 的補登申請，請填寫原因：`, "");
            if (note === null) return;
            note = note.trim();
            if (!note) {
                alert("駁回請填寫原因");
                return;
            }
        } else {
            const times = [r.clockin && `上班 ${r.clockin}`, r.clockout && `下班 ${r.clockout}`].filter(Boolean).join("、");
            if (!confirm(`確定核准 ${r.name} ${r.date} 的補登（${times}）？核准後會產生補登打卡紀錄。`)) return;
        }
        $.ajax({
            url: `${API}/api/makeup/review`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ account: userId, cookie: sessionKey, requestId: r.requestId, decision, note }),
        }).done(() => {
            alert(decision === "approve" ? "已核准" : "已駁回");
            load();
        }).fail((xhr) => {
            const message = xhr.responseJSON && xhr.responseJSON.message;
            alert(message || (xhr.status === 403 ? "權限不足，無法審核這筆申請" : "操作失敗，請稍後再試"));
            load();
        });
    }

    function showAudit(requestId) {
        $.ajax({
            url: `${API}/api/makeup/audit`,
            type: "GET",
            dataType: "json",
            data: { account: userId, cookie: sessionKey, requestId },
        }).done((res) => {
            const body = $("#auditRows").empty();
            res.audit.forEach((a) => {
                body.append($("<tr>").append(
                    $("<td>").text(a.acted_at),
                    $("<td>").text(ACTION_LABELS[a.action] || a.action),
                    $("<td>").text(`${a.actor_name} (${a.actor_id})`),
                    $("<td>").text(a.reason)
                ));
            });
            bootstrap.Modal.getOrCreateInstance(document.getElementById("auditModal")).show();
        }).fail(() => alert("無法取得稽核紀錄"));
    }

    $("#state").on("change", load);
    load();
});
