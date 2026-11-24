// 公告管理（後台）：新增、編輯、刪除公告；發布與下架時間可預先排定（台北時間）。
// 公告顯示在員工首頁（對象：全體、員工）與主管首頁「假單審核」（對象：全體、主管）。
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

    const STATUS = {
        published: { text: "發布中", cls: "text-bg-success" },
        scheduled: { text: "排程中", cls: "text-bg-warning" },
        expired: { text: "已下架", cls: "text-bg-secondary" },
    };
    let nowMinute = "";

    const toInput = (minute) => (minute ? minute.replace(" ", "T") : "");
    const fromInput = (value) => (value ? value.replace("T", " ") : "");

    function resetForm() {
        $("#announcementId").val("");
        $("#title, #body, #expireAt").val("");
        $("#audience").val("all");
        $("#publishAt").val(toInput(nowMinute));
        $("#pinned").prop("checked", false);
        $("#formTitle").text("新增公告");
        $("#saveBtn").text("發布");
        $("#cancelBtn").addClass("d-none");
    }

    function edit(a) {
        $("#announcementId").val(a.id);
        $("#title").val(a.title);
        $("#body").val(a.body);
        $("#audience").val(a.audience);
        $("#publishAt").val(toInput(a.publishAt));
        $("#expireAt").val(toInput(a.expireAt));
        $("#pinned").prop("checked", a.pinned);
        $("#formTitle").text(`編輯公告：${a.title}`);
        $("#saveBtn").text("儲存修改");
        $("#cancelBtn").removeClass("d-none");
        document.getElementById("announcementForm").scrollIntoView({ behavior: "smooth" });
    }

    function remove(a) {
        if (!confirm(`確定刪除公告「${a.title}」？刪除後員工與主管都看不到。`)) return;
        $.ajax({
            url: `${API}/api/announcements/delete`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ account: userId, cookie: sessionKey, id: a.id }),
        }).done(() => {
            if (String($("#announcementId").val()) === String(a.id)) resetForm();
            load();
        }).fail((xhr) => alert((xhr.responseJSON && xhr.responseJSON.message) || "刪除失敗，請稍後再試"));
    }

    function render(list) {
        const body = $("#announcements").empty();
        if (!list.length) {
            body.append($("<tr>").append($("<td>").attr("colspan", 7).addClass("text-center text-muted").text("尚無公告")));
            return;
        }
        list.forEach((a) => {
            const status = STATUS[a.status] || STATUS.published;
            const title = $("<td>").append(
                a.pinned ? $("<span>").addClass("badge text-bg-danger me-1").text("置頂") : null,
                $("<span>").addClass("fw-semibold").text(a.title),
                $("<div>").addClass("small text-muted eu-preline").text(a.body.length > 80 ? `${a.body.slice(0, 80)}…` : a.body)
            );
            body.append($("<tr>").append(
                $("<td>").addClass("text-nowrap").append($("<span>").addClass(`badge ${status.cls}`).text(status.text)),
                title,
                $("<td>").addClass("text-nowrap").text(a.audienceLabel),
                $("<td>").addClass("text-nowrap").text(a.publishAt),
                $("<td>").addClass("text-nowrap").text(a.expireAt || "—"),
                $("<td>").addClass("small").text(`${a.updatedByName}\n${a.updatedAt}`).css("white-space", "pre-line"),
                $("<td>").addClass("text-nowrap").append(
                    $("<button>").attr("type", "button").addClass("btn btn-outline-primary btn-sm me-1").text("編輯").on("click", () => edit(a)),
                    $("<button>").attr("type", "button").addClass("btn btn-outline-danger btn-sm").text("刪除").on("click", () => remove(a))
                )
            ));
        });
    }

    function load(first) {
        $.ajax({
            url: `${API}/api/announcements/manage`,
            type: "GET",
            dataType: "json",
            data: { account: userId, cookie: sessionKey },
        }).done((res) => {
            nowMinute = res.now;
            $("#now").text(`目前時間：${res.now}`);
            if (first) resetForm();
            render(res.announcements || []);
        }).fail(() => alert("無法取得公告，請稍後再試"));
    }

    $("#cancelBtn").on("click", resetForm);

    $("#announcementForm").on("submit", (event) => {
        event.preventDefault();
        const payload = {
            account: userId,
            cookie: sessionKey,
            id: $("#announcementId").val() || null,
            title: $("#title").val().trim(),
            body: $("#body").val().trim(),
            audience: $("#audience").val(),
            publishAt: fromInput($("#publishAt").val()),
            expireAt: fromInput($("#expireAt").val()) || null,
            pinned: $("#pinned").prop("checked"),
        };
        if (!payload.title || !payload.body || !payload.publishAt) {
            alert("請填寫標題、內容與發布時間");
            return;
        }
        $("#saveBtn").prop("disabled", true);
        $.ajax({
            url: `${API}/api/announcements/save`,
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(payload),
        }).done((res) => {
            const a = res.announcement;
            alert(a.status === "scheduled" ? `已排程，將於 ${a.publishAt} 發布` : "已儲存");
            resetForm();
            load();
        }).fail((xhr) => {
            alert((xhr.responseJSON && xhr.responseJSON.message) || "儲存失敗，請稍後再試");
        }).always(() => $("#saveBtn").prop("disabled", false));
    });

    load(true);
});
