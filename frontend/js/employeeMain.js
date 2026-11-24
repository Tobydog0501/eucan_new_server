$(function () {
    $("#navbar-container").load("../employee/navbar.html");
    // Issue-report service: port 6744 on the same host as the page (production keeps its old link).
    $("#report-issue-link").attr("href", `${window.location.protocol}//${window.location.hostname}:6744/submit`);
});