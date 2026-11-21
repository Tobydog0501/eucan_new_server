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
