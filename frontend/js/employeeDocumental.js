$(function () {
    const now = new Date();
    const defaultYear = String(now.getFullYear());
    const sessionKey = readCookie("session");
    const userId = readCookie("id");
    const itemsPerPage = 10;
    const stateTextMap = {
        "-1": "拒絕",
        "0": "待審核",
        "1": "通過"
    };

    let allData = [];
    let currentPage = 0;
    let currentState = "1";

    $("#navbar-container").load("../employee/navbar.html");

    if (!sessionKey || !userId) {
        alert("請重新登入");
        window.location = window.location.origin;
        return;
    }

    loginCheck(userId, sessionKey);
    $("#year").val(defaultYear);

    $("#search").on("click", () => {
        const selectedYear = String($("#year").val() || "").trim();
        if (!/^\d{4}$/.test(selectedYear)) {
            alert("請輸入正確年度，例如 2026");
            return;
        }
        currentPage = 0;
        fetchData(selectedYear);
    });

    $("#approve").on("click", () => switchState("1"));
    $("#wait").on("click", () => switchState("0"));
    $("#reject").on("click", () => switchState("-1"));

    $("#nextPage").on("click", () => {
        const filteredData = getFilteredData();
        if ((currentPage + 1) * itemsPerPage < filteredData.length) {
            currentPage += 1;
            renderPage();
        }
    });

    $("#prevPage").on("click", () => {
        if (currentPage > 0) {
            currentPage -= 1;
            renderPage();
        }
    });

    switchState(currentState);
    fetchData(defaultYear);

    function switchState(state) {
        currentState = String(state);
        currentPage = 0;
        updateFilterButtonState();
        renderPage();
    }

    function getFilteredData() {
        return allData.filter((item) => String(item.state) === currentState);
    }

    function renderPage() {
        const filteredData = getFilteredData();
        const start = currentPage * itemsPerPage;
        const end = start + itemsPerPage;
        const pageData = filteredData.slice(start, end);

        $("#table").empty();

        if (pageData.length === 0) {
            const emptyRow = $("<tr>").append(
                $("<td>")
                    .attr("colspan", 7)
                    .addClass("text-center text-muted")
                    .text("查無符合條件的假單資料")
            );
            $("#table").append(emptyRow);
        } else {
            pageData.forEach((item) => {
                const stateValue = String(item.state);
                const tableRow = $("<tr>").append(
                    $("<td>").text(item.serialnum || ""),
                    $("<td>").text(item.name || ""),
                    $("<td>").text(item.type || ""),
                    $("<td>").text(item.reason || ""),
                    $("<td>").text(item.start || ""),
                    $("<td>").text(item.end || ""),
                    $("<td>").text(stateTextMap[stateValue] || "未知")
                );
                $("#table").append(tableRow);
            });
        }

        updatePaginationButtons(filteredData.length);
    }

    function updatePaginationButtons(totalItems) {
        const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
        const safePage = Math.min(currentPage, totalPages - 1);

        if (safePage !== currentPage) {
            currentPage = safePage;
            renderPage();
            return;
        }

        $("#prevPage").prop("disabled", currentPage === 0);
        $("#nextPage").prop("disabled", currentPage >= totalPages - 1 || totalItems === 0);
        $("#pageInfo").text(`目前在第 ${currentPage + 1} 頁，共 ${totalPages} 頁`);
    }

    function updateFilterButtonState() {
        $(".leave-filter-btn").removeClass("active");
        if (currentState === "1") {
            $("#approve").addClass("active");
        } else if (currentState === "0") {
            $("#wait").addClass("active");
        } else if (currentState === "-1") {
            $("#reject").addClass("active");
        }
    }

    function fetchData(year) {
        $.ajax({
            url: "https://eucan.ddns.net:3000/empquery",
            type: "POST",
            dataType: "json",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                account: userId,
                cookie: sessionKey,
                year: year
            })
        })
            .done((res) => {
                if (!res || !Array.isArray(res.data)) {
                    console.error("API 回傳格式錯誤:", res);
                    alert("資料格式錯誤，請聯繫管理員！");
                    allData = [];
                    currentPage = 0;
                    renderPage();
                    return;
                }

                allData = res.data.slice().sort((a, b) => {
                    const aSerial = String(a.serialnum || "");
                    const bSerial = String(b.serialnum || "");
                    return aSerial.localeCompare(bSerial, "zh-Hant");
                });

                currentPage = 0;
                renderPage();
            })
            .fail((jqXHR, textStatus, errorThrown) => {
                console.error("請求失敗：", textStatus, errorThrown);
                console.log("伺服器回應：", jqXHR.responseText);
                alert("資料加載失敗，請稍後再試！");
                allData = [];
                currentPage = 0;
                renderPage();
            });
    }
});
