function ensureNavbarStyles() {
    if (document.getElementById("eucan-navbar-css")) {
        return;
    }
    const link = document.createElement("link");
    link.id = "eucan-navbar-css";
    link.rel = "stylesheet";
    link.href = "../css/navbar.css";
    document.head.appendChild(link);
}

ensureNavbarStyles();

function navPageName(href) {
    if (!href || href === "#") {
        return "";
    }
    return href.split("/").pop().split("?")[0] || "";
}

function highlightActiveLink() {
    const currentPage = window.location.pathname.split("/").pop() || "";

    document.querySelectorAll(".navbar-nav .nav-link").forEach((link) => {
        const isActive = navPageName(link.getAttribute("href")) === currentPage;
        link.classList.toggle("active", isActive);
        if (isActive) {
            link.setAttribute("aria-current", "page");
        } else {
            link.removeAttribute("aria-current");
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
