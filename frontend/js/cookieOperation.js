// Backend API base, shared by every page script (this file loads first).
// Empty = the page's own host on port 3000; in production that is exactly the
// address the pages used to hardcode. A build can pin it
// with the API_BASE build arg (frontend/Dockerfile rewrites the line below).
var EUCAN_API_BASE_CONFIGURED = ''; // @API_BASE@
var EUCAN_API_BASE = EUCAN_API_BASE_CONFIGURED || (window.location.protocol + '//' + window.location.hostname + ':3000');

function decodeCookieValue(value) {
	if (value == null) return value;
	try {
		return decodeURIComponent(value);
	} catch (e) {
		return value;
	}
}

function cookieToObj(){
	var cookieString = document.cookie;
	var cookieData = {}
	cookieString.split(/; ?/gm).forEach((val)=>{
        if(val=="") return;
		const eq = val.indexOf("=");
		if (eq < 0) {
			cookieData[val] = "";
			return;
		}
		cookieData[val.slice(0, eq)] = decodeCookieValue(val.slice(eq + 1));
	});
    return cookieData;
}


function readCookie(key){
    const cookieData = cookieToObj();
	if(cookieData[key] == undefined){
		return null;
	}else{
		return cookieData[key];
	}
}

function updateCookie(cookieData){
    for(let k in cookieData){
         document.cookie = `${encodeURIComponent(k)}=${encodeURIComponent(cookieData[k] == null ? "" : String(cookieData[k]))}; path=/; SameSite=Lax`;
    }
}

function addCookie(key,val){
    document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(val == null ? "" : String(val))}; path=/; SameSite=Lax`;
}

function deleteCookie(key){
    document.cookie = `${encodeURIComponent(key)}=; path=/; max-age=0; SameSite=Lax`;
}

function renderGreeting(username) {
	const text = `${username || ""}~~您好`;
	$(".user-greeting").text(text);
	$("#name").text(text);
}


function loginCheck(userId,sessionKey){
    return $.ajax({
        url: `${EUCAN_API_BASE}/session`,
        type: 'POST',
        dataType: 'json',
        headers: {
            'Content-Type': 'application/json',
        },
        data: JSON.stringify({
            account:userId,
            cookie:sessionKey
        }),
    }).then(res=>{
        if (res && res.name) {
            addCookie("name", res.name);
            renderGreeting(res.name);
        }
    }).catch(rej=>{
        console.log(rej)
        alert("請重新登入");
        window.location = window.location.origin;
    });
}

// 功能管理：導覽列裡標了 data-feature="功能代碼" 的項目預設隱藏（d-none），
// 這裡向後端問目前開啟的功能，開啟的才顯示。navbar.html 載入後呼叫。
function applyFeatureFlags(root) {
	const userId = readCookie("id");
	const sessionKey = readCookie("session");
	if (!userId || !sessionKey) return;
	$.ajax({
		url: `${EUCAN_API_BASE}/api/features`,
		type: "GET",
		dataType: "json",
		data: { account: userId, cookie: sessionKey },
	}).done((res) => {
		const features = (res && res.features) || {};
		$(root || document).find("[data-feature]").each(function () {
			$(this).toggleClass("d-none", features[$(this).attr("data-feature")] !== true);
		});
	});
}

// 公告：把目前生效的公告畫進 selector 指定的區塊；沒有公告時整個區塊隱藏。
// 內文是純文字，用 text() 顯示，換行保留（CSS white-space: pre-line）。
function renderAnnouncementBoard(selector) {
	const box = $(selector);
	const userId = readCookie("id");
	const sessionKey = readCookie("session");
	if (!box.length || !userId || !sessionKey) return;
	$.ajax({
		url: `${EUCAN_API_BASE}/api/announcements`,
		type: "GET",
		dataType: "json",
		data: { account: userId, cookie: sessionKey },
	}).done((res) => {
		const list = (res && res.announcements) || [];
		const items = box.find(".eu-announcement-list").empty();
		list.forEach((a) => {
			const head = $("<div>").addClass("eu-announcement-head");
			if (a.pinned) head.append($("<span>").addClass("eu-announcement-pin").text("置頂"));
			head.append($("<h3>").addClass("eu-announcement-title").text(a.title));
			head.append($("<span>").addClass("eu-announcement-date").text((a.publishAt || "").slice(0, 10)));
			items.append($("<article>").addClass("eu-announcement").append(
				head,
				$("<p>").addClass("eu-announcement-body").text(a.body)
			));
		});
		box.toggleClass("d-none", list.length === 0);
	});
}
