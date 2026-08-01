$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");
    const employeeId = new URLSearchParams(window.location.search).get("id");

    if (sessionKey == null) {
        alert("請重新登入！");
        window.location = window.location.origin;
        return;
    }

    loginCheck(userId, sessionKey);

    if (!employeeId) {
        alert("缺少員工編號");
        window.location.href = "./personnel.html";
        return;
    }

    let cachedEmployee = null;

    loadEmployee();

    $("#status").on("change", toggleLeaveDate);
    $("#reload").on("click", loadEmployee);
    $("#employeeForm").on("submit", saveEmployee);

    $("#navbar-container").load("../admin/navbar.html");

    function loadEmployee() {
        $.ajax({
            url: `https://eucan.ddns.net:3000/users`,
            type: 'POST',
            dataType: 'json',
            headers: {
                'Content-Type': 'application/json',
            },
            data: JSON.stringify({
                account: userId,
                cookie: sessionKey,
            }),
        }).then((res) => {
            const employee = (res.data || []).find((item) => item.id === employeeId);
            if (!employee) {
                alert("找不到該員工資料");
                window.location.href = "./personnel.html";
                return;
            }

            cachedEmployee = employee;
            renderEmployee(employee);
        }).catch(() => {
            alert("讀取員工資料失敗");
        });
    }

    function renderEmployee(employee) {
        $("#id").val(employee.id);
        $("#pwd").val(employee.pwd || "");
        $("#employeeName").val(employee.name || "");
        $("#email").val(employee.email || "");
        $("#joinTime").val((employee.joinTime || "").split(" ")[0]);
        $("#type").val(employee.type || "employee");
        $("#mgroup").val(String(employee.mgroup ?? 0));
        $("#permit").val(String(employee.permit ?? 1));
        $("#status").val(String(employee.status ?? 1));
        if (employee.leaveDate) {
            $("#leaveDate").val(normalizeLeaveDate(employee.leaveDate));
        } else {
            $("#leaveDate").val("");
        }
        toggleLeaveDate();
    }

    function toggleLeaveDate() {
        const status = $("#status").val();
        const isResigned = String(status) === "0";
        $("#leaveDate").prop("required", isResigned);
        $("#leaveDateWrap").toggleClass("opacity-50", !isResigned);
    }

    function saveEmployee(event) {
        event.preventDefault();

        const status = $("#status").val();
        const leaveDateValue = $("#leaveDate").val();
        const joinTime = $("#joinTime").val();

        if (!joinTime) {
            alert("請填寫到職日期");
            return;
        }

        if (String(status) === "0" && !leaveDateValue) {
            alert("員工狀態為離職時，離職時間必填");
            return;
        }

        const payload = {
            account: userId,
            cookie: sessionKey,
            user: employeeId,
            pwd: $("#pwd").val(),
            email: $("#email").val(),
            name: $("#employeeName").val(),
            date: joinTime,
            type: $("#type").val(),
            mgroup: $("#mgroup").val(),
            permit: $("#permit").val(),
            status: status,
            leaveDate: String(status) === "0" ? formatLeaveDate(leaveDateValue) : null,
        };

        $.ajax({
            url: `https://eucan.ddns.net:3000/modemp`,
            type: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            data: JSON.stringify(payload),
        }).then(() => {
            alert("員工資料已更新");
            loadEmployee();
        }).catch((xhr) => {
            if (xhr && xhr.status === 400) {
                alert("資料格式有誤，請檢查到職日期、離職時間與狀態設定");
                return;
            }
            if (xhr && xhr.status === 403) {
                alert("沒有權限修改此資料");
                return;
            }
            alert("更新失敗");
        });
    }

    function formatLeaveDate(value) {
        return value ? value : null;
    }

    function normalizeLeaveDate(value) {
        return value ? String(value).slice(0, 10) : "";
    }
});