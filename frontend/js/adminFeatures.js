// 功能管理（後台）：開發人員把功能做完並部署後，主管在這裡排定上線時間、
// 立即上線、取消排定或下架。開發中的功能只列出來，不能排定。
$(function () {
    const API = EUCAN_API_BASE;
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    $("#navbar-container").load("../admin/navbar.html");

    if (!sessionKey) {
        alert("請重新登入");
        window.location = window.location.origin;
        return;
    }
    loginCheck(userId, sessionKey);

    const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
    let nowMinute = "";

    // "2026-12-01 00:00" -> "12/1（二）00:00"，跨年時加上年份
    function whenText(minute) {
        const [date, time] = minute.split(" ");
        const [y, m, d] = date.split("-").map(Number);
        const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
        const year = nowMinute && Number(nowMinute.slice(0, 4)) !== y ? `${y}/` : "";
        return `${year}${m}/${d}（${weekday}）${time}`;
    }

    function minutesBetween(from, to) {
        const parse = (s) => {
            const [date, time] = s.split(" ");
            const [y, m, d] = date.split("-").map(Number);
            const [hh, mm] = time.split(":").map(Number);
            return Date.UTC(y, m - 1, d, hh, mm);
        };
        return Math.round((parse(to) - parse(from)) / 60000);
    }

    function countdownText(launchAt) {
        const mins = minutesBetween(nowMinute, launchAt);
        if (mins < 60) return `再 ${Math.max(mins, 1)} 分鐘`;
        if (launchAt.slice(0, 10) === nowMinute.slice(0, 10)) return `今天 ${launchAt.slice(11)}`;
        return `剩 ${Math.ceil(mins / 1440)} 天`;
    }

    // 明天 00:00，作為排定時間的預設值
    function tomorrowMidnight() {
        const [y, m, d] = nowMinute.slice(0, 10).split("-").map(Number);
        const t = new Date(Date.UTC(y, m - 1, d + 1));
        return `${t.toISOString().slice(0, 10)} 00:00`;
    }

    // 排定／改上線時間的彈窗（整頁共用一個）
    const scheduleModal = new bootstrap.Modal(document.getElementById("scheduleModal"));
    let scheduling = null; // the feature being scheduled

    function scheduleError(message) {
        $("#scheduleError").text(message || "").toggleClass("d-none", !message);
    }

    function updatePreview() {
        const launchAt = ($("#scheduleAt").val() || "").replace("T", " ");
        scheduleError("");
        if (!launchAt) {
            $("#schedulePreview").text("");
            return;
        }
        $("#schedulePreview").text(launchAt > nowMinute
            ? `將於 ${whenText(launchAt)} 上線（${countdownText(launchAt)}）`
            : "這個時間已經過了，請選擇未來的時間");
    }

    function openSchedule(f) {
        scheduling = f;
        const rescheduling = f.state === "scheduled";
        $("#scheduleTitle").text(rescheduling ? "改上線時間" : "排定上線");
        $("#scheduleFeature").text(f.name);
        $("#scheduleCurrent").text(rescheduling ? `目前排定：${whenText(f.launchAt)} 上線` : "目前未上線");
        $("#scheduleAt").attr("min", nowMinute.replace(" ", "T"))
            .val((rescheduling ? f.launchAt : tomorrowMidnight()).replace(" ", "T"));
        $("#scheduleSave").text(rescheduling ? "確認改期" : "確認排定").prop("disabled", false);
        updatePreview();
        scheduleModal.show();
    }

    $("#scheduleAt").on("input change", updatePreview);
    document.getElementById("scheduleModal").addEventListener("shown.bs.modal", () => $("#scheduleAt").trigger("focus"));

    $("#scheduleSave").on("click", () => {
        const f = scheduling;
        if (!f) return;
        const launchAt = ($("#scheduleAt").val() || "").replace("T", " ");
        if (!launchAt) {
            scheduleError("請選擇上線時間");
            return;
        }
        if (launchAt <= nowMinute) {
            scheduleError("上線時間必須晚於現在；要馬上上線請按「立即上線」");
            return;
        }
        if (f.state === "scheduled" && launchAt === f.launchAt) {
            scheduleError("時間沒有變更");
            return;
        }
        const button = $("#scheduleSave").prop("disabled", true);
        $.ajax({
            url: `${API}/api/features/release`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ account: userId, cookie: sessionKey, key: f.key, action: "schedule", launchAt }),
        }).done(() => {
            scheduleModal.hide();
            load();
            applyFeatureFlags();
        }).fail((xhr) => {
            scheduleError((xhr.responseJSON && xhr.responseJSON.message) || "排定失敗，請稍後再試");
        }).always(() => button.prop("disabled", false));
    });

    function pill(text, cls) {
        return $("<span>").addClass(`eu-release-pill ${cls}`).text(text);
    }

    function release(f, action, launchAt, button) {
        if (button) button.prop("disabled", true);
        return $.ajax({
            url: `${API}/api/features/release`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ account: userId, cookie: sessionKey, key: f.key, action, launchAt }),
        }).done(() => {
            load();
            applyFeatureFlags(); // 導覽列跟著更新
        }).fail((xhr) => {
            alert((xhr.responseJSON && xhr.responseJSON.message) || "操作失敗，請稍後再試");
        }).always(() => {
            if (button) button.prop("disabled", false);
        });
    }

    function renderFeature(f) {
        const card = $("<section>").addClass("eu-card eu-release-card");

        // 標題列：名稱＋目前狀態
        const status = $("<div>").addClass("eu-release-status");
        if (f.state === "live") {
            status.append(pill("已上線", "is-live"));
            status.append($("<span>").addClass("eu-release-when").text(f.launchAt ? `${whenText(f.launchAt)} 起` : `${(f.updatedAt || "").slice(0, 16)} 起`));
        } else if (f.state === "scheduled") {
            status.append(pill(`已排定 ${whenText(f.launchAt)} 上線`, "is-scheduled"));
            status.append($("<span>").addClass("eu-release-when").text(countdownText(f.launchAt)));
        } else if (f.state === "off") {
            status.append(pill("未上線", "is-off"));
        } else {
            status.append(pill("開發中", "is-developing"));
        }
        card.append($("<div>").addClass("eu-release-head").append($("<h2>").addClass("eu-release-name").text(f.name), status));
        card.append($("<p>").addClass("eu-release-desc").text(f.description));

        card.append($("<p>").addClass("eu-release-meta").text(
            f.ready ? "開發：已完成並部署，可以排定上線" : "開發中：開發人員完成並部署後，才能排定上線"
        ));
        if (f.forced !== null) {
            card.append($("<p>").addClass("eu-release-warning").text(
                `伺服器設定（FEATURE_OVERRIDES）目前強制${f.forced ? "上線" : "不上線"}，這裡的排定暫時不生效。`
            ));
        }

        if (f.ready) {
            const actions = $("<div>").addClass("eu-release-actions");
            const openEditor = () => openSchedule(f);

            const btn = (text, cls, handler) => $("<button>").attr("type", "button").addClass(`btn ${cls}`).text(text).on("click", handler);
            const launchNow = btn("立即上線", "btn-outline-success", function () {
                if (!confirm(`確定讓「${f.name}」現在就上線？員工馬上就會看到。`)) return;
                release(f, "launch", null, $(this));
            });

            if (f.state === "off") {
                actions.append(btn("排定上線", "btn-primary", openEditor), launchNow);
            } else if (f.state === "scheduled") {
                actions.append(
                    btn("改上線時間", "btn-primary", openEditor),
                    launchNow,
                    btn("取消排定", "btn-outline-danger", function () {
                        if (!confirm(`取消「${f.name}」在 ${whenText(f.launchAt)} 的上線排定？取消後會維持未上線。`)) return;
                        release(f, "stop", null, $(this));
                    })
                );
            } else if (f.state === "live") {
                actions.append(btn("下架", "btn-outline-danger", function () {
                    if (!confirm(`確定下架「${f.name}」？員工會馬上看不到這個功能。`)) return;
                    release(f, "stop", null, $(this));
                }));
            }
            card.append(actions);
        }

        if (f.updatedByName) {
            card.append($("<p>").addClass("eu-release-updated").text(`最後修改：${f.updatedByName}，${(f.updatedAt || "").slice(0, 16)}`));
        }
        return card;
    }

    function renderHistory(rows) {
        const body = $("#history").empty();
        if (!rows.length) {
            body.append($("<tr>").append($("<td>").attr("colspan", 4).addClass("text-center text-muted").text("尚無發布紀錄")));
            return;
        }
        rows.forEach((h) => body.append($("<tr>").append(
            $("<td>").addClass("text-nowrap").text(h.actedAt.slice(0, 16)),
            $("<td>").addClass("text-nowrap").text(h.name),
            $("<td>").text(h.text),
            $("<td>").addClass("text-nowrap").text(h.actorName)
        )));
    }

    function load() {
        $.ajax({
            url: `${API}/api/features/manage`,
            type: "GET",
            dataType: "json",
            data: { account: userId, cookie: sessionKey },
        }).done((res) => {
            nowMinute = res.now;
            $("#now").text(`目前時間：${res.now}`);
            $("#features").empty().append(res.features.map(renderFeature));
            renderHistory(res.history || []);
        }).fail(() => alert("無法取得功能設定，請稍後再試"));
    }

    load();
});
