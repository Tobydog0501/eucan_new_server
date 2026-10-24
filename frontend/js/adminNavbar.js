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
    const isPersonnelDetailPage = currentPage === "employeeDetail.html";

    document.querySelectorAll(".navbar-nav .dropdown-toggle").forEach((toggle) => {
        toggle.classList.remove("active");
        toggle.removeAttribute("aria-current");
    });

    document.querySelectorAll(".navbar-nav .nav-link, .navbar-nav .dropdown-item").forEach((link) => {
        if (link.classList.contains("dropdown-toggle")) {
            return;
        }

        const page = navPageName(link.getAttribute("href"));
        const isActive = page === currentPage || (isPersonnelDetailPage && page === "personnel.html");

        link.classList.toggle("active", isActive);
        if (isActive) {
            link.setAttribute("aria-current", "page");
            const dropdown = link.closest(".dropdown");
            if (dropdown) {
                const toggle = dropdown.querySelector(".dropdown-toggle");
                if (toggle) {
                    toggle.classList.add("active");
                }
            }
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
