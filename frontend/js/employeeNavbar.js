function highlightActiveLink() {
    const currentPage = window.location.pathname.split("/").pop();

    document.querySelectorAll(".navbar-nav .nav-link").forEach((link) => {
        if (link.getAttribute("href") === currentPage) {
            link.classList.add("active");
        } else {
            link.classList.remove("active");
        }
    });
}

$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");
    const username = readCookie("name");

    highlightActiveLink();

    if (sessionKey == null) {
        alert("請重新登入！");
        window.location = window.location.origin;
        return;
    }

    renderGreeting(username);
    loginCheck(userId, sessionKey);

    $(document).on("click", "#logoutBtn", () => {
        deleteCookie("session");
        deleteCookie("id");
        deleteCookie("name");
        window.location.href = window.location.origin;
    });
});
