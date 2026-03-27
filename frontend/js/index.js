
$(function() {
	$("#login").on("click",function(){
		var twoFAc = "";
		if($("#code").val()=='root'){
			twoFAc = prompt("請輸入2FA驗證碼");
		}
		$.ajax({
			url: 'http://eucan.ddns.net:3000/login',
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
			// console.log(res);
			document.cookie = `session=${res["sessionKey"]};`;
			addCookie("session",res["sessionKey"]);
			addCookie("id",$("#code").val());
			addCookie("name", res["name"]);
			window.location = `${window.location.origin}/${res["accountType"]=="employee"?"employee/employeeMain.html":res["accountType"]=="admin"?"admin/review.html":""}`
		}).catch(rej=>{
			alert("帳號或密碼錯誤");
		});
	});
});