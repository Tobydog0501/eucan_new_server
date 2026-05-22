/// <reference path="jquery-3.7.1.min.js"/>
$(() => {
    const now = new Date();
    const year = now.getFullYear();
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    if (!sessionKey) {
        alert("請重新登入");
        window.location = window.location.origin;
        return;
    }

    loginCheck(userId, sessionKey);

    // 先載入當年度資訊
    info(userId, sessionKey, year);

    // 切換年度查詢特休假資訊
    $("#search").on("click", () => {
        const selectedYear = $("#info select").val() === "當年度" ? year : year + 1;
        info(userId, sessionKey, selectedYear);
    });

    // 送出請假申請
    $("#submit").on("click", submitLeaveRequest);

    // 載入導覽列
    $("#navbar-container").load("../employee/navbar.html");
});

function info(userId, sessionKey, selectedYear) {
    $.ajax({
        url: `https://eucan.ddns.net:3000/sync`,
        type: 'POST',
        dataType: 'json',
        headers: {
            'Content-Type': 'application/json',
        },
        data: JSON.stringify({
            account: userId,
            cookie: sessionKey,
            user: userId,
            year: selectedYear,

        }),
    }).then(res => {
        //console.log(res);
    })

    clean();

    $.when(quota(selectedYear, userId, sessionKey), dayoff(selectedYear, userId, sessionKey))
        .then(function (quota, dayoff) {
            console.log(quota[0]);
            let separate = 0;
            if (quota[0].separate === true) {
                $.confirm({
                    title: '確認',
                    content: '要查看上半年還是下半年',
                    buttons: {
                        confirm: {
                            text: '上半年',
                            btnClass: 'btn-blue',
                            action: function () {
                                separate = 0;
                                $.alert('上半年已選擇');
                                renderData(separate, quota, dayoff);
                            }
                        },
                        cancel: {
                            text: '下半年',
                            action: function () {
                                separate = 1;
                                $.alert('下半年已選擇');
                                renderData(separate, quota, dayoff);
                            }
                        }
                    }
                });
            } else {
                separate = 0;
                renderData(separate, quota, dayoff);
            }

            function renderData(separate, quota, dayoff) {
                // Check if data exists and has at least one element
                const quotaData = quota[0] && quota[0].data && quota[0].data.length > 0 ? quota[0].data[separate] : {};
                const dayoffData = dayoff[0] && dayoff[0].data && dayoff[0].data.length > 0 ? dayoff[0].data[separate] : {};

                const inf = {
                    quota: quotaData.quota || 0,
                    annual: dayoffData.annual || 0,
                };

                $("#quota").text(`${inf.quota}(hr)`);
                $("#annual").text(`${inf.annual}(hr)`);

            }
        })
        .fail(function (textStatus, errorThrown) {
            // 失敗
            alert("請求失敗，請檢查員工編號是否正確或稍後再試！");
            console.error("Request failed:", textStatus, errorThrown);
        });


}
function clean() {
    $("#quota, #annual").empty();
    $("#joinTime h2").remove();
};




function quota(year, userId, sessionKey) {
    return $.ajax({
        url: `https://eucan.ddns.net:3000/quota`,
        type: "POST",
        dataType: "json",
        headers: {
            "Content-Type": "application/json",
        },
        data: JSON.stringify({
            account: userId,
            cookie: sessionKey,
            year: year,
        }),
    })
}
function dayoff(year, userId, sessionKey) {
    return $.ajax({
        url: `https://eucan.ddns.net:3000/dayoff`,
        type: "POST",
        dataType: "json",
        headers: {
            "Content-Type": "application/json",
        },
        data: JSON.stringify({
            account: userId,
            cookie: sessionKey,
            year: year,
        }),
    })
}

/**
 * 送出請假申請
 */
function submitLeaveRequest() {
    const userId = readCookie("id");
    const sessionKey = readCookie("session");

    const startDate = $("#start_day").val();
    const startTime = $("#start_time").val();
    const endDate = $("#end_day").val();
    const endTime = $("#end_time").val();
    const reason = $("#reason").val();
    const leaveType = $("#type").val();

    console.log(leaveType);

    // 檢查時間格式是否正確
    if (!validTime(startTime)) {
        alert("起始時間格式有誤，請重新輸入！");
        return reloadPage();
    }
    if (!validTime(endTime)) {
        alert("結束時間格式有誤，請重新輸入！");
        return reloadPage();
    }

    if (!validType(leaveType)) {
        alert("假別有誤，請重新輸入！");
        return reloadPage();
    }

    const requestData = {
        account: userId,
        cookie: sessionKey,
        type: leaveType,
        start: `${startDate} ${startTime}`,
        end: `${endDate} ${endTime}`,
        reason
    };

    console.log("🚀 發送請假申請:", requestData);

    $.ajax({
        url: "https://eucan.ddns.net:3000/request",
        type: "POST",
        dataType: "text", // 設為 text，讓我們可以手動解析 JSON
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(requestData)
    }).done(res => {
        console.log("✅ 請假申請成功:", res);
        try {
            alert("已發送請假申請");
        } catch (e) {
            console.error("⚠️ JSON 解析失敗:", e);
            alert("已發送請假申請");
        }
        reloadPage();
    }).fail(xhr => {
        console.error("❌ 請假申請失敗:", xhr);
        alert(`請求失敗，錯誤代碼：${xhr.status}`);
        reloadPage();
    });
}

/**
 * 驗證時間格式是否符合規範 (08:30 - 17:30, 只允許整點與半點)
 */
function validTime(time) {
    if (!time || !time.includes(":")) return false;
    const [hour, minute] = time.split(":").map(Number);
    if (hour < 8 || hour > 17) return false;
    if (hour === 8 && minute === 0) return false;
    return minute === 0 || minute === 30;
}

//檢查是否填寫假別
function validType(type) {
    return type !== "選擇假別";
}


/**
 * 重新載入頁面
 */
function reloadPage() {
    setTimeout(() => {
        window.location.reload();
    }, 500);
}

/* 範例請假申請 JSON
{
    "account": "david",
    "cookie": "bbbe040c61",
    "type": "sick",
    "start": "2024-08-09",
    "end": "2024-08-10",
    "reason": "test01"
}
*/
