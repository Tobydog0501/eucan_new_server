const FONT_SCALES = [0.9, 1, 1.1, 1.2, 1.35];
const DEFAULT_FONT_INDEX = 1;

function highlightActiveLink() {
    const currentPage = window.location.pathname.split("/").pop();
    const isPersonnelDetailPage = currentPage === "employeeDetail.html";

    document.querySelectorAll(".navbar-nav .nav-link").forEach((link) => {
        const linkTarget = link.getAttribute("href");
        if (linkTarget === currentPage || (isPersonnelDetailPage && linkTarget === "./personnel.html")) {
            link.classList.add("active");
        } else {
            link.classList.remove("active");
        }
    });
}

function applyGlobalFontScale(scale) {
    document.documentElement.style.fontSize = `${scale * 100}%`;
    document.documentElement.style.setProperty("--record-font-scale", String(scale));
    localStorage.setItem("appFontScale", String(scale));
}

function getStoredFontIndex() {
    const storedValue = parseFloat(localStorage.getItem("appFontScale") || "");
    if (!Number.isFinite(storedValue)) {
        return DEFAULT_FONT_INDEX;
    }

    const matchedIndex = FONT_SCALES.findIndex((value) => value === storedValue);
    return matchedIndex >= 0 ? matchedIndex : DEFAULT_FONT_INDEX;
}

function updateFontButtonsState(index) {
    $("#fontDown").prop("disabled", index <= 0);
    $("#fontUp").prop("disabled", index >= FONT_SCALES.length - 1);
}

$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");
    const username = readCookie("name");
    let fontIndex = getStoredFontIndex();

    highlightActiveLink();
    applyGlobalFontScale(FONT_SCALES[fontIndex]);
    updateFontButtonsState(fontIndex);

    if (sessionKey == null) {
        alert("請重新登入！");
        window.location = window.location.origin;
        return;
    }

    loginCheck(userId, sessionKey);
    $("#name").text(`${username || ""}~~您好`);

    $(document).on("click", "#fontDown", () => {
        if (fontIndex > 0) {
            fontIndex -= 1;
            applyGlobalFontScale(FONT_SCALES[fontIndex]);
            updateFontButtonsState(fontIndex);
        }
    });

    $(document).on("click", "#fontReset", () => {
        fontIndex = DEFAULT_FONT_INDEX;
        applyGlobalFontScale(FONT_SCALES[fontIndex]);
        updateFontButtonsState(fontIndex);
    });

    $(document).on("click", "#fontUp", () => {
        if (fontIndex < FONT_SCALES.length - 1) {
            fontIndex += 1;
            applyGlobalFontScale(FONT_SCALES[fontIndex]);
            updateFontButtonsState(fontIndex);
        }
    });

    $(document).on("click", "#logoutBtn", () => {
        deleteCookie("session");
        deleteCookie("id");
        deleteCookie("name");
        window.location.href = window.location.origin;
    });
});
