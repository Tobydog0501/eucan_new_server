
$(function() {
	function login() {
		var twoFAc = "";
		if($("#code").val()=='root'){
			twoFAc = prompt("請輸入2FA驗證碼");
		}
		$.ajax({
			url: 'https://eucan.ddns.net:3000/login',
			type: 'POST',
			dataType: 'json',
			headers: {
				'Content-Type': 'application/json',
			},
			data: JSON.stringify({
				account:$("#code").val(),
				pwd:$("#pw").val(),
				cookie:readCookie("session"),
				twoFA:twoFAc
			}),
		}).then(res=>{
			addCookie("session",res["sessionKey"]);
			addCookie("id",$("#code").val());
			addCookie("name", res["name"] || "");
			window.location = `${window.location.origin}/${res["accountType"]=="employee"?"employee/employeeMain.html":res["accountType"]=="admin"?"admin/review.html":""}`
		}).catch(rej=>{
			alert("帳號或密碼錯誤");
		});
	}

	$("#loginForm").on("submit", function(e){
		e.preventDefault();
		login();
	});

	$("#togglePw").on("click", function(){
		var isMasked = $("#pw").prop("type") === "password";
		$("#pw").prop("type", isMasked ? "text" : "password");
		$(this).text(isMasked ? "隱藏" : "顯示");
	});
});
