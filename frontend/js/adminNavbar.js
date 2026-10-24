document.addEventListener("DOMContentLoaded", function () {
    // 取得目前頁面檔名
    const currentPage = window.location.pathname.split("/").pop();
    const isPersonnelDetailPage = currentPage === "employeeDetail.html";

    // 遍歷所有導覽列連結，標記 active 頁面
    document.querySelectorAll(".navbar-nav .nav-link").forEach(link => {
        const linkTarget = link.getAttribute("href");
        if (linkTarget === currentPage || (isPersonnelDetailPage && linkTarget === "./personnel.html")) {
            link.classList.add("active");
        } else {
            link.classList.remove("active");
        }
    });
});

$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");
    const username = readCookie("name");
    if (sessionKey == null) {
        alert("請重新登入！");
        window.location = window.location.origin;
    }

    loginCheck(userId, sessionKey);
    $("#name").html(`
        <p id="name">${username}~~您好</p>
        `
    )
})
